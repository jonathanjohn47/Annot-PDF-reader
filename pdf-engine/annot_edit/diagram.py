"""Typed diagrams -> vector PDF. Hierarchy, flow and timeline layouts with built-in geometry validation.

The model supplies structure (nodes, edges, levels); this module owns all positions, so labels cannot be
mis-placed by hand. Text is real text (selectable, searchable). Every drawn diagram is validated:
no overlapping nodes, no connector through an unrelated node, nothing outside the canvas, text not
clipped, and a minimum effective font size after scaling to the page width.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import fitz

from .textlayout import draw_html, inline_html, measure_html, plain_text, text_width
from .util import EditError, area, norm_text

LABEL_SIZE = 9.5
SUB_SIZE = 8.0
SMALL_SIZE = 8.0
NODE_MAX_W = 150.0
NODE_MIN_W = 56.0
NODE_PAD_X = 7.0
NODE_PAD_Y = 5.0
LEVEL_GAP = 30.0
SIBLING_GAP = 14.0
CANVAS_PAD = 6.0
MIN_SCALE = 0.85

STYLES = {
    "plain": {"fill": (1, 1, 1), "stroke": (0.36, 0.40, 0.44), "text": "#1d2429"},
    "primary": {"fill": (0.89, 0.93, 0.98), "stroke": (0.17, 0.36, 0.61), "text": "#15324f"},
    "secondary": {"fill": (0.89, 0.95, 0.92), "stroke": (0.18, 0.48, 0.31), "text": "#17402a"},
    "result": {"fill": (0.99, 0.94, 0.84), "stroke": (0.72, 0.47, 0.12), "text": "#5b3a06"},
    "muted": {"fill": (0.945, 0.945, 0.945), "stroke": (0.60, 0.60, 0.60), "text": "#444444"},
}
RELATIONS = ("contains", "then", "computed_from", "association", "causes")
EDGE_LEGEND = {
    "then": "next step (order in time)",
    "computed_from": "computed from",
    "association": "association only (no causal claim)",
    "causes": "causal link (supported by the document)",
}


@dataclass
class Node:
    id: str
    label: str
    sublabel: str = ""
    style: str = "plain"
    level: Optional[int] = None
    repeat: Optional[int] = None
    rect: fitz.Rect = field(default_factory=lambda: fitz.Rect(0, 0, 0, 0))
    w: float = 0.0
    h: float = 0.0


@dataclass
class DiagramResult:
    doc: fitz.Document
    width: float
    height: float
    texts: List[str]
    min_font: float
    warnings: List[str]
    kind: str


def _html_for_node(node: Node) -> Tuple[str, str]:
    style = STYLES.get(node.style, STYLES["plain"])
    css = (
        f".n{{font-family:sans-serif;color:{style['text']};text-align:center;}}"
        f".n .l{{font-size:{LABEL_SIZE}pt;font-weight:bold;line-height:1.15;}}"
        f".n .s{{font-size:{SUB_SIZE}pt;line-height:1.15;}}"
    )
    body = f"<div class='n'><div class='l'>{inline_html(node.label)}</div>"
    if node.sublabel:
        body += f"<div class='s'>{inline_html(node.sublabel)}</div>"
    body += "</div>"
    return body, css


def _measure_node(node: Node) -> None:
    natural = max(
        text_width(plain_text(node.label), LABEL_SIZE, bold=True),
        text_width(plain_text(node.sublabel), SUB_SIZE) if node.sublabel else 0.0,
    )
    width = max(NODE_MIN_W, min(NODE_MAX_W, natural * 1.14 + 2 * NODE_PAD_X))
    html, css = _html_for_node(node)
    inner = measure_html(html, css, width - 2 * NODE_PAD_X)
    node.w = width
    node.h = inner + 2 * NODE_PAD_Y


# ── spec normalisation ──────────────────────────────────────────────────────

def _normalise(spec: Dict[str, Any]) -> Tuple[str, List[Node], List[Dict[str, Any]]]:
    kind = spec.get("kind")
    if kind not in ("hierarchy", "flow", "timeline"):
        raise EditError("diagram_kind", f"Unknown diagram kind '{kind}'. Use hierarchy, flow or timeline.")
    nodes: List[Node] = []
    seen = set()
    for raw in spec.get("nodes", []):
        node_id = str(raw.get("id", "")).strip()
        if not node_id or node_id in seen:
            raise EditError("diagram_node_id", f"Diagram node id missing or duplicated: '{node_id}'.")
        seen.add(node_id)
        style = raw.get("style", "plain") or "plain"
        if style not in STYLES:
            raise EditError("diagram_style", f"Unknown node style '{style}'. Use: {', '.join(STYLES)}.")
        nodes.append(Node(
            id=node_id, label=str(raw.get("label", "")).strip(), sublabel=str(raw.get("sublabel", "") or "").strip(),
            style=style, level=raw.get("level"), repeat=raw.get("repeat"),
        ))
    if not nodes:
        raise EditError("diagram_empty", "Diagram has no nodes.")
    for node in nodes:
        if not node.label:
            raise EditError("diagram_label", f"Diagram node '{node.id}' has no label.")
    edges: List[Dict[str, Any]] = []
    for raw in spec.get("edges", []) or []:
        a, b = str(raw.get("from")), str(raw.get("to"))
        if a not in seen or b not in seen:
            raise EditError("diagram_edge", f"Edge {a} -> {b} refers to a node that does not exist.")
        relation = raw.get("relation", "then")
        if relation not in RELATIONS:
            raise EditError("diagram_relation", f"Unknown edge relation '{relation}'. Use: {', '.join(RELATIONS)}.")
        edges.append({"from": a, "to": b, "label": str(raw.get("label", "") or "").strip(), "relation": relation})
    return kind, nodes, edges


def _assign_levels(kind: str, nodes: List[Node], edges: List[Dict[str, Any]]) -> Dict[str, int]:
    """Level (layer) per node. Explicit levels win; otherwise longest path from sources."""
    by_id = {n.id: n for n in nodes}
    if all(n.level is not None for n in nodes):
        return {n.id: int(n.level) for n in nodes}  # type: ignore[arg-type]
    layer_edges = [e for e in edges if (e["relation"] == "contains") or kind == "flow"]
    if kind == "hierarchy" and not layer_edges:
        layer_edges = [e for e in edges if e["relation"] in ("contains", "then")]
    incoming: Dict[str, List[str]] = {n.id: [] for n in nodes}
    for e in layer_edges:
        incoming[e["to"]].append(e["from"])
    level: Dict[str, int] = {}
    visiting: set = set()

    def resolve(node_id: str) -> int:
        if node_id in level:
            return level[node_id]
        if node_id in visiting:
            raise EditError("diagram_cycle", "Diagram edges form a cycle; hierarchy and flow diagrams must be acyclic.")
        visiting.add(node_id)
        explicit = by_id[node_id].level
        value = int(explicit) if explicit is not None else (
            max((resolve(p) + 1 for p in incoming[node_id]), default=0)
        )
        visiting.discard(node_id)
        level[node_id] = value
        return value

    for n in nodes:
        resolve(n.id)
    return level


# ── geometry helpers ────────────────────────────────────────────────────────

def _border_point(rect: fitz.Rect, toward: fitz.Point) -> fitz.Point:
    cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
    dx, dy = toward.x - cx, toward.y - cy
    if dx == 0 and dy == 0:
        return fitz.Point(cx, cy)
    scale = min(
        (rect.width / 2) / abs(dx) if dx else math.inf,
        (rect.height / 2) / abs(dy) if dy else math.inf,
    )
    return fitz.Point(cx + dx * scale, cy + dy * scale)


def _segment_hits_rect(p: fitz.Point, q: fitz.Point, rect: fitz.Rect, shrink: float = 1.0) -> bool:
    r = fitz.Rect(rect.x0 + shrink, rect.y0 + shrink, rect.x1 - shrink, rect.y1 - shrink)
    if r.is_empty:
        return False
    steps = max(8, int(max(abs(q.x - p.x), abs(q.y - p.y)) / 2))
    for i in range(steps + 1):
        t = i / steps
        x, y = p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t
        if r.x0 <= x <= r.x1 and r.y0 <= y <= r.y1:
            return True
    return False


class _Canvas:
    """Collects drawing commands so size is known before the page is created."""

    def __init__(self) -> None:
        self.ops: List[Tuple[str, Any]] = []
        self.texts: List[str] = []
        self.bounds = fitz.Rect(1e9, 1e9, -1e9, -1e9)
        self.label_rects: List[Tuple[fitz.Rect, str]] = []

    def include(self, rect: fitz.Rect) -> None:
        self.bounds |= rect

    def add(self, name: str, **kw: Any) -> None:
        self.ops.append((name, kw))


# ── layouts ─────────────────────────────────────────────────────────────────

def _layout_hierarchy(nodes: List[Node], edges: List[Dict[str, Any]], levels: Dict[str, int], gutter: float) -> List[str]:
    """Tidy tree: children laid left-to-right under the parent. Returns warnings."""
    by_id = {n.id: n for n in nodes}
    contains = [e for e in edges if e["relation"] == "contains"]
    parent_of: Dict[str, str] = {}
    children: Dict[str, List[str]] = {n.id: [] for n in nodes}
    for e in contains:
        if e["to"] in parent_of:
            raise EditError("diagram_two_parents", f"Node '{e['to']}' has two 'contains' parents. Use relation 'computed_from' or 'association' for the second link.")
        parent_of[e["to"]] = e["from"]
        children[e["from"]].append(e["to"])
    for node_id, parent in parent_of.items():
        if levels[node_id] <= levels[parent]:
            raise EditError("diagram_levels", f"Node '{node_id}' must sit at a deeper level than its container '{parent}'.")
    roots = [n.id for n in nodes if n.id not in parent_of]
    span: Dict[str, float] = {}

    def subtree(node_id: str) -> float:
        kids = children[node_id]
        kid_total = sum(subtree(k) for k in kids) + SIBLING_GAP * max(0, len(kids) - 1)
        span[node_id] = max(by_id[node_id].w, kid_total)
        return span[node_id]

    for r in roots:
        subtree(r)

    # row heights per level
    level_ids = sorted(set(levels.values()))
    row_h = {lv: max(n.h for n in nodes if levels[n.id] == lv) for lv in level_ids}
    row_y: Dict[int, float] = {}
    y = CANVAS_PAD
    for lv in level_ids:
        row_y[lv] = y
        y += row_h[lv] + LEVEL_GAP

    def place(node_id: str, left: float) -> None:
        node = by_id[node_id]
        width = span[node_id]
        cx = left + width / 2
        lv = levels[node_id]
        node.rect = fitz.Rect(cx - node.w / 2, row_y[lv] + (row_h[lv] - node.h) / 2,
                              cx + node.w / 2, row_y[lv] + (row_h[lv] - node.h) / 2 + node.h)
        kids = children[node_id]
        kid_total = sum(span[k] for k in kids) + SIBLING_GAP * max(0, len(kids) - 1)
        cursor = left + (width - kid_total) / 2
        for k in kids:
            place(k, cursor)
            cursor += span[k] + SIBLING_GAP

    incoming_any: Dict[str, List[str]] = {n.id: [] for n in nodes}
    for e in edges:
        incoming_any[e["to"]].append(e["from"])
    primary = [r for r in roots if not incoming_any[r]] or roots[:1]
    attached = [r for r in roots if r not in primary]
    x = gutter + CANVAS_PAD
    for r in primary + attached:
        place(r, x)
        x += span[r] + SIBLING_GAP * 2

    def subtree_ids(node_id: str) -> List[str]:
        out = [node_id]
        for k in children[node_id]:
            out += subtree_ids(k)
        return out

    # Nodes that are derived from others (not contained by them) sit under their sources, not off to the side.
    for r in attached:
        sources = [by_id[s] for s in incoming_any[r] if s in by_id and levels[s] < levels[r]]
        if not sources:
            continue
        target = sum((s.rect.x0 + s.rect.x1) / 2 for s in sources) / len(sources)
        current = (by_id[r].rect.x0 + by_id[r].rect.x1) / 2
        dx = target - current
        members = set(subtree_ids(r))
        moved = {m: fitz.Rect(by_id[m].rect.x0 + dx, by_id[m].rect.y0, by_id[m].rect.x1 + dx, by_id[m].rect.y1) for m in members}
        clash = any(
            area(fitz.Rect(moved[m].x0 - SIBLING_GAP / 2, moved[m].y0, moved[m].x1 + SIBLING_GAP / 2, moved[m].y1) & other.rect) > 0
            for m in members for other in nodes if other.id not in members and abs(levels[other.id] - levels[m]) == 0
        )
        if not clash and min(rc.x0 for rc in moved.values()) >= gutter + CANVAS_PAD:
            for m, rc in moved.items():
                by_id[m].rect = rc
    return []


def _layout_layers(nodes: List[Node], edges: List[Dict[str, Any]], levels: Dict[str, int], horizontal: bool) -> None:
    """Layered layout for flows. horizontal=True: layers are columns, left to right."""
    layers: Dict[int, List[Node]] = {}
    for n in nodes:
        layers.setdefault(levels[n.id], []).append(n)
    order = sorted(layers)
    position: Dict[str, float] = {}
    for idx, lv in enumerate(order):
        members = layers[lv]
        if idx > 0:
            def barycentre(n: Node) -> float:
                preds = [position[e["from"]] for e in edges if e["to"] == n.id and e["from"] in position]
                return sum(preds) / len(preds) if preds else float(members.index(n))
            members.sort(key=barycentre)
        for i, n in enumerate(members):
            position[n.id] = float(i)
    cross_gap = 18.0 if horizontal else SIBLING_GAP + 4
    main_gap = 46.0 if horizontal else LEVEL_GAP + 6
    extent: Dict[int, float] = {}
    for lv in order:
        members = layers[lv]
        extent[lv] = sum((n.h if horizontal else n.w) for n in members) + cross_gap * (len(members) - 1)
    max_extent = max(extent.values())
    cursor = CANVAS_PAD
    for lv in order:
        members = layers[lv]
        main_size = max((n.w if horizontal else n.h) for n in members)
        cross = CANVAS_PAD + (max_extent - extent[lv]) / 2
        for n in members:
            if horizontal:
                n.rect = fitz.Rect(cursor + (main_size - n.w) / 2, cross, cursor + (main_size - n.w) / 2 + n.w, cross + n.h)
                cross += n.h + cross_gap
            else:
                n.rect = fitz.Rect(cross, cursor + (main_size - n.h) / 2, cross + n.w, cursor + (main_size - n.h) / 2 + n.h)
                cross += n.w + cross_gap
        cursor += main_size + main_gap


def _layout_timeline(nodes: List[Node]) -> float:
    """Events alternate above/below a horizontal axis. Returns the axis y."""
    above = [n for i, n in enumerate(nodes) if i % 2 == 0]
    below = [n for i, n in enumerate(nodes) if i % 2 == 1]
    axis_y = CANVAS_PAD + max(n.h for n in above) + 24
    centres: List[float] = []
    for i, n in enumerate(nodes):
        cx = CANVAS_PAD + n.w / 2
        if i >= 1:
            cx = max(cx, centres[i - 1] + 26)
        if i >= 2:
            cx = max(cx, centres[i - 2] + (nodes[i - 2].w + n.w) / 2 + 10)
        centres.append(cx)
        if i % 2 == 0:
            n.rect = fitz.Rect(cx - n.w / 2, axis_y - 24 - n.h, cx + n.w / 2, axis_y - 24)
        else:
            n.rect = fitz.Rect(cx - n.w / 2, axis_y + 24, cx + n.w / 2, axis_y + 24 + n.h)
    return axis_y


# ── drawing ─────────────────────────────────────────────────────────────────

def _arrow_head(shape: fitz.Shape, tip: fitz.Point, frm: fitz.Point, size: float = 5.0, color=(0.2, 0.2, 0.2)) -> None:
    angle = math.atan2(tip.y - frm.y, tip.x - frm.x)
    left = fitz.Point(tip.x - size * math.cos(angle - 0.45), tip.y - size * math.sin(angle - 0.45))
    right = fitz.Point(tip.x - size * math.cos(angle + 0.45), tip.y - size * math.sin(angle + 0.45))
    shape.draw_polyline([left, tip, right, left])
    shape.finish(color=color, fill=color, width=0.5, closePath=True)


def render_diagram(spec: Dict[str, Any]) -> DiagramResult:
    kind, nodes, edges = _normalise(spec)
    for n in nodes:
        _measure_node(n)
    by_id = {n.id: n for n in nodes}
    levels = _assign_levels(kind, nodes, edges)
    warnings: List[str] = []
    axis_y_value = 0.0

    level_labels: List[str] = list(spec.get("level_labels") or [])
    gutter = 0.0
    if kind == "hierarchy" and level_labels:
        gutter = min(110.0, max(text_width(plain_text(t), SMALL_SIZE, True) for t in level_labels) * 1.15 + 16)
        gutter = max(gutter, 64.0)

    if kind == "hierarchy":
        _layout_hierarchy(nodes, edges, levels, gutter)
    elif kind == "flow":
        horizontal = (spec.get("direction") or "right") == "right"
        _layout_layers(nodes, edges, levels, horizontal)
    else:
        axis_y_value = _layout_timeline(nodes)

    # group frames
    groups = []
    for g in spec.get("groups", []) or []:
        members = [by_id[m] for m in g.get("members", []) if m in by_id]
        if len(members) < 1:
            continue
        frame = fitz.Rect(members[0].rect)
        for m in members[1:]:
            frame |= m.rect
        frame = fitz.Rect(frame.x0 - 8, frame.y0 - 16, frame.x1 + 8, frame.y1 + 8)
        groups.append((frame, str(g.get("label", "")), {m.id for m in members}))
    for frame, label, member_ids in groups:
        for n in nodes:
            if n.id not in member_ids and area(fitz.Rect(frame) & n.rect) > 0:
                raise EditError("diagram_group_overlap", f"Group '{label}' would overlap node '{n.id}'. Reorder nodes or split the group.")

    # overlaps
    for i, a in enumerate(nodes):
        for b in nodes[i + 1:]:
            if area(fitz.Rect(a.rect) & b.rect) > 0.5:
                raise EditError("diagram_overlap", f"Nodes '{a.id}' and '{b.id}' overlap in the layout.")

    # edges
    drawn_edges: List[Dict[str, Any]] = []
    for e in edges:
        a, b = by_id[e["from"]], by_id[e["to"]]
        if e["relation"] == "contains" and kind == "hierarchy":
            start = fitz.Point((a.rect.x0 + a.rect.x1) / 2, a.rect.y1)
            end = fitz.Point((b.rect.x0 + b.rect.x1) / 2, b.rect.y0)
            mid_y = (start.y + end.y) / 2
            path = [start, fitz.Point(start.x, mid_y), fitz.Point(end.x, mid_y), end]
            drawn_edges.append({**e, "path": path, "arrow": False})
            continue
        ca = fitz.Point((a.rect.x0 + a.rect.x1) / 2, (a.rect.y0 + a.rect.y1) / 2)
        cb = fitz.Point((b.rect.x0 + b.rect.x1) / 2, (b.rect.y0 + b.rect.y1) / 2)
        p, q = _border_point(a.rect, cb), _border_point(b.rect, ca)
        for other in nodes:
            if other.id in (a.id, b.id):
                continue
            if _segment_hits_rect(p, q, other.rect):
                raise EditError("diagram_edge_crosses_node", f"Edge '{a.id}' -> '{b.id}' would pass through node '{other.id}'. Reorder the nodes, change levels, or drop that edge.")
        drawn_edges.append({**e, "path": [p, q], "arrow": e["relation"] != "association"})

    # canvas size
    bounds = fitz.Rect(1e9, 1e9, -1e9, -1e9)
    for n in nodes:
        bounds |= n.rect
        if n.repeat and n.repeat > 1:
            bounds |= fitz.Rect(n.rect.x0 + 6, n.rect.y0 - 12, n.rect.x1 + 22, n.rect.y1 - 6)  # stacked cards + "×N" badge
    for frame, _, _ in groups:
        bounds |= frame
    left_edge = CANVAS_PAD if kind != "hierarchy" else 0.0
    width = max(bounds.x1 + CANVAS_PAD + 6, 40.0)
    height = bounds.y1 + CANVAS_PAD + 6

    # edge labels
    label_rects: List[Tuple[fitz.Rect, str]] = []
    for e in drawn_edges:
        if not e["label"]:
            continue
        path = e["path"]
        mid = fitz.Point((path[1].x + path[2].x) / 2, (path[1].y + path[2].y) / 2) if len(path) == 4 else fitz.Point((path[0].x + path[1].x) / 2, (path[0].y + path[1].y) / 2)
        w = text_width(e["label"], SMALL_SIZE) * 1.1 + 8
        rect = fitz.Rect(mid.x - w / 2, mid.y - 6, mid.x + w / 2, mid.y + 6)
        for n in nodes:
            if area(rect & n.rect) > 0.5:
                raise EditError("diagram_label_overlap", f"Edge label '{e['label']}' would overlap node '{n.id}'. Shorten the label or give the edge more room.")
        for other_rect, other_text in label_rects:
            if area(rect & other_rect) > 0.5:
                raise EditError("diagram_label_overlap", f"Edge labels '{e['label']}' and '{other_text}' would overlap.")
        label_rects.append((rect, e["label"]))
        bounds |= rect
        width = max(width, rect.x1 + CANVAS_PAD)
        height = max(height, rect.y1 + CANVAS_PAD)

    # legend + notes
    styles_used = sorted({n.style for n in nodes if n.style != "plain"})
    legend_entries: List[Tuple[str, str, Any]] = []
    declared = {str(item.get("style")): str(item.get("label", "")) for item in (spec.get("legend") or []) if item.get("style")}
    if styles_used and len(set(n.style for n in nodes)) > 1:
        missing = [s for s in styles_used if s not in declared]
        if missing:
            raise EditError("diagram_legend", f"Node styles {missing} are used but missing from 'legend'. Every non-plain style needs a legend entry explaining what the colour means.")
    for style, label in declared.items():
        if style in STYLES and label:
            legend_entries.append(("node", label, style))
    relations_used = sorted({e["relation"] for e in edges if e["relation"] in EDGE_LEGEND})
    for rel in relations_used:
        legend_entries.append(("edge", EDGE_LEGEND[rel], rel))
    notes = [str(t) for t in (spec.get("notes") or []) if str(t).strip()]

    legend_h = 0.0
    legend_layout: List[Tuple[fitz.Rect, str, str, Any]] = []
    if legend_entries:
        x = CANVAS_PAD + 2
        y = height + 4
        row_h = 13.0
        for typ, label, ref in legend_entries:
            item_w = 22 + text_width(label, SMALL_SIZE) * 1.1 + 12
            if x + item_w > max(width, 300):
                x = CANVAS_PAD + 2
                y += row_h
            legend_layout.append((fitz.Rect(x, y, x + item_w, y + row_h), typ, label, ref))
            x += item_w
            width = max(width, x + CANVAS_PAD)
        legend_h = (y + row_h) - height + 4
        height += legend_h
    note_blocks: List[Tuple[fitz.Rect, str]] = []
    for note in notes:
        h = measure_html(f"<div class='nt'>{inline_html(note)}</div>", f".nt{{font-family:sans-serif;font-size:{SMALL_SIZE}pt;color:#444;line-height:1.2}}", max(width - 2 * CANVAS_PAD, 60))
        note_blocks.append((fitz.Rect(CANVAS_PAD, height + 2, width - CANVAS_PAD, height + 2 + h), note))
        height += h + 4

    # ── draw on a scratch page (vector, real text)
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    texts: List[str] = []

    shape = page.new_shape()
    if kind == "hierarchy" and level_labels:
        row_tops: Dict[int, Tuple[float, float]] = {}
        for n in nodes:
            lv = levels[n.id]
            lo, hi = row_tops.get(lv, (1e9, -1e9))
            row_tops[lv] = (min(lo, n.rect.y0), max(hi, n.rect.y1))
        for idx, (lv, (y0, y1)) in enumerate(sorted(row_tops.items())):
            band = fitz.Rect(0, y0 - 8, width, y1 + 8)
            shape.draw_rect(band)
            shape.finish(color=None, fill=(0.965, 0.972, 0.982) if idx % 2 == 0 else (1, 1, 1), width=0)
    shape.commit()
    if kind == "hierarchy" and level_labels:
        for lv, (y0, y1) in sorted(row_tops.items()):
            if lv < len(level_labels):
                label = level_labels[lv]
                box = fitz.Rect(4, y0, gutter - 6, y1)
                draw_html(page, box, f"<div style='font-family:sans-serif;font-size:{SMALL_SIZE}pt;font-weight:bold;color:#55616b;text-align:right;line-height:1.15'>{inline_html(label)}</div>",
                          "")
                texts.append(plain_text(label))
        # a thin gutter divider
        divider = page.new_shape()
        divider.draw_line(fitz.Point(gutter, 2), fitz.Point(gutter, height - 2))
        divider.finish(color=(0.8, 0.83, 0.86), width=0.6)
        divider.commit()

    shape = page.new_shape()
    for frame, label, _ in groups:
        shape.draw_rect(frame, radius=0.06)
        shape.finish(color=(0.5, 0.55, 0.6), fill=None, width=0.8, dashes="[3 2] 0")
    shape.commit()
    for frame, label, _ in groups:
        if label:
            draw_html(page, fitz.Rect(frame.x0 + 4, frame.y0 + 1, frame.x1 - 4, frame.y0 + 14),
                      f"<div style='font-family:sans-serif;font-size:{SMALL_SIZE}pt;color:#55616b;font-style:italic'>{inline_html(label)}</div>", "")
            texts.append(plain_text(label))

    # timeline axis
    if kind == "timeline":
        axis = page.new_shape()
        axis_y = axis_y_value
        axis.draw_line(fitz.Point(CANVAS_PAD, axis_y), fitz.Point(width - CANVAS_PAD, axis_y))
        axis.finish(color=(0.35, 0.38, 0.42), width=1.4)
        for n in nodes:
            cx = (n.rect.x0 + n.rect.x1) / 2
            near = n.rect.y1 if n.rect.y1 <= axis_y else n.rect.y0
            axis.draw_line(fitz.Point(cx, near), fitz.Point(cx, axis_y))
            axis.finish(color=(0.6, 0.62, 0.66), width=0.6)
            axis.draw_circle(fitz.Point(cx, axis_y), 3)
            axis.finish(color=(0.17, 0.36, 0.61), fill=(0.17, 0.36, 0.61), width=0.5)
        axis.commit()

    # edges
    shape = page.new_shape()
    relation_style = {
        "contains": {"color": (0.36, 0.40, 0.44), "width": 1.0, "dashes": None},
        "then": {"color": (0.22, 0.25, 0.28), "width": 1.2, "dashes": None},
        "computed_from": {"color": (0.17, 0.36, 0.61), "width": 1.1, "dashes": "[4 3] 0"},
        "association": {"color": (0.45, 0.45, 0.45), "width": 1.0, "dashes": "[1.5 2.5] 0"},
        "causes": {"color": (0.69, 0.23, 0.18), "width": 2.0, "dashes": None},
    }
    for e in drawn_edges:
        st = relation_style[e["relation"]]
        pts = e["path"]
        shape.draw_polyline(pts)
        shape.finish(color=st["color"], width=st["width"], dashes=st["dashes"], closePath=False)
        if e["arrow"]:
            _arrow_head(shape, pts[-1], pts[-2], color=st["color"])
    shape.commit()

    # nodes (+ stacked card for repeated nodes)
    for n in nodes:
        style = STYLES[n.style]
        shape = page.new_shape()
        if n.repeat and n.repeat > 1:
            for off in (6, 3):
                back = fitz.Rect(n.rect.x0 + off, n.rect.y0 - off, n.rect.x1 + off, n.rect.y1 - off)
                shape.draw_rect(back, radius=0.12)
                shape.finish(color=style["stroke"], fill=style["fill"], width=0.7)
        shape.draw_rect(n.rect, radius=0.12)
        shape.finish(color=style["stroke"], fill=style["fill"], width=1.0)
        shape.commit()
        html, css = _html_for_node(n)
        inner = fitz.Rect(n.rect.x0 + NODE_PAD_X, n.rect.y0 + NODE_PAD_Y, n.rect.x1 - NODE_PAD_X, n.rect.y1 - NODE_PAD_Y + 2)
        draw_html(page, inner, html, css)
        texts.append(plain_text(n.label))
        if n.sublabel:
            texts.append(plain_text(n.sublabel))
        if n.repeat and n.repeat > 1:
            badge = fitz.Rect(n.rect.x1 - 6, n.rect.y0 - 12, n.rect.x1 + 22, n.rect.y0 + 2)
            bshape = page.new_shape()
            bshape.draw_rect(badge, radius=0.5)
            bshape.finish(color=style["stroke"], fill=(1, 1, 1), width=0.8)
            bshape.commit()
            draw_html(page, fitz.Rect(badge.x0, badge.y0 + 1, badge.x1, badge.y1),
                      f"<div style='font-family:sans-serif;font-size:{SMALL_SIZE}pt;font-weight:bold;color:{style['text']};text-align:center'>×{n.repeat}</div>", "")
            texts.append(f"×{n.repeat}")

    # edge labels
    for rect, label in label_rects:
        shape = page.new_shape()
        shape.draw_rect(rect)
        shape.finish(color=None, fill=(1, 1, 1), width=0)
        shape.commit()
        draw_html(page, fitz.Rect(rect.x0 + 2, rect.y0 + 0.5, rect.x1 - 2, rect.y1 + 1),
                  f"<div style='font-family:sans-serif;font-size:{SMALL_SIZE}pt;color:#333;text-align:center;line-height:1.1'>{inline_html(label)}</div>", "")
        texts.append(plain_text(label))

    # legend
    for rect, typ, label, ref in legend_layout:
        shape = page.new_shape()
        if typ == "node":
            st = STYLES[ref]
            sw = fitz.Rect(rect.x0, rect.y0 + 2, rect.x0 + 14, rect.y0 + 11)
            shape.draw_rect(sw, radius=0.2)
            shape.finish(color=st["stroke"], fill=st["fill"], width=0.8)
        else:
            st = relation_style[ref]
            shape.draw_line(fitz.Point(rect.x0, rect.y0 + 6.5), fitz.Point(rect.x0 + 14, rect.y0 + 6.5))
            shape.finish(color=st["color"], width=st["width"], dashes=st["dashes"])
        shape.commit()
        draw_html(page, fitz.Rect(rect.x0 + 18, rect.y0, rect.x1, rect.y1 + 2),
                  f"<div style='font-family:sans-serif;font-size:{SMALL_SIZE}pt;color:#333;line-height:1.1'>{inline_html(label)}</div>", "")
        texts.append(plain_text(label))
    for rect, note in note_blocks:
        draw_html(page, rect, f"<div class='nt'>{inline_html(note)}</div>",
                  f".nt{{font-family:sans-serif;font-size:{SMALL_SIZE}pt;color:#444;line-height:1.2}}")
        texts.append(plain_text(note))

    # rendered-output validation: every label word must really be on the page
    rendered = norm_text(page.get_text())
    for t in texts:
        for word in norm_text(t).split(" "):
            if word and word not in rendered:
                raise EditError("diagram_text_clipped", f"Diagram text '{t}' did not render fully (missing '{word}'). Shorten labels or add room.")

    # canvas bound check
    for n in nodes:
        if n.rect.x0 < -0.1 or n.rect.y0 < -0.1 or n.rect.x1 > width + 0.1 or n.rect.y1 > height + 0.1:
            raise EditError("diagram_outside_canvas", f"Node '{n.id}' falls outside the diagram canvas.")

    return DiagramResult(doc=doc, width=width, height=height, texts=texts,
                         min_font=min(SMALL_SIZE, SUB_SIZE, LABEL_SIZE), warnings=warnings, kind=kind)


def diagram_numbers(spec: Dict[str, Any]) -> List[int]:
    return [int(n["repeat"]) for n in spec.get("nodes", []) if n.get("repeat")]


def diagram_texts(spec: Dict[str, Any]) -> List[str]:
    """All human-readable strings in a spec (for number / wording checks), without rendering."""
    out: List[str] = []
    for n in spec.get("nodes", []):
        out.append(str(n.get("label", "")))
        if n.get("sublabel"):
            out.append(str(n["sublabel"]))
    for e in spec.get("edges", []) or []:
        if e.get("label"):
            out.append(str(e["label"]))
    out += [str(t) for t in (spec.get("level_labels") or [])]
    for g in spec.get("groups", []) or []:
        out.append(str(g.get("label", "")))
    for item in spec.get("legend", []) or []:
        out.append(str(item.get("label", "")))
    out += [str(t) for t in (spec.get("notes") or [])]
    return [t for t in out if t]
