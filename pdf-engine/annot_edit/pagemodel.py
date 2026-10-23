"""Page analysis: text blocks, vertical bands, columns, fonts, header/footer zones, quote lookup."""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import fitz

from .util import EditError, norm_text

BAND_GAP_TOLERANCE = 1.0
SERIF_NAME_RE = re.compile(r"(times|serif|roman|libertin|palatino|georgia|garamond|cmr|minion|book|century|charter)", re.I)
SANS_NAME_RE = re.compile(r"(sans|arial|helvet|calibri|carlito|verdana|tahoma|myriad|cmss)", re.I)


@dataclass
class TextBlock:
    index: int
    rect: fitz.Rect
    text: str
    size: float
    serif: bool
    font: str
    line_count: int
    line_pitch: float
    bold: bool
    zone: str = "body"  # body | header | footer


@dataclass
class Band:
    y0: float
    y1: float
    x0: float
    x1: float
    kinds: set = field(default_factory=set)
    block_indexes: List[int] = field(default_factory=list)

    @property
    def rect(self) -> fitz.Rect:
        return fitz.Rect(self.x0, self.y0, self.x1, self.y1)

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass
class PageProfile:
    width: float
    height: float
    body_size: float
    serif: bool
    line_ratio: float
    left: float
    right: float
    top_margin: float
    bottom_limit: float
    header_bottom: Optional[float]
    footer_top: Optional[float]
    columns: int
    blocks: List[TextBlock]
    bands: List[Band]
    rotation: int

    @property
    def content_width(self) -> float:
        return self.right - self.left

    def body_blocks(self) -> List[TextBlock]:
        return [b for b in self.blocks if b.zone == "body"]


def _is_serif(font: str, flags: int) -> bool:
    if SANS_NAME_RE.search(font or ""):
        return False
    if SERIF_NAME_RE.search(font or ""):
        return True
    return bool(flags & 4)


def _extract_blocks(page: fitz.Page) -> Tuple[List[TextBlock], List[fitz.Rect]]:
    data = page.get_text("dict")
    blocks: List[TextBlock] = []
    image_rects: List[fitz.Rect] = []
    for raw in data.get("blocks", []):
        rect = fitz.Rect(raw["bbox"])
        if raw.get("type") == 1:
            image_rects.append(rect)
            continue
        lines = raw.get("lines", [])
        chars = 0
        size_weights: Dict[float, int] = {}
        fonts: Dict[str, int] = {}
        serif_votes = 0
        bold_votes = 0
        pitches: List[float] = []
        previous_y: Optional[float] = None
        pieces: List[str] = []
        for line in lines:
            line_text = "".join(span.get("text", "") for span in line.get("spans", []))
            pieces.append(line_text)
            y = line["bbox"][1]
            if previous_y is not None and y - previous_y > 1:
                pitches.append(y - previous_y)
            previous_y = y
            for span in line.get("spans", []):
                n = len(span.get("text", "").strip())
                if n == 0:
                    continue
                chars += n
                size = round(float(span.get("size", 10)) * 2) / 2
                size_weights[size] = size_weights.get(size, 0) + n
                font = span.get("font", "")
                fonts[font] = fonts.get(font, 0) + n
                if _is_serif(font, span.get("flags", 0)):
                    serif_votes += n
                if span.get("flags", 0) & 16 or re.search(r"bold|black|heavy", font, re.I):
                    bold_votes += n
        if chars == 0:
            continue
        size = max(size_weights.items(), key=lambda kv: kv[1])[0]
        font = max(fonts.items(), key=lambda kv: kv[1])[0]
        blocks.append(TextBlock(
            index=len(blocks), rect=rect, text="\n".join(pieces), size=size,
            serif=serif_votes * 2 >= chars, font=font, line_count=len(lines),
            line_pitch=statistics.median(pitches) if pitches else size * 1.2,
            bold=bold_votes * 2 >= chars,
        ))
    return blocks, image_rects


def _drawing_rects(page: fitz.Page) -> List[fitz.Rect]:
    rects: List[fitz.Rect] = []
    page_area = page.rect.width * page.rect.height
    try:
        drawings = page.get_drawings()
    except Exception:
        return rects
    for item in drawings:
        r = fitz.Rect(item["rect"])
        if r.is_infinite:
            continue
        if r.width * r.height > 0.85 * page_area:
            continue  # page background
        if r.height < 0.5:
            r.y1 = r.y0 + 0.5
        if r.width < 0.5:
            r.x1 = r.x0 + 0.5
        rects.append(r)
    return rects


def _merge_bands(items: List[Tuple[fitz.Rect, str, Optional[int]]]) -> List[Band]:
    bands: List[Band] = []
    for rect, kind, block_index in sorted(items, key=lambda it: (it[0].y0, it[0].x0)):
        if bands and rect.y0 <= bands[-1].y1 + BAND_GAP_TOLERANCE:
            band = bands[-1]
            band.y1 = max(band.y1, rect.y1)
            band.x0 = min(band.x0, rect.x0)
            band.x1 = max(band.x1, rect.x1)
            band.kinds.add(kind)
            if block_index is not None:
                band.block_indexes.append(block_index)
        else:
            bands.append(Band(rect.y0, rect.y1, rect.x0, rect.x1, {kind},
                              [block_index] if block_index is not None else []))
    return bands


def _detect_columns(blocks: List[TextBlock], width: float) -> int:
    body = [b for b in blocks if b.zone == "body" and len(b.text.strip()) >= 40]
    mid = width / 2
    left = [b for b in body if b.rect.x1 < mid + width * 0.02]
    right = [b for b in body if b.rect.x0 > mid - width * 0.02]
    spanning = [b for b in body if b.rect.x0 < mid - width * 0.05 and b.rect.x1 > mid + width * 0.05]
    if len(left) >= 2 and len(right) >= 2:
        for lb in left:
            for rb in right:
                overlap = min(lb.rect.y1, rb.rect.y1) - max(lb.rect.y0, rb.rect.y0)
                if overlap > 12 and len(spanning) <= max(1, len(body) // 4):
                    return 2
    return 1


def analyze_page(page: fitz.Page) -> PageProfile:
    width, height = page.rect.width, page.rect.height
    blocks, image_rects = _extract_blocks(page)

    size_weights: Dict[float, int] = {}
    serif_chars = total_chars = 0
    for b in blocks:
        n = len(b.text.strip())
        size_weights[b.size] = size_weights.get(b.size, 0) + n
        total_chars += n
        if b.serif:
            serif_chars += n
    body_size = max(size_weights.items(), key=lambda kv: kv[1])[0] if size_weights else 11.0
    serif = serif_chars * 2 >= total_chars if total_chars else False

    for b in blocks:
        text = b.text.strip()
        if b.line_count == 1 and len(text) <= 80 and b.rect.y1 <= 0.10 * height:
            b.zone = "header"
        elif b.line_count == 1 and len(text) <= 60 and b.rect.y0 >= 0.90 * height:
            b.zone = "footer"

    items: List[Tuple[fitz.Rect, str, Optional[int]]] = []
    for b in blocks:
        if b.zone == "body":
            items.append((b.rect, "text", b.index))
    for r in image_rects:
        items.append((r, "image", None))
    has_footer = any(b.zone == "footer" for b in blocks)
    for r in _drawing_rects(page):
        if r.y1 < 0.10 * height and not any(b.zone == "body" and b.rect.y0 < r.y1 for b in blocks):
            continue
        if r.y0 > 0.90 * height and has_footer:
            continue
        items.append((r, "draw", None))
    bands = _merge_bands(items)

    body_candidates = [b for b in blocks if b.zone == "body" and abs(b.size - body_size) <= 0.5 and len(b.text.strip()) >= 60]
    if body_candidates:
        xs0 = sorted(b.rect.x0 for b in body_candidates)
        xs1 = sorted(b.rect.x1 for b in body_candidates)
        left = xs0[0]
        right = xs1[-1]
    else:
        left, right = width * 0.1, width * 0.9

    ratios = [b.line_pitch / b.size for b in body_candidates if b.line_count > 1 and b.size > 0]
    line_ratio = statistics.median(ratios) if ratios else 1.25
    line_ratio = max(1.1, min(1.8, line_ratio))

    header_blocks = [b for b in blocks if b.zone == "header"]
    footer_blocks = [b for b in blocks if b.zone == "footer"]
    header_bottom = max((b.rect.y1 for b in header_blocks), default=None)
    footer_top = min((b.rect.y0 for b in footer_blocks), default=None)

    body_ys = [b.rect.y0 for b in blocks if b.zone == "body"]
    top_margin = min(body_ys) if body_ys else 0.08 * height
    top_margin = max(0.05 * height, min(0.12 * height, top_margin))
    body_bottom = max((band.y1 for band in bands), default=height * 0.9)
    bottom_margin = max(0.05 * height, min(0.10 * height, height - body_bottom))
    bottom_limit = height - bottom_margin
    if footer_top is not None:
        bottom_limit = min(bottom_limit, footer_top - 0.8 * body_size)

    return PageProfile(
        width=width, height=height, body_size=body_size, serif=serif, line_ratio=line_ratio,
        left=left, right=right, top_margin=top_margin, bottom_limit=bottom_limit,
        header_bottom=header_bottom, footer_top=footer_top,
        columns=_detect_columns(blocks, width), blocks=blocks, bands=bands, rotation=page.rotation,
    )


# ── quote lookup ────────────────────────────────────────────────────────────

def _token_matches(page: fitz.Page, quote: str) -> List[List[fitz.Rect]]:
    qtokens = norm_text(quote).split(" ")
    if not qtokens or qtokens == [""]:
        return []
    words = page.get_text("words")
    words.sort(key=lambda w: (w[5], w[6], w[7]))
    tokens = [norm_text(w[4]) for w in words]
    hits: List[List[fitz.Rect]] = []
    n = len(qtokens)
    i = 0
    while i + n <= len(tokens):
        if tokens[i:i + n] == qtokens:
            hits.append([fitz.Rect(w[:4]) for w in words[i:i + n]])
            i += n
        else:
            i += 1
    return hits


def find_quote(page: fitz.Page, quote: str, profile: Optional[PageProfile] = None) -> Optional[Dict[str, Any]]:
    """Locate a quote on a page. Returns {rects, rect, count, approx} or None if absent."""
    if len(norm_text(quote)) < 3:
        raise EditError("quote_too_short", f"Quote '{quote}' is too short to locate reliably; quote at least a few words.")
    hits = _token_matches(page, quote)
    if hits:
        rects = hits[0]
        union = fitz.Rect(rects[0])
        for r in rects[1:]:
            union |= r
        return {"rects": rects, "rect": union, "count": len(hits), "approx": False}

    qn = norm_text(quote)
    page_norm = norm_text(page.get_text())
    if qn in page_norm:
        profile = profile or analyze_page(page)
        for b in profile.blocks:
            if qn in norm_text(b.text):
                return {"rects": [b.rect], "rect": fitz.Rect(b.rect), "count": page_norm.count(qn), "approx": True}
    return None


def locate_unique_quote(page: fitz.Page, quote: str, profile: Optional[PageProfile] = None) -> Dict[str, Any]:
    found = find_quote(page, quote, profile)
    if not found:
        raise EditError("quote_not_found", f"Quote not found on the page: \"{quote[:80]}\". Quote text exactly as it appears in the PDF.")
    if found["count"] > 1:
        raise EditError("quote_ambiguous", f"Quote appears {found['count']} times on the page: \"{quote[:80]}\". Quote a longer, unique passage.")
    return found


def block_for_rect(profile: PageProfile, rect: fitz.Rect) -> Optional[TextBlock]:
    best: Optional[TextBlock] = None
    best_area = 0.0
    for b in profile.blocks:
        inter = fitz.Rect(b.rect) & rect
        area = 0.0 if inter.is_empty else inter.width * inter.height
        if area > best_area:
            best, best_area = b, area
    return best


def band_for_rect(profile: PageProfile, rect: fitz.Rect) -> Optional[Band]:
    cy = (rect.y0 + rect.y1) / 2
    for band in profile.bands:
        if band.y0 - 0.5 <= cy <= band.y1 + 0.5:
            return band
    return None


def block_text(block: TextBlock) -> str:
    """Block text as one paragraph (line breaks removed, hyphenated breaks re-joined)."""
    text = re.sub(r"-\n(?=[a-z])", "", block.text)
    return re.sub(r"\s*\n\s*", " ", text).strip()
