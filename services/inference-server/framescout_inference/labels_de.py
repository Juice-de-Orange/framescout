"""English → German species names for the ``/classify`` (legacy species-service
compatible) response. Mirrors DeepFaune's German vocabulary where the
labels overlap, so the receiving UI shows familiar names. Unknown labels
fall back to a title-cased English name.
"""

from __future__ import annotations

# Framescout taxonomy + the DeepFaune classes it may grow into.
_DE: dict[str, str] = {
    "cat": "Katze",
    "hedgehog": "Igel",
    "mouse": "Maus",
    "rat": "Ratte",
    "micromammal": "Kleinsäuger",
    "squirrel": "Eichhörnchen",
    "bird": "Vogel",
    "mustelid": "Marder",
    "marten": "Marder",
    "genet": "Ginsterkatze",
    "badger": "Dachs",
    "fox": "Fuchs",
    "wild_boar": "Wildschwein",
    "wild boar": "Wildschwein",
    "roe_deer": "Rehwild",
    "roe deer": "Rehwild",
    "red_deer": "Rothirsch",
    "red deer": "Rothirsch",
    "fallow_deer": "Damwild",
    "dog": "Hund",
    "hare": "Hase",
    "rabbit": "Kaninchen",
    "lagomorph": "Hasenartige",
    "deer": "Reh",
}


def species_de(label: str) -> str:
    key = label.strip().lower()
    if key in _DE:
        return _DE[key]
    return label.replace("_", " ").title()
