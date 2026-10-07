"""Preprocess known lyrics locally. The published player runs no AI or backend.
  python tools/lyrics.py check
  python tools/lyrics.py align --track chatgpt_1a
  python tools/lyrics.py align
  python tools/lyrics.py publish
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
from typing import Any

from common import (ROOT, TRACK_IDS, Reporter, atomic_json, digest_file, digest_object,
                    project_environment, run_lock, utc_now, venv_python)
from lyric_data import (PIPELINE_VERSION, audio_fingerprint, line_alignment, lyrics_hash,
                        parse_master, publish, review_report, valid_cache)


ALIGN_OPTIONS = {
    "language": "en", "original_split": True, "regroup": False,
    "remove_instant_words": False, "suppress_silence": True, "vad": False,
    "max_word_dur": 10.0, "word_dur_factor": 4.0,
    "nonspeech_skip": 5.0, "fast_mode": False, "stream": False,
}


def selected_tracks(patterns: list[str] | None) -> list[str]:
    if not patterns:
        return list(TRACK_IDS)
    selected: set[str] = set()
    for pattern in patterns:
        found = [id for id in TRACK_IDS if fnmatch.fnmatchcase(id, pattern)]
        if not found:
            raise ValueError(f"Unknown track pattern: {pattern}")
        selected.update(found)
    return [id for id in TRACK_IDS if id in selected]


def find_ffmpeg(root: Path) -> str:
    env = project_environment(root)
    exe = shutil.which("ffmpeg", path=env["PATH"])
    if not exe:
        raise RuntimeError("FFmpeg is missing. Make ffmpeg.exe available on PATH, or place it at "
                           "tools/ffmpeg/bin/ffmpeg.exe. Your existing YuE2 FFmpeg can be reused.")
    return exe


def decode_audio(path: Path, ffmpeg: str) -> Any:
    import numpy as np
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]
    process = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if process.returncode:
        raise RuntimeError(f"FFmpeg could not decode {path.name}: " + process.stderr.decode("utf-8", "replace")[-2000:])
    audio = np.frombuffer(process.stdout, dtype=np.float32).copy()
    if not len(audio) or not np.isfinite(audio).all():
        raise RuntimeError(f"Invalid/empty decoded audio: {path.name}")
    return audio


def dependencies(report: Reporter, requested: str) -> tuple[Any, Any, str]:
    try:
        import torch
        import stable_whisper
    except (ImportError, OSError) as exc:
        raise RuntimeError("Alignment dependencies are missing/unusable. Run "
                           "python tools/setup_lyrics.py --device cuda (or --device cpu). " + str(exc)) from exc
    device = ("cuda" if torch.cuda.is_available() else "cpu") if requested == "auto" else requested
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable. Check the NVIDIA driver and rerun "
                           "setup_lyrics.py --device cuda, or explicitly use --device cpu.")
    report.log(f"Python: {sys.version.split()[0]}; torch: {torch.__version__}; "
               f"stable-ts: {importlib.metadata.version('stable-ts')}; device: {device}")
    if device == "cuda":
        report.log(f"GPU: {torch.cuda.get_device_name(0)}")
    # Real kernel check, not just a CUDA-available boolean; useful on newer GPUs.
    with torch.no_grad():
        x = torch.ones((8, 8), device=device)
        _ = (x @ x).sum().item()
        if device == "cuda":
            torch.cuda.synchronize()
    return stable_whisper, torch, device


def align_all(root: Path, args: argparse.Namespace, report: Reporter) -> int:
    master = parse_master(root / "lyrics" / "recordings.txt")
    selected = selected_tracks(args.track)
    fingerprints: dict[str, Any] = {}
    with report.phase("Reading lyrics and hashing the available audio files"):
        for track_id in master:
            fingerprints[track_id] = audio_fingerprint(root, track_id)
    # Text edits immediately invalidate old published timestamps, including for
    # unselected tracks. Never show new text over a previous version's timings.
    data = publish(root, master, fingerprints)
    review_report(root, data)
    signature = digest_object({"model": args.model, "options": ALIGN_OPTIONS,
                               "pipeline": PIPELINE_VERSION, "vocalsDir": str(args.vocals_dir or "")})
    pending, errors, skipped = [], {}, 0
    for track_id in selected:
        if not fingerprints[track_id]:
            errors[track_id] = "No canonical audio file. Put audio in audio/ and run rename_audio.py --apply first."
            report.log(f"MISSING {track_id}: no .opus or .m4a")
            continue
        cache = valid_cache(root, track_id, master[track_id], fingerprints[track_id])
        if cache and cache.get("settingsHash") == signature and not args.force:
            skipped += 1
            report.log(f"SKIP {track_id}: audio, lyrics, and settings unchanged")
        else:
            pending.append(track_id)
    report.log(f"Plan: {len(selected)} selected; {len(pending)} to align; {skipped} unchanged; {len(errors)} missing.")
    if not pending:
        review_report(root, data, errors)
        report.log("No model loaded. Published available lyric data.")
        return 2 if errors else 0
    ffmpeg = find_ffmpeg(root)
    with report.phase("Loading alignment dependencies and testing the selected compute device"):
        stable_whisper, torch, device = dependencies(report, args.device)
        torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    model_root = root / ".runtime" / "models" / "whisper"
    model_root.mkdir(parents=True, exist_ok=True)
    with report.phase(f"Loading {args.model}; model download on first use only: {model_root}"):
        model = stable_whisper.load_model(args.model, device=device, download_root=str(model_root))
    completed = 0
    try:
        for number, track_id in enumerate(pending, 1):
            report.operation = f"[{number}/{len(pending)}] {track_id}"
            source_ext = "opus" if "opus" in fingerprints[track_id] else "m4a"
            path = root / "audio" / f"{track_id}.{source_ext}"
            try:
                with report.phase(f"[{number}/{len(pending)}] Decoding {path.name}"):
                    audio = decode_audio(path, ffmpeg)
                    duration = len(audio) / 16000
                    if duration > 3600:
                        raise RuntimeError("Audio exceeds the one-hour safety limit for this song-preparation tool")
                    audio_for_alignment = audio
                    vocal_source = None
                    if args.vocals_dir:
                        stem = args.vocals_dir / f"{track_id}.wav"
                        if not stem.is_file():
                            raise FileNotFoundError(f"Missing optional vocal stem: {stem}")
                        audio_for_alignment = decode_audio(stem, ffmpeg)
                        if abs(len(audio_for_alignment) / 16000 - duration) > .1:
                            raise ValueError("Vocal stem duration differs from the playback file. Use an untrimmed stem with the identical timeline.")
                        vocal_source = {"path": str(stem.resolve()), "sha256": digest_file(stem)}
                    source_warnings = []
                    alternate = "m4a" if source_ext == "opus" else "opus"
                    if alternate in fingerprints[track_id]:
                        other = decode_audio(root / "audio" / f"{track_id}.{alternate}", ffmpeg)
                        delta = abs(len(other) / 16000 - duration)
                        del other
                        if delta > .25:
                            source_warnings.append(f"Opus/M4A decoded durations differ by {delta:.3f}s. Shared timing may not match both encodings.")
                last_progress = [0.0]
                def progress(current: float, total: float) -> None:
                    now = time.monotonic()
                    if now - last_progress[0] >= 3 or current >= total:
                        percent = min(100, 100 * current / total) if total else 0
                        report.log(f"{track_id}: alignment {percent:.1f}% ({current:.1f}/{total:.1f}s audio)")
                        last_progress[0] = now
                with report.phase(f"[{number}/{len(pending)}] Aligning {track_id}: {len(master[track_id])} lines, {duration:.1f}s audio"):
                    text = "\n".join(line["text"] for line in master[track_id])
                    with torch.inference_mode():
                        result = model.align(audio_for_alignment, text, **ALIGN_OPTIONS,
                                             verbose=None, progress_callback=progress)
                    if result is None:
                        raise RuntimeError("The aligner returned no result")
                    raw = result.to_dict()
                    record = line_alignment(track_id, master[track_id], raw["segments"], duration)
                    record["warnings"].extend(source_warnings)
                    if source_warnings:
                        record["status"] = "needs-review"
                    record["alignedFrom"] = path.name
                    record["model"] = args.model
                # Do not label a result as current if the generator replaced audio meanwhile.
                if audio_fingerprint(root, track_id) != fingerprints[track_id]:
                    raise RuntimeError("Audio changed during alignment. Stop generation/export for this track, then rerun.")
                cache = {"pipelineVersion": PIPELINE_VERSION, "createdAt": utc_now(),
                         "lyricsHash": lyrics_hash(master[track_id]), "settingsHash": signature,
                         "audioFingerprint": fingerprints[track_id], "vocalSource": vocal_source,
                         "record": record}
                atomic_json(root / ".runtime" / "lyrics" / "raw" / f"{track_id}.json", raw)
                atomic_json(root / ".runtime" / "lyrics" / "alignments" / f"{track_id}.json", cache)
                data = publish(root, master, fingerprints)
                completed += 1
                report.log(f"SAVED {track_id}: {record['timedLines']}/{len(record['lines'])} timed lines, "
                           f"{len(record['warnings'])} diagnostic warning(s)")
                for warning in record["warnings"][:8]:
                    report.log("  REVIEW: " + warning)
                if len(record["warnings"]) > 8:
                    report.log("  Further warnings are in .runtime/lyrics/review.txt")
                del result, raw, audio, audio_for_alignment
            except (Exception,) as exc:
                errors[track_id] = str(exc)
                report.log(f"FAILED {track_id}: {exc}")
                report.log(traceback.format_exc())
                if "out of memory" in str(exc).lower():
                    report.log("Close YuE2/ComfyUI to release GPU memory, or rerun with --model small.en. Completed tracks are preserved.")
                if device == "cuda":
                    torch.cuda.empty_cache()
                # Continue other recordings. No invented timestamps are substituted.
            finally:
                review_report(root, data, errors)
    finally:
        # A Ctrl+C retains completed tracks; any TXT edits made during the run
        # invalidate only their affected records instead of silently publishing stale text.
        latest = parse_master(root / "lyrics" / "recordings.txt")
        data = publish(root, latest)
        review_report(root, data, errors)
    warning_tracks = sum(record["status"] == "needs-review" for record in data["tracks"].values())
    report.log(f"SUMMARY: completed={completed}; unchanged={skipped}; errors={len(errors)}; "
               f"tracks with review warnings={warning_tracks}")
    report.log("Published: data/lyrics.json. Review: .runtime/lyrics/review.txt")
    report.log("Automatic timing is an estimate. No-warning output still needs a listening check.")
    return 2 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("check", "align", "publish", "doctor"))
    parser.add_argument("--track", nargs="+", help="Recording IDs or quoted patterns, e.g. chatgpt_1a or 'gemini_*'")
    parser.add_argument("--model", default="medium.en", choices=("tiny.en", "base.en", "small.en", "medium.en", "large-v3"))
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--threads", type=int, default=4, help="CPU thread count, default 4")
    parser.add_argument("--force", action="store_true", help="Re-align selected tracks even when unchanged")
    parser.add_argument("--vocals-dir", type=Path, help="Optional untrimmed, time-identical WAV vocals named by track ID")
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be positive")
    # AI commands use the isolated environment without requiring activation.
    interpreter = venv_python()
    if args.command in ("align", "doctor") and interpreter.is_file() and Path(sys.prefix).resolve() != (ROOT / ".venv-lyrics").resolve():
        return subprocess.call([str(interpreter), str(Path(__file__).resolve()), *sys.argv[1:]], env=project_environment(ROOT))
    os.environ.update(project_environment(ROOT))
    if args.vocals_dir:
        args.vocals_dir = args.vocals_dir.resolve()
    try:
        with Reporter(ROOT, "lyrics-" + args.command) as report, run_lock(ROOT, "lyrics"):
            if args.command == "doctor":
                report.log("FFmpeg: " + find_ffmpeg(ROOT))
                with report.phase("Checking packages and actual compute kernel execution"):
                    dependencies(report, args.device)
                report.log("Backend check passed. This does not load model weights or measure lyric accuracy.")
                return 0
            master = parse_master(ROOT / "lyrics" / "recordings.txt")
            if args.command == "check":
                missing = 0
                for track_id in selected_tracks(args.track):
                    existing = [ext for ext in ("opus", "m4a") if (ROOT / "audio" / f"{track_id}.{ext}").is_file()]
                    report.log(f"{track_id}: {len(master[track_id])} sung lines; audio: {', '.join(existing) or 'MISSING'}")
                    missing += not bool(existing)
                report.log(f"Master valid: {len(master)} independent recordings. Selected tracks missing audio: {missing}.")
                return 2 if missing else 0
            if args.command == "publish":
                with report.phase("Publishing current text and matching cached alignments"):
                    data = publish(ROOT, master)
                    review_report(ROOT, data)
                report.log(f"Published {len(master)} tracks to data/lyrics.json. No model was loaded.")
                return 0
            return align_all(ROOT, args, report)
    except KeyboardInterrupt:
        print("Cancelled. Completed alignments remain saved. Run the same command to resume.")
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
