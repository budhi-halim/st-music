"""Preview by default. --apply performs lossless, no-overwrite file renames.
Run from the project root OR from audio/: paths are resolved from this script.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys

from common import ROOT, TRACK_IDS, Reporter, atomic_json, digest_file, run_lock, utc_now

SOURCE = re.compile(r"^sweet-times-music-(chatgpt|gemini)-([1-5])([ab])-preview-seed-(\d+)\.(opus|m4a)$", re.IGNORECASE)
CANONICAL = re.compile(r"^(chatgpt|gemini)_[1-5][ab]\.(opus|m4a)$")


def build_plan(folder: Path) -> tuple[list[tuple[Path, Path]], list[str]]:
    if not folder.is_dir():
        raise ValueError(f"Audio directory not found: {folder}")
    entries = list(folder.iterdir())
    existing = {p.name.casefold(): p for p in entries}
    targets: set[str] = set()
    plan: list[tuple[Path, Path]] = []
    problems: list[str] = []
    for source in sorted(entries, key=lambda p: p.name.casefold()):
        match = SOURCE.fullmatch(source.name)
        if not match:
            if source.suffix.lower() in (".opus", ".m4a") and not CANONICAL.fullmatch(source.name):
                problems.append(f"UNRECOGNIZED AUDIO (left untouched): {source.name}")
            continue
        if source.is_symlink() or not source.is_file():
            problems.append(f"UNSAFE INPUT: {source.name} is not a regular file")
            continue
        group, number, variant, seed, ext = match.groups()
        target = folder / f"{group.lower()}_{number}{variant.lower()}.{ext.lower()}"
        if target.name.casefold() in existing:
            problems.append(f"COLLISION: {source.name} -> {target.name} already exists")
        if target.name.casefold() in targets:
            problems.append(f"COLLISION: multiple source files map to {target.name}")
        targets.add(target.name.casefold())
        plan.append((source, target))
    return plan, problems


def move_no_replace(source: Path, target: Path) -> None:
    """Windows rename refuses overwrite; POSIX uses atomic hard-link creation first.
    There is no copy/re-encoding and an existing destination is never replaced.
    """
    if os.name == "nt":
        os.rename(source, target)
    else:
        os.link(source, target, follow_symlinks=False)
        try:
            source.unlink()
        except BaseException:
            target.unlink(missing_ok=True)
            raise


def inventory(folder: Path, report: Reporter) -> None:
    missing = [f"{id}.{ext}" for id in TRACK_IDS for ext in ("opus", "m4a")
               if not (folder / f"{id}.{ext}").is_file()]
    report.log(f"Canonical inventory: {40 - len(missing)}/40 present.")
    if missing:
        report.log("Missing: " + ", ".join(missing))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Actually rename. Without this flag: preview only.")
    parser.add_argument("--audio-dir", type=Path, default=ROOT / "audio")
    args = parser.parse_args()
    folder = args.audio_dir.resolve()
    try:
        with Reporter(ROOT, "rename-audio") as report, run_lock(ROOT, "rename-audio"):
            plan, problems = build_plan(folder)
            report.log(f"Audio directory: {folder}")
            for source, target in plan:
                report.log(f"{source.name} -> {target.name}")
            for problem in problems:
                report.log(problem)
            collisions = [p for p in problems if not p.startswith("UNRECOGNIZED")]
            report.log(f"Plan: {len(plan)} rename(s), {len(collisions)} blocking conflict(s).")
            if collisions:
                report.log("Nothing renamed. Resolve the conflicts first; no files were overwritten.")
                return 2
            if not args.apply:
                report.log("PREVIEW ONLY. Run with --apply to rename. Audio bytes were not changed.")
                return 0
            if not plan:
                report.log("Nothing to rename. Already-renamed files are kept.")
                inventory(folder, report)
                return 0
            completed: list[tuple[Path, Path]] = []
            journal = ROOT / ".runtime" / "rename-journal.json"
            records = []
            with report.phase("Hashing source files before rename"):
                for source, target in plan:
                    records.append({"from": str(source), "to": str(target), "sha256": digest_file(source), "done": False})
            state = {"createdAt": utc_now(), "state": "planned", "files": records}
            atomic_json(journal, state)
            try:
                for index, ((source, target), item) in enumerate(zip(plan, records), 1):
                    # Recheck immediately before moving. The operation itself also refuses overwrite.
                    if target.exists():
                        raise FileExistsError(f"Destination appeared during rename: {target}")
                    if digest_file(source) != item["sha256"]:
                        raise RuntimeError(f"Source changed during rename: {source.name}")
                    move_no_replace(source, target)
                    completed.append((source, target))
                    if digest_file(target) != item["sha256"]:
                        raise RuntimeError(f"Post-rename verification failed: {target.name}")
                    item["done"] = True
                    state["state"] = "running"
                    atomic_json(journal, state)
                    report.log(f"[{index}/{len(plan)}] Renamed + verified: {target.name}")
            except BaseException:
                report.log("Rename interrupted/failed. Attempting rollback of completed renames.")
                rollback_errors = []
                for source, target in reversed(completed):
                    try:
                        move_no_replace(target, source)
                        report.log(f"Restored: {source.name}")
                    except OSError as error:
                        rollback_errors.append(str(error))
                state["state"] = "rollback-incomplete" if rollback_errors else "rolled-back"
                state["rollbackErrors"] = rollback_errors
                atomic_json(journal, state)
                raise
            state["state"] = "completed"
            atomic_json(journal, state)
            report.log(f"SUCCESS: {len(completed)} files renamed; audio content hashes unchanged.")
            inventory(folder, report)
            report.log(f"Journal: {journal}")
        return 0
    except KeyboardInterrupt:
        print("Cancelled. See .runtime/logs and rename-journal.json for the last completed operation.")
        return 130
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
