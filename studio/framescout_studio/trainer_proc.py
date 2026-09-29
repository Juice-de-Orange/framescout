"""Run training/export as subprocesses and stream structured progress.

Wraps ``python -m framescout_trainer.train`` / ``export_onnx`` so the
GPU work runs out-of-process (isolated, cancellable) while the studio
server streams progress to the UI. A single job runs at a time.
"""

from __future__ import annotations

import re
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue

_EPOCH_RE = re.compile(r"epoch\s+(\d+)\s*/\s*(\d+).*?val_top1=([0-9.]+)")
_SHA_RE = re.compile(r"sha256:\s*([0-9a-f]{64})")
_DIM_RE = re.compile(r"embedding_dim.*?:\s*(\d+)")


@dataclass
class Progress:
    kind: str  # 'log' | 'epoch' | 'done' | 'error' | 'sha'
    line: str = ""
    epoch: int | None = None
    total: int | None = None
    val_top1: float | None = None
    sha256: str | None = None
    embedding_dim: int | None = None


@dataclass
class _Job:
    proc: subprocess.Popen[str]
    kind: str = "train"  # 'train' | 'export'
    queue: "Queue[Progress | None]" = field(default_factory=Queue)


class TrainerProc:
    def __init__(self) -> None:
        self._job: _Job | None = None
        self._lock = threading.Lock()
        # Last-known progress so /api/train/status can restore the panel
        # after a page reload mid-run.
        self._phase = "idle"  # 'idle' | 'running' | 'done' | 'error'
        self._last_epoch: int | None = None
        self._last_total: int | None = None
        self._last_val: float | None = None
        self._last_sha: str | None = None
        # Fired (in a daemon thread) after a successful *training* run only —
        # the auto-deploy chain hooks here. Not fired for export jobs.
        self._on_train_done: Callable[[], None] | None = None

    def set_on_train_done(self, cb: Callable[[], None] | None) -> None:
        self._on_train_done = cb

    @property
    def running(self) -> bool:
        return self._job is not None and self._job.proc.poll() is None

    def status(self) -> dict[str, object]:
        running = self.running
        out: dict[str, object] = {
            "phase": "running" if running else self._phase,
            "running": running,
        }
        if self._last_epoch is not None:
            out["lastEpoch"] = self._last_epoch
        if self._last_total is not None:
            out["lastTotal"] = self._last_total
        if self._last_val is not None:
            out["lastValTop1"] = self._last_val
        if self._last_sha is not None:
            out["lastSha"] = self._last_sha
        return out

    def start_train(self, data_dir: Path, out_dir: Path, **opts: object) -> None:
        args = [
            sys.executable, "-m", "framescout_trainer.train",
            "--data", str(data_dir), "--out", str(out_dir),
        ]
        for k, v in opts.items():
            flag = "--" + k.replace("_", "-")
            if isinstance(v, bool):
                if v:
                    args.append(flag)
            else:
                args += [flag, str(v)]
        self._spawn(args)

    def start_export(self, run_dir: Path, out_dir: Path) -> None:
        self._spawn([
            sys.executable, "-m", "framescout_trainer.export_onnx",
            "--run", str(run_dir), "--out", str(out_dir),
        ], kind="export")

    def _spawn(self, args: list[str], kind: str = "train") -> None:
        with self._lock:
            if self.running:
                raise RuntimeError("a job is already running")
            proc = subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                bufsize=1,
            )
            job = _Job(proc=proc, kind=kind)
            self._job = job
            self._phase = "running"
            self._last_epoch = None
            self._last_total = None
            self._last_val = None
        threading.Thread(target=self._pump, args=(job,), daemon=True).start()

    def _pump(self, job: _Job) -> None:
        assert job.proc.stdout is not None
        for raw in job.proc.stdout:
            line = raw.rstrip("\n")
            prog = _parse(line)
            self._observe(prog)
            job.queue.put(prog)
        code = job.proc.wait()
        self._phase = "done" if code == 0 else "error"
        job.queue.put(
            Progress(kind="done" if code == 0 else "error", line=f"exit {code}")
        )
        job.queue.put(None)  # sentinel
        # Auto-deploy hook: only after a *successful training* run (export
        # jobs must not re-trigger it). Runs detached so it can spawn the
        # export job without blocking this pump.
        if job.kind == "train" and code == 0 and self._on_train_done is not None:
            threading.Thread(target=self._on_train_done, daemon=True).start()

    def _observe(self, prog: Progress) -> None:
        """Record last-known progress for status() reconnects."""
        if prog.kind == "epoch":
            self._last_epoch = prog.epoch
            self._last_total = prog.total
            self._last_val = prog.val_top1
        elif prog.kind == "sha" and prog.sha256:
            self._last_sha = prog.sha256

    def stream(self) -> Iterator[Progress]:
        """Yield progress events for the active job until it ends."""
        job = self._job
        if job is None:
            return
        while True:
            item = job.queue.get()
            if item is None:
                break
            yield item

    def cancel(self) -> None:
        job = self._job
        if job is None or job.proc.poll() is not None:
            return
        job.proc.terminate()
        try:
            job.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            job.proc.kill()


def _parse(line: str) -> Progress:
    m = _EPOCH_RE.search(line)
    if m:
        return Progress(
            kind="epoch", line=line,
            epoch=int(m.group(1)), total=int(m.group(2)),
            val_top1=float(m.group(3)),
        )
    sha = _SHA_RE.search(line)
    if sha:
        dim = _DIM_RE.search(line)
        return Progress(
            kind="sha", line=line, sha256=sha.group(1),
            embedding_dim=int(dim.group(1)) if dim else None,
        )
    return Progress(kind="log", line=line)
