"""Export a trained checkpoint to a two-output ONNX + labels.json.

    python -m framescout_trainer.export_onnx --run ./runs/v1 --out ./dist

Produces:
  <out>/model.onnx    outputs: embedding (D, L2), logits (numClasses)
  <out>/labels.json   index → species name (read by the inference server)

After export it runs an onnxruntime smoke inference, asserts the output
shapes, and prints the SHA-256 to pin in
`packages/core/src/models/registry.ts`
(`framescout-classifier-v1`). Opset is pinned for reproducibility.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import onnxruntime as ort
import torch

from .model import ExportWrapper, SpeciesEmbedNet

OPSET = 17


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, type=Path, help="dir with model.pt + meta.json")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    meta = json.loads((args.run / "meta.json").read_text())
    net = SpeciesEmbedNet(
        num_classes=meta["num_classes"],
        num_individuals=meta["num_individuals"],
        backbone=meta["backbone"],
        embedding_dim=meta["embedding_dim"],
        pretrained=False,
    )
    # weights_only=True: otherwise `torch.load` is a full pickle load and runs
    # arbitrary code from the checkpoint. The switch is only effective from
    # torch 2.6.0 on (CVE-2025-32434 bypassed it before), hence the pin.
    net.load_state_dict(
        torch.load(args.run / "model.pt", map_location="cpu", weights_only=True)
    )
    net.eval()
    wrapper = ExportWrapper(net).eval()

    args.out.mkdir(parents=True, exist_ok=True)
    onnx_path = args.out / "model.onnx"
    dummy = torch.zeros(1, 3, meta["input_size"], meta["input_size"])
    torch.onnx.export(
        wrapper,
        dummy,
        str(onnx_path),
        input_names=["input"],
        output_names=["embedding", "logits"],
        dynamic_axes={
            "input": {0: "batch"},
            "embedding": {0: "batch"},
            "logits": {0: "batch"},
        },
        opset_version=OPSET,
    )

    # Smoke-run + shape assertions (catches a broken export immediately).
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    out = {o.name: o for o in sess.get_outputs()}
    assert "embedding" in out and "logits" in out, f"missing outputs: {list(out)}"
    emb, logits = sess.run(["embedding", "logits"], {"input": dummy.numpy()})
    assert emb.shape == (1, meta["embedding_dim"]), emb.shape
    assert logits.shape == (1, meta["num_classes"]), logits.shape

    (args.out / "labels.json").write_text(json.dumps(meta["labels"]))
    sha = _sha256(onnx_path)
    print(f"exported {onnx_path}")
    print(f"labels:  {args.out / 'labels.json'}  ({meta['num_classes']} classes)")
    print(f"embedding_dim (outputDim): {meta['embedding_dim']}")
    print(f"sha256: {sha}")
    print(
        "→ pin url+sha+labels in packages/core/src/models/registry.ts "
        "(framescout-classifier-v1)"
    )


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    main()
