"""Typed operations: resolve anchors against the live document, build layout items, apply through the flow engine."""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

import fitz

from .blocks import ClipItem, Item, ParagraphItem, Style, build_items
from .flow import WorkDoc, collect_annots
from .pagemodel import (PageProfile, Band, TextBlock, analyze_page, band_for_rect, block_for_rect, block_text,
                        find_quote)
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


def op_move_section(work: WorkDoc, op: Dict[str, Any], resolver: Callable[[str], str]) -> Dict[str, Any]:
    src = op["from"]
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
        raise EditError("multi_column_layout", "Moving sections is not supported on multi-column pages.")
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
    target = dict(op["to"])
    insert_op = {"type": "insert_content", "placement": target, "blocks": [], "provenance_label": False}
    t_origin = int(target["page"])
    t_indexes = _origin_indexes(work, t_origin)
    quote = target.get("after_quote") or target.get("before_quote")
    if quote:
        t_idx, t_prof, t_found = locate_in_origin(work, t_origin, quote)
        t_band = band_for_rect(t_prof, t_found["rect"])
        if t_band is None:
            raise EditError("anchor_not_in_flow", "Could not place the target anchor in the page flow.")
        bi = t_prof.bands.index(t_band)
        t_keep = bi + 1 if target.get("after_quote") else bi
    elif target.get("position") == "page_start":
        t_idx = t_indexes[0]
        t_prof = analyze_page(work.doc[t_idx])
        t_keep = 0
    else:
        t_idx = t_indexes[-1]
        t_prof = analyze_page(work.doc[t_idx])
        t_keep = len(t_prof.bands)
    if abs(t_prof.width - prof.width) > 1 or abs(t_prof.height - prof.height) > 1:
        raise EditError("page_size_mismatch", "Source and target pages have different sizes; moving a section between them is not supported.")
    clip_item.space_before = 0.7 * t_prof.body_size
    result = work.splice(t_idx, t_prof, t_keep, t_keep, [clip_item], MAX_NEW_PAGES_PER_OP)
    return {"kind": "moved", **result, "removed_text": removed_text}


OP_HANDLERS: Dict[str, Callable[[WorkDoc, Dict[str, Any], Callable[[str], str]], Dict[str, Any]]] = {
    "insert_content": op_insert_content,
    "replace_passage": op_replace_passage,
    "delete_passage": op_delete_passage,
    "delete_pages": op_delete_pages,
    "move_pages": op_move_pages,
    "move_section": op_move_section,
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
