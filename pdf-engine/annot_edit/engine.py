"""Build a candidate document from a proposal: check -> apply -> verify the real result -> previews."""
from __future__ import annotations

import json
import os
import re
import tempfile
import traceback
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

import fitz

from .checks import content_strings, dependents_and_refs, numbering_mode, run_checks
from .flow import WorkDoc
from .ops import apply_ops, page_ref_map
from .util import EditError, area, issue, norm_text

PREVIEW_DPI = 100
MAX_AFTER_PREVIEWS = 6
MAX_BEFORE_PREVIEWS = 4


def _tokens(page: fitz.Page) -> Counter:
    return Counter(norm_text(w[4]) for w in page.get_text("words"))


def verify_result(work: WorkDoc, orig: fitz.Document, proposal: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Inspect the *actual* resulting document, not the intent."""
    problems: List[Dict[str, Any]] = []
    doc = work.doc
    if doc.page_count != len(work.tags):
        problems.append(issue("error", "page_bookkeeping", "Internal page bookkeeping does not match the resulting document."))
        return problems

    # 1. pages the edit did not touch must be unchanged
    for i, tag in enumerate(work.tags):
        if tag["kind"] == "orig" and tag["origin"] is not None:
            before = norm_text(orig[tag["origin"] - 1].get_text())
            after = norm_text(doc[i].get_text())
            if before != after:
                problems.append(issue("error", "untouched_page_changed", f"Page {tag['origin']} was not part of the edit but its text changed."))

    # 2. nothing original may be lost except what the edit removes on purpose
    touched = {t["origin"] for t in work.tags if t["kind"] != "orig" and t["origin"] is not None}
    touched = {o for o in touched if o not in work.deleted_origins}
    expected: Counter = Counter()
    for origin in touched:
        expected += _tokens(orig[origin - 1])
    expected.subtract(work.removed_tokens)
    got: Counter = Counter()
    for i, tag in enumerate(work.tags):
        if tag["origin"] in touched:
            got += _tokens(doc[i])
    lost = [(w, n - got.get(w, 0)) for w, n in expected.items() if n > 0 and got.get(w, 0) < n and w]
    if lost:
        sample = ", ".join(f"'{w}'" for w, _ in lost[:6])
        problems.append(issue("error", "content_lost", f"Original text went missing from the edited pages ({sample}…). The edit was rejected so nothing is lost."))

    # 3. geometry: no overlaps, nothing outside the page
    pages_by_xref = {doc[i].xref: i for i in range(doc.page_count)}
    for xref, placed in work.placements.items():
        if xref not in pages_by_xref:
            continue
        pno = pages_by_xref[xref]
        page_rect = doc[pno].rect
        for idx, (rect, kind) in enumerate(placed):
            if rect.x0 < -1 or rect.y0 < -1 or rect.x1 > page_rect.x1 + 1 or rect.y1 > page_rect.y1 + 1:
                problems.append(issue("error", "outside_page", f"New content on page {pno + 1} extends past the page edge."))
            for other_rect, other_kind in placed[idx + 1:]:
                if area(rect & other_rect) > 1.5:
                    problems.append(issue("error", "overlap", f"Content on page {pno + 1} overlaps other content ({kind} vs {other_kind})."))

    # 4. no blank added pages
    for i, tag in enumerate(work.tags):
        if tag["kind"] == "added" and not doc[i].get_text().strip() and not work.placements.get(doc[i].xref):
            problems.append(issue("error", "blank_page", f"The edit left an empty page at {i + 1}."))

    # 5. pixels: new content is really visible
    for xref, placed in work.placements.items():
        if xref not in pages_by_xref:
            continue
        page = doc[pages_by_xref[xref]]
        for rect, kind in placed:
            if kind != "new" or rect.width < 4 or rect.height < 4:
                continue
            clip = fitz.Rect(rect) & page.rect
            if clip.is_empty:
                continue
            pix = page.get_pixmap(dpi=36, clip=clip)
            samples = pix.samples
            if samples and min(samples) > 250:
                problems.append(issue("error", "invisible_content", f"Content placed on page {pages_by_xref[xref] + 1} rendered as blank."))

    # 6. new text is extractable / searchable
    result_text = norm_text(" ".join(doc[i].get_text() for i, t in enumerate(work.tags) if t["kind"] != "orig"))
    missing: List[str] = []
    for _, kind, string in content_strings(proposal["ops"]):
        for word in norm_text(re.sub(r"\{\{page:\d+\}\}", "", string)).split(" ")[:14]:
            if len(word) > 2 and word not in result_text:
                missing.append(word)
    if missing:
        problems.append(issue("error", "text_not_extractable", f"Some new text is not present as real text in the result ({', '.join(sorted(set(missing))[:6])}). It may use characters the font cannot render."))
    return problems


def _marks(work: WorkDoc) -> List[Dict[str, Any]]:
    return [{"page": i + 1, "kind": t["kind"], "origin": t["origin"]} for i, t in enumerate(work.tags) if t["kind"] != "orig"]


def _overlay(page: fitz.Page, rect: fitz.Rect, color: Tuple[float, float, float]) -> None:
    shape = page.new_shape()
    shape.draw_rect(fitz.Rect(rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2))
    shape.finish(color=color, fill=color, width=1.2, fill_opacity=0.10, stroke_opacity=0.9)
    shape.commit()


def render_previews(orig: fitz.Document, work: WorkDoc, out_dir: str) -> List[Dict[str, Any]]:
    os.makedirs(out_dir, exist_ok=True)
    manifest: List[Dict[str, Any]] = []
    marks = _marks(work)
    after_pages = [m["page"] for m in marks][:MAX_AFTER_PREVIEWS]
    overlay_doc = fitz.open("pdf", work.doc.tobytes())
    pages_by_xref = {work.doc[i].xref: i for i in range(work.doc.page_count)}
    for xref, placed in work.placements.items():
        if xref in pages_by_xref:
            target = overlay_doc[pages_by_xref[xref]]
            for rect, kind in placed:
                if kind == "new":
                    _overlay(target, rect, (0.1, 0.6, 0.25))

    wanted: List[Tuple[str, int]] = []
    if after_pages:
        first, last = after_pages[0], after_pages[-1]
        if first > 1 and work.tags[first - 2]["kind"] == "orig":
            wanted.append(("context", first - 1))
        wanted += [("after", p) for p in after_pages]
        if last < work.doc.page_count and work.tags[last]["kind"] == "orig":
            wanted.append(("context", last + 1))
    for role, page_no in wanted:
        file_name = f"{role}-{page_no}.png"
        overlay_doc[page_no - 1].get_pixmap(dpi=PREVIEW_DPI).save(os.path.join(out_dir, file_name))
        kind = work.tags[page_no - 1]["kind"]
        label = {"added": "New page", "changed": "Changed page", "orig": "Unchanged page"}[kind]
        manifest.append({"role": role, "page": page_no, "label": f"{label} {page_no}", "file": file_name, "kind": kind})
    overlay_doc.close()

    before_origins: List[int] = []
    for m in marks:
        if m["kind"] == "changed" and m["origin"] not in before_origins:
            before_origins.append(m["origin"])
    for origin in sorted(work.deleted_origins):
        if origin not in before_origins:
            before_origins.append(origin)
    for origin in before_origins[:MAX_BEFORE_PREVIEWS]:
        scratch = fitz.open("pdf", orig.tobytes())
        page = scratch[origin - 1]
        for removed_origin, rect in work.removed_rects:
            if removed_origin == origin:
                _overlay(page, rect, (0.75, 0.15, 0.12))
        file_name = f"before-{origin}.png"
        page.get_pixmap(dpi=PREVIEW_DPI).save(os.path.join(out_dir, file_name))
        manifest.append({"role": "before", "page": origin, "label": f"Original page {origin}", "file": file_name,
                         "kind": "deleted" if origin in work.deleted_origins else "orig"})
        scratch.close()
    return manifest


def build(payload: Dict[str, Any]) -> Dict[str, Any]:
    pdf_path = payload["pdfPath"]
    out_path = payload.get("outPath")
    proposal = payload["proposal"]
    preview_dir = payload.get("previewDir")
    orig = fitz.open(pdf_path)
    try:
        issues, info = run_checks(orig, proposal)
        if any(i["severity"] == "error" for i in issues):
            return {"ok": False, "stage": "checks", "issues": issues}

        # Page references written as {{page:N}}: with printed page numbers N stays N; otherwise N follows the page.
        has_refs = "{{page:" in json.dumps(proposal["ops"]) and numbering_mode(orig) == "index"
        work: Optional[WorkDoc] = None
        try:
            work = WorkDoc(pdf_path)
            results = apply_ops(work, proposal["ops"], None)
            if has_refs:
                refs = page_ref_map(work)
                work.doc.close()
                work = WorkDoc(pdf_path)
                results = apply_ops(work, proposal["ops"], refs)
                if page_ref_map(work) != refs:
                    raise EditError("page_reference_unstable", "Page numbers used in cross-references moved while placing them. Reduce the amount of new content.")
        except EditError as err:
            return {"ok": False, "stage": "apply", "issues": issues + [err.as_issue()]}

        problems = verify_result(work, orig, proposal)
        issues += problems
        issues += work.warnings
        if any(i["severity"] == "error" for i in issues):
            return {"ok": False, "stage": "verify", "issues": issues}

        page_map = page_ref_map(work)
        issues += dependents_and_refs(orig, proposal, page_map)
        marks = _marks(work)

        if out_path:
            handle, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(out_path) or None)
            os.close(handle)
            try:
                work.doc.save(tmp_path, garbage=3, deflate=True)
                check = fitz.open(tmp_path)
                if check.page_count != len(work.tags):
                    raise EditError("save_mismatch", "The saved candidate has the wrong number of pages.")
                for i in range(check.page_count):
                    check[i].get_text()  # forces every page to parse
                check.close()
                os.replace(tmp_path, out_path)
            except Exception:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                raise

        previews = render_previews(orig, work, preview_dir) if preview_dir else []
        stats = {
            "pagesBefore": orig.page_count,
            "pagesAfter": work.doc.page_count,
            "addedPages": sum(1 for t in work.tags if t["kind"] == "added"),
            "changedPages": sum(1 for t in work.tags if t["kind"] == "changed"),
            "droppedHighlights": work.dropped_highlights,
            "droppedAnnotations": work.dropped_other_annots,
            "removedWords": sum(work.removed_tokens.values()),
        }
        return {
            "ok": True, "issues": issues, "pageMap": [{"original": k, "current": v} for k, v in sorted(page_map.items())],
            "marks": marks, "previews": previews, "stats": stats, "results": results,
            "destructive": info["destructive"],
        }
    except EditError as err:
        return {"ok": False, "stage": "apply", "issues": [err.as_issue()]}
    except Exception as err:  # never leave a half-written candidate or report success
        return {"ok": False, "stage": "internal", "issues": [issue("error", "internal_error", f"Unexpected failure while building the edit: {err}", trace=traceback.format_exc(limit=4))]}
    finally:
        orig.close()
