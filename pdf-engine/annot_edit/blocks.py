"""Layout items: the content blocks of an edit, measured and drawn in the host page's look."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import fitz

from .diagram import MIN_SCALE, DiagramResult, render_diagram
from .textlayout import base_css, draw_html, inline_html, measure_html, plain_text
from .util import EditError

CALLOUT_TONES = {
    "definition": {"bg": (0.93, 0.96, 0.99), "bar": (0.17, 0.36, 0.61), "title": "Definition"},
    "note": {"bg": (0.955, 0.955, 0.955), "bar": (0.45, 0.45, 0.45), "title": "Note"},
    "example": {"bg": (0.93, 0.97, 0.94), "bar": (0.18, 0.48, 0.31), "title": "Example"},
    "caution": {"bg": (0.99, 0.95, 0.88), "bar": (0.72, 0.47, 0.12), "title": "Caution"},
    "see_also": {"bg": (0.955, 0.955, 0.955), "bar": (0.45, 0.45, 0.45), "title": "See also"},
}
PROVENANCE_TEXT = "Added for clarity — explanatory material, not part of the original document"


@dataclass
class Style:
    serif: bool
    size: float
    line_ratio: float

    def css(self) -> str:
        return base_css(self.serif, self.size, self.line_ratio)


class Item:
    keep_with_next = False
    space_before = 0.0
    space_after = 0.0
    kind = "item"
    visible = ""  # reader-visible text, for validation

    def measure(self, width: float) -> float:
        raise NotImplementedError

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        raise NotImplementedError

    def split(self, width: float, avail: float) -> Optional[Tuple["Item", "Item"]]:
        return None


class HtmlItem(Item):
    def __init__(self, kind: str, html: str, css: str, visible: str, size: float,
                 before: float = 0.0, after: float = 0.0, keep_next: bool = False) -> None:
        self.kind = kind
        self.html = html
        self.css = css
        self.visible = visible
        self.size = size
        self.space_before = before
        self.space_after = after
        self.keep_with_next = keep_next
        self._height: Dict[float, float] = {}

    def measure(self, width: float) -> float:
        key = round(width, 2)
        if key not in self._height:
            self._height[key] = measure_html(self.html, self.css, width)
        return self._height[key]

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        h = self.measure(width)
        rect = fitz.Rect(x, y, x + width, y + h + 2)
        draw_html(page, rect, self.html, self.css)
        return fitz.Rect(x, y, x + width, y + h)


class ParagraphItem(HtmlItem):
    def __init__(self, markup: str, style: Style, before: float = 0.0, after: float = 0.0) -> None:
        self.markup = markup
        self.style = style
        super().__init__("paragraph", f"<div class='b'><p>{inline_html(markup)}</p></div>", style.css(),
                         plain_text(markup), style.size, before, after)

    @staticmethod
    def _balanced(text: str) -> bool:
        return (text.count("**") % 2 == 0 and text.count("{") == text.count("}")
                and len(re.findall(r"(?<!\*)\*(?!\*)", text)) % 2 == 0 and text.count("`") % 2 == 0)

    def split(self, width: float, avail: float) -> Optional[Tuple[Item, Item]]:
        words = self.markup.split(" ")
        if len(words) < 12:
            return None
        min_head = self.style.size * self.style.line_ratio * 2
        lo, hi, best = 4, len(words) - 4, None
        while lo <= hi:
            mid = (lo + hi) // 2
            head = " ".join(words[:mid])
            if self._balanced(head) and measure_html(f"<div class='b'><p>{inline_html(head)}</p></div>", self.css, width) <= avail:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if best is None:
            return None
        head_text, tail_text = " ".join(words[:best]), " ".join(words[best:])
        if measure_html(f"<div class='b'><p>{inline_html(head_text)}</p></div>", self.css, width) < min_head:
            return None
        return (ParagraphItem(head_text, self.style, self.space_before, 0.0),
                ParagraphItem(tail_text, self.style, 0.0, self.space_after))


class CalloutItem(Item):
    kind = "callout"
    PAD = 6.0
    BAR = 3.0

    def __init__(self, tone: str, title: str, markup: str, style: Style, before: float, after: float) -> None:
        spec = CALLOUT_TONES.get(tone, CALLOUT_TONES["note"])
        self.spec = spec
        self.style = style
        head = title or spec["title"]
        self.html = f"<div class='b'><p><b>{inline_html(head)}</b></p><p>{inline_html(markup)}</p></div>"
        self.visible = f"{plain_text(head)} {plain_text(markup)}"
        self.space_before, self.space_after = before, after
        self._h: Dict[float, float] = {}

    def measure(self, width: float) -> float:
        key = round(width, 2)
        if key not in self._h:
            self._h[key] = measure_html(self.html, self.style.css(), width - 2 * self.PAD - self.BAR) + 2 * self.PAD
        return self._h[key]

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        h = self.measure(width)
        rect = fitz.Rect(x, y, x + width, y + h)
        shape = page.new_shape()
        shape.draw_rect(rect)
        shape.finish(color=None, fill=self.spec["bg"], width=0)
        shape.draw_rect(fitz.Rect(x, y, x + self.BAR, y + h))
        shape.finish(color=None, fill=self.spec["bar"], width=0)
        shape.commit()
        inner = fitz.Rect(x + self.BAR + self.PAD, y + self.PAD, x + width - self.PAD, y + h - self.PAD + 2)
        draw_html(page, inner, self.html, self.style.css())
        return rect


class DiagramItem(Item):
    kind = "diagram"

    def __init__(self, spec: Dict[str, Any], caption: str, style: Style, before: float, after: float) -> None:
        self.spec = spec
        self.style = style
        self.caption = caption
        self.space_before, self.space_after = before, after
        self.result: Optional[DiagramResult] = None
        self.caption_item = HtmlItem(
            "caption",
            f"<div class='b'><p style='font-size:{style.size * 0.9:.2f}pt'><i>{inline_html(caption)}</i></p></div>",
            style.css(), plain_text(caption), style.size * 0.9, before=0.0, after=0.0,
        )
        self.visible = ""
        self._scale: Dict[float, float] = {}

    def _render(self) -> DiagramResult:
        if self.result is None:
            self.result = render_diagram(self.spec)
            self.visible = " ".join(self.result.texts) + " " + plain_text(self.caption)
        return self.result

    def _fit(self, width: float) -> float:
        res = self._render()
        scale = min(1.0, width / res.width)
        if scale < MIN_SCALE:
            raise EditError(
                "diagram_too_dense",
                f"Diagram is {res.width:.0f}pt wide but the page text column is only {width:.0f}pt; it would have to shrink to "
                f"{scale * 100:.0f}% and become hard to read (minimum {MIN_SCALE * 100:.0f}%). Split it into two diagrams, "
                "use fewer nodes per level, shorten labels, or use direction 'down'.",
            )
        return scale

    def measure(self, width: float) -> float:
        res = self._render()
        scale = self._fit(width)
        return res.height * scale + 4 + self.caption_item.measure(width)

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        res = self._render()
        scale = self._fit(width)
        w, h = res.width * scale, res.height * scale
        left = x + (width - w) / 2
        page.show_pdf_page(fitz.Rect(left, y, left + w, y + h), res.doc, 0)
        cap_rect = self.caption_item.draw(page, x, y + h + 4, width)
        return fitz.Rect(x, y, x + width, cap_rect.y1)


class ClipItem(Item):
    """A slice of an existing page, moved verbatim (move_section)."""
    kind = "clip"

    def __init__(self, src: fitz.Document, clip: fitz.Rect, highlights: List[Dict[str, Any]],
                 links: List[Dict[str, Any]], before: float = 0.0) -> None:
        self.src = src
        self.clip = fitz.Rect(clip)
        self.highlights = highlights
        self.links = links
        self.space_before = before
        self.visible = ""

    def measure(self, width: float) -> float:
        return self.clip.height

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        rect = fitz.Rect(self.clip.x0, y, self.clip.x1, y + self.clip.height)
        page.show_pdf_page(rect, self.src, 0, clip=self.clip)
        return rect


class Stack(Item):
    kind = "stack"

    def __init__(self, items: List[Item], gap: float, before: float = 0.0, after: float = 0.0) -> None:
        self.items = items
        self.gap = gap
        self.space_before, self.space_after = before, after
        self.visible = " ".join(i.visible for i in items)

    def measure(self, width: float) -> float:
        return sum(i.measure(width) for i in self.items) + self.gap * (len(self.items) - 1)

    def draw(self, page: fitz.Page, x: float, y: float, width: float) -> fitz.Rect:
        top = y
        for item in self.items:
            rect = item.draw(page, x, y, width)
            y = rect.y1 + self.gap
        return fitz.Rect(x, top, x + width, y - self.gap)


# ── building items from typed block specs ───────────────────────────────────

def block_texts(block: Dict[str, Any]) -> List[str]:
    """All reader-visible strings of a block spec (used by validation before anything is drawn)."""
    kind = block.get("type")
    if kind in ("heading", "paragraph", "equation"):
        return [str(block.get("text", ""))]
    if kind == "bullets":
        return [str(t) for t in block.get("items", [])]
    if kind == "callout":
        return [str(block.get("title", "") or ""), str(block.get("text", ""))]
    if kind == "table":
        cells = [str(c) for c in block.get("header", [])]
        for row in block.get("rows", []):
            cells += [str(c) for c in row]
        return cells + [str(block.get("caption", "") or "")]
    if kind == "diagram":
        from .diagram import diagram_texts
        return diagram_texts(block.get("spec", {})) + [str(block.get("caption", ""))]
    return []


def build_items(blocks: List[Dict[str, Any]], style: Style, resolve_refs: Callable[[str], str],
                provenance: bool = True) -> List[Item]:
    s = style.size
    gap = 0.7 * s
    items: List[Item] = []

    def r(text: Any) -> str:
        return resolve_refs(str(text or ""))

    if provenance:
        label_css = style.css()
        items.append(HtmlItem(
            "label",
            f"<div class='b'><p style='font-size:{s * 0.78:.2f}pt;color:#6a737a'><i>{inline_html(PROVENANCE_TEXT)}</i></p></div>",
            label_css, PROVENANCE_TEXT, s * 0.78, before=0.0, after=0.2 * s, keep_next=True,
        ))
    for block in blocks:
        kind = block.get("type")
        if kind == "heading":
            level = int(block.get("level", 2))
            scale = {1: 1.35, 2: 1.18, 3: 1.05}.get(level, 1.1)
            markup = r(block.get("text"))
            html = f"<div class='b'><p style='font-size:{s * scale:.2f}pt;font-weight:bold'>{inline_html(markup)}</p></div>"
            items.append(HtmlItem("heading", html, style.css(), plain_text(markup), s * scale,
                                  before=1.0 * s, after=0.35 * s, keep_next=True))
        elif kind == "paragraph":
            items.append(ParagraphItem(r(block.get("text")), style, before=gap, after=0.0))
        elif kind == "bullets":
            tag = "ol" if block.get("ordered") else "ul"
            lis = "".join(f"<li>{inline_html(r(t))}</li>" for t in block.get("items", []))
            visible = " ".join(plain_text(r(t)) for t in block.get("items", []))
            items.append(HtmlItem("bullets", f"<div class='b'><{tag}>{lis}</{tag}></div>", style.css(), visible, s, before=gap))
        elif kind == "equation":
            markup = r(block.get("text"))
            html = (f"<div class='b'><p style='text-align:center;font-style:italic;font-size:{s * 1.05:.2f}pt'>"
                    f"{inline_html(markup)}</p></div>")
            items.append(HtmlItem("equation", html, style.css(), plain_text(markup), s, before=gap, after=0.2 * s))
        elif kind == "callout":
            items.append(CalloutItem(str(block.get("tone", "note")), r(block.get("title")), r(block.get("text")),
                                     style, before=gap, after=0.2 * s))
        elif kind == "table":
            head = "".join(f"<th>{inline_html(r(c))}</th>" for c in block.get("header", []))
            rows = "".join("<tr>" + "".join(f"<td>{inline_html(r(c))}</td>" for c in row) + "</tr>" for row in block.get("rows", []))
            table_html = f"<div class='b'><table><tr>{head}</tr>{rows}</table></div>"
            visible = " ".join(plain_text(r(c)) for c in block.get("header", [])) + " " + " ".join(
                plain_text(r(c)) for row in block.get("rows", []) for c in row)
            table = HtmlItem("table", table_html, style.css(), visible, s)
            caption = r(block.get("caption"))
            if caption:
                cap = HtmlItem("caption", f"<div class='b'><p style='font-size:{s * 0.9:.2f}pt'><i>{inline_html(caption)}</i></p></div>",
                               style.css(), plain_text(caption), s * 0.9)
                items.append(Stack([table, cap], 4.0, before=gap, after=0.2 * s))
            else:
                table.space_before = gap
                items.append(table)
        elif kind == "diagram":
            spec = dict(block.get("spec", {}))
            items.append(DiagramItem(spec, r(block.get("caption")), style, before=gap, after=0.3 * s))
        else:
            raise EditError("unknown_block", f"Unknown block type '{kind}'.")
    return items
