"""Semantic checks run BEFORE anything is drawn: the document is the source of truth.

Enforces, deterministically, what the editing rules ask for: quotes really exist, every number in new content is
declared and sourced, derived numbers add up, a term is defined before its first use, existing explanations are
not duplicated, causal wording is backed by the document, and qualifications are not silently weakened.
"""
from __future__ import annotations

import ast
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

import fitz

from .blocks import block_texts
from .diagram import diagram_texts
from .pagemodel import find_quote
from .textlayout import plain_text
from .util import issue, norm_text, words_of

NUMBER_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?)(?![\w])")
NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}
FREE_NUMBERS = {0.0, 1.0}
CAUSAL_PATTERNS = [
    r"\bcauses?\b", r"\bcaused by\b", r"\bleads? to\b", r"\bresults? in\b", r"\bpredicts?\b", r"\bpredictive\b",
    r"\bproves?\b", r"\bdrives?\b", r"\bdetermines?\b", r"\bguarantees?\b", r"\bbecause\b", r"\bdue to\b",
]
HEDGE_WORDS = [
    "may", "might", "could", "suggest", "suggests", "preliminary", "exploratory", "limited", "limitation", "limitations",
    "however", "but", "only", "not", "cannot", "unclear", "appears", "approximately", "roughly", "caveat", "tentative",
    "no claim", "we did not",
]
SHINGLE = 5


def numbers_in(text: str, words: bool = False) -> List[float]:
    text = unicodedata.normalize("NFKC", text or "")  # PDFs store "five" as "ﬁve" (ligature)
    out: List[float] = []
    for m in NUMBER_RE.finditer(text or ""):
        whole = m.group(1).replace(",", "")
        value = float(whole + ("." + m.group(2) if m.group(2) else ""))
        out.append(value)
    if words:
        for word in re.findall(r"[a-z]+", (text or "").lower()):
            if word in NUMBER_WORDS:
                out.append(float(NUMBER_WORDS[word]))
    return out


def _num_eq(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


class DocText:
    """Cached normalised text per page, for quote verification and searches."""

    def __init__(self, doc: fitz.Document) -> None:
        self.doc = doc
        self._norm: Dict[int, str] = {}
        self._raw: Dict[int, str] = {}

    def raw(self, page_no: int) -> str:
        if page_no not in self._raw:
            self._raw[page_no] = self.doc[page_no - 1].get_text()
        return self._raw[page_no]

    def norm(self, page_no: int) -> str:
        if page_no not in self._norm:
            self._norm[page_no] = norm_text(self.raw(page_no))
        return self._norm[page_no]

    def has_quote(self, page_no: int, quote: str) -> bool:
        if page_no < 1 or page_no > self.doc.page_count:
            return False
        q = norm_text(quote)
        return bool(q) and q in self.norm(page_no)

    def paragraphs(self) -> List[Tuple[int, str]]:
        out: List[Tuple[int, str]] = []
        for i in range(self.doc.page_count):
            for block in self.doc[i].get_text("blocks"):
                if block[6] == 0 and len(block[4].strip()) > 40:
                    out.append((i + 1, block[4]))
        return out

    def first_use(self, term: str) -> Optional[Tuple[int, float]]:
        for i in range(self.doc.page_count):
            hits = self.doc[i].search_for(term)
            if hits:
                return i + 1, min(h.y0 for h in hits)
        return None

    def definitions(self, term: str) -> List[Tuple[int, str]]:
        t = re.escape(term)
        patterns = [
            rf"\b{t}\w*\b[^.\n]{{0,40}}\b(is|are|means|denotes|refers to|is defined as|are defined as)\b",
            rf"\b(called|termed|denote[sd]?|define[sd]?|known as)\b[^.\n]{{0,30}}\b{t}",
        ]
        out: List[Tuple[int, str]] = []
        for i in range(self.doc.page_count):
            text = re.sub(r"\s+", " ", self.raw(i + 1))
            for p in patterns:
                m = re.search(p, text, re.I)
                if m:
                    start = max(0, m.start() - 20)
                    out.append((i + 1, text[start:m.end() + 60]))
                    break
        return out


def _shingles(text: str) -> Set[Tuple[str, ...]]:
    words = words_of(text)
    return {tuple(words[i:i + SHINGLE]) for i in range(max(0, len(words) - SHINGLE + 1))}


def content_strings(ops: List[Dict[str, Any]]) -> List[Tuple[int, str, str]]:
    """(op number, kind, text) for every reader-visible string the edit adds."""
    out: List[Tuple[int, str, str]] = []
    for number, op in enumerate(ops, start=1):
        if op["type"] == "insert_content":
            for block in op["blocks"]:
                kind = block.get("type", "")
                for text in block_texts(block):
                    if text.strip():
                        out.append((number, kind, plain_text(text)))
        elif op["type"] == "replace_passage":
            out.append((number, "replacement", plain_text(op.get("replacement", ""))))
    return out


def insertion_points(doc: fitz.Document, ops: List[Dict[str, Any]]) -> List[Tuple[int, int, float]]:
    """(op number, original page, y) where new content lands, resolved against the original document."""
    points: List[Tuple[int, int, float]] = []
    for number, op in enumerate(ops, start=1):
        if op["type"] != "insert_content":
            continue
        pl = op["placement"]
        page_no = int(pl["page"])
        if page_no < 1 or page_no > doc.page_count:
            continue
        page = doc[page_no - 1]
        y = page.rect.height
        if pl.get("mode") == "new_pages":
            y = 0.0 if pl.get("position") == "page_start" else page.rect.height + 1
        elif pl.get("after_quote") or pl.get("before_quote"):
            found = find_quote(page, pl.get("after_quote") or pl.get("before_quote"))
            if found:
                y = found["rect"].y1 if pl.get("after_quote") else found["rect"].y0
        elif pl.get("position") == "page_start":
            y = 0.0
        points.append((number, page_no, y))
    return points


def _safe_eval(expr: str, allowed: Set[float]) -> Tuple[Optional[float], Optional[str]]:
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return None, "not a valid arithmetic expression"

    def ev(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            v = float(node.value)
            if not any(_num_eq(v, a) for a in allowed) and not (v == int(v) and 0 <= v <= 10):
                raise ValueError(f"{node.value} is neither a declared fact nor a small constant")
            return v
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = ev(node.operand)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            a, b = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Add):
                return a + b
            if isinstance(node.op, ast.Sub):
                return a - b
            if isinstance(node.op, ast.Mult):
                return a * b
            if b == 0:
                raise ValueError("division by zero")
            return a / b
        raise ValueError("only + - * / and numbers are allowed")

    try:
        return ev(tree), None
    except ValueError as err:
        return None, str(err)


def run_checks(doc: fitz.Document, proposal: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Returns (issues, info). info carries insertion points etc. for later stages."""
    issues: List[Dict[str, Any]] = []
    ops: List[Dict[str, Any]] = proposal["ops"]
    text = DocText(doc)
    points = insertion_points(doc, ops)
    destructive = any(op["type"] in ("replace_passage", "delete_passage", "delete_pages", "move_section", "move_pages") for op in ops)
    additive = [op for op in ops if op["type"] == "insert_content"]

    # ── page ranges
    for number, op in enumerate(ops, start=1):
        pages: List[int] = []
        if "page" in op:
            pages.append(int(op["page"]))
        elif "placement" in op:
            pages.append(int(op["placement"]["page"]))
        elif "pages" in op:
            pages += [int(p) for p in op["pages"]]
        elif "from" in op:
            pages.append(int(op["from"]["page"]))
        for p in pages:
            if p < 1 or p > doc.page_count:
                issues.append(issue("error", "page_out_of_range", f"Operation {number}: page {p} does not exist (the document has {doc.page_count} pages).", op=number))

    # ── facts
    allowed: Set[float] = set(FREE_NUMBERS)
    facts = proposal.get("facts", []) or []
    for fact in facts:
        fid = fact.get("id", "?")
        value = fact.get("value")
        src = fact.get("source") or {}
        if not isinstance(value, (int, float)):
            issues.append(issue("error", "fact_value", f"Fact {fid} has no numeric value."))
            continue
        allowed.add(float(value))
        quote, page_no = src.get("quote", ""), int(src.get("page", 0) or 0)
        if fact.get("origin") == "assumption":
            issues.append(issue("error", "fact_unsupported", f"Fact {fid} is marked as an assumption. Numbers that the document does not establish must not appear in the edit."))
            continue
        if not text.has_quote(page_no, quote):
            issues.append(issue("error", "fact_quote_missing", f"Fact {fid} ({value}) cites page {page_no} with quote \"{quote[:70]}\", but that text is not on that page. Facts must be quoted exactly from the PDF."))
        elif not any(_num_eq(n, float(value)) for n in numbers_in(quote, words=True)):
            issues.append(issue("error", "fact_value_mismatch", f"Fact {fid}: the quoted text on page {page_no} does not contain the number {value}."))

    derived = proposal.get("derived", []) or []
    for d in derived:
        value, expr = d.get("value"), str(d.get("expr", ""))
        result, err = _safe_eval(expr, set(allowed))
        if err:
            issues.append(issue("error", "derived_invalid", f"Derived value '{expr}': {err}."))
        elif not isinstance(value, (int, float)) or not _num_eq(result, float(value)):
            issues.append(issue("error", "arithmetic_mismatch", f"Derived value '{expr}' equals {result:g}, not {value}. Counts and labels must agree."))
        else:
            allowed.add(float(value))

    # ── number discipline over everything the edit writes
    original_quote_numbers: Set[float] = set()
    for op in ops:
        if op["type"] in ("replace_passage", "delete_passage"):
            for n in numbers_in(op.get("quote", "")):
                original_quote_numbers.add(n)
    for number, kind, string in content_strings(ops):
        for n in numbers_in(re.sub(r"\{\{page:\d+\}\}", "", string)):
            if n in FREE_NUMBERS or any(_num_eq(n, a) for a in allowed | original_quote_numbers):
                continue
            issues.append(issue("error", "unsourced_number", f"Operation {number}: the number {n:g} appears in the new {kind} text but is not a declared fact (from the PDF) or a checked derivation. Declare it in 'facts' with a quote, or in 'derived' with its arithmetic, or remove it.", op=number))
    for number, op in enumerate(ops, start=1):
        if op["type"] != "insert_content":
            continue
        for block in op["blocks"]:
            if block.get("type") == "diagram":
                for node in block["spec"].get("nodes", []):
                    rep = node.get("repeat")
                    if rep and not any(_num_eq(float(rep), a) for a in allowed):
                        issues.append(issue("error", "unsourced_number", f"Operation {number}: diagram node '{node.get('id')}' repeats ×{rep}, but {rep} is not a declared fact.", op=number))

    # ── claims
    claims = proposal.get("claims", []) or []
    causal_supported = False
    for c in claims:
        status, src = c.get("status"), c.get("source") or {}
        if status == "in_document":
            if not text.has_quote(int(src.get("page", 0) or 0), src.get("quote", "")):
                issues.append(issue("error", "claim_quote_missing", f"Claim \"{str(c.get('text'))[:70]}\" is marked in_document but its quote is not on page {src.get('page')}."))
            elif any(re.search(p, norm_text(src.get("quote", ""))) for p in CAUSAL_PATTERNS):
                causal_supported = True
        elif status == "not_established":
            issues.append(issue("error", "unestablished_claim", f"Claim \"{str(c.get('text'))[:70]}\" is not established by the document. Remove it from the edit, or state it as an open question instead."))
        elif status == "assistant_interpretation":
            issues.append(issue("info", "interpretation_added", f"Interpretation added by the assistant (labelled in the document as added explanation): {str(c.get('text'))[:90]}"))

    # ── causal / predictive wording
    for number, kind, string in content_strings(ops):
        low = norm_text(string)
        for pattern in CAUSAL_PATTERNS:
            if re.search(pattern, low) and not causal_supported:
                issues.append(issue("error", "unsupported_causal_wording", f"Operation {number}: new {kind} text uses causal/predictive wording (\"{re.search(pattern, low).group(0)}\") that no in_document claim supports. State only the association the document reports, or add a claim quoting where the document says it.", op=number))
                break
    for number, op in enumerate(ops, start=1):
        if op["type"] != "insert_content":
            continue
        for block in op["blocks"]:
            if block.get("type") == "diagram":
                for e in block["spec"].get("edges", []) or []:
                    if e.get("relation") == "causes" and not causal_supported:
                        issues.append(issue("error", "unsupported_causal_edge", f"Operation {number}: a diagram edge {e.get('from')} → {e.get('to')} is drawn as causal, but the document does not state a causal link. Use relation 'association' or 'then'.", op=number))

    # ── terms: definitions must come before first use
    terms_defined = [t for t in (proposal.get("terms_defined") or []) if str(t).strip()]
    coverage = proposal.get("existing_coverage") or {}
    acknowledged_pages = {int(f.get("page", 0)) for f in (coverage.get("found") or []) if isinstance(f, dict)}
    earliest = min(points, key=lambda p: (p[1], p[2])) if points else None
    for term in terms_defined:
        if earliest is None:
            break
        use = text.first_use(term)
        if use and (use[0], use[1]) < (earliest[1], earliest[2] - 1):
            issues.append(issue("error", "defined_after_use", f"The term '{term}' is first used on page {use[0]} but this edit defines it later (page {earliest[1]}). Insert the definition before the first use, or do not present it as the definition."))
        for page_no, snippet in text.definitions(term):
            before_edit = (page_no, 0.0) < (earliest[1], earliest[2])
            if before_edit and page_no not in acknowledged_pages:
                issues.append(issue("error", "already_defined", f"'{term}' is already explained on page {page_no} (\"{snippet[:90]}\"). Add a short cross-reference or reminder instead of a second full explanation, and list that page in existing_coverage.found."))
            elif before_edit:
                issues.append(issue("warning", "possible_duplicate", f"'{term}' has an existing explanation on page {page_no}; keep the new text to a reminder or cross-reference."))

    for pre in proposal.get("prerequisites", []) or []:
        term, status = pre.get("term", ""), pre.get("status")
        if status == "defined_in_document":
            page_no = int(pre.get("page", 0) or 0)
            if not text.has_quote(page_no, pre.get("quote", "")):
                issues.append(issue("error", "prerequisite_quote_missing", f"Prerequisite '{term}': its quote is not on page {page_no}."))
            elif earliest and page_no > earliest[1]:
                issues.append(issue("error", "prerequisite_later", f"Prerequisite '{term}' is only explained on page {page_no}, after the insertion point on page {earliest[1]}, so a reader would meet it unexplained. Either (a) define it inside this edit (status defined_by_this_edit, and place the edit before the term's first use), (b) avoid the term, or (c) mark it not_needed if it is ordinary vocabulary."))
        elif status == "defined_by_this_edit":
            if term not in terms_defined:
                issues.append(issue("error", "prerequisite_not_defined", f"Prerequisite '{term}' is marked defined_by_this_edit, so add '{term}' to terms_defined."))
        elif status != "not_needed":
            issues.append(issue("error", "prerequisite_status", f"Prerequisite '{term}' needs a status: defined_in_document, defined_by_this_edit or not_needed."))

    # ── duplication of whole explanations
    paragraphs = text.paragraphs()
    for number, kind, string in content_strings(ops):
        if kind not in ("paragraph", "callout", "replacement") or len(words_of(string)) < 12:
            continue
        mine = _shingles(string)
        if not mine:
            continue
        for page_no, existing in paragraphs:
            theirs = _shingles(existing)
            overlap = len(mine & theirs) / len(mine)
            if overlap >= 0.5:
                issues.append(issue("error" if kind != "replacement" else "warning", "duplicate_content", f"Operation {number}: the new {kind} repeats text already on page {page_no} ({overlap:.0%} overlap). Use a short cross-reference ({{{{page:{page_no}}}}}) instead of copying it.", op=number))
                break

    # ── figure numbering collisions
    existing_labels = set()
    for i in range(doc.page_count):
        for m in re.finditer(r"\b(Figure|Fig\.|Table)\s*(\d+[a-z]?)", doc[i].get_text()):
            existing_labels.add((m.group(1).replace("Fig.", "Figure"), m.group(2)))
    for number, op in enumerate(ops, start=1):
        if op["type"] != "insert_content":
            continue
        for block in op["blocks"]:
            caption = str(block.get("caption", "") or "")
            m = re.match(r"\s*(Figure|Fig\.|Table)\s*(\d+[a-z]?)", caption)
            if m and (m.group(1).replace("Fig.", "Figure"), m.group(2)) in existing_labels:
                issues.append(issue("error", "figure_number_collision", f"Operation {number}: the caption label '{m.group(1)} {m.group(2)}' already exists in the document. Use an unnumbered caption or a distinct label such as '{m.group(1)} {m.group(2)}a'.", op=number))

    # ── qualifications and limitations
    for number, op in enumerate(ops, start=1):
        if op["type"] in ("replace_passage", "delete_passage"):
            page_no = int(op["page"])
            found = find_quote(doc[page_no - 1], op["quote"]) if 1 <= page_no <= doc.page_count else None
            original = op["quote"]
            if found:
                for block in doc[page_no - 1].get_text("blocks"):
                    if fitz.Rect(block[:4]).intersects(found["rect"]):
                        original = block[4]
                        break
            low = norm_text(original)
            hedges_before = sum(1 for w in HEDGE_WORDS if re.search(rf"\b{re.escape(w)}\b", low))
            if op["type"] == "delete_passage" and hedges_before:
                issues.append(issue("warning", "removes_qualification", f"Operation {number}: the removed text contains qualifying language (limitations, caveats or negative results). Confirm nothing the reader needs is lost; it also stays recoverable via undo.", op=number))
            if op["type"] == "replace_passage":
                low_new = norm_text(op.get("replacement", ""))
                hedges_after = sum(1 for w in HEDGE_WORDS if re.search(rf"\b{re.escape(w)}\b", low_new))
                if hedges_before > hedges_after and op.get("scope", "phrase") == "phrase" and hedges_before:
                    issues.append(issue("warning", "weakens_qualification", f"Operation {number}: the replacement carries less hedging than the original ({hedges_before} → {hedges_after} qualifier words). Check the conclusion is not made stronger than the evidence.", op=number))
                if numbers_in(original) and sorted(numbers_in(original)) != sorted(numbers_in(op.get("replacement", ""))) and op.get("scope") == "phrase":
                    issues.append(issue("warning", "numbers_changed", f"Operation {number}: numbers in the replaced text differ from the original. Verify against the evidence.", op=number))
    if destructive and not (proposal.get("qualification_check") or "").strip():
        issues.append(issue("warning", "qualification_check_missing", "State in 'qualification_check' whether any limitation, caveat or negative result is affected by the removal or revision."))

    info = {"insertion_points": points, "destructive": destructive, "additive": bool(additive)}
    return issues, info


def numbering_mode(doc: fitz.Document) -> str:
    """'printed' when pages carry their own printed numbers equal to their index (so references by number stay
    correct when pages are inserted, because inserted/continuation pages repeat the printed number); else 'index'."""
    if doc.page_count < 3:
        return "index"
    hits = 0
    for i in range(doc.page_count):
        page = doc[i]
        h = page.rect.height
        for w in page.get_text("words"):
            if (w[3] <= 0.10 * h or w[1] >= 0.90 * h) and norm_text(w[4]) == str(i + 1):
                hits += 1
                break
    return "printed" if hits / doc.page_count >= 0.6 else "index"


def dependents_and_refs(orig: fitz.Document, proposal: Dict[str, Any], page_map: Dict[int, int]) -> List[Dict[str, Any]]:
    """After building: other places that mention changed terms/numbers, and page references that may now be stale."""
    issues: List[Dict[str, Any]] = []
    text = DocText(orig)
    ops = proposal["ops"]
    touched_pages = {int(op["page"]) for op in ops if "page" in op}
    watch: Set[str] = set()
    for op in ops:
        if op["type"] in ("replace_passage", "delete_passage"):
            for w in words_of(op.get("quote", "")):
                if len(w) >= 7:
                    watch.add(w)
    for t in proposal.get("terms_defined") or []:
        watch.add(norm_text(str(t)))
    shown = 0
    for term in sorted(watch):
        # Words found on most pages (titles, running headers, ordinary vocabulary) say nothing about dependence.
        if sum(1 for i in range(orig.page_count) if term in text.norm(i + 1)) > max(3, orig.page_count // 2):
            continue
        for i in range(orig.page_count):
            if (i + 1) in touched_pages and term not in (norm_text(str(t)) for t in proposal.get("terms_defined") or []):
                continue
            if term in text.norm(i + 1) and shown < 8:
                snippet_at = text.norm(i + 1).find(term)
                issues.append(issue("info", "dependent_mention", f"'{term}' also appears on page {i + 1}: …{text.norm(i + 1)[max(0, snippet_at - 40):snippet_at + 60]}… Check it still agrees with this edit.", page=i + 1))
                shown += 1
    shifted = {old: new for old, new in page_map.items() if old != new} if numbering_mode(orig) == "index" else {}
    if shifted:
        for i in range(orig.page_count):
            for m in re.finditer(r"\b(?:pages?|p\.|pp\.)\s*(\d{1,4})\b", text.raw(i + 1), re.I):
                n = int(m.group(1))
                if n in shifted:
                    issues.append(issue("warning", "page_reference_shifted", f"Page {i + 1} says \"{m.group(0)}\" but that page is now page {shifted[n]}. Add a replace_passage operation to update the reference.", page=i + 1, was=n, now=shifted[n]))
    return issues
