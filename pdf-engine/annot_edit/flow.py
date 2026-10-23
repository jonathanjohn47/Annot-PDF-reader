"""Working document + flow engine.

A PDF cannot reflow, so an in-flow edit is done as a *splice* on one page: everything above the cut stays
untouched, new content is laid out after it, and the original content below the cut is re-placed after the new
content (page break handled), with highlights and links carried along. Only the touched page is changed;
every other page stays byte-for-byte the same content.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import fitz

from .blocks import ClipItem, Item, Style
from .pagemodel import Band, PageProfile, analyze_page
from .util import EditError, norm_text, words_of

EPS = 0.01


@dataclass
class Annots:
    highlights: List[Dict[str, Any]] = field(default_factory=list)
    other: int = 0


def collect_annots(page: fitz.Page) -> Tuple[List[Dict[str, Any]], int]:
    highlights: List[Dict[str, Any]] = []
    other = 0
    annot = page.first_annot
    while annot:
        type_name = annot.type[1] if annot.type else ""
        if type_name == "Highlight":
            verts = annot.vertices or []
            quads = [verts[i:i + 4] for i in range(0, len(verts), 4)]
            highlights.append({
                "xref": annot.xref, "rect": fitz.Rect(annot.rect), "quads": [[fitz.Point(p) for p in q] for q in quads],
                "colors": annot.colors, "info": dict(annot.info or {}), "opacity": annot.opacity,
            })
        elif type_name not in ("Link", "Popup", "Widget"):
            other += 1
        annot = annot.next
    return highlights, other


def recreate_highlight(page: fitz.Page, hl: Dict[str, Any], dy: float, dx: float = 0.0) -> None:
    quads = []
    for q in hl["quads"]:
        pts = [fitz.Point(p.x + dx, p.y + dy) for p in q]
        quads.append(fitz.Quad(*pts))
    new = page.add_highlight_annot(quads=quads or None)
    stroke = (hl.get("colors") or {}).get("stroke")
    if stroke:
        new.set_colors(stroke=stroke)
    info = hl.get("info") or {}
    new.set_info(title=info.get("title", ""), subject=info.get("subject", ""), content=info.get("content", ""))
    if hl.get("opacity", -1) is not None and hl.get("opacity", -1) >= 0:
        new.set_opacity(hl["opacity"])
    new.update()


def _link_payload(link: Dict[str, Any], dy: float) -> Dict[str, Any]:
    rect = fitz.Rect(link["from"])
    out = {k: link[k] for k in ("kind", "page", "to", "zoom", "uri", "file", "name") if k in link}
    out["from"] = fitz.Rect(rect.x0, rect.y0 + dy, rect.x1, rect.y1 + dy)
    return out


def zone_clips(prof: PageProfile) -> Tuple[Optional[fitz.Rect], Optional[fitz.Rect]]:
    """Clip rectangles of the running header and footer, so pages created by an edit can repeat them."""
    header = None
    footer = None
    if prof.header_bottom is not None:
        header = fitz.Rect(0, 0, prof.width, prof.header_bottom + 3)
    footer_blocks = [b for b in prof.blocks if b.zone == "footer"]
    if footer_blocks:
        fy0 = min(b.rect.y0 for b in footer_blocks)
        last_body = max((b.y1 for b in prof.bands), default=0.0)
        footer = fitz.Rect(0, max(last_body + 0.5, fy0 - 6), prof.width, prof.height)
    return header, footer


def decorate(page: fitz.Page, src: fitz.Document, header: Optional[fitz.Rect], footer: Optional[fitz.Rect]) -> None:
    for clip in (header, footer):
        if clip is not None:
            page.show_pdf_page(clip, src, 0, clip=clip)


class WorkDoc:
    """The document being edited, plus bookkeeping that survives page insertions."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.doc = fitz.open(path)
        self.tags: List[Dict[str, Any]] = [{"origin": i + 1, "kind": "orig"} for i in range(self.doc.page_count)]
        self.placements: Dict[int, List[Tuple[fitz.Rect, str]]] = {}
        self.warnings: List[Dict[str, Any]] = []
        self.dropped_highlights = 0
        self.dropped_other_annots = 0
        self.removed_tokens: Counter = Counter()
        self.deleted_origins: set = set()
        self.removed_rects: List[Tuple[int, fitz.Rect]] = []  # (original page, rect) for previews

    # ── bookkeeping ──
    def pages_of(self, origin: int) -> List[int]:
        return [i for i, t in enumerate(self.tags) if t["origin"] == origin]

    def _place(self, page: fitz.Page, rect: fitz.Rect, kind: str) -> None:
        self.placements.setdefault(page.xref, []).append((fitz.Rect(rect), kind))

    def _new_page_after(self, pno: int, width: float, height: float, origin: Optional[int]) -> int:
        self.doc.new_page(pno=pno + 1, width=width, height=height)
        self.tags.insert(pno + 1, {"origin": origin, "kind": "added"})
        return pno + 1

    # ── splice ──
    def splice(self, pno: int, prof: PageProfile, keep_upto: int, resume_from: int, items: List[Item],
               max_new_pages: int = 8) -> Dict[str, Any]:
        """Keep bands[:keep_upto], drop bands[keep_upto:resume_from], flow `items`, then re-place bands[resume_from:]."""
        if prof.rotation:
            raise EditError("unsupported_layout", "This page is rotated; in-flow edits are not supported on rotated pages. Use mode 'new_pages'.")
        if prof.columns > 1:
            raise EditError("multi_column_layout", "This page has a multi-column layout, where a vertical splice would cut through both columns. Use placement mode 'new_pages' (a new page after this one) instead.")
        doc = self.doc
        page = doc[pno]
        origin = self.tags[pno]["origin"]
        W, H = prof.width, prof.height
        bands = prof.bands
        s = prof.body_size
        content_width = prof.content_width
        removed = bands[keep_upto:resume_from]
        lower = bands[resume_from:]
        prev_y1 = bands[keep_upto - 1].y1 if keep_upto > 0 else None

        if bands:
            redact_y = (prev_y1 + 0.5) if prev_y1 is not None else max(0.0, bands[0].y0 - 0.5)
        else:
            redact_y = prof.top_margin
        header_clip, footer_clip = zone_clips(prof)
        redact_bottom = footer_clip.y0 if footer_clip is not None else H

        after_gap = (lower[0].y0 - (removed[-1].y1 if removed else (prev_y1 if prev_y1 is not None else lower[0].y0))) if lower else 0.0
        after_gap = max(after_gap, 0.6 * s) if items else max(after_gap, 0.0)
        if removed:
            lead = removed[0].y0 - (prev_y1 if prev_y1 is not None else removed[0].y0)
        else:
            lead = (lower[0].y0 - prev_y1) if (lower and prev_y1 is not None) else 0.8 * s
        lead = max(lead, 0.6 * s) if prev_y1 is not None else 0.0
        start_y = (prev_y1 + lead) if prev_y1 is not None else (bands[0].y0 if bands else prof.top_margin)

        # record what is being removed (for the conservation check)
        for band in removed:
            self.removed_rects.append((origin, fitz.Rect(band.rect)))
            for w in page.get_text("words", clip=band.rect + (-0.5, -0.5, 0.5, 0.5)):
                self.removed_tokens[norm_text(w[4])] += 1

        src = fitz.open()
        src.insert_pdf(doc, from_page=pno, to_page=pno)
        highlights, other_annots = collect_annots(page)
        links = [l for l in page.get_links() if l.get("kind") in (1, 2, 3, 4, 5)]

        # detach annotations/links that live in the part that is rebuilt
        movable_hl = [h for h in highlights if redact_y <= (h["rect"].y0 + h["rect"].y1) / 2 < redact_bottom]
        for h in movable_hl:
            for annot in page.annots() or []:
                if annot.xref == h["xref"]:
                    page.delete_annot(annot)
                    break
        movable_links = [l for l in links if redact_y <= (fitz.Rect(l["from"]).y0 + fitz.Rect(l["from"]).y1) / 2 < redact_bottom]
        for l in movable_links:
            try:
                page.delete_link(l)
            except Exception:
                pass
        if other_annots:
            below = 0
            annot = page.first_annot
            while annot:
                t = annot.type[1] if annot.type else ""
                if t not in ("Highlight", "Link", "Popup", "Widget") and (annot.rect.y0 + annot.rect.y1) / 2 >= redact_y:
                    below += 1
                annot = annot.next
            if below:
                self.dropped_other_annots += below
                self.warnings.append({"severity": "warning", "code": "annotations_not_carried",
                                      "message": f"{below} non-highlight annotation(s) on page {origin} sit in the re-flowed region and were not carried over."})

        # redact the rebuilt region on the original page object (keeps links/outline targets pointing at it)
        page.add_redact_annot(fitz.Rect(0, redact_y, W, redact_bottom), fill=False)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_REMOVE,
            graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
        remaining = [w for w in page.get_text("words") if w[1] >= redact_y + 1 and w[3] <= redact_bottom]
        if remaining:
            raise EditError("redaction_failed", f"Could not cleanly detach the lower part of page {origin} ({len(remaining)} words remained). Use placement mode 'new_pages' instead.")

        # ── flow
        cur = pno
        cur_page = doc[cur]
        y = start_y
        top = start_y
        first_on_page = True
        new_pages = 0
        prev_after = 0.0
        pages_used = [cur]
        queue: List[Tuple[str, Any]] = [("item", it) for it in items] + [("unit", b) for b in lower]
        unit_dest: List[Tuple[Band, int, float]] = []
        clip_dest: List[Tuple[ClipItem, int, fitz.Rect]] = []

        def start_new_page() -> None:
            nonlocal cur, cur_page, y, top, first_on_page, new_pages, prev_after
            if new_pages >= max_new_pages:
                raise EditError("too_many_pages", f"The edit would need more than {max_new_pages} extra pages on page {origin}. Shorten it or split it into several edits.")
            cur = self._new_page_after(cur, W, H, origin)
            cur_page = doc[cur]
            decorate(cur_page, src, header_clip, footer_clip)
            pages_used.append(cur)
            y = prof.top_margin
            top = y
            first_on_page = True
            prev_after = 0.0
            new_pages += 1

        idx = 0
        while idx < len(queue):
            kind, obj = queue[idx]
            if kind == "item":
                item: Item = obj
                item_width = getattr(item, "fixed_width", None) or content_width
                h = item.measure(item_width)
                gap = 0.0 if first_on_page else max(prev_after, item.space_before)
                need = h
                if item.keep_with_next and idx + 1 < len(queue) and queue[idx + 1][0] == "item":
                    nxt: Item = queue[idx + 1][1]
                    need = h + max(item.space_after, nxt.space_before) + min(nxt.measure(content_width), 3 * s * prof.line_ratio)
                if y + gap + need > prof.bottom_limit + EPS:
                    parts = item.split(item_width, prof.bottom_limit - (y + gap))
                    if parts is not None and (prof.bottom_limit - (y + gap)) > 3 * s * prof.line_ratio:
                        head, tail = parts
                        for attr in ("fixed_x", "fixed_width"):
                            setattr(head, attr, getattr(item, attr, None))
                            setattr(tail, attr, getattr(item, attr, None))
                        rect = head.draw(cur_page, getattr(item, "fixed_x", None) if getattr(item, "fixed_x", None) is not None else prof.left, y + gap, item_width)
                        self._place(cur_page, rect, "new")
                        queue[idx] = ("item", tail)
                        start_new_page()
                        continue
                    if first_on_page and h > prof.bottom_limit - y + EPS:
                        raise EditError("block_too_tall", f"A {item.kind} block is taller ({h:.0f}pt) than a full page of usable space ({prof.bottom_limit - y:.0f}pt). Split it into smaller pieces.")
                    start_new_page()
                    continue
                ix = getattr(item, "fixed_x", None)
                rect = item.draw(cur_page, (ix if ix is not None else prof.left) if not isinstance(item, ClipItem) else 0.0, y + gap, getattr(item, "fixed_width", None) or content_width)
                self._place(cur_page, rect, "new" if not isinstance(item, ClipItem) else "unit")
                if isinstance(item, ClipItem):
                    clip_dest.append((item, cur, rect))
                y = rect.y1
                prev_after = item.space_after
                first_on_page = False
                idx += 1
            else:
                band: Band = obj
                unit_h = band.height + 1.0
                ordinal = [q for q in queue[:idx] if q[0] == "unit"]
                if ordinal:
                    prev_band: Band = ordinal[-1][1]
                    gap = max(0.0, band.y0 - prev_band.y1)
                else:
                    gap = max(after_gap, prev_after)
                if first_on_page:
                    gap = 0.0
                if y + gap + unit_h > prof.bottom_limit + EPS and not first_on_page:
                    start_new_page()
                    continue
                dest_y = y + gap
                rect = fitz.Rect(0, dest_y, W, dest_y + unit_h)
                clip = fitz.Rect(0, band.y0 - 0.5, W, band.y1 + 0.5)
                cur_page.show_pdf_page(rect, src, 0, clip=clip)
                self._place(cur_page, fitz.Rect(band.x0, dest_y + 0.5, band.x1, dest_y + 0.5 + band.height), "unit")
                unit_dest.append((band, cur, dest_y + 0.5 - band.y0 + 0.0))
                y = dest_y + unit_h
                prev_after = 0.0
                first_on_page = False
                idx += 1

        # carry highlights and links along
        def locate(rect: fitz.Rect) -> Optional[Tuple[int, float]]:
            cy = (rect.y0 + rect.y1) / 2
            for band, dest_page, dy in unit_dest:
                if band.y0 - 1 <= cy <= band.y1 + 1:
                    return dest_page, dy
            return None

        for h in movable_hl:
            spot = locate(h["rect"])
            if spot is None:
                self.dropped_highlights += 1
                continue
            recreate_highlight(doc[spot[0]], h, spot[1])
        for l in movable_links:
            spot = locate(fitz.Rect(l["from"]))
            if spot is None:
                continue
            try:
                doc[spot[0]].insert_link(_link_payload(l, spot[1]))
            except Exception:
                self.warnings.append({"severity": "warning", "code": "link_not_carried", "message": f"A link on page {origin} could not be carried over."})

        for clip_item, dest_page, dest_rect in clip_dest:
            for h in clip_item.highlights:
                recreate_highlight(doc[dest_page], h, dest_rect.y0 - clip_item.clip.y0)

        # tags: pages that carry original content are "changed", pages with only new material are "added"
        for i in pages_used:
            if self.tags[i]["kind"] == "added":
                continue
            carries_original = i == pno or any(d[1] == i for d in unit_dest) or any(d[1] == i for d in clip_dest)
            self.tags[i]["kind"] = "changed" if carries_original else "added"
        src.close()
        return {"pages": pages_used, "added_pages": new_pages, "removed_bands": len(removed)}

    # ── new pages ──
    def insert_pages(self, after_pno: int, prof: PageProfile, items: List[Item], origin: Optional[int],
                     max_new_pages: int = 8) -> Dict[str, Any]:
        doc = self.doc
        W, H = prof.width, prof.height
        cur = after_pno
        new_pages = 0
        content_width = prof.content_width

        def fresh() -> int:
            nonlocal new_pages
            if new_pages >= max_new_pages:
                raise EditError("too_many_pages", f"The edit would need more than {max_new_pages} new pages. Shorten it or split it.")
            new_pages += 1
            return self._new_page_after(cur, W, H, origin)

        header_clip, footer_clip = zone_clips(prof)
        ref = fitz.open()
        ref.insert_pdf(doc, from_page=after_pno if after_pno >= 0 else 0, to_page=after_pno if after_pno >= 0 else 0)

        def fresh_decorated() -> int:
            index = fresh()
            decorate(doc[index], ref, header_clip, footer_clip)
            return index

        cur = fresh_decorated()
        page = doc[cur]
        y = prof.top_margin
        first = True
        prev_after = 0.0
        queue = list(items)
        idx = 0
        pages: List[int] = [cur]
        while idx < len(queue):
            item = queue[idx]
            h = item.measure(content_width)
            gap = 0.0 if first else max(prev_after, item.space_before)
            need = h
            if item.keep_with_next and idx + 1 < len(queue):
                nxt = queue[idx + 1]
                need = h + max(item.space_after, nxt.space_before) + min(nxt.measure(content_width), 3 * prof.body_size * prof.line_ratio)
            if y + gap + need > prof.bottom_limit + EPS and not first:
                parts = item.split(content_width, prof.bottom_limit - (y + gap))
                if parts is not None and (prof.bottom_limit - (y + gap)) > 3 * prof.body_size * prof.line_ratio:
                    head, tail = parts
                    rect = head.draw(page, prof.left, y + gap, content_width)
                    self._place(page, rect, "new")
                    queue[idx] = tail
                    cur = fresh_decorated()
                    page = doc[cur]
                    pages.append(cur)
                    y, first, prev_after = prof.top_margin, True, 0.0
                    continue
                cur = fresh_decorated()
                page = doc[cur]
                pages.append(cur)
                y, first, prev_after = prof.top_margin, True, 0.0
                continue
            if first and h > prof.bottom_limit - y + EPS:
                raise EditError("block_too_tall", f"A {item.kind} block is taller ({h:.0f}pt) than a page of usable space ({prof.bottom_limit - y:.0f}pt). Split it into smaller pieces.")
            rect = item.draw(page, prof.left, y + gap, content_width)
            self._place(page, rect, "new")
            y = rect.y1
            prev_after = item.space_after
            first = False
            idx += 1
        return {"pages": pages, "added_pages": new_pages}

    # ── in-place / delete ──
    def redact_rect(self, pno: int, rect: fitz.Rect, *, images: bool = False) -> int:
        """Remove content under rect. Highlights overlapping it are dropped. Returns number of highlights dropped."""
        page = self.doc[pno]
        self.removed_rects.append((self.tags[pno]["origin"], fitz.Rect(rect)))
        for w in page.get_text("words", clip=rect):
            self.removed_tokens[norm_text(w[4])] += 1
        dropped = 0
        annot = page.first_annot
        while annot:
            nxt = annot.next
            if annot.type and annot.type[1] == "Highlight" and not (fitz.Rect(annot.rect) & rect).is_empty:
                page.delete_annot(annot)
                dropped += 1
            annot = nxt
        page.add_redact_annot(rect, fill=False)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_REMOVE if images else fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
        self.dropped_highlights += dropped
        return dropped

    def draw_in_place(self, pno: int, item: Item, x: float, y: float, width: float) -> fitz.Rect:
        page = self.doc[pno]
        rect = item.draw(page, x, y, width)
        self._place(page, rect, "new")
        return rect

    # ── pages ──
    def delete_pages(self, indexes: List[int]) -> None:
        for i in sorted(indexes, reverse=True):
            self.doc.delete_page(i)
            self.tags.pop(i)

    def move_page(self, pno: int, before: int) -> None:
        """Move page `pno` so it sits immediately before page `before` (index), or last when before >= page_count."""
        count = self.doc.page_count
        self.doc.move_page(pno, -1 if before >= count else before)
        tag = self.tags.pop(pno)
        target = len(self.tags) if before >= count else (before if before <= pno else before - 1)
        self.tags.insert(target, tag)
