"""Project-local paths, atomic output, and progress logs (standard library only)."""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[1]
TRACK_IDS = tuple(f"{source}_{number}{variant}" for source in ("chatgpt", "gemini")
                  for number in range(1, 6) for variant in ("a", "b"))


def atomic_text(path: Path, text: str) -> None:
    """Never leave a truncated JSON/TXT if interrupted, including on OneDrive."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(.25 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path: Path, obj: Any) -> None:
    atomic_text(path, json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def digest_object(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode("utf-8")).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def project_environment(root: Path) -> dict[str, str]:
    """Keep caches/temp data out of the user's profile and other AI environments."""
    env = dict(os.environ)
    runtime = root / ".runtime"
    folders = {
        "XDG_CACHE_HOME": runtime / "cache",
        "HF_HOME": runtime / "models" / "huggingface",
        "TORCH_HOME": runtime / "models" / "torch",
        "TIKTOKEN_CACHE_DIR": runtime / "cache" / "tiktoken",
        "NUMBA_CACHE_DIR": runtime / "cache" / "numba",
        "PIP_CACHE_DIR": runtime / "cache" / "pip",
        "TMP": runtime / "tmp", "TEMP": runtime / "tmp", "TMPDIR": runtime / "tmp",
    }
    for key, folder in folders.items():
        folder.mkdir(parents=True, exist_ok=True)
        env[key] = str(folder)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    ffmpeg_bin = root / "tools" / "ffmpeg" / "bin"
    env["PATH"] = str(ffmpeg_bin) + os.pathsep + env.get("PATH", "")
    return env


def venv_python(root: Path = ROOT) -> Path:
    return root / ".venv-lyrics" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


@contextlib.contextmanager
def run_lock(root: Path, name: str) -> Iterator[None]:
    lock = root / ".runtime" / f"{name}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(f"PID={os.getpid()}\nStarted={utc_now()}\n")
    except FileExistsError as exc:
        raise RuntimeError(f"Another {name} run may be active. Lock: {lock}\n"
                           "After a forced process termination, first confirm no run is active, "
                           "then delete ONLY this lock file and retry.") from exc
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


class Reporter:
    """Flush progress to terminal + a local log, including a 10-second heartbeat."""
    def __init__(self, root: Path, name: str):
        folder = root / ".runtime" / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / f"{dt.datetime.now():%Y%m%d-%H%M%S}-{name}-{os.getpid()}.log"
        self.stream = self.path.open("a", encoding="utf-8", buffering=1)
        self.started = time.monotonic()
        self.operation = "Preparing"
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()
        self.log(f"Log: {self.path}")

    def log(self, text: str) -> None:
        with self.lock:
            line = f"[{time.monotonic() - self.started:8.1f}s] {text}"
            try:
                print(line, flush=True)
            except UnicodeEncodeError:
                print(line.encode(sys.stdout.encoding or "ascii", "replace").decode(sys.stdout.encoding or "ascii"), flush=True)
            self.stream.write(line + "\n")

    def _heartbeat(self) -> None:
        while not self.stop.wait(10):
            self.log(f"Still working: {self.operation}")

    @contextlib.contextmanager
    def phase(self, text: str) -> Iterator[None]:
        previous, self.operation = self.operation, text
        began = time.monotonic()
        self.log(text)
        try:
            yield
        finally:
            self.log(f"Phase finished ({time.monotonic() - began:.1f}s): {text}")
            self.operation = previous

    def command(self, args: list[str], *, env: dict[str, str] | None = None,
                cwd: Path | None = None) -> None:
        self.log("Command: " + subprocess.list2cmdline(args))
        process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        try:
            assert process.stdout is not None
            for line in process.stdout:
                self.log(line.rstrip("\r\n"))
            code = process.wait()
            if code:
                raise RuntimeError(f"Command failed with exit code {code}.")
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            raise
        finally:
            if process.stdout:
                process.stdout.close()

    def close(self) -> None:
        self.stop.set()
        self.thread.join(timeout=2)
        self.log("Finished.")
        self.stream.close()

    def __enter__(self) -> Reporter:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc is not None:
            self.log(f"ERROR: {exc}")
        self.close()
