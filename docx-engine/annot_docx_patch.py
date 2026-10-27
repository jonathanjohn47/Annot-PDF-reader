#!/usr/bin/env python3
"""Apply a hand edit to a .docx without rewriting it.

The viewer shows the document as HTML and the user types into it. Converting that HTML back into a whole new .docx
would flatten every colour, font and alignment in the file, including in places the user never touched. This script
does the opposite: it lines up the paragraphs of the edited text with the paragraphs of the original word/document.xml
and changes only the ones that differ. Every other byte of the file stays as it was.

Input (JSON on stdin):
  {"docxPath": "...", "outPath": "...",
   "blocks": [{"tag": "p"|"h1".."h6"|"li"|"cell"|"meta", "segments": [["text", flags], ...]}, ...]}
  flags: 1 = bold, 2 = italic, 4 = underline. U+FFFC stands for an equation (never edited here).
Output (JSON on stdout): {"ok": true, "changed": n, "inserted": n, "deleted": n, "warnings": [...]} or {"ok": false, "error": "..."}
"""
from __future__ import annotations

import base64
import copy
import difflib
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
IMAGE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
IMAGE_TYPES = {"image/png": ("png", "image/png"), "image/jpeg": ("jpeg", "image/jpeg"), "image/gif": ("gif", "image/gif")}
EMU_PER_PIXEL = 9525
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MATH = "￼"
BOLD, ITALIC, UNDERLINE = 1, 2, 4
MIN_PAIR_RATIO = 0.55


def w(tag: str) -> str:
    return "{%s}%s" % (W, tag)


class PatchError(Exception):
    pass


class Fallback(Exception):
    """This paragraph cannot be patched safely; it is left as it was and reported."""


# ── reading paragraphs ──────────────────────────────────────────────────────────────────────────────────────────────

def _flag(run_props: Optional[ET.Element], name: str) -> bool:
    if run_props is None:
        return False
    element = run_props.find(w(name))
    if element is None:
        return False
    value = element.get(w("val"))
    return value not in ("0", "false", "off") and not (name == "u" and value == "none")


def _run_flags(run: Optional[ET.Element]) -> int:
    props = run.find(w("rPr")) if run is not None else None
    flags = (BOLD if _flag(props, "b") else 0) | (ITALIC if _flag(props, "i") else 0) | (UNDERLINE if _flag(props, "u") else 0)
    style = props.find(w("rStyle")) if props is not None else None
    name = (style.get(w("val")) or "").lower() if style is not None else ""
    # the HTML shows the standard character styles as <strong> / <em>
    return flags | (BOLD if name == "strong" else 0) | (ITALIC if name in ("emphasis", "emphasis1") else 0)


def _tokens(paragraph: ET.Element) -> List[Tuple[str, Optional[ET.Element], Optional[ET.Element]]]:
    """(kind, element, run) in reading order. kinds: t (text), ws (tab/break), math, draw."""
    out: List[Tuple[str, Optional[ET.Element], Optional[ET.Element]]] = []

    def walk(node: ET.Element, run: Optional[ET.Element]) -> None:
        for child in node:
            tag = child.tag
            if tag in (w("pPr"), w("delText"), w("del"), w("rPr"), w("instrText")):
                continue
            if tag == w("r"):
                walk(child, child)
            elif tag == w("t"):
                out.append(("t", child, run))
            elif tag in (w("tab"), w("br"), w("cr")):
                if tag == w("br") and child.get(w("type")) == "page":
                    continue
                out.append(("ws", None, run))
            elif tag == "{%s}oMath" % M:
                out.append(("math", child, run))
            elif tag in (w("drawing"), w("pict"), w("object")):
                out.append(("draw", child, run))
            elif tag in ("{%s}Fallback" % MC,):
                continue
            else:
                walk(child, run)

    walk(paragraph, None)
    return out


class Para:
    """One original paragraph: its text, per-character formatting, and which w:t each character lives in."""

    def __init__(self, element: ET.Element) -> None:
        self.element = element
        self.tokens = _tokens(element)
        chars: List[Tuple[str, int, int]] = []   # (character, index into text_nodes or -1, offset in that node)
        self.text_nodes: List[ET.Element] = []
        for kind, el, run in self.tokens:
            flags = _run_flags(run)
            if kind == "t" and el is not None:
                self.text_nodes.append(el)
                node = len(self.text_nodes) - 1
                for offset, ch in enumerate(el.text or ""):
                    chars.append((ch, node, offset, flags))  # type: ignore[arg-type]
            elif kind == "ws":
                chars.append((" ", -1, 0, flags))  # type: ignore[arg-type]
            elif kind == "math":
                chars.append((MATH, -1, 0, 0))  # type: ignore[arg-type]
        self.chars = _collapse(chars)
        self.text = "".join(c[0] for c in self.chars)
        self.flags = [c[3] for c in self.chars]  # type: ignore[index]
        props = element.find(w("pPr"))
        style = props.find(w("pStyle")).get(w("val")) if props is not None and props.find(w("pStyle")) is not None else ""
        match = re.fullmatch(r"(?i)heading\s*([1-6])", style or "")
        self.level = int(match.group(1)) if match else 0
        self.is_list = props is not None and props.find(w("numPr")) is not None
        self.simple = all(kind in ("t", "ws") for kind, _, _ in self.tokens) and not any(
            child.tag not in (w("pPr"), w("r"), w("bookmarkStart"), w("bookmarkEnd"), w("proofErr")) for child in element
        ) and not any(sub.tag in (w("fldChar"), w("instrText"), w("footnoteReference"), w("endnoteReference")) for sub in element.iter())


def _collapse(chars: List[Any]) -> List[Any]:
    """Collapse runs of whitespace to one space and trim, as the HTML text was."""
    out: List[Any] = []
    for item in chars:
        if item[0].isspace() or item[0] == " " and False:
            if not out or out[-1][0] == " ":
                continue
            out.append((" ",) + tuple(item[1:]))
        else:
            out.append(item)
    while out and out[-1][0] == " ":
        out.pop()
    return out


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ── the edited blocks ───────────────────────────────────────────────────────────────────────────────────────────────

class Block:
    def __init__(self, raw: Dict[str, Any]) -> None:
        self.tag = str(raw.get("tag", "p"))
        chars: List[Tuple[str, int]] = []
        for segment in raw.get("segments", []):
            text, flags = str(segment[0]), int(segment[1])
            for ch in text:
                chars.append((ch, flags))
        collapsed: List[Tuple[str, int]] = []
        for ch, flags in chars:
            if ch.isspace():
                if not collapsed or collapsed[-1][0] == " ":
                    continue
                collapsed.append((" ", flags))
            else:
                collapsed.append((ch, flags))
        while collapsed and collapsed[-1][0] == " ":
            collapsed.pop()
        self.text = "".join(c[0] for c in collapsed)
        self.flags = [c[1] for c in collapsed]
        match = re.fullmatch(r"h([1-6])", self.tag)
        self.level = int(match.group(1)) if match else 0
        self.meta = self.tag == "meta"
        # Whether the user worked in this block. A block they never touched is only ever compared by its text, so
        # a difference in how the HTML and the file describe formatting can never rewrite it.
        self.touched = bool(raw.get("touched", True))
        self.image: Optional[Dict[str, Any]] = raw.get("image") if self.tag == "image" else None


# ── alignment ───────────────────────────────────────────────────────────────────────────────────────────────────────

def align(original: List[str], edited: List[str]) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """(pairs of original/edited indexes, deleted original indexes, inserted edited indexes)."""
    pairs: List[Tuple[int, int]] = []
    deleted: List[int] = []
    inserted: List[int] = []
    matcher = difflib.SequenceMatcher(None, original, edited, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            pairs += [(i1 + k, j1 + k) for k in range(i2 - i1)]
        elif op == "delete":
            deleted += list(range(i1, i2))
        elif op == "insert":
            inserted += list(range(j1, j2))
        else:
            free = list(range(i1, i2))
            for j in range(j1, j2):
                best, best_ratio = None, MIN_PAIR_RATIO
                for i in free:
                    ratio = difflib.SequenceMatcher(None, original[i], edited[j], autojunk=False).ratio()
                    if ratio >= best_ratio:
                        best, best_ratio = i, ratio
                if best is None:
                    inserted.append(j)
                else:
                    for i in [x for x in free if x < best]:
                        deleted.append(i)
                    free = [x for x in free if x > best]
                    pairs.append((best, j))
            deleted += free
    return sorted(pairs, key=lambda p: p[1]), sorted(set(deleted)), sorted(set(inserted))


# ── editing one paragraph ───────────────────────────────────────────────────────────────────────────────────────────

def _set_text(node: ET.Element, text: str) -> None:
    node.text = text
    node.set(XML_SPACE, "preserve")


def _patch_text(para: Para, new_text: str) -> None:
    """Change the paragraph's text by character-level edits, so untouched runs keep their formatting."""
    if not para.text_nodes:
        raise Fallback("no text to patch")
    old = para.text
    per_node: List[List[Optional[str]]] = [list(node.text or "") for node in para.text_nodes]
    before: Dict[Tuple[int, int], str] = {}
    sm = difflib.SequenceMatcher(None, old, new_text, autojunk=False)

    def real(position: int) -> Optional[Tuple[int, int]]:
        if 0 <= position < len(para.chars):
            _, node, offset, _flags = para.chars[position]  # type: ignore[misc]
            return (node, offset) if node >= 0 else None
        return None

    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        if MATH in old[i1:i2] or MATH in new_text[j1:j2]:
            raise Fallback("the edit touches an equation")
        for k in range(i1, i2):
            spot = real(k)
            if spot is not None:
                per_node[spot[0]][spot[1]] = None
        insertion = new_text[j1:j2]
        if not insertion:
            continue
        spot = None
        for k in list(range(i1, i2)) + [i1 - 1, i1]:
            spot = real(k)
            if spot is not None:
                break
        if spot is None:
            raise Fallback("nowhere to put the new text")
        after_previous = i1 == i2 and i1 > 0 and real(i1 - 1) is not None
        if after_previous:
            node, offset = real(i1 - 1)  # type: ignore[misc]
            key = (node, offset + 1)
        else:
            key = spot
        before[key] = before.get(key, "") + insertion
    for node_index, node in enumerate(para.text_nodes):
        pieces: List[str] = []
        for offset, ch in enumerate(per_node[node_index]):
            pieces.append(before.get((node_index, offset), ""))
            if ch is not None:
                pieces.append(ch)
        pieces.append(before.get((node_index, len(per_node[node_index])), ""))
        _set_text(node, "".join(pieces))


def _base_run_props(para: Para) -> Optional[ET.Element]:
    for kind, _el, run in para.tokens:
        if kind == "t" and run is not None and run.find(w("rPr")) is not None:
            props = copy.deepcopy(run.find(w("rPr")))
            for name in ("b", "bCs", "i", "iCs", "u"):
                for found in props.findall(w(name)):
                    props.remove(found)
            return props
    return None


def _make_runs(template: Optional[Para], block: Block) -> List[ET.Element]:
    runs: List[ET.Element] = []
    base = _base_run_props(template) if template is not None else None
    start = 0
    text = block.text
    while start < len(text):
        end = start
        while end < len(text) and block.flags[end] == block.flags[start]:
            end += 1
        flags = block.flags[start]
        run = ET.Element(w("r"))
        props = copy.deepcopy(base) if base is not None else ET.Element(w("rPr"))
        if flags & BOLD:
            props.insert(0, ET.Element(w("b")))
        if flags & ITALIC:
            props.insert(1 if flags & BOLD else 0, ET.Element(w("i")))
        if flags & UNDERLINE:
            underline = ET.SubElement(props, w("u"))
            underline.set(w("val"), "single")
        if len(props):
            run.append(props)
        node = ET.SubElement(run, w("t"))
        _set_text(node, text[start:end].replace(MATH, ""))
        runs.append(run)
        start = end
    return runs


def _rebuild_runs(para: Para, block: Block) -> None:
    if not para.simple or MATH in block.text:
        raise Fallback("the paragraph holds links, fields or equations")
    for child in list(para.element):
        if child.tag != w("pPr"):
            para.element.remove(child)
    for run in _make_runs(para, block):
        para.element.append(run)


def _set_style(element: ET.Element, level: int, previous: int) -> None:
    props = element.find(w("pPr"))
    if props is None:
        props = ET.Element(w("pPr"))
        element.insert(0, props)
    style = props.find(w("pStyle"))
    if level:
        if style is None:
            style = ET.Element(w("pStyle"))
            props.insert(0, style)
        style.set(w("val"), "Heading%d" % level)
    elif previous and style is not None:
        props.remove(style)


def _signature_matches(para: Para, block: Block) -> bool:
    return len(para.flags) == len(block.flags) and all(
        a == b for a, b, ch in zip(para.flags, block.flags, para.text) if ch != " " and ch != MATH
    )


def _modify(para: Para, block: Block, notes: List[str]) -> bool:
    """Bring one paragraph in line with the edited block. Returns whether anything was changed."""
    changed = False
    new_level = 0 if block.meta else block.level
    text_changed = para.text != block.text
    if not text_changed and not block.touched:
        return False
    if text_changed:
        trial_parent = ET.Element("holder")
        trial = copy.deepcopy(para.element)
        trial_parent.append(trial)
        try:
            _patch_text(Para(trial), block.text)
            patched = Para(trial)
            if patched.text == block.text:
                if _signature_matches(patched, block) or not para.simple:
                    for child in list(para.element):
                        para.element.remove(child)
                    for child in list(trial):
                        para.element.append(child)
                    if not _signature_matches(patched, block):
                        notes.append("Formatting changes in a paragraph with links or equations were not applied.")
                    changed = True
                else:
                    _rebuild_runs(para, block)
                    changed = True
        except Fallback as why:
            notes.append("A paragraph was left as it was: %s." % why)
            return False
    elif not _signature_matches(para, block):
        try:
            _rebuild_runs(para, block)
            changed = True
        except Fallback:
            notes.append("Bold/italic/underline changes in a paragraph with links or equations were not applied.")
    if not block.meta and (para.level or new_level) and para.level != new_level:
        _set_style(para.element, new_level, para.level)
        changed = True
    return changed


# ── whole document ──────────────────────────────────────────────────────────────────────────────────────────────────

def _paragraphs(root: ET.Element) -> List[Para]:
    parents = {child: parent for parent in root.iter() for child in parent}

    def skipped(element: ET.Element) -> bool:
        node: Optional[ET.Element] = parents.get(element)
        while node is not None:
            if node.tag in (w("txbxContent"), "{%s}Fallback" % MC):
                return True
            node = parents.get(node)
        return False

    return [Para(p) for p in root.iter(w("p")) if not skipped(p)]


def _document_xml(path: str) -> Tuple[bytes, ET.Element, bytes, bytes]:
    with zipfile.ZipFile(path) as archive:
        data = archive.read("word/document.xml")
    start = re.search(rb"<(?:[A-Za-z0-9_]+:)?document\b[^>]*>", data)
    if not start:
        raise PatchError("This is not a Word document (word/document.xml has no root).")
    for prefix, uri in re.findall(rb'xmlns:?([A-Za-z0-9_]*)="([^"]*)"', start.group(0)):
        ET.register_namespace(prefix.decode(), uri.decode())
    return data, ET.fromstring(data), data[: start.start()], start.group(0)


def _serialise(root: ET.Element, header: bytes, root_tag: bytes) -> bytes:
    body = ET.tostring(root, encoding="utf-8")
    body = re.sub(rb"^<[^>]*>", lambda _m: root_tag, body, count=1)
    body = body.replace(b" />", b"/>")   # ElementTree writes <x /> where Word writes <x/>; ">" inside text is always escaped
    return header + body



# ── pictures pasted into the page ───────────────────────────────────────────────────────────────────────────────────

class Pictures:
    """New pictures: the media files, the relationships that point at them, and the paragraphs that show them."""

    def __init__(self, root: ET.Element, root_tag: bytes) -> None:
        self.root = root
        self.media: List[Tuple[str, bytes]] = []
        self.rels: List[str] = []
        self.extensions: Dict[str, str] = {}
        declared = dict((p.decode(), u.decode()) for p, u in re.findall(rb'xmlns:?([A-Za-z0-9_]*)="([^"]*)"', root_tag))
        self.prefix: Dict[str, str] = {}
        self.declare: List[Tuple[str, str]] = []
        for want, uri in (("wp", WP), ("a", A), ("pic", PIC), ("r", R)):
            existing = next((p for p, u in declared.items() if u == uri and p), None)
            if existing:
                self.prefix[uri] = existing
                continue
            prefix = want
            while prefix in declared:
                prefix += "x"
            declared[prefix] = uri
            ET.register_namespace(prefix, uri)
            self.prefix[uri] = prefix
            self.declare.append((prefix, uri))
        ids = [int(e.get("id", "0")) for e in root.iter("{%s}docPr" % WP) if (e.get("id") or "0").isdigit()]
        self.next_id = max(ids + [0]) + 1
        self.page_width = self._text_width()

    def _text_width(self) -> int:
        section = None
        for section in self.root.iter(w("sectPr")):
            pass
        width, left, right = 12240, 1440, 1440
        if section is not None:
            size, margin = section.find(w("pgSz")), section.find(w("pgMar"))
            try:
                if size is not None and size.get(w("w")):
                    width = int(size.get(w("w")))
                if margin is not None:
                    left, right = int(margin.get(w("left"), left)), int(margin.get(w("right"), right))
            except ValueError:
                pass
        return max(1440, width - left - right) * 635   # twips -> EMU

    def paragraph(self, image: Dict[str, Any], in_cell: bool) -> ET.Element:
        mime = str(image.get("mime"))
        if mime not in IMAGE_TYPES:
            raise PatchError("Only PNG, JPEG and GIF pictures can be added.")
        extension, content_type = IMAGE_TYPES[mime]
        data = base64.b64decode(str(image.get("data", "")), validate=True)
        if not data:
            raise PatchError("The picture is empty.")
        width, height = max(1, int(image.get("width", 1))), max(1, int(image.get("height", 1)))
        cx, cy = width * EMU_PER_PIXEL, height * EMU_PER_PIXEL
        limit = min(self.page_width, 2743200) if in_cell else self.page_width
        if cx > limit:
            cy, cx = max(1, cy * limit // cx), limit
        number = len(self.media) + 1
        name = "annot-picture-%d.%s" % (number, extension)
        rel_id = "rIdAnnotPicture%d" % number
        self.media.append(("word/media/" + name, data))
        self.rels.append('<Relationship Id="%s" Type="%s" Target="media/%s"/>' % (rel_id, IMAGE_RELATIONSHIP, name))
        self.extensions[extension] = content_type
        picture_id, self.next_id = self.next_id, self.next_id + 1
        xml = (
            '<w:p xmlns:w="%(W)s" xmlns:wp="%(WP)s" xmlns:a="%(A)s" xmlns:pic="%(PIC)s" xmlns:r="%(R)s"><w:r><w:drawing>'
            '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%(cx)d" cy="%(cy)d"/>'
            '<wp:docPr id="%(id)d" name="Picture %(id)d"/>'
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
            '<a:graphic><a:graphicData uri="%(PIC)s"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="%(name)s"/><pic:cNvPicPr/></pic:nvPicPr>'
            '<pic:blipFill><a:blip r:embed="%(rid)s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%(cx)d" cy="%(cy)d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
        ) % {"W": W, "WP": WP, "A": A, "PIC": PIC, "R": R, "cx": cx, "cy": cy, "id": picture_id, "name": name, "rid": rel_id}
        return ET.fromstring(xml)

    def package_parts(self, source: zipfile.ZipFile) -> Dict[str, bytes]:
        """The existing package parts that must change for the new pictures to be found."""
        changed: Dict[str, bytes] = {}
        names = set(source.namelist())
        rels_name = "word/_rels/document.xml.rels"
        if rels_name in names:
            rels = source.read(rels_name)
        else:
            rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s"></Relationships>' % PKG_RELS).encode("utf-8")
        changed[rels_name] = rels.replace(b"</Relationships>", "".join(self.rels).encode("utf-8") + b"</Relationships>", 1)
        types = source.read("[Content_Types].xml")
        for extension, content_type in self.extensions.items():
            if not re.search(rb'Extension="%s"' % extension.encode(), types, flags=re.I):
                types = re.sub(rb"(<Types\b[^>]*>)", lambda m: m.group(1) + ('<Default Extension="%s" ContentType="%s"/>' % (extension, content_type)).encode(), types, count=1)
        changed["[Content_Types].xml"] = types
        return changed

def patch(docx_path: str, out_path: str, raw_blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    _, root, header, root_tag = _document_xml(docx_path)
    paras = _paragraphs(root)
    original = [p for p in paras if _norm(p.text)]
    everything = [Block(b) for b in raw_blocks]
    blocks = [b for b in everything if not b.image and _norm(b.text)]      # what is lined up with the file's paragraphs
    sequence = [b for b in everything if b.image or _norm(b.text)]         # reading order, pictures included
    text_index = {id(b): k for k, b in enumerate(blocks)}
    pictures: Optional[Pictures] = Pictures(root, root_tag) if any(b.image for b in everything) else None

    pairs, deleted, inserted = align([p.text for p in original], [b.text for b in blocks])
    notes: List[str] = []
    changed = 0

    for i, j in pairs:
        if _modify(original[i], blocks[j], notes):
            changed += 1

    parents = {child: parent for parent in root.iter() for child in parent}
    removed = 0
    for i in deleted:
        element = original[i].element
        parent = parents.get(element)
        if parent is None:
            continue
        keeps_section = element.find(w("pPr")) is not None and element.find(w("pPr")).find(w("sectPr")) is not None
        only_one = parent.tag == w("tc") and len(parent.findall(w("p"))) == 1
        if keeps_section or only_one:
            for kind, el, _run in original[i].tokens:
                if kind == "t" and el is not None:
                    el.text = ""
        else:
            parent.remove(element)
        removed += 1

    pair_of_new = {j: i for i, j in pairs}
    last: Optional[ET.Element] = None
    last_para: Optional[Para] = None
    added = 0
    added_pictures = 0
    for block in sequence:
        if block.image:
            anchor_el = last if last is not None else (original[0].element if original else None)
            parent_el = parents.get(anchor_el) if anchor_el is not None else root.find(w("body"))
            if parent_el is None or pictures is None:
                notes.append("A picture could not be placed.")
                continue
            new_picture = pictures.paragraph(block.image, parent_el.tag == w("tc"))
            index = (list(parent_el).index(anchor_el) + (1 if last is not None else 0)) if anchor_el is not None else 0
            parent_el.insert(index, new_picture)
            parents[new_picture] = parent_el
            last = new_picture
            added_pictures += 1
            continue
        j = text_index[id(block)]
        if j in pair_of_new:
            last_para = original[pair_of_new[j]]
            last = last_para.element
            continue
        template = last_para or next((original[pair_of_new[k]] for k in sorted(pair_of_new) if k > j), None)
        if template is None:
            notes.append("A new paragraph could not be placed (the document has no text to copy from).")
            continue
        anchor = last if last is not None else template.element
        parent = parents.get(anchor)
        if parent is None:
            continue
        new_p = ET.Element(w("p"))
        props = template.element.find(w("pPr"))
        if props is not None:
            copied = copy.deepcopy(props)
            for section in copied.findall(w("sectPr")):
                copied.remove(section)
            if not template.is_list or block.tag != "li":
                for numbering in copied.findall(w("numPr")):
                    copied.remove(numbering)
            new_p.append(copied)
        _set_style(new_p, 0 if block.meta else block.level, template.level)
        for run in _make_runs(template, block):
            new_p.append(run)
        position = list(parent).index(anchor) + (1 if last is not None else 0)
        parent.insert(position, new_p)
        parents[new_p] = parent
        last = new_p
        added += 1

    if not (changed or removed or added or added_pictures):
        return {"ok": True, "changed": 0, "inserted": 0, "deleted": 0, "images": 0, "warnings": notes, "unchanged": True}

    if pictures is not None and pictures.declare:
        root_tag = root_tag[:-1] + "".join(' xmlns:%s="%s"' % pair for pair in pictures.declare).encode("utf-8") + b">"
    new_xml = _serialise(root, header, root_tag)
    fd, tmp = tempfile.mkstemp(suffix=".docx", dir=os.path.dirname(out_path) or None)
    os.close(fd)
    try:
        with zipfile.ZipFile(docx_path) as source, zipfile.ZipFile(tmp, "w") as target:
            replaced = {"word/document.xml": new_xml}
            if pictures is not None:
                replaced.update(pictures.package_parts(source))
            written = set()
            for item in source.infolist():
                content = replaced[item.filename] if item.filename in replaced else source.read(item.filename)
                target.writestr(item, content, compress_type=item.compress_type)
                written.add(item.filename)
            for name, content in replaced.items():
                if name not in written:                      # for example a relationships part the file did not have yet
                    target.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
            if pictures is not None:
                for name, content in pictures.media:
                    target.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
        with zipfile.ZipFile(tmp) as check:
            ET.fromstring(check.read("word/document.xml"))
        shutil.copymode(docx_path, tmp)   # mkstemp makes the file private; the saved file keeps the original's permissions
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"ok": True, "changed": changed, "inserted": added, "deleted": removed, "images": added_pictures, "warnings": sorted(set(notes))}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = patch(payload["docxPath"], payload["outPath"], payload["blocks"])
    except (PatchError, zipfile.BadZipFile, KeyError, ET.ParseError) as error:
        result = {"ok": False, "error": str(error) or error.__class__.__name__}
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
