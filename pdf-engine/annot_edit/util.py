"""Shared helpers: text normalisation, issues, errors."""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional

_DASHES = {
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "−": "-", "­": "",
}
_QUOTES = {"‘": "'", "’": "'", "“": '"', "”": '"', " ": " "}


def norm_text(value: str) -> str:
    """Normalise text for quote matching: ligatures, dashes, quotes, hyphenated line breaks, case, whitespace."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKC", value)
    text = re.sub(r"-\s*\n\s*", "", text)
    for src, dst in list(_DASHES.items()) + list(_QUOTES.items()):
        text = text.replace(src, dst)
    text = re.sub(r"\s+", " ", text)
    return text.strip().casefold()


def words_of(value: str) -> List[str]:
    return re.findall(r"[^\W_]+(?:'[^\W_]+)?", norm_text(value), flags=re.UNICODE)


class EditError(Exception):
    """A problem that makes the whole edit unsafe. Carries a machine code for the repair loop."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra

    def as_issue(self) -> Dict[str, Any]:
        issue = {"severity": "error", "code": self.code, "message": self.message}
        issue.update(self.extra)
        return issue


def issue(severity: str, code: str, message: str, **extra: Any) -> Dict[str, Any]:
    out = {"severity": severity, "code": code, "message": message}
    out.update(extra)
    return out


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def first(items: List[Any], default: Optional[Any] = None) -> Any:
    return items[0] if items else default


def area(rect: Any) -> float:
    """Area of a fitz.Rect (0 for empty / inverted rects)."""
    if rect.is_empty or rect.is_infinite:
        return 0.0
    return float(rect.width * rect.height)
