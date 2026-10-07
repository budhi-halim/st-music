"""Create a separate project-local lyric alignment environment, not the YuE2 env.
  python tools/setup_lyrics.py --device cuda
  python tools/setup_lyrics.py --device cpu
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from common import ROOT, Reporter, project_environment, run_lock, venv_python


def choose_python() -> list[str]:
    # Restrict this pinned preparation environment to mature wheel combinations.
    if (3, 10) <= sys.version_info[:2] <= (3, 12):
        return [sys.executable]
    candidates = [["py", "-3.11"], ["py", "-3.12"], ["py", "-3.10"]] if os.name == "nt" else [["python3.11"], ["python3.12"], ["python3.10"]]
    for command in candidates:
        if not shutil.which(command[0]):
            continue
        try:
            check = subprocess.run(command + ["-c", "import sys; assert (3,10)<=sys.version_info[:2]<=(3,12)"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if check.returncode == 0:
                return command
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise RuntimeError("Setup requires 64-bit Python 3.10, 3.11, or 3.12. Python 3.11 is recommended. "
                       "Install one of these alongside your existing Python and rerun; do not replace the YuE2 environment.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    args = parser.parse_args()
    env = project_environment(ROOT)
    device = args.device
    if device == "auto":
        device = "cuda" if shutil.which("nvidia-smi") and platform.system() != "Darwin" else "cpu"
    if device == "cuda" and platform.system() not in ("Windows", "Linux"):
        parser.error("CUDA setup is supported here on Windows/Linux only; use --device cpu")
    try:
        with Reporter(ROOT, "setup-lyrics") as report, run_lock(ROOT, "setup-lyrics"), run_lock(ROOT, "lyrics"):
            if not shutil.which("ffmpeg", path=env["PATH"]):
                raise RuntimeError("FFmpeg not found. Put your existing ffmpeg.exe on PATH, or copy it into "
                                   "tools/ffmpeg/bin/ffmpeg.exe before setup. No global settings were changed.")
            report.log(f"Target: {ROOT / '.venv-lyrics'}; compute: {device}")
            report.log("Internet is required for package/model downloads. Audio and lyrics are processed locally, not uploaded.")
            interpreter = venv_python()
            if not interpreter.is_file():
                base = choose_python()
                with report.phase("Creating an isolated Python environment"):
                    report.command(base + ["-m", "venv", str(ROOT / ".venv-lyrics")], env=env, cwd=ROOT)
            else:
                report.log("Reusing the existing project-local environment; no global package installation.")
            with report.phase("Checking the environment Python"):
                report.command([str(interpreter), "-c",
                                "import sys,struct; assert (3,10)<=sys.version_info[:2]<=(3,12), 'Recreate .venv-lyrics using Python 3.10-3.12'; assert struct.calcsize('P')==8, '64-bit Python required'; print(sys.version)"], env=env)
            pip = [str(interpreter), "-m", "pip"]
            with report.phase("Installing package tooling"):
                report.command(pip + ["install", "--upgrade", "pip", "setuptools", "wheel"], env=env, cwd=ROOT)
            index = "https://download.pytorch.org/whl/" + ("cu128" if device == "cuda" else "cpu")
            torch_cmd = pip + ["install", "torch==2.7.1", "torchaudio==2.7.1"]
            if platform.system() != "Darwin":
                torch_cmd += ["--index-url", index]
            # Force replacement only when switching wheel families. Installing a CPU
            # environment over a CUDA wheel (or vice versa) must actually switch it.
            marker = ROOT / ".venv-lyrics" / "sweet-times-device.txt"
            existing = marker.read_text().strip() if marker.is_file() else None
            if existing and existing != device:
                torch_cmd += ["--force-reinstall"]
            with report.phase(f"Installing PyTorch / torchaudio ({device})"):
                report.command(torch_cmd, env=env, cwd=ROOT)
            marker.write_text(device + "\n", encoding="utf-8")
            with report.phase("Installing pinned alignment dependencies"):
                report.command(pip + ["install", "-r", str(ROOT / "tools" / "requirements-lyrics.txt")], env=env, cwd=ROOT)
                report.command(pip + ["check"], env=env, cwd=ROOT)
            # Import/test in a subprocess without invoking lyrics.py (whose lock we hold).
            code = ("import sys; sys.path.insert(0, 'tools'); from lyrics import dependencies; "
                    "from common import Reporter, ROOT; "
                    f"r=Reporter(ROOT, 'setup-check'); dependencies(r, '{device}'); r.close()")
            with report.phase("Testing the installed packages and an actual compute operation"):
                report.command([str(interpreter), "-c", code], env=env, cwd=ROOT)
            report.log("SETUP COMPLETE. Next: python tools/lyrics.py align --track chatgpt_1a")
            report.log("The selected Whisper model downloads on first alignment. The website never requires Python.")
        return 0
    except KeyboardInterrupt:
        print("Cancelled. Rerun setup to finish the existing local environment.")
        return 130
    except (OSError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
