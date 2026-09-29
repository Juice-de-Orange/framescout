"""Store tests — verify the on-disk format matches what the trainer
reads (manifest line shape + species folder), torch-free, plus the
done-ledger and outbox resilience.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from framescout_studio.store import InvalidLabel, OutboxEntry, Store

from .conftest import tiny_jpeg


def test_write_label_produces_trainer_format(tmp_path: Path):
    store = Store(tmp_path)
    jpeg = tiny_jpeg()
    rel = store.write_label(jpeg, "domestic_cat", individual="tulli", observation_id="obs-1")

    assert rel.startswith("domestic_cat/")
    assert (tmp_path / rel).read_bytes() == jpeg
    line = json.loads((tmp_path / "manifest.jsonl").read_text().splitlines()[0])
    assert line["path"] == rel
    assert line["species"] == "domestic_cat"
    assert line["individual"] == "tulli"
    assert line["observationId"] == "obs-1"
    assert "labeledAt" in line


def test_invalid_labels_rejected(tmp_path: Path):
    store = Store(tmp_path)
    with pytest.raises(InvalidLabel):
        store.write_label(tiny_jpeg(), "../etc")
    with pytest.raises(InvalidLabel):
        store.write_label(tiny_jpeg(), "cat", individual="a/b")


def test_content_addressed_dedupe(tmp_path: Path):
    store = Store(tmp_path)
    a = store.write_label(tiny_jpeg(), "cat")
    b = store.write_label(tiny_jpeg(), "cat")
    assert a == b  # same bytes → same hash → same path


def test_done_ledger(tmp_path: Path):
    store = Store(tmp_path)
    store.mark_done("hash-a")
    store.mark_done("hash-b")
    assert store.done_hashes() == {"hash-a", "hash-b"}


def test_outbox_roundtrip(tmp_path: Path):
    store = Store(tmp_path)
    store.enqueue_outbox(OutboxEntry(queue_hash="h1", action="label", species="cat"))
    store.enqueue_outbox(OutboxEntry(queue_hash="h2", action="skip"))
    entries = store.read_outbox()
    assert [e.queue_hash for e in entries] == ["h1", "h2"]
    store.rewrite_outbox(entries[1:])
    assert [e.queue_hash for e in store.read_outbox()] == ["h2"]


def test_stats(tmp_path: Path):
    store = Store(tmp_path)
    store.write_label(b"\x01", "cat", individual="tulli")
    store.write_label(b"\x02", "cat", individual="lizzy")
    store.write_label(b"\x03", "hedgehog")
    s = store.stats()
    assert s["total"] == 3
    assert s["bySpecies"] == {"cat": 2, "hedgehog": 1}
    assert s["byIndividual"] == {"tulli": 1, "lizzy": 1}
