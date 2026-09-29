"""The fine-tuned network: a timm backbone with an L2-normalised
embedding output and a species classification head, plus an optional
individual head used only during training to shape the embedding so it
separates named individuals (Tulli/Lizzy).

At inference only two outputs matter — ``embedding`` (for centroid
matching) and ``logits`` (species). The individual head is dropped on
export; new individuals are added at runtime via centroids without
retraining.
"""

from __future__ import annotations

import timm
import torch
import torch.nn.functional as F
from torch import nn


class SpeciesEmbedNet(nn.Module):
    def __init__(
        self,
        *,
        num_classes: int,
        num_individuals: int = 0,
        backbone: str = "convnextv2_tiny",
        embedding_dim: int | None = None,
        pretrained: bool = True,
    ) -> None:
        super().__init__()
        self.backbone = timm.create_model(
            backbone, pretrained=pretrained, num_classes=0
        )
        feat = self.backbone.num_features
        self.embedding_dim = embedding_dim or feat
        self.proj = (
            nn.Identity()
            if self.embedding_dim == feat
            else nn.Linear(feat, self.embedding_dim)
        )
        self.species_head = nn.Linear(self.embedding_dim, num_classes)
        self.individual_head = (
            nn.Linear(self.embedding_dim, num_individuals)
            if num_individuals > 0
            else None
        )

    def embed(self, x: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.proj(self.backbone(x)), dim=1)

    def forward(
        self, x: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor | None]:
        emb = self.embed(x)
        logits = self.species_head(emb)
        ind_logits = (
            self.individual_head(emb) if self.individual_head is not None else None
        )
        return emb, logits, ind_logits


class ExportWrapper(nn.Module):
    """ONNX export view: returns exactly ``(embedding, logits)`` so the
    graph has the two named outputs the inference server expects."""

    def __init__(self, net: SpeciesEmbedNet) -> None:
        super().__init__()
        self.net = net

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        emb = self.net.embed(x)
        logits = self.net.species_head(emb)
        return emb, logits
