"""Document-aware retrieval: outline, per-page digests, exact block text, term search. Also used by the model via CLI."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional

import fitz

from .checks import DocText
from .pagemodel import analyze_page
from .util import norm_text

CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.|Table|Algorithm|Listing)\s*\d+[a-z]?[.:]", re.I)


def parse_pages(spec: Optional[str], count: int) -> List[int]:
    if not spec:
        return list(range(1, count + 1))
    pages: List[int] = []
    for part in str(spec).split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages += list(range(int(a), int(b) + 1))
        elif part:
            pages.append(int(part))
    return [p for p in pages if 1 <= p <= count]


def page_digest(doc: fitz.Document, page_no: int) -> Dict[str, Any]:
    page = doc[page_no - 1]
    prof = analyze_page(page)
    headings: List[str] = []
    captions: List[str] = []
    first_line = ""
    for b in prof.blocks:
        if b.zone != "body":
            continue
        text = " ".join(b.text.split())
        if not first_line:
            first_line = text[:100]
        if CAPTION_RE.match(text):
            captions.append(text[:140])
        elif b.line_count <= 2 and len(text) <= 90 and (b.size >= prof.body_size * 1.12 or (b.bold and b.size >= prof.body_size)):
            headings.append(text)
    words = len(page.get_text("words"))
    return {
        "page": page_no, "words": words, "columns": prof.columns, "headings": headings[:4], "captions": captions[:3],
        "firstLine": first_line, "images": sum(1 for b in prof.bands if "image" in b.kinds),
        "size": [round(prof.width), round(prof.height)],
    }


def outline(doc: fitz.Document) -> List[Dict[str, Any]]:
    return [{"level": lvl, "title": title, "page": page} for lvl, title, page in doc.get_toc()]


def build_map(doc: fitz.Document, max_chars: int = 7000) -> Dict[str, Any]:
    toc = outline(doc)
    digests = [page_digest(doc, p) for p in range(1, doc.page_count + 1)]
    lines = [f"Pages: {doc.page_count}"]
    if toc:
        lines.append("Outline: " + "; ".join(f"{t['title']} (p{t['page']})" for t in toc[:40]))
    for d in digests:
        bits = [f"p{d['page']}"]
        if d["headings"]:
            bits.append("H: " + " | ".join(h[:60] for h in d["headings"][:2]))
        else:
            bits.append(d["firstLine"][:70])
        if d["captions"]:
            bits.append("Cap: " + " | ".join(c[:60] for c in d["captions"]))
        if d["columns"] > 1:
            bits.append("[2-column]")
        lines.append(" — ".join(bits))
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n… (map truncated; use the context CLI for the rest)"
    return {"pageCount": doc.page_count, "outline": toc, "pages": digests, "text": text}


def page_blocks(doc: fitz.Document, page_no: int) -> Dict[str, Any]:
    prof = analyze_page(doc[page_no - 1])
    return {
        "page": page_no, "columns": prof.columns,
        "blocks": [
            {"index": b.index, "zone": b.zone, "y": [round(b.rect.y0), round(b.rect.y1)], "size": b.size,
             "text": " ".join(b.text.split())}
            for b in prof.blocks
        ],
    }


def find_term(doc: fitz.Document, term: str) -> Dict[str, Any]:
    text = DocText(doc)
    hits = []
    for i in range(doc.page_count):
        rects = doc[i].search_for(term)
        if rects:
            raw = re.sub(r"\s+", " ", text.raw(i + 1))
            at = norm_text(raw).find(norm_text(term))
            snippet = norm_text(raw)[max(0, at - 50): at + 90] if at >= 0 else ""
            hits.append({"page": i + 1, "count": len(rects), "y": round(min(r.y0 for r in rects)), "snippet": snippet})
    return {
        "term": term, "hits": hits[:20], "firstUse": ({"page": hits[0]["page"], "y": hits[0]["y"]} if hits else None),
        "definitions": [{"page": p, "snippet": s} for p, s in text.definitions(term)],
    }


def validate_pdf(path: str) -> Dict[str, Any]:
    try:
        doc = fitz.open(path)
        count = doc.page_count
        for i in range(count):
            doc[i].get_text()
        doc.close()
        return {"ok": count > 0, "pageCount": count}
    except Exception as err:
        return {"ok": False, "error": str(err)}


def render_pages(path: str, pages: List[int], out_dir: str, dpi: int = 72, prefix: str = "page") -> List[Dict[str, Any]]:
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(path)
    out = []
    for p in pages:
        if 1 <= p <= doc.page_count:
            name = f"{prefix}-{p}.png"
            doc[p - 1].get_pixmap(dpi=dpi).save(os.path.join(out_dir, name))
            out.append({"page": p, "file": name})
    doc.close()
    return out


def run(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload["pdfPath"]
    if action == "validate_pdf":
        return validate_pdf(path)
    if action == "render":
        return {"pages": render_pages(path, payload["pages"], payload["outDir"], int(payload.get("dpi", 72)), payload.get("prefix", "page"))}
    doc = fitz.open(path)
    try:
        if action == "map":
            return build_map(doc, int(payload.get("maxChars", 7000)))
        if action == "outline":
            return {"outline": outline(doc)}
        if action == "pages":
            return {"pages": [page_digest(doc, p) for p in parse_pages(payload.get("pages"), doc.page_count)]}
        if action == "text":
            return {"pages": [page_blocks(doc, p) for p in parse_pages(payload.get("pages"), doc.page_count)]}
        if action == "find":
            return find_term(doc, payload["term"])
        raise ValueError(f"Unknown context action: {action}")
    finally:
        doc.close()
