"""Text layout helpers built on PyMuPDF's HTML engine (real, selectable, searchable text)."""
from __future__ import annotations

import html as html_lib
import re
from typing import Optional, Tuple

import fitz

from .util import EditError

_SCRATCH: Optional[fitz.Document] = None
_SCRATCH_PAGE: Optional[fitz.Page] = None
_MEASURE_HEIGHT = 4000.0


def _scratch_page() -> fitz.Page:
    global _SCRATCH, _SCRATCH_PAGE
    if _SCRATCH is None or _SCRATCH_PAGE is None or _SCRATCH.page_count > 1 or len(_SCRATCH_PAGE.get_contents()) > 40:
        _SCRATCH = fitz.open()
        _SCRATCH_PAGE = _SCRATCH.new_page(width=2000, height=_MEASURE_HEIGHT + 20)
    return _SCRATCH_PAGE


def inline_html(text: str) -> str:
    """Tiny, safe markup: **bold**, *italic*, ^{sup}, _{sub}, `code`, newline -> <br>. Everything else is escaped."""
    out = html_lib.escape(text or "", quote=False)
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", out)
    out = re.sub(r"\^\{(.+?)\}", r"<sup>\1</sup>", out)
    out = re.sub(r"_\{(.+?)\}", r"<sub>\1</sub>", out)
    out = re.sub(r"`(.+?)`", r"<span style='font-family:monospace'>\1</span>", out)
    return out.replace("\n", "<br>")


def plain_text(markup: str) -> str:
    """The text a reader sees for a markup string."""
    out = re.sub(r"\*\*(.+?)\*\*", r"\1", markup or "")
    out = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", out)
    out = re.sub(r"\^\{(.+?)\}", r"\1", out)
    out = re.sub(r"_\{(.+?)\}", r"\1", out)
    return re.sub(r"`(.+?)`", r"\1", out)


def measure_html(html: str, css: str, width: float) -> float:
    """Height needed to lay the HTML out at a given width."""
    if width < 8:
        raise EditError("layout_too_narrow", "Not enough horizontal space to lay out text.")
    page = _scratch_page()
    spare, _ = page.insert_htmlbox(fitz.Rect(0, 0, width, _MEASURE_HEIGHT), html, css=css)
    if spare < 0:
        raise EditError("layout_overflow", "Content is too tall to lay out.")
    return _MEASURE_HEIGHT - spare


def draw_html(page: fitz.Page, rect: fitz.Rect, html: str, css: str) -> None:
    spare, _ = page.insert_htmlbox(rect, html, css=css, scale_low=1)
    if spare < 0:
        raise EditError("text_clipped", "Text would not fit its box without shrinking or clipping.")


def text_width(text: str, size: float, bold: bool = False) -> float:
    return fitz.get_text_length(text, fontname="hebo" if bold else "helv", fontsize=size)


def base_css(serif: bool, size: float, line_ratio: float, color: str = "#111111") -> str:
    family = "serif" if serif else "sans-serif"
    return (
        f".b{{font-family:{family};font-size:{size:.2f}pt;line-height:{line_ratio:.2f};color:{color};}}"
        ".b p{margin:0;}"
        ".b ul,.b ol{margin:0;padding-left:14pt;}"
        ".b li{margin:0 0 2pt 0;}"
        ".b table{border-collapse:collapse;}"
        ".b th,.b td{border:0.6pt solid #888888;padding:3pt 5pt;vertical-align:top;}"
        ".b th{background-color:#eeeeee;font-weight:bold;}"
    )
