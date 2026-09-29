"""Local authoritative dataset store on the main PC.

Writes the exact on-disk format the trainer reads
(``framescout_trainer.dataset.load_samples``): ``<species>/<hash>.jpg``
+ ``manifest.jsonl`` lines ``{path, species, individual?, observationId?,
labeledAt}``.

Two ledgers make the studio resilient to the daemon being briefly offline:
 - ``.studio/done.jsonl`` — daemon queue hashes already labeled here, so a
   desync never double-labels;
 - ``.studio/outbox.jsonl`` — intended daemon marks not yet acknowledged
   (the daemon was offline); a flusher drains them when the daemon is reachable.
No image is ever lost: it is written locally before the daemon mark.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

_LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.IGNORECASE)


class InvalidLabel(ValueError):
    pass


def _assert_label(kind: str, value: str) -> None:
    if not _LABEL_RE.match(value):
        raise InvalidLabel(f"invalid {kind} label {value!r}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class OutboxEntry:
    queue_hash: str
    action: str  # 'label' | 'skip'
    species: str | None = None
    individual: str | None = None


class Store:
    def __init__(self, dataset_dir: Path) -> None:
        self.dataset_dir = Path(dataset_dir)
        self._state_dir = self.dataset_dir / ".studio"
        self._manifest = self.dataset_dir / "manifest.jsonl"
        self._done = self._state_dir / "done.jsonl"
        self._outbox = self._state_dir / "outbox.jsonl"
        self._state_dir.mkdir(parents=True, exist_ok=True)
        # Cached done-ledger — the studio polls /api/queue on a timer, so
        # re-reading the whole file each poll would get hot. Loaded once,
        # then kept in sync by mark_done (append-only ledger).
        self._done_cache: set[str] | None = None

    # ── dataset writing ─────────────────────────────────────────────
    def write_label(
        self,
        jpeg: bytes,
        species: str,
        individual: str | None = None,
        observation_id: str | None = None,
    ) -> str:
        _assert_label("species", species)
        if individual is not None:
            _assert_label("individual", individual)
        hash_ = hashlib.sha256(jpeg).hexdigest()[:16]
        species_dir = self.dataset_dir / species
        species_dir.mkdir(parents=True, exist_ok=True)
        (species_dir / f"{hash_}.jpg").write_bytes(jpeg)
        rec: dict[str, object] = {
            "path": f"{species}/{hash_}.jpg",
            "species": species,
        }
        if individual is not None:
            rec["individual"] = individual
        if observation_id is not None:
            rec["observationId"] = observation_id
        rec["labeledAt"] = _now()
        with self._manifest.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        return f"{species}/{hash_}.jpg"

    # ── done ledger ─────────────────────────────────────────────────
    def mark_done(self, queue_hash: str) -> None:
        with self._done.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"hash": queue_hash, "at": _now()}) + "\n")
        if self._done_cache is not None:
            self._done_cache.add(queue_hash)

    def done_hashes(self) -> set[str]:
        if self._done_cache is not None:
            return self._done_cache
        out: set[str] = set()
        if self._done.exists():
            for line in self._done.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    out.add(json.loads(line)["hash"])
                except (json.JSONDecodeError, KeyError):
                    continue
        self._done_cache = out
        return out

    # ── outbox (deferred daemon marks) ─────────────────────────────────
    def enqueue_outbox(self, entry: OutboxEntry) -> None:
        with self._outbox.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry.__dict__) + "\n")

    def read_outbox(self) -> list[OutboxEntry]:
        if not self._outbox.exists():
            return []
        out: list[OutboxEntry] = []
        for line in self._outbox.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(OutboxEntry(**json.loads(line)))
            except (json.JSONDecodeError, TypeError):
                continue
        return out

    def rewrite_outbox(self, entries: list[OutboxEntry]) -> None:
        tmp = self._outbox.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(e.__dict__) + "\n" for e in entries))
        tmp.replace(self._outbox)

    # ── stats ───────────────────────────────────────────────────────
    def stats(self) -> dict[str, object]:
        by_species: dict[str, int] = {}
        by_individual: dict[str, int] = {}
        total = 0
        if self._manifest.exists():
            for line in self._manifest.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Skip orphaned entries whose crop file was deleted, so the
                # counts match what training/centroids actually see.
                p = Path(rec.get("path", ""))
                fp = p if p.is_absolute() else self.dataset_dir / p
                if not fp.exists():
                    continue
                total += 1
                sp = rec.get("species")
                if sp:
                    by_species[sp] = by_species.get(sp, 0) + 1
                ind = rec.get("individual")
                if ind:
                    by_individual[ind] = by_individual.get(ind, 0) + 1
        return {"total": total, "bySpecies": by_species, "byIndividual": by_individual}
