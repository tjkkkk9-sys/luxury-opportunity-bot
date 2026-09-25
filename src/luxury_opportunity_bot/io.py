from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable

from .domain import Opportunity, ValidationError


def load_opportunities(path: str | Path) -> list[Opportunity]:
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"file non trovato: {file_path}")
    try:
        if file_path.suffix.lower() == ".json":
            raw = json.loads(file_path.read_text(encoding="utf-8"))
        elif file_path.suffix.lower() == ".csv":
            with file_path.open(newline="", encoding="utf-8-sig") as stream:
                raw = list(csv.DictReader(stream))
        else:
            raise ValidationError("il file deve avere estensione .json o .csv")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValidationError(f"formato file non valido: {exc}") from exc
    if not isinstance(raw, list):
        raise ValidationError("il JSON deve contenere una lista di opportunità")
    return [Opportunity.from_dict(item) for item in raw]


def eligible(opportunities: Iterable[Opportunity], min_profit: float, min_roi: float,
             allowed_brands: set[str] | None = None) -> list[Opportunity]:
    return [item for item in opportunities
            if item.net_profit >= min_profit and item.roi_percent >= min_roi
            and (not allowed_brands or item.brand.lower() in allowed_brands)]
