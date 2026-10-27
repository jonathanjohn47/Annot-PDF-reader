"""Typed operations: resolve anchors against the live document, build layout items, apply through the flow engine."""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

import fitz

from .blocks import PROVENANCE_TEXT, ClipItem, Item, ParagraphItem, Style, build_items
from .flow import WorkDoc, collect_annots
from .pagemodel import (PageProfile, Band, TextBlock, analyze_page, band_for_rect, block_for_rect, block_text,
                        find_quote)
from .prune import prune_page_fully
from .util import EditError, clamp, norm_text

PAGE_REF = re.compile(r"\{\{page:(\d+)\}\}")
MAX_NEW_PAGES_PER_OP = 6


def style_for(prof: PageProfile) -> Style:
    return Style(prof.serif, prof.body_size, prof.line_ratio)


def _origin_indexes(work: WorkDoc, origin: int) -> List[int]:
    indexes = work.pages_of(origin)
    if not indexes:
        raise EditError("page_out_of_range", f"Page {origin} does not exist in this document (or was removed by an earlier operation).")
    return indexes


def locate_in_origin(work: WorkDoc, origin: int, quote: str) -> Tuple[int, PageProfile, Dict[str, Any]]:
    """Find a quote on the pages that currently derive from original page `origin`."""
    hits: List[Tuple[int, PageProfile, Dict[str, Any]]] = []
    for idx in _origin_indexes(work, origin):
        page = work.doc[idx]
        found = find_quote(page, quote)
        if found:
            hits.append((idx, analyze_page(page), found))
    if not hits:
        raise EditError("quote_not_found", f"Quote not found on page {origin}: \"{quote[:80]}\". Quote text exactly as it appears in the PDF (a few consecutive words).")
    if len(hits) > 1 or hits[0][2]["count"] > 1:
        raise EditError("quote_ambiguous", f"Quote appears more than once on page {origin}: \"{quote[:80]}\". Quote a longer, unique passage.")
    return hits[0]


def make_resolver(refs: Optional[Dict[int, int]]) -> Callable[[str], str]:
    def resolve(text: str) -> str:
        def sub(m: "re.Match[str]") -> str:
            n = int(m.group(1))
            return str(refs.get(n, n)) if refs else str(n)
        return PAGE_REF.sub(sub, text or "")
    return resolve


def page_ref_map(work: WorkDoc) -> Dict[int, int]:
    out: Dict[int, int] = {}
    for i, tag in enumerate(work.tags):
        origin = tag.get("origin")
        if origin is not None and origin not in out and tag["kind"] != "added":
            out[origin] = i + 1
    return out


# ── insert_content ──────────────────────────────────────────────────────────

def op_insert_content(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    placement = op["placement"]
    origin = int(placement["page"])
    mode = placement.get("mode", "inline")
    position = placement.get("position")
    provenance = op.get("provenance_label", True)
    indexes = _origin_indexes(work, origin)

    if mode == "new_pages":
        prof = analyze_page(work.doc[indexes[0]])
        items = build_items(op["blocks"], style_for(prof), resolver, provenance)
        after = indexes[0] - 1 if position == "page_start" else indexes[-1]
        if after < 0:
            result = work.insert_pages(0, prof, items, origin)
            for k, p in enumerate(list(result["pages"])):
                work.move_page(p, k)
            result["pages"] = list(range(len(result["pages"])))
        else:
            result = work.insert_pages(after, prof, items, origin)
        return {"kind": "new_pages", **result}

    quote_after, quote_before = placement.get("after_quote"), placement.get("before_quote")
    if quote_after or quote_before:
        quote = quote_after or quote_before
        idx, prof, found = locate_in_origin(work, origin, quote)
        block = block_for_rect(prof, found["rect"])
        if block is not None and block.zone != "body":
            raise EditError("anchor_in_header_footer", "The anchor text is in a running header/footer; anchor on body text instead.")
        band = band_for_rect(prof, found["rect"])
        if band is None:
            raise EditError("anchor_not_in_flow", "Could not place the anchor in the page flow; anchor on a nearby paragraph.")
        band_index = prof.bands.index(band)
        keep_upto = band_index + 1 if quote_after else band_index
    elif position == "page_start":
        idx = indexes[0]
        prof = analyze_page(work.doc[idx])
        keep_upto = 0
    else:
        idx = indexes[-1]
        prof = analyze_page(work.doc[idx])
        keep_upto = len(prof.bands)

    items = build_items(op["blocks"], style_for(prof), resolver, provenance)
    result = work.splice(idx, prof, keep_upto, keep_upto, items, MAX_NEW_PAGES_PER_OP)
    return {"kind": "inline", **result}


# ── replace / delete ────────────────────────────────────────────────────────

def _flex_pattern(quote: str) -> "re.Pattern[str]":
    tokens = [re.escape(t) for t in re.split(r"\s+", quote.strip()) if t]
    return re.compile(r"\s*".join(tokens) if len(tokens) == 1 else r"\s+".join(tokens), re.I)


def _protect(text: str) -> str:
    """Original PDF text must not be interpreted as markup."""
    return text.replace("*", "∗").replace("^{", "^​{").replace("_{", "_​{").replace("`", "'")


def _find_block(work: WorkDoc, origin: int, quote: str) -> Tuple[int, PageProfile, TextBlock, Dict[str, Any]]:
    idx, prof, found = locate_in_origin(work, origin, quote)
    block = block_for_rect(prof, found["rect"])
    if block is None:
        raise EditError("anchor_not_text", "The quoted passage is not in a text paragraph.")
    if block.zone != "body":
        raise EditError("anchor_in_header_footer", "The quoted passage is in a running header/footer, which cannot be edited.")
    return idx, prof, block, found


def _rewrite_block(work: WorkDoc, idx: int, prof: PageProfile, block: TextBlock, new_markup: Optional[str],
                   protected_prefix: str = "", protected_suffix: str = "", op_label: str = "replace") -> Dict[str, Any]:
    """Replace a whole paragraph with new text (in place if it fits, else by splicing the page)."""
    page = work.doc[idx]
    ratio = clamp(block.line_pitch / block.size if block.size else 1.2, 1.1, 1.8)
    style = Style(block.serif, block.size, ratio)
    band = next((b for b in prof.bands if block.index in b.block_indexes), None)
    if new_markup is None or not (new_markup + protected_prefix + protected_suffix).strip():
        item: Optional[ParagraphItem] = None
    else:
        item = ParagraphItem(protected_prefix + new_markup + protected_suffix, style, 0.0, 0.0)

    whole_band = band is not None and band.block_indexes == [block.index] and band.kinds == {"text"}
    # In place if it fits in the space the block already owns (up to the next band / footer).
    below = [b.y0 for b in prof.bands if b.y0 > block.rect.y1 + 0.5]
    limit_y = min(below + ([prof.footer_top] if prof.footer_top else []) + [prof.bottom_limit + 4]) - 1.5
    available = limit_y - block.rect.y0

    if item is None:
        if whole_band and prof.columns == 1 and band is not None:
            band_index = prof.bands.index(band)
            work.splice(idx, prof, band_index, band_index + 1, [], MAX_NEW_PAGES_PER_OP)
            return {"kind": "deleted", "pages": [idx]}
        work.redact_rect(idx, fitz.Rect(block.rect.x0 - 0.5, block.rect.y0 + 0.2, block.rect.x1 + 0.5, block.rect.y1 - 0.2))
        work.tags[idx]["kind"] = "changed" if work.tags[idx]["kind"] != "added" else "added"
        work.warnings.append({"severity": "info", "code": "gap_left", "message": f"The deleted text on page {work.tags[idx]['origin']} left blank space (this layout cannot close the gap)."})
        return {"kind": "deleted", "pages": [idx]}

    width = block.rect.width
    needed = item.measure(width)
    if whole_band and prof.columns == 1 and band is not None:
        # Splice (not in place) so the new text sits at the right point of the page's reading order.
        band_index = prof.bands.index(band)
        item.fixed_x, item.fixed_width = block.rect.x0, width
        result = work.splice(idx, prof, band_index, band_index + 1, [item], MAX_NEW_PAGES_PER_OP)
        return {"kind": "reflowed" if needed > available + 0.5 else "replaced", **result}

    if needed <= available + 0.5:
        work.redact_rect(idx, fitz.Rect(block.rect.x0 - 0.5, block.rect.y0 + 0.2, block.rect.x1 + 0.5, block.rect.y1 - 0.2))
        work.draw_in_place(idx, item, block.rect.x0, block.rect.y0, width)
        work.tags[idx]["kind"] = "changed" if work.tags[idx]["kind"] != "added" else "added"
        work.warnings.append({"severity": "info", "code": "reading_order", "message": f"The revised text on page {work.tags[idx]['origin']} was placed in the existing space; screen-reader / text-extraction order may differ slightly from visual order."})
        return {"kind": "in_place", "pages": [idx]}

    avg_chars = max(1, len(block_text(block))) / max(1, block.line_count)
    lines_available = int(available / (block.line_pitch or block.size * 1.2))
    raise EditError(
        "replacement_too_long",
        f"The replacement needs {needed:.0f}pt of height but only {available:.0f}pt is available here (about {int(lines_available * avg_chars)} characters). "
        "Shorten the replacement, or add the extra explanation with insert_content.",
    )


def op_replace_passage(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    origin = int(op["page"])
    quote = op["quote"]
    scope = op.get("scope", "phrase")
    replacement = resolver(op.get("replacement", ""))
    idx, prof, block, found = _find_block(work, origin, quote)
    original = block_text(block)
    if scope == "paragraph":
        return _rewrite_block(work, idx, prof, block, replacement)
    match = _flex_pattern(quote).search(original)
    if not match:
        raise EditError("quote_spans_blocks", "The quoted phrase crosses a paragraph boundary. Quote a phrase inside one paragraph, or use scope 'paragraph'.")
    prefix, suffix = _protect(original[:match.start()]), _protect(original[match.end():])
    return _rewrite_block(work, idx, prof, block, replacement, prefix, suffix)


def op_delete_passage(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    origin = int(op["page"])
    quote = op["quote"]
    scope = op.get("scope", "paragraph")
    idx, prof, block, found = _find_block(work, origin, quote)
    if scope == "paragraph":
        return _rewrite_block(work, idx, prof, block, None)
    original = block_text(block)
    match = _flex_pattern(quote).search(original)
    if not match:
        raise EditError("quote_spans_blocks", "The quoted phrase crosses a paragraph boundary. Quote a phrase inside one paragraph, or use scope 'paragraph'.")
    rest = (_protect(original[:match.start()]).rstrip() + " " + _protect(original[match.end():]).lstrip()).strip()
    return _rewrite_block(work, idx, prof, block, "", rest, "") if rest else _rewrite_block(work, idx, prof, block, None)


# ── pages ───────────────────────────────────────────────────────────────────

def op_delete_pages(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    targets: List[int] = []
    for origin in op["pages"]:
        targets += _origin_indexes(work, int(origin))
    if len(set(targets)) >= work.doc.page_count:
        raise EditError("cannot_delete_all", "Refusing to delete every page of the document.")
    for i in set(targets):
        for w in work.doc[i].get_text("words"):
            work.removed_tokens[norm_text(w[4])] += 1
        work.deleted_origins.add(work.tags[i]["origin"])
    work.delete_pages(sorted(set(targets)))
    return {"kind": "pages_deleted", "pages": []}


def op_move_pages(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    pages = [int(p) for p in op["pages"]]
    after = int(op["after_page"])
    moving: List[int] = []
    for origin in pages:
        moving += _origin_indexes(work, origin)
    moving = sorted(set(moving))
    moving_set = set(moving)
    order = list(range(work.doc.page_count))
    rest = [i for i in order if i not in moving_set]
    if after == 0:
        insert_at = 0
    else:
        if any(i in moving_set for i in _origin_indexes(work, after)):
            raise EditError("move_into_self", "'after_page' cannot be one of the pages being moved.")
        insert_at = _origin_indexes_after_removal(rest, work, after) + 1
    new_order = rest[:insert_at] + moving + rest[insert_at:]
    if new_order == order:
        raise EditError("noop_move", "The pages are already in that position.")
    work.doc.select(new_order)
    work.tags = [work.tags[i] for i in new_order]
    for i in range(insert_at, insert_at + len(moving)):
        if work.tags[i]["kind"] != "added":
            work.tags[i]["kind"] = "changed"
    return {"kind": "pages_moved", "pages": list(range(insert_at, insert_at + len(moving)))}


def _origin_indexes_after_removal(rest: List[int], work: WorkDoc, after: int) -> int:
    last = -1
    for position, original_index in enumerate(rest):
        if work.tags[original_index]["origin"] == after:
            last = position
    if last < 0:
        raise EditError("page_out_of_range", f"Page {after} does not exist.")
    return last


def _section_range(work: WorkDoc, src: Dict[str, Any]) -> Tuple[int, PageProfile, int, int]:
    """Band range (first, last) between a start quote and an optional end quote on one page."""
    origin = int(src["page"])
    idx, prof, found = locate_in_origin(work, origin, src["start_quote"])
    first_band = band_for_rect(prof, found["rect"])
    if first_band is None:
        raise EditError("anchor_not_in_flow", "Could not place the start of the section in the page flow.")
    last_band = first_band
    if src.get("end_quote"):
        idx2, prof2, found2 = locate_in_origin(work, origin, src["end_quote"])
        if idx2 != idx:
            raise EditError("section_spans_pages", "Moving a section is supported within one page; start and end quotes are on different pages.")
        last_band = band_for_rect(prof, found2["rect"]) or first_band
    first_i, last_i = prof.bands.index(first_band), prof.bands.index(last_band)
    if last_i < first_i:
        first_i, last_i = last_i, first_i
    if prof.columns > 1:
        raise EditError("multi_column_layout", "Moving or removing sections is not supported on multi-column pages.")
    return idx, prof, first_i, last_i


def _band_text(prof: PageProfile, band: Band) -> str:
    return norm_text(" ".join(b.text for b in prof.blocks if b.index in band.block_indexes))


def op_delete_section(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    """Remove whole bands (text, figures, drawings) from the band holding start_quote to the one holding end_quote."""
    idx, prof, first_i, last_i = _section_range(work, op["from"])
    # an "Added for clarity" label belongs to the content below it
    if first_i > 0 and _band_text(prof, prof.bands[first_i - 1]) == norm_text(PROVENANCE_TEXT):
        first_i -= 1
    result = work.splice(idx, prof, first_i, last_i + 1, [], MAX_NEW_PAGES_PER_OP)
    return {"kind": "deleted", **result}


def _move_bands(work: WorkDoc, idx: int, prof: PageProfile, first_i: int, last_i: int,
                target: Dict[str, Any]) -> Dict[str, Any]:
    """Cut bands first_i..last_i out of page idx (closing the gap) and place them verbatim at `target`, a placement
    dict ({page, after_quote | before_quote | position}) or {"index": page index, "position": "page_end"}."""
    page = work.doc[idx]
    snapshot = fitz.open()
    snapshot.insert_pdf(work.doc, from_page=idx, to_page=idx)
    clip = fitz.Rect(0, prof.bands[first_i].y0 - 0.5, prof.width, prof.bands[last_i].y1 + 0.5)
    highlights, _ = collect_annots(page)
    inside = [h for h in highlights if clip.y0 <= (h["rect"].y0 + h["rect"].y1) / 2 <= clip.y1]
    clip_item = ClipItem(snapshot, clip, inside, [], before=0.0)
    removed_text = " ".join(b.text for b in prof.blocks if b.index in sum((prof.bands[i].block_indexes for i in range(first_i, last_i + 1)), []))
    # 1) remove from the source (closing the gap) 2) insert at the target
    work.splice(idx, prof, first_i, last_i + 1, [], MAX_NEW_PAGES_PER_OP)
    quote = target.get("after_quote") or target.get("before_quote")
    if "index" in target:
        t_idx = int(target["index"])
        t_prof = analyze_page(work.doc[t_idx])
        t_keep = len(t_prof.bands)
    elif quote:
        t_origin = int(target["page"])
        t_idx, t_prof, t_found = locate_in_origin(work, t_origin, quote)
        t_band = band_for_rect(t_prof, t_found["rect"])
        if t_band is None:
            raise EditError("anchor_not_in_flow", "Could not place the target anchor in the page flow.")
        bi = t_prof.bands.index(t_band)
        t_keep = bi + 1 if target.get("after_quote") else bi
    elif target.get("position") == "page_start":
        t_idx = _origin_indexes(work, int(target["page"]))[0]
        t_prof = analyze_page(work.doc[t_idx])
        t_keep = 0
    else:
        t_idx = _origin_indexes(work, int(target["page"]))[-1]
        t_prof = analyze_page(work.doc[t_idx])
        t_keep = len(t_prof.bands)
    if abs(t_prof.width - prof.width) > 1 or abs(t_prof.height - prof.height) > 1:
        raise EditError("page_size_mismatch", "Source and target pages have different sizes; moving a section between them is not supported.")
    clip_item.space_before = 0.7 * t_prof.body_size
    result = work.splice(t_idx, t_prof, t_keep, t_keep, [clip_item], MAX_NEW_PAGES_PER_OP)
    return {"kind": "moved", **result, "removed_text": removed_text}


def op_move_section(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    idx, prof, first_i, last_i = _section_range(work, op["from"])
    return _move_bands(work, idx, prof, first_i, last_i, dict(op["to"]))


def _is_running_text(prof: PageProfile, band: Band) -> bool:
    """A one-line text band in the top or bottom margin: a running header or footer, not body content."""
    in_margin = band.y1 <= 0.09 * prof.height or band.y0 >= 0.92 * prof.height
    return in_margin and band.kinds == {"text"} and band.height < 2.2 * prof.body_size


def op_pull_up(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    """Fill the empty space at the bottom of a page with the blocks that start the next page, so the document contracts.
    Whole blocks keep their spacing; the next page closes up and is removed when nothing but its header is left."""
    origin = int(op["page"])
    idx = _origin_indexes(work, origin)[-1]
    nidx = idx + 1
    if nidx >= work.doc.page_count:
        raise EditError("no_next_page", f"Page {origin} is the last page, so there is nothing after it to pull up.")
    prof, nprof = analyze_page(work.doc[idx]), analyze_page(work.doc[nidx])
    if prof.columns > 1 or nprof.columns > 1 or prof.rotation or nprof.rotation:
        raise EditError("unsupported_layout", "Pulling content up is not supported on multi-column or rotated pages.")
    if abs(nprof.width - prof.width) > 1 or abs(nprof.height - prof.height) > 1:
        raise EditError("page_size_mismatch", "The two pages have different sizes.")

    movable = [i for i, b in enumerate(nprof.bands) if not _is_running_text(nprof, b)]
    if not movable:
        raise EditError("nothing_to_pull", "The next page has no body content to pull up.")
    if movable != list(range(movable[0], movable[0] + len(movable))):
        raise EditError("unsupported_layout", "The next page has body content above and below a header/footer; pulling it up is not supported.")
    first = movable[0]

    body_bands = [b for b in prof.bands if not _is_running_text(prof, b)]
    last_y = max((b.y1 for b in body_bands), default=prof.top_margin)
    # Where splice() will put the first pulled block: 0.8 line below the last band, plus the block's own 0.7 line gap.
    dest_top = last_y + 1.5 * prof.body_size
    free = (prof.bottom_limit - 2.0) - dest_top
    first_top = nprof.bands[first].y0 - 0.5
    count = 0
    for i in movable:
        if nprof.bands[i].y1 + 0.5 - first_top <= free:
            count = i - first + 1
        else:
            break
    if count == 0:
        height = nprof.bands[first].y1 - nprof.bands[first].y0
        raise EditError("does_not_fit", f"The first block on the next page is {height:.0f}pt tall but only {max(free, 0):.0f}pt are free at the bottom of page {origin}. Nothing was moved.")

    result = _move_bands(work, nidx, nprof, first, first + count - 1, {"index": idx})

    # the next page may now hold only its running header/footer: remove it
    left = analyze_page(work.doc[nidx])
    if all(_is_running_text(left, b) for b in left.bands):
        _remove_page(work, nidx)
        result["removed_page"] = nidx
    return {**result, "kind": "pulled_up"}


def _remove_page(work: WorkDoc, index: int) -> None:
    tag = work.tags[index]
    for w in work.doc[index].get_text("words"):
        work.removed_tokens[norm_text(w[4])] += 1
    shared = any(other["origin"] == tag["origin"] for j, other in enumerate(work.tags) if j != index)
    if tag["kind"] == "orig" and tag["origin"] is not None and not shared:
        work.deleted_origins.add(tag["origin"])
    work.delete_pages([index])


# ── printed page numbers ────────────────────────────────────────────────────

SERIF_FONT = re.compile(r"times|termes|serif|roman|garamond|palatino|minion|computer modern|cmr|libertin", re.I)


def _margin_number(page: fitz.Page, zone: str) -> Optional[Dict[str, Any]]:
    """The right-most digits-only text span in the top or bottom tenth of the page: the printed page number."""
    height, width = page.rect.height, page.rect.width
    clip = fitz.Rect(0, 0, width, 0.10 * height) if zone == "top" else fitz.Rect(0, 0.90 * height, width, height)
    data = page.get_text("dict", clip=clip, flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    best: Optional[Dict[str, Any]] = None
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span["text"].strip()
                if text.isdigit() and len(text) <= 4 and (best is None or span["bbox"][2] > best["bbox"][2]):
                    best = span
    return best


def _number_line(page: fitz.Page, origin_y: float, size: float) -> fitz.Rect:
    """The text line the page number sits on (a margin tenth also holds body text on a page without a header)."""
    return fitz.Rect(0, origin_y - 1.05 * size, page.rect.width, origin_y + 0.35 * size)


def _header_text_right_edge(page: fitz.Page, origin_y: float, size: float, number_x0: float) -> Optional[float]:
    """Right edge of the running-header text on the page number's line, or None when that line has no text."""
    edges = [w[2] for w in page.get_text("words", clip=_number_line(page, origin_y, size)) if w[2] < number_x0 - 1]
    return max(edges) if edges else None


def _header_rule(page: fitz.Page, origin_y: float, size: float) -> Optional[Dict[str, Any]]:
    """A thin line across the page just under the header text, if the page draws one."""
    for item in page.get_drawings():
        rect = item["rect"]
        if origin_y <= rect.y0 <= origin_y + 0.9 * size and rect.height < 2 and rect.width > 0.5 * page.rect.width and item.get("color"):
            return {"x0": rect.x0, "x1": rect.x1, "y": (rect.y0 + rect.y1) / 2, "color": item["color"], "width": item.get("width") or 0.5}
    return None


def op_renumber_pages(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    """Make the printed page numbers match the page positions again after pages were added, removed or moved.
    Pages that lost their running header (pages created by an earlier edit) get it back from the nearest page that has one."""
    doc = work.doc
    found: Dict[str, List[Optional[Dict[str, Any]]]] = {z: [_margin_number(doc[i], z) for i in range(doc.page_count)] for z in ("top", "bottom")}
    zone = max(found, key=lambda z: sum(1 for c in found[z] if c is not None))
    raw = found[zone]
    if not any(raw):
        raise EditError("no_page_numbers", "This document does not seem to print page numbers in the page header or footer, so there is nothing to renumber.")
    # A page number sits at the same spot on every page. Digits elsewhere in the margin (a list number, a figure in a
    # sentence on a page without a running header) are body text, not page numbers.
    rights = sorted(c["bbox"][2] for c in raw if c is not None)
    ys = sorted(c["origin"][1] for c in raw if c is not None)
    sizes = sorted(c["size"] for c in raw if c is not None)
    mid = len([c for c in raw if c is not None]) // 2
    right, ref_origin_y, ref_size = rights[mid], ys[mid], sizes[mid]
    numbers = [c if c is not None and abs(c["bbox"][2] - right) <= 6 and abs(c["origin"][1] - ref_origin_y) <= 4 else None for c in raw]
    with_number = [i for i, c in enumerate(numbers) if c is not None]
    if len(with_number) < max(2, doc.page_count // 2):
        raise EditError("no_page_numbers", "This document does not seem to print page numbers in the page header or footer, so there is nothing to renumber.")

    offset = int(numbers[with_number[0]]["text"].strip()) - (with_number[0] + 1)  # a document may start at 3, say

    changed: List[int] = []
    for i in range(doc.page_count):
        page = doc[i]
        want = str(i + 1 + offset)
        cand = numbers[i]
        if cand is not None and cand["text"].strip() == want:
            continue

        size = float(cand["size"]) if cand is not None else float(ref_size)
        origin_y = float(cand["origin"][1]) if cand is not None else float(ref_origin_y)
        right_edge = float(cand["bbox"][2]) if cand is not None else float(right)
        font_name = cand["font"] if cand is not None else next(c["font"] for c in numbers if c is not None)
        colour = fitz.sRGB_to_pdf(cand["color"]) if cand is not None else (0, 0, 0)

        if cand is not None:
            work.redact_rect(i, fitz.Rect(cand["bbox"]) + (-0.5, -0.5, 0.5, 0.5))
        elif _header_text_right_edge(page, origin_y, size, right_edge - 8) is None:
            # the page lost its running header: copy it (without the number) from the nearest page that still has one
            donor = min((j for j in with_number
                         if _header_text_right_edge(doc[j], float(numbers[j]["origin"][1]), float(numbers[j]["size"]), numbers[j]["bbox"][0]) is not None),
                        key=lambda j: abs(j - i), default=None)
            if donor is not None:
                dp, dn = doc[donor], numbers[donor]
                dy, dsize = float(dn["origin"][1]), float(dn["size"])
                edge = _header_text_right_edge(dp, dy, dsize, dn["bbox"][0])
                line = _number_line(dp, dy, dsize)
                clip = fitz.Rect(0, line.y0, float(edge) + 3, line.y1)
                ref = fitz.open()
                ref.insert_pdf(doc, from_page=donor, to_page=donor)
                page.show_pdf_page(clip, ref, 0, clip=clip)
                ref.close()
                rule = _header_rule(dp, dy, dsize)
                if rule:
                    page.draw_line(fitz.Point(rule["x0"], rule["y"]), fitz.Point(rule["x1"], rule["y"]), color=rule["color"], width=rule["width"])

        font = "tiro" if SERIF_FONT.search(font_name or "") else "helv"
        width = fitz.get_text_length(want, fontname=font, fontsize=size)
        page.insert_text(fitz.Point(right_edge - width, origin_y), want, fontname=font, fontsize=size, color=colour)
        if work.tags[i]["kind"] != "added":
            work.tags[i]["kind"] = "changed"
        changed.append(i)

    if not changed:
        raise EditError("already_numbered", "The printed page numbers already match the page positions.")

    mentions = []
    for i in range(doc.page_count):
        for m in re.finditer(r"\b(?:pages?|pp?\.)\s*\d{1,4}\b", doc[i].get_text()):
            mentions.append(f"p.{i + 1}: \"{m.group(0)}\"")
    if mentions:
        work.warnings.append({"severity": "warning", "code": "page_mentions", "message":
                              "The text mentions page numbers (" + "; ".join(mentions[:4]) + ("; …" if len(mentions) > 4 else "") +
                              "). Renumbering does not rewrite them; check they still point to the right page."})
    return {"kind": "renumbered", "pages": changed}


def op_clean_file(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    """Remove the invisible duplicate copies earlier edits left inside pages. Nothing visible changes."""
    changed: List[int] = []
    removed = 0
    for i in range(work.doc.page_count):
        count = prune_page_fully(work.doc, work.doc[i])
        if count:
            removed += count
            changed.append(i)
            if work.tags[i]["kind"] != "added":
                work.tags[i]["kind"] = "changed"
    if not changed:
        raise EditError("nothing_to_clean", "The file has no hidden duplicate content to remove.")
    return {"kind": "cleaned", "pages": changed, "removed_references": removed}


OP_HANDLERS: Dict[str, Callable[[WorkDoc, Dict[str, Any], Callable[[str], str]], Dict[str, Any]]] = {
    "insert_content": op_insert_content,
    "replace_passage": op_replace_passage,
    "delete_passage": op_delete_passage,
    "delete_pages": op_delete_pages,
    "move_pages": op_move_pages,
    "move_section": op_move_section,
    "delete_section": op_delete_section,
    "pull_up": op_pull_up,
    "renumber_pages": op_renumber_pages,
    "clean_file": op_clean_file,
}


def apply_ops(work: WorkDoc, ops: List[Dict[str, Any]], refs: Optional[Dict[int, int]]) -> List[Dict[str, Any]]:
    resolver = make_resolver(refs)
    results: List[Dict[str, Any]] = []
    for number, op in enumerate(ops, start=1):
        handler = OP_HANDLERS.get(op.get("type", ""))
        if handler is None:
            raise EditError("unknown_op", f"Unknown operation type '{op.get('type')}'.")
        try:
            results.append({"op": number, "type": op["type"], **handler(work, op, resolver)})
        except EditError as err:
            err.extra.setdefault("op", number)
            raise
    return results
