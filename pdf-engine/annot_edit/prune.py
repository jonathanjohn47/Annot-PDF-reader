"""Remove hidden copies from page content.

Moving a block of a page (show_pdf_page) embeds the *whole* source page as a clipped form. After a few edits a page
holds forms inside forms, and most of them are clipped away: invisible, yet a viewer still has to run every one of
them (hundreds of thousands of operators on one page). This pass walks the form tree of a page, tracks the clip each
form imposes, and deletes every `/Name Do` whose form or image lies entirely outside what can be seen. Only things
that cannot be seen are removed; the page is compared before and after and restored if anything differs.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Dict, List, Optional, Tuple

import fitz

TOKEN = re.compile(rb"%[^\r\n]*|/[^\s()<>\[\]{}/%]*|\((?:\\.|[^\\()])*\)|<<|>>|\[|\]|<[0-9A-Fa-f\s]*>|[^\s()<>\[\]{}/%]+", re.S)
NUMBER = re.compile(rb"^[+-]?(?:\d+\.?\d*|\.\d+)$")
REF = re.compile(r"/([^\s/<>\[\]()]+)\s+(\d+)\s+0\s+R")
MAX_DEPTH = 40

Matrix6 = Tuple[float, float, float, float, float, float]
IDENTITY: Matrix6 = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _mul(a: Matrix6, b: Matrix6) -> Matrix6:
    """a followed by b (PDF row-vector convention)."""
    return (
        a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
    )


def _bounds(rect: Tuple[float, float, float, float], m: Matrix6) -> Tuple[float, float, float, float]:
    xs, ys = [], []
    for x, y in ((rect[0], rect[1]), (rect[2], rect[1]), (rect[0], rect[3]), (rect[2], rect[3])):
        xs.append(x * m[0] + y * m[2] + m[4])
        ys.append(x * m[1] + y * m[3] + m[5])
    return min(xs), min(ys), max(xs), max(ys)


def _meet(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> Optional[Tuple[float, float, float, float]]:
    out = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return out if out[2] - out[0] > 0.01 and out[3] - out[1] > 0.01 else None


def _numbers(doc: fitz.Document, xref: int, key: str) -> Optional[List[float]]:
    kind, value = doc.xref_get_key(xref, key)
    if kind != "array":
        return None
    try:
        return [float(v) for v in value.strip("[] ").split()]
    except ValueError:
        return None


def _xobjects(doc: fitz.Document, owner: int) -> Dict[str, int]:
    """Name -> xref of the XObjects in the resources of a page or form."""
    node = owner
    for _ in range(6):
        kind, value = doc.xref_get_key(node, "Resources/XObject")
        if kind == "xref":
            value = doc.xref_object(int(value.split()[0]), compressed=True)
            kind = "dict"
        if kind == "dict":
            return {name: int(ref) for name, ref in REF.findall(value)}
        pk, pv = doc.xref_get_key(node, "Parent")
        if pk != "xref":
            break
        node = int(pv.split()[0])
    return {}


class _Plan:
    def __init__(self) -> None:
        self.cuts: Dict[int, List[Tuple[int, int, str]]] = {}   # stream owner -> (start, end, name)
        self.visits: Counter = Counter()
        self.data: Dict[int, bytes] = {}
        self.failed = False


def _walk(doc: fitz.Document, owner: int, data: bytes, ctm: Matrix6, clip: Tuple[float, float, float, float],
          depth: int, plan: _Plan) -> None:
    if depth > MAX_DEPTH:
        plan.failed = True
        return
    plan.data[owner] = data
    names = _xobjects(doc, owner)
    stack: List[Matrix6] = []
    cur = ctm
    last: List[Tuple[bytes, int, int]] = []
    for match in TOKEN.finditer(data):
        token = match.group()
        if token[:1] == b"%":
            continue
        if token == b"BI":
            plan.failed = True      # inline image: do not try to interpret this stream
            return
        if token == b"q":
            stack.append(cur)
        elif token == b"Q":
            if stack:
                cur = stack.pop()
        elif token == b"cm" and len(last) >= 6 and all(NUMBER.match(t[0]) for t in last[-6:]):
            cur = _mul(tuple(float(t[0]) for t in last[-6:]), cur)  # type: ignore[arg-type]
        elif token == b"Do" and last and last[-1][0][:1] == b"/":
            name_token, start, _ = last[-1]
            name = name_token[1:].decode("latin-1")
            target = names.get(name)
            if target is None:
                last.append((token, match.start(), match.end()))
                continue
            subtype = doc.xref_get_key(target, "Subtype")[1]
            if subtype == "/Image":
                box = _bounds((0, 0, 1, 1), cur)
                if _meet(box, clip) is None:
                    plan.cuts.setdefault(owner, []).append((start, match.end(), name))
            elif subtype == "/Form":
                bbox = _numbers(doc, target, "BBox")
                matrix = _numbers(doc, target, "Matrix")
                if bbox is None or len(bbox) != 4:
                    last.append((token, match.start(), match.end()))
                    continue
                inner = _mul(tuple(matrix) if matrix and len(matrix) == 6 else IDENTITY, cur)  # type: ignore[arg-type]
                seen = _meet(_bounds(tuple(bbox), inner), clip)  # type: ignore[arg-type]
                if seen is None:
                    plan.cuts.setdefault(owner, []).append((start, match.end(), name))
                else:
                    plan.visits[target] += 1
                    if plan.visits[target] == 1:
                        _walk(doc, target, doc.xref_stream(target) or b"", inner, seen, depth + 1, plan)
        last.append((token, match.start(), match.end()))
        if len(last) > 8:
            del last[0]


def _render(page: fitz.Page) -> bytes:
    return page.get_pixmap(dpi=50, colorspace=fitz.csGRAY, annots=False).samples


def prune_hidden(doc: fitz.Document, page: fitz.Page) -> int:
    """Delete invisible forms/images from the content of `page`. Returns how many references were removed."""
    if page.rotation:
        return 0
    box = fitz.Rect(page.mediabox)
    if abs(box.x0) > 0.01 or abs(box.y0) > 0.01 or abs(page.rect.width - box.width) > 0.5 or abs(page.rect.height - box.height) > 0.5:
        return 0
    contents = page.get_contents()
    if not contents or not page.get_xobjects():
        return 0
    page_data = b"\n".join(doc.xref_stream(x) or b"" for x in contents)

    plan = _Plan()
    plan.visits[page.xref] = 1
    _walk(doc, page.xref, page_data, IDENTITY, (box.x0, box.y0, box.x1, box.y1), 0, plan)
    if plan.failed or not plan.cuts:
        return 0

    # Forms made by one splice are shared by every page that block was drawn on: only touch what this page owns.
    others = set()
    for i in range(doc.page_count):
        if doc[i].number != page.number:
            others.update(item[0] for item in doc[i].get_xobjects())
    res_kind, res_value = doc.xref_get_key(page.xref, "Resources")
    resources_unshared = res_kind != "xref" or sum(
        1 for i in range(doc.page_count) if doc.xref_get_key(doc[i].xref, "Resources") == (res_kind, res_value)) == 1
    before = _render(page)
    backups: List[Tuple[str, int, object]] = []
    removed = 0
    for owner, cuts in plan.cuts.items():
        if plan.visits[owner] != 1 or owner in others:
            continue    # reached from several places (clipped differently at each) or from another page: leave it alone
        data = plan.data[owner]
        out, pos, gone = [], 0, set()
        for start, end, name in sorted(cuts):
            out.append(data[pos:start])
            out.append(b" ")
            pos = end
            gone.add(name)
            removed += 1
        out.append(data[pos:])
        new_data = b"".join(out)
        if owner == page.xref:
            backups.append(("stream", contents[0], doc.xref_stream(contents[0])))
            for extra in contents[1:]:
                backups.append(("stream", extra, doc.xref_stream(extra)))
                doc.update_stream(extra, b" ")
            doc.update_stream(contents[0], new_data)
        else:
            backups.append(("stream", owner, doc.xref_stream(owner)))
            doc.update_stream(owner, new_data)
        still_used = {m.group()[1:].decode("latin-1") for m in re.finditer(rb"/[^\s()<>\[\]{}/%]+(?=\s+Do\b)", new_data)}
        for name in gone - still_used:
            kind, value = doc.xref_get_key(owner, "Resources/XObject")
            if owner == page.xref:
                owned = resources_unshared
            else:
                owned = doc.xref_get_key(owner, "Resources")[0] == "dict"   # inline in this form: nothing else can share it
            if kind == "dict" and owned:
                backups.append(("key", owner, (f"Resources/XObject/{name}", doc.xref_get_key(owner, f"Resources/XObject/{name}")[1])))
                doc.xref_set_key(owner, f"Resources/XObject/{name}", "null")

    if _render(page) != before:
        for kind, xref, saved in reversed(backups):
            if kind == "stream":
                doc.update_stream(xref, saved)  # type: ignore[arg-type]
            else:
                key, value = saved  # type: ignore[misc]
                doc.xref_set_key(xref, key, value)
        return 0
    return removed


def prune_page_fully(doc: fitz.Document, page: fitz.Page, passes: int = 5) -> int:
    """Repeat prune_hidden until nothing more can be removed (cutting a branch can make its siblings unshared)."""
    total = 0
    for _ in range(passes):
        removed = prune_hidden(doc, page)
        total += removed
        if not removed:
            break
    return total
