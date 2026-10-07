"""Canonical text parsing, alignment validation, publication, and diagnostics."""
from __future__ import annotations

import math
from pathlib import Path
import re
from typing import Any

from common import TRACK_IDS, atomic_json, atomic_text, digest_file, digest_object, read_json, utc_now

BLOCK = re.compile(r"^===\s*((?:chatgpt|gemini)_[1-5][ab])\s*===$")
SECTION = re.compile(r"^\[([^\[\]]+)\]$")
NOTE = re.compile(r"\([^)]*(?:fade(?:s|d)?|breakdown|horns kick|brass finish|instrumental|guitar slowly|synths slowly)[^)]*\)", re.I)
PIPELINE_VERSION = 1


def parse_master(path: Path, require_all: bool = True) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    track: str | None = None
    section, section_index = "", 0
    for number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        text = raw.strip()
        if not text or text.startswith("#"):
            continue
        match = BLOCK.fullmatch(text)
        if match:
            track = match.group(1)
            if track in result:
                raise ValueError(f"Line {number}: duplicate track block {track}")
            result[track] = []
            section, section_index = "", 0
            continue
        if text.startswith("===") or track is None:
            raise ValueError(f"Line {number}: expected === chatgpt_1a === (or another valid track ID)")
        match = SECTION.fullmatch(text)
        if match:
            section, section_index = match.group(1), section_index + 1
            continue
        if "[" in text or "]" in text:
            raise ValueError(f"Line {number}: put section labels on their own lines")
        if NOTE.search(text):
            raise ValueError(f"Line {number}: non-sung production note. Put it on a # comment line instead")
        if len(text) > 3000:
            raise ValueError(f"Line {number}: lyric line too long; use one sung line per text line")
        result[track].append({"text": text, "section": section, "sectionIndex": section_index})
    if require_all and set(result) != set(TRACK_IDS):
        raise ValueError("Master file must contain all 20 blocks. Missing: " + ", ".join(sorted(set(TRACK_IDS) - set(result))))
    if not result or any(not lines for lines in result.values()):
        raise ValueError("Each track must contain at least one sung line")
    if any(len(lines) > 2000 for lines in result.values()):
        raise ValueError("Too many lyric lines in a track (maximum 2000)")
    return result


def lyrics_hash(lines: list[dict[str, Any]]) -> str:
    return digest_object([{key: item[key] for key in ("text", "section", "sectionIndex")} for item in lines])


def audio_fingerprint(root: Path, track_id: str) -> dict[str, Any]:
    out = {}
    for ext in ("opus", "m4a"):
        path = root / "audio" / f"{track_id}.{ext}"
        if path.is_file():
            out[ext] = {"name": path.name, "size": path.stat().st_size, "sha256": digest_file(path)}
    return out


def plain_record(track_id: str, lines: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": track_id, "status": "plain", "lyricsHash": lyrics_hash(lines),
            "duration": None, "warnings": [],
            "lines": [{**line, "start": None, "end": None} for line in lines]}


def normalized(text: str) -> str:
    return "".join(character for character in text.casefold() if character.isalnum())


def line_alignment(track_id: str, lines: list[dict[str, Any]], segments: list[dict[str, Any]],
                   duration: float) -> dict[str, Any]:
    """Never invent even-spaced times. Invalid cues stay visible but untimed."""
    if len(segments) != len(lines):
        raise ValueError(f"{track_id}: expected {len(lines)} line segments, received {len(segments)}. "
                         "Original line boundaries were not preserved; no guessed mapping was published.")
    record = plain_record(track_id, lines)
    record["duration"] = round(duration, 3)
    warnings: list[str] = []
    for index, (original, segment, target) in enumerate(zip(lines, segments, record["lines"]), 1):
        if normalized(str(segment.get("text", ""))) != normalized(original["text"]):
            raise ValueError(f"{track_id} line {index}: aligner returned different text. "
                             "No shifted/mismatched lyric mapping was published.")
        flags: list[str] = []
        start, end = segment.get("start"), segment.get("end")
        valid = isinstance(start, (int, float)) and isinstance(end, (int, float))
        valid = valid and math.isfinite(start) and math.isfinite(end)
        valid = valid and 0 <= start < duration and end > start + .02 and end <= duration + .25
        if not valid:
            flags.append("invalid/zero-length timing; left untimed")
        else:
            target["start"], target["end"] = round(float(start), 3), round(min(float(end), duration), 3)
            span = end - start
            if span > 18:
                flags.append("unusually long line span")
            if span < .45 and len(original["text"].split()) >= 4:
                flags.append("many words in a very short span")
            words = segment.get("words") or []
            probs = [w.get("probability") for w in words if isinstance(w.get("probability"), (int, float)) and math.isfinite(w["probability"])]
            if probs and sum(probs) / len(probs) < .35:
                flags.append("low model word probability (diagnostic, not calibrated confidence)")
            instants = [w for w in words if isinstance(w.get("start"), (int, float)) and isinstance(w.get("end"), (int, float)) and w["end"] - w["start"] <= .02]
            if words and len(instants) / len(words) > .2:
                flags.append("many zero-length words")
        target["flags"] = flags
        warnings.extend(f"Line {index}: {flag}" for flag in flags)
    previous: dict[str, Any] | None = None
    for index, target in enumerate(record["lines"], 1):
        if target["start"] is None:
            continue
        if previous is not None and target["start"] < previous["end"]:
            if target["start"] <= previous["start"] + .02:
                target["start"] = target["end"] = None
                flag = "non-increasing line timing; left untimed"
                target["flags"].append(flag)
                warnings.append(f"Line {index}: {flag}")
                continue
            previous["end"] = target["start"]
            previous["flags"].append("overlap clipped at next line start")
            warnings.append(f"Before line {index}: overlap clipped at next line start")
        previous = target
    timed = sum(line["start"] is not None for line in record["lines"])
    if not timed:
        raise ValueError(f"{track_id}: aligner produced no usable line timings")
    record["warnings"] = warnings
    record["status"] = "needs-review" if warnings else "auto"
    record["timedLines"] = timed
    return record


def valid_cache(root: Path, track_id: str, lines: list[dict[str, Any]],
                fingerprints: dict[str, Any] | None = None) -> dict[str, Any] | None:
    cache = read_json(root / ".runtime" / "lyrics" / "alignments" / f"{track_id}.json")
    if not isinstance(cache, dict) or cache.get("pipelineVersion") != PIPELINE_VERSION:
        return None
    if cache.get("lyricsHash") != lyrics_hash(lines):
        return None
    sources = fingerprints if fingerprints is not None else audio_fingerprint(root, track_id)
    if not sources or sources != cache.get("audioFingerprint"):
        return None
    vocal = cache.get("vocalSource")
    if vocal:
        path = Path(vocal["path"])
        if not path.is_file() or digest_file(path) != vocal.get("sha256"):
            return None
    return cache


def publish(root: Path, master: dict[str, list[dict[str, Any]]],
            fingerprints: dict[str, Any] | None = None) -> dict[str, Any]:
    records = {}
    for track_id, lines in master.items():
        cache = valid_cache(root, track_id, lines, fingerprints.get(track_id) if fingerprints is not None else None)
        records[track_id] = cache["record"] if cache else plain_record(track_id, lines)
    data = {"schemaVersion": 1, "generatedAt": utc_now(), "tracks": records}
    atomic_json(root / "data" / "lyrics.json", data)
    return data


def review_report(root: Path, data: dict[str, Any], errors: dict[str, str] | None = None) -> None:
    errors = errors or {}
    output = ["SWEET TIMES MUSIC - AUTOMATIC ALIGNMENT REVIEW", "",
              "These are model estimates, not proof that the transcript matches the singing.",
              "Review repeated sections, held notes, overlaps, and long instrumental breaks.",
              "Edit words/repetitions in lyrics/recordings.txt, then run align again.",
              "Blank timing means the line is intentionally not synchronized.", ""]
    for track_id, record in data["tracks"].items():
        output += [f"=== {track_id} ===", f"Status: {record['status']}"]
        if track_id in errors:
            output.append("ERROR: " + errors[track_id])
        for warning in record.get("warnings", []):
            output.append("WARNING: " + warning)
        for index, line in enumerate(record["lines"], 1):
            time_range = "       --        " if line["start"] is None else f"{line['start']:8.3f}-{line['end']:8.3f}"
            flags = " | " + "; ".join(line.get("flags", [])) if line.get("flags") else ""
            output.append(f"{index:03d}  {time_range}  {line['text']}{flags}")
        output.append("")
    atomic_text(root / ".runtime" / "lyrics" / "review.txt", "\n".join(output) + "\n")
    atomic_json(root / ".runtime" / "lyrics" / "report.json", {
        "generatedAt": utc_now(), "errors": errors,
        "tracks": {id: {"status": item["status"], "lines": len(item["lines"]),
                         "timedLines": sum(line["start"] is not None for line in item["lines"]),
                         "warnings": item.get("warnings", [])} for id, item in data["tracks"].items()}})
