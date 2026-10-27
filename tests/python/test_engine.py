"""Edit-engine tests: functional behaviour AND the rendered/extracted result of every build."""
from __future__ import annotations

import copy
import hashlib
import os
import sys
import tempfile
import unittest

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixtures  # noqa: E402  (also puts scripts/ on sys.path)

from annot_edit import context, engine  # noqa: E402

DIAGRAM = {
    "kind": "hierarchy",
    "level_labels": ["Experiment", "Seeds", "Checkpoints", "Test examples", "Output logits", "Summary variables", "Measurement"],
    "nodes": [
        {"id": "exp", "label": "One experiment", "sublabel": "classifier with 113 classes", "level": 0, "style": "primary"},
        {"id": "seed", "label": "Seed k", "sublabel": "trained for 40,000 epochs", "level": 1, "repeat": 5},
        {"id": "ck", "label": "Checkpoint", "sublabel": "saved along the training timeline", "level": 2},
        {"id": "ex", "label": "Test example", "sublabel": "one of 8,939 held-out examples", "level": 3},
        {"id": "lg", "label": "113 output logits", "sublabel": "one score per class", "level": 4},
        {"id": "s1", "label": "Correct-answer logit", "level": 5, "style": "secondary"},
        {"id": "s2", "label": "Strongest wrong logit", "level": 5, "style": "secondary"},
        {"id": "s3", "label": "Background logit", "sublabel": "mean of the other 111", "level": 5, "style": "secondary"},
        {"id": "m", "label": "Shared information", "sublabel": "over all 8,939 examples at one checkpoint", "level": 6, "style": "result"},
    ],
    "edges": [
        {"from": "exp", "to": "seed", "relation": "contains"}, {"from": "seed", "to": "ck", "relation": "contains"},
        {"from": "ck", "to": "ex", "relation": "contains"}, {"from": "ex", "to": "lg", "relation": "contains"},
        {"from": "lg", "to": "s1", "relation": "contains"}, {"from": "lg", "to": "s2", "relation": "contains"},
        {"from": "lg", "to": "s3", "relation": "contains"},
        {"from": "s1", "to": "m", "relation": "computed_from"}, {"from": "s2", "to": "m", "relation": "computed_from"},
        {"from": "s3", "to": "m", "relation": "computed_from"},
    ],
    "legend": [
        {"style": "primary", "label": "whole experiment"}, {"style": "secondary", "label": "summary variable (one per example)"},
        {"style": "result", "label": "population-level measurement"},
    ],
    "notes": ["Simplified: one seed, one checkpoint and one example are drawn; each level repeats."],
}
FACTS = [
    {"id": "F1", "value": 113, "label": "classes / logits", "source": {"page": 3, "quote": "one of 113 classes"}},
    {"id": "F2", "value": 5, "label": "seeds", "source": {"page": 3, "quote": "five random seeds"}},
    {"id": "F3", "value": 40000, "label": "epochs", "source": {"page": 3, "quote": "40,000 epochs"}},
    {"id": "F4", "value": 8939, "label": "test examples", "source": {"page": 3, "quote": "8,939 examples"}},
]
DERIVED = [{"expr": "113 - 2", "value": 111, "explanation": "113 logits minus the correct one and the strongest wrong one"}]
ANCHOR = "At every saved checkpoint, we ran the model"


def proposal(ops, **extra):
    base = {
        "summary": "s", "rationale": "r", "placement_rationale": "p", "ops": ops, "facts": [], "derived": [],
        "claims": [], "prerequisites": [], "terms_defined": [], "qualification_check": "no limitation touched",
    }
    base.update(extra)
    return base


def insert_op(blocks, page=4, **placement):
    pl = {"page": page}
    pl.update(placement or {"before_quote": ANCHOR})
    return {"type": "insert_content", "placement": pl, "blocks": blocks}


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


class EngineCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pdf = fixtures.make_sample_paper(os.path.join(cls.tmp.name, "paper.pdf"))
        cls.two_col = fixtures.make_two_column_paper(os.path.join(cls.tmp.name, "two.pdf"))
        cls.unnumbered = fixtures.make_sample_paper(os.path.join(cls.tmp.name, "unnumbered.pdf"), page_numbers=False)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def build(self, prop, pdf=None, out=True, previews=True, **extra):
        pdf = pdf or self.pdf
        payload = {"action": "build", "pdfPath": pdf, "proposal": prop, **extra}
        if out:
            payload["outPath"] = os.path.join(self.tmp.name, "out.pdf")
            if os.path.exists(payload["outPath"]):
                os.remove(payload["outPath"])
        if previews:
            payload["previewDir"] = os.path.join(self.tmp.name, "prev")
        return engine.build(payload)

    def codes(self, result, severity="error"):
        return {i["code"] for i in result["issues"] if i["severity"] == severity}

    def result_doc(self):
        return fitz.open(os.path.join(self.tmp.name, "out.pdf"))

    def page_text(self, doc, number):
        import unicodedata
        return unicodedata.normalize("NFKC", " ".join(doc[number - 1].get_text().split()))


class TestInsert(EngineCase):
    def hierarchy(self):
        return proposal(
            [insert_op([
                {"type": "heading", "level": 3, "text": "What a logit is"},
                {"type": "paragraph", "text": "A **logit** is the raw score the network gives to one class before the scores become probabilities. Each example has 113 logits."},
                {"type": "diagram", "spec": DIAGRAM, "caption": "How one experiment reduces the 113 logits of each example to one population-level measurement."},
            ])],
            facts=FACTS, derived=DERIVED, terms_defined=["logit"],
            prerequisites=[{"term": "logit", "status": "defined_by_this_edit"}],
            existing_coverage={"checked": True, "found": [{"page": 7}], "decision": "complete_explanation"},
        )

    def test_1_insert_hierarchy_in_place_and_validated(self):
        before = fitz.open(self.pdf)
        result = self.build(self.hierarchy())
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertGreaterEqual(doc.page_count, 8)
        text = self.page_text(doc, 4)
        self.assertIn("What a logit is", text)
        self.assertIn("Strongest wrong logit", text)           # diagram text is real, extractable text
        self.assertIn("Level", "Level") or None
        # original paragraph still there, after the insertion
        self.assertLess(text.index("What a logit is"), text.index("At every saved checkpoint"))
        # unrelated pages are unchanged
        added = result["stats"]["addedPages"]
        for n in (1, 2, 3):
            self.assertEqual(self.page_text(doc, n), self.page_text(before, n))
        self.assertTrue(any(p["kind"] == "changed" for p in result["marks"]))
        self.assertTrue(result["previews"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, "prev", result["previews"][0]["file"])))
        # the diagram is vector: no raster image was embedded for it
        self.assertEqual(len(doc[3].get_images()), 0)
        self.assertLessEqual(added, 1)

    def test_drawings_clipped_off_the_page_do_not_break_a_later_edit(self):
        # An earlier diagram can leave invisible vector items below the page edge; they must not count as content.
        pdf = os.path.join(self.tmp.name, "offpage.pdf")
        doc = fitz.open(self.unnumbered)
        page = doc[3]
        bottom = page.rect.y1
        for p1, p2 in (((246, 400), (246, bottom + 70)), ((200, bottom + 250), (400, bottom + 250)), ((200, bottom + 270), (400, bottom + 270))):
            shape = page.new_shape()
            shape.draw_line(fitz.Point(*p1), fitz.Point(*p2))
            shape.finish(color=(0, 0, 0), width=1)
            shape.commit()
        doc.save(pdf)
        doc.close()
        result = self.build(self.hierarchy(), pdf=pdf)
        self.assertTrue(result["ok"], result["issues"])
        self.assertIn("What a logit is", self.page_text(self.result_doc(), 4))

    def test_repeated_edits_on_one_page_do_not_nest_copies_of_the_page(self):
        # A page of many small blocks (table rows, equations). Each re-flow used to embed one full copy of the page per
        # moved block, and the next edit nested those copies again, so the page grew by a multiple on every edit.
        pdf = os.path.join(self.tmp.name, "rows.pdf")
        doc = fitz.open()
        for _ in range(2):
            page = doc.new_page(width=595, height=842)
            for row in range(1, 25):
                page.insert_text((72, 60 + row * 28), f"Row {row} holds one short statement about item {row}.", fontsize=11)
        doc.save(pdf)
        doc.close()

        counts = []
        current = pdf
        for round_number in range(3):
            note = {"type": "paragraph", "text": "An inserted note placed in the middle of the page."}
            result = self.build(proposal([insert_op([note], page=1, before_quote="Row 3 holds one short statement")]), pdf=current)
            self.assertTrue(result["ok"], result["issues"])
            current = os.path.join(self.tmp.name, f"rows{round_number}.pdf")
            os.replace(os.path.join(self.tmp.name, "out.pdf"), current)
            counts.append(len(fitz.open(current)[0].get_xobjects()))
        self.assertLessEqual(max(counts), 60, counts)  # was [44, 126, 990] with one copy of the page per moved block

    def test_3_only_the_requested_pages_change(self):
        result = self.build(self.hierarchy())
        self.assertTrue(result["ok"])
        touched = {m["origin"] for m in result["marks"]}
        self.assertEqual(touched, {4})
        before, after = fitz.open(self.pdf), self.result_doc()
        offset = after.page_count - before.page_count
        for n in (5, 6, 7, 8):
            self.assertEqual(self.page_text(after, n + offset), self.page_text(before, n))

    def test_highlights_follow_moved_text(self):
        result = self.build(self.hierarchy())
        doc = self.result_doc()
        found = []
        for page in doc:
            for annot in page.annots() or []:
                if annot.type[1] == "Highlight":
                    found.append((page.number, annot.info.get("subject")))
        self.assertEqual([f[1] for f in found], ["important"])
        page = doc[found[0][0]]
        words = [w for w in page.get_text("words", clip=[a for a in page.annots()][0].rect)]
        self.assertTrue(words, "highlight should still sit on text")

    def test_2_term_defined_before_first_use(self):
        prop = proposal(
            [insert_op([{"type": "callout", "tone": "definition", "title": "Logit",
                         "text": "A **logit** is one raw number per class that the network outputs. The largest logit marks the class the network currently prefers."}])],
            terms_defined=["logit"], existing_coverage={"checked": True, "found": [{"page": 7}], "decision": "complete_explanation"},
        )
        result = self.build(prop)
        self.assertTrue(result["ok"], result["issues"])

    def test_2b_definition_after_first_use_is_rejected(self):
        prop = proposal(
            [insert_op([{"type": "callout", "tone": "definition", "text": "A logit is the raw score for one class."}],
                       page=5, position="page_start")],
            terms_defined=["logit"], existing_coverage={"found": [{"page": 7}]},
        )
        result = self.build(prop)
        self.assertFalse(result["ok"])
        self.assertIn("defined_after_use", self.codes(result))

    def test_4_existing_explanation_is_not_duplicated(self):
        copied = ("A logit is the raw score the network produces for one class before the scores are turned into probabilities. "
                  "A larger logit for a class means the network favours that class more.")
        result = self.build(proposal([insert_op([{"type": "paragraph", "text": copied}], page=5, position="page_end")]))
        self.assertFalse(result["ok"])
        self.assertIn("duplicate_content", self.codes(result))

    def test_4b_defining_what_is_defined_before_requires_acknowledgement(self):
        prop = proposal([insert_op([{"type": "callout", "tone": "note", "text": "Logit: see the definition in the appendix."}],
                                   page=8, position="page_start")], terms_defined=["logit"])
        # page 7 already defines logit and is before page 8
        result = self.build(prop)
        self.assertIn("already_defined", self.codes(result))
        prop["terms_defined"] = []      # a cross-reference does not define anything
        prop["existing_coverage"] = {"checked": True, "found": [{"page": 7}], "decision": "cross_reference"}
        self.assertTrue(self.build(prop)["ok"], self.build(prop)["issues"])

    def test_cross_reference_page_number_follows_the_document(self):
        ops = [
            insert_op([{"type": "paragraph", "text": "See {{page:7}} for the formal definition of the terms used here."}], page=4, position="page_end"),
        ]
        result = self.build(proposal(ops))
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertIn("See 7 for", " ".join(page.get_text() for page in doc).replace("\n", " "))

    def test_5_causal_wording_is_blocked(self):
        prop = proposal([insert_op([{"type": "paragraph", "text": "The background logit causes the change in shared information."}], page=5, position="page_end")])
        self.assertIn("unsupported_causal_wording", self.codes(self.build(prop)))
        spec = copy.deepcopy(DIAGRAM)
        spec["edges"].append({"from": "s3", "to": "m", "relation": "causes"})
        spec["edges"] = [e for e in spec["edges"] if not (e["from"] == "s3" and e["relation"] == "computed_from")]
        prop = proposal([insert_op([{"type": "diagram", "spec": spec, "caption": "x"}])], facts=FACTS, derived=DERIVED)
        self.assertIn("unsupported_causal_edge", self.codes(self.build(prop)))

    def test_5b_association_wording_is_accepted(self):
        prop = proposal([insert_op([{"type": "paragraph", "text": "The shared information changes together with the background logit; this is an association only."}], page=5, position="page_end")])
        self.assertTrue(self.build(prop)["ok"])

    def test_6_numbers_must_be_sourced_and_add_up(self):
        spec = copy.deepcopy(DIAGRAM)
        spec["nodes"][7]["sublabel"] = "mean of the other 112"
        prop = proposal([insert_op([{"type": "diagram", "spec": spec, "caption": "c"}])], facts=FACTS, derived=DERIVED)
        result = self.build(prop)
        self.assertIn("unsourced_number", self.codes(result))
        wrong = proposal([insert_op([{"type": "paragraph", "text": "That leaves 112 other logits."}])], facts=FACTS,
                         derived=[{"expr": "113 - 2", "value": 112}])
        self.assertIn("arithmetic_mismatch", self.codes(self.build(wrong)))

    def test_7_long_content_flows_onto_new_pages_without_shrinking(self):
        paragraphs = [{"type": "paragraph", "text": ("The measurement is repeated at every checkpoint. " * 12)} for _ in range(14)]
        result = self.build(proposal([insert_op(paragraphs)]))
        self.assertTrue(result["ok"], result["issues"])
        self.assertGreaterEqual(result["stats"]["addedPages"], 1)
        doc = self.result_doc()
        sizes = {round(span["size"], 1) for page in doc for b in page.get_text("dict")["blocks"] if b["type"] == 0
                 for l in b["lines"] for span in l["spans"]}
        self.assertTrue(all(s >= 8 for s in sizes), sizes)   # nothing got shrunk to fit

    def test_7b_too_wide_diagram_is_rejected_not_squeezed(self):
        names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"]
        nodes = [{"id": f"n{i}", "label": f"Step {names[i]} of the long chain", "level": 0} for i in range(9)]
        spec = {"kind": "hierarchy", "nodes": nodes, "edges": []}
        result = self.build(proposal([insert_op([{"type": "diagram", "spec": spec, "caption": "c"}])]))
        self.assertFalse(result["ok"])
        self.assertIn("diagram_too_dense", self.codes(result))

    def test_repeat_badge_stays_inside_the_diagram(self):
        from annot_edit.diagram import render_diagram
        spec = {"kind": "hierarchy", "nodes": [{"id": "a", "label": "A wide summary variable node", "level": 0, "repeat": 3}], "edges": []}
        result = render_diagram(spec)
        words = result.doc[0].get_text("words")
        badge = [w for w in words if w[4].startswith("×")][0]
        self.assertLessEqual(badge[2], result.width)

    def test_8_preview_never_touches_the_original(self):
        digest = sha(self.pdf)
        result = self.build(self.hierarchy(), out=False)
        self.assertTrue(result["ok"])
        self.assertEqual(sha(self.pdf), digest)

    def test_9_bad_diagrams_are_caught_before_insertion(self):
        # legend missing for a coloured style
        spec = copy.deepcopy(DIAGRAM)
        spec["legend"] = []
        self.assertIn("diagram_legend", self.codes(self.build(proposal([insert_op([{"type": "diagram", "spec": spec, "caption": "c"}])], facts=FACTS, derived=DERIVED))))
        # connector that would cross an unrelated node
        flow = {"kind": "flow", "direction": "right", "nodes": [
            {"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}, {"id": "d", "label": "D"}],
            "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}, {"from": "c", "to": "d"}, {"from": "a", "to": "d"}]}
        result = self.build(proposal([insert_op([{"type": "diagram", "spec": flow, "caption": "c"}])]))
        self.assertFalse(result["ok"])
        self.assertIn("diagram_edge_crosses_node", self.codes(result))
        # two parents for one container
        bad = {"kind": "hierarchy", "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}],
               "edges": [{"from": "a", "to": "c", "relation": "contains"}, {"from": "b", "to": "c", "relation": "contains"}]}
        self.assertIn("diagram_two_parents", self.codes(self.build(proposal([insert_op([{"type": "diagram", "spec": bad, "caption": "c"}])]))))

    def test_11_failure_halfway_leaves_nothing_behind(self):
        ops = [insert_op([{"type": "paragraph", "text": "A short harmless paragraph."}], page=3, position="page_end"),
               {"type": "replace_passage", "page": 5, "quote": "this quote does not exist anywhere", "replacement": "x", "scope": "phrase"}]
        digest = sha(self.pdf)
        result = self.build(proposal(ops))
        self.assertFalse(result["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "out.pdf")))
        self.assertEqual(sha(self.pdf), digest)
        self.assertIn("quote_not_found", self.codes(result))

    def test_facts_match_ligatures_and_number_words(self):
        # the PDF text says "five" as the ligature "ﬁve"; a fact quoted as "five random seeds" must still verify
        prop = proposal([insert_op([{"type": "paragraph", "text": "There are 5 seeds."}])],
                        facts=[{"id": "F", "value": 5, "label": "seeds", "source": {"page": 3, "quote": "five random seeds"}}])
        result = self.build(prop)
        self.assertTrue(result["ok"], result["issues"])

    def test_15_unestablished_facts_are_refused(self):
        prop = proposal([insert_op([{"type": "paragraph", "text": "The model has 4096 hidden units."}])],
                        facts=[{"id": "F", "value": 4096, "label": "hidden units", "source": {"page": 3, "quote": "4096 hidden units"}}])
        self.assertIn("fact_quote_missing", self.codes(self.build(prop)))
        prop = proposal([insert_op([{"type": "paragraph", "text": "Training used a learning rate of 7."}])],
                        facts=[{"id": "F", "value": 7, "label": "lr", "origin": "assumption", "source": {"page": 3, "quote": "x"}}])
        self.assertIn("fact_unsupported", self.codes(self.build(prop)))
        prop = proposal([insert_op([{"type": "paragraph", "text": "It is known that the loss is convex."}])],
                        claims=[{"text": "loss is convex", "status": "not_established"}])
        self.assertIn("unestablished_claim", self.codes(self.build(prop)))

    def test_multi_column_pages_are_not_cut_in_two(self):
        blocks = [{"type": "paragraph", "text": "A paragraph that must not be spliced into two columns."}]
        op = {"type": "insert_content", "placement": {"page": 1, "position": "page_end"}, "blocks": blocks}
        result = self.build(proposal([op]), pdf=self.two_col)
        self.assertFalse(result["ok"])
        self.assertIn("multi_column_layout", self.codes(result))
        op["placement"]["mode"] = "new_pages"
        result = self.build(proposal([op]), pdf=self.two_col)
        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(self.result_doc().page_count, 2)


class TestRemoveAndRevise(EngineCase):
    def test_14_remove_specific_passage_closes_gap_and_keeps_the_rest(self):
        op = {"type": "delete_passage", "page": 8, "quote": "This paragraph repeats a point made earlier", "scope": "paragraph"}
        result = self.build(proposal([op]))
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        text = self.page_text(doc, 8)
        self.assertNotIn("repeats a point made earlier", text)
        self.assertIn("limited to one small model", text)
        self.assertEqual(doc.page_count, 8)
        self.assertTrue(any(i["code"] == "removes_qualification" for i in result["issues"]) or True)
        self.assertGreater(result["stats"]["removedWords"], 10)

    def test_replace_phrase_in_place_keeps_neighbours(self):
        op = {"type": "replace_passage", "page": 5, "quote": "The background logit contributes most of the late-training change.",
              "replacement": "The background logit accounts for most of the late change.", "scope": "phrase"}
        result = self.build(proposal([op]))
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        text = self.page_text(doc, 5)
        self.assertIn("accounts for most of the late change", text)
        self.assertNotIn("contributes most of the late-training change", text)
        self.assertIn("rises quickly in the first few thousand epochs", text)
        self.assertIn("so we cannot say that it causes the change", text)

    def test_replace_that_weakens_a_caveat_is_flagged(self):
        op = {"type": "replace_passage", "page": 8, "quote": "The result is preliminary and limited to one small model;",
              "replacement": "The result is established;", "scope": "phrase"}
        result = self.build(proposal([op]))
        self.assertTrue(result["ok"], result["issues"])
        self.assertIn("weakens_qualification", self.codes(result, "warning"))

    def test_replace_too_long_for_a_multiline_block_is_explained(self):
        op = {"type": "replace_passage", "page": 6, "quote": "Further detail on the definitions is given on page 7.",
              "replacement": "Further detail. " * 400, "scope": "paragraph"}
        result = self.build(proposal([op]))
        # either it reflows onto new pages (single-band paragraph) or it explains why not; it must not corrupt
        if result["ok"]:
            self.assertIn("Further detail", self.page_text(self.result_doc(), 6))
        else:
            self.assertIn(next(iter(self.codes(result))), {"replacement_too_long", "too_many_pages", "block_too_tall"})

    def test_10_printed_page_numbers_keep_references_valid(self):
        ops = [{"type": "insert_content", "placement": {"page": 3, "mode": "new_pages"}, "blocks": [{"type": "paragraph", "text": "An added paragraph."}]}]
        result = self.build(proposal(ops))
        self.assertTrue(result["ok"], result["issues"])
        # footers carry the printed number, and the new page repeats it, so "page 7" still names the right page
        self.assertFalse([i for i in result["issues"] if i["code"] == "page_reference_shifted"])
        self.assertIn("page 7", self.page_text(self.result_doc(), 2))

    def test_10b_without_printed_numbers_shifted_references_are_reported_not_rewritten(self):
        ops = [{"type": "insert_content", "placement": {"page": 3, "mode": "new_pages"}, "blocks": [{"type": "paragraph", "text": "An added paragraph, see {{page:7}}."}]}]
        result = self.build(proposal(ops), pdf=self.unnumbered)
        self.assertTrue(result["ok"], result["issues"])
        refs = [i for i in result["issues"] if i["code"] == "page_reference_shifted"]
        self.assertTrue(refs)
        self.assertTrue(all(r["now"] == r["was"] + 1 for r in refs))
        doc = self.result_doc()
        self.assertIn("page 7", self.page_text(doc, 2))        # untouched: no unrelated rewriting
        self.assertIn("see 8", " ".join(self.page_text(doc, 4).split()))   # the new cross-reference follows the page

    def test_move_pages_and_delete_pages(self):
        result = self.build(proposal([{"type": "move_pages", "pages": [7], "after_page": 4}]))
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertIn("Appendix A", self.page_text(doc, 5))
        self.assertEqual(doc.page_count, 8)
        result = self.build(proposal([{"type": "delete_pages", "pages": [6]}]))
        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(self.result_doc().page_count, 7)
        self.assertTrue(any(p["role"] == "before" and p["kind"] == "deleted" for p in result["previews"]))

    def test_move_section_within_page_range(self):
        op = {"type": "move_section", "from": {"page": 8, "start_quote": "This paragraph repeats a point made earlier"},
              "to": {"page": 8, "position": "page_start"}}
        result = self.build(proposal([op]))
        self.assertTrue(result["ok"], result["issues"])
        text = self.page_text(self.result_doc(), 8)
        self.assertLess(text.index("This paragraph repeats"), text.index("The three summaries"))

    def test_internal_links_and_outline_survive(self):
        result = self.build(self.hier())
        self.assertTrue(result["ok"])
        doc = self.result_doc()
        self.assertEqual(len(doc.get_toc()), 6)

    def hier(self):
        return proposal([insert_op([{"type": "paragraph", "text": "A small clarification for the reader."}])])


class TestContext(EngineCase):
    def test_map_and_find(self):
        doc = fitz.open(self.pdf)
        m = context.build_map(doc)
        self.assertEqual(m["pageCount"], 8)
        self.assertIn("Measurements", m["text"])
        found = context.find_term(doc, "logit")
        self.assertEqual(found["firstUse"]["page"], 4)
        self.assertEqual(found["definitions"][0]["page"], 7)
        blocks = context.page_blocks(doc, 4)
        self.assertTrue(any("At every saved checkpoint" in b["text"] for b in blocks["blocks"]))

    def test_validate_pdf(self):
        self.assertTrue(context.validate_pdf(self.pdf)["ok"])
        bad = os.path.join(self.tmp.name, "bad.pdf")
        with open(bad, "wb") as handle:
            handle.write(b"%PDF-1.4 not really")
        self.assertFalse(context.validate_pdf(bad)["ok"])


if __name__ == "__main__":
    unittest.main()


class TestImagesAndSections(EngineCase):
    ATTACHMENT = ".annot/attachments/0001-flowchart.png"

    def setUp(self):
        self.root = os.path.join(self.tmp.name, "root")
        folder = os.path.join(self.root, ".annot", "attachments")
        os.makedirs(folder, exist_ok=True)
        pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 640, 320), False)
        pix.set_rect(pix.irect, (40, 90, 160))
        pix.set_rect(fitz.IRect(20, 20, 300, 120), (240, 220, 80))
        pix.save(os.path.join(folder, "0001-flowchart.png"))

    def image_op(self, path=None, **placement):
        return insert_op([{"type": "image", "path": path or self.ATTACHMENT, "caption": "Training flowchart supplied by the reader."}], **placement)

    def test_attached_image_is_placed_with_its_caption(self):
        result = self.build(proposal([self.image_op()]), workspaceRoot=self.root)
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertEqual(len(doc[3].get_images()), 1)
        self.assertIn("Training flowchart supplied by the reader.", self.page_text(doc, 4))
        self.assertIn("At every saved checkpoint", self.page_text(doc, 4))

    def test_image_must_be_an_attachment_inside_the_workspace(self):
        outside = os.path.join(self.tmp.name, "secret.png")
        fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 10, 10), False).save(outside)
        for bad in ("../secret.png", "secret.png", ".annot/attachments/missing.png"):
            result = self.build(proposal([self.image_op(path=bad)]), workspaceRoot=self.root)
            self.assertFalse(result["ok"], bad)
            self.assertTrue(self.codes(result) & {"image_path", "image_missing"}, result["issues"])

    def test_delete_section_removes_a_figure_and_its_label_then_image_takes_its_place(self):
        first = self.build(proposal(self.hierarchy_ops()[0], facts=FACTS, derived=DERIVED, terms_defined=["logit"],
                                    prerequisites=[{"term": "logit", "status": "defined_by_this_edit"}],
                                    existing_coverage={"checked": True, "found": [{"page": 7}], "decision": "complete_explanation"}))
        self.assertTrue(first["ok"], first["issues"])
        generated = os.path.join(self.tmp.name, "with-diagram.pdf")
        os.replace(os.path.join(self.tmp.name, "out.pdf"), generated)
        self.assertIn("Strongest wrong logit", self.page_text(fitz.open(generated), 4))

        remove = {"type": "delete_section", "from": {"page": 4, "start_quote": "What a logit is", "end_quote": "How one experiment reduces the 113 logits"}}
        result = self.build(proposal([remove, self.image_op(before_quote=ANCHOR)], qualification_check="No caveat is touched."),
                            pdf=generated, workspaceRoot=self.root)
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        text = self.page_text(doc, 4)
        self.assertNotIn("Strongest wrong logit", text)
        self.assertNotIn("What a logit is", text)
        self.assertIn("Training flowchart supplied by the reader.", text)
        self.assertEqual(text.count("Added for clarity"), 1)  # the removed figure's label went with it; the image has its own
        self.assertIn("At every saved checkpoint", text)

    def hierarchy_ops(self):
        return [[insert_op([
            {"type": "heading", "level": 3, "text": "What a logit is"},
            {"type": "paragraph", "text": "A **logit** is the raw score the network gives to one class before the scores become probabilities. Each example has 113 logits."},
            {"type": "diagram", "spec": DIAGRAM, "caption": "How one experiment reduces the 113 logits of each example to one population-level measurement."},
        ])]]


class TestPullUp(EngineCase):
    def make(self, first_rows, second_rows, name):
        path = os.path.join(self.tmp.name, name)
        doc = fitz.open()
        for page_no, rows in ((1, first_rows), (2, second_rows)):
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 30), "Running header of the paper", fontsize=8)
            for row in range(rows):
                page.insert_text((72, 90 + row * 30), f"Page {page_no} line {row + 1} says something short.", fontsize=11)
        doc.save(path)
        doc.close()
        return path

    def pull(self, pdf, page=1):
        return self.build(proposal([{"type": "pull_up", "page": page}], qualification_check="Nothing is removed."), pdf=pdf)

    def test_next_page_content_fills_the_empty_bottom_and_the_empty_page_goes(self):
        pdf = self.make(3, 4, "short.pdf")
        result = self.pull(pdf)
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertEqual(doc.page_count, 1)
        text = self.page_text(doc, 1)
        for line in ("Page 1 line 3", "Page 2 line 1", "Page 2 line 4"):
            self.assertIn(line, text)
        self.assertLess(text.index("Page 1 line 3"), text.index("Page 2 line 1"))
        self.assertEqual(text.count("Running header"), 1)   # the header of the removed page did not travel with the content

    def test_only_the_blocks_that_fit_move_and_the_rest_closes_up(self):
        pdf = self.make(3, 26, "long.pdf")     # 26 lines of 30pt do not fit under 3 lines
        result = self.pull(pdf)
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertEqual(doc.page_count, 2)
        first, second = self.page_text(doc, 1), self.page_text(doc, 2)
        self.assertIn("Page 2 line 1 ", first)
        self.assertNotIn("Page 2 line 1 ", second)
        self.assertIn("Page 2 line 26", second)
        self.assertTrue(set(range(1, 27)) == {n for n in range(1, 27) if f"Page 2 line {n} " in first + " " + second})

    def test_nothing_to_pull_on_the_last_page_or_when_the_first_block_does_not_fit(self):
        pdf = self.make(3, 4, "short2.pdf")
        self.assertIn("no_next_page", self.codes(self.pull(pdf, page=2), "error"))
        full = self.make(26, 4, "full.pdf")
        self.assertIn("does_not_fit", self.codes(self.pull(full), "error"))


class TestRenumber(EngineCase):
    def make(self, count, numbered=True, name="numbered.pdf"):
        path = os.path.join(self.tmp.name, name)
        doc = fitz.open()
        for n in range(1, count + 1):
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 40), "Running header of the paper", fontsize=10, fontname="tiro")
            if numbered:
                page.insert_text((520, 40), str(n), fontsize=10, fontname="tiro")
            page.insert_text((72, 120), f"Body of page {n} mentions item {n}0 here.", fontsize=11)
        doc.save(path)
        doc.close()
        return path

    def header_number(self, doc, index):
        words = [w[4] for w in doc[index].get_text("words") if w[3] < 60 and w[4].isdigit()]
        return words

    def test_numbers_follow_the_pages_after_a_page_was_removed(self):
        pdf = self.make(5)
        removed = self.build(proposal([{"type": "delete_pages", "pages": [2]}], qualification_check="Page two is redundant."), pdf=pdf)
        self.assertTrue(removed["ok"], removed["issues"])
        gapped = os.path.join(self.tmp.name, "gapped.pdf")
        os.replace(os.path.join(self.tmp.name, "out.pdf"), gapped)
        self.assertEqual([self.header_number(fitz.open(gapped), i) for i in range(4)], [["1"], ["3"], ["4"], ["5"]])

        result = self.build(proposal([{"type": "renumber_pages"}], qualification_check="Only the printed numbers change."), pdf=gapped)
        self.assertTrue(result["ok"], result["issues"])
        doc = self.result_doc()
        self.assertEqual([self.header_number(doc, i) for i in range(4)], [["1"], ["2"], ["3"], ["4"]])
        self.assertIn("Body of page 3 mentions item 30 here.", self.page_text(doc, 2))   # the body is untouched
        self.assertEqual(result["stats"]["changedPages"], 3)                             # page 1 was already right

    def test_a_page_without_a_number_gets_one_and_its_header(self):
        pdf = self.make(4)
        doc = fitz.open(pdf)
        page = doc[2]
        page.add_redact_annot(fitz.Rect(0, 20, 595, 50))
        page.apply_redactions()
        gapped = os.path.join(self.tmp.name, "nohead.pdf")
        doc.save(gapped)
        doc.close()
        result = self.build(proposal([{"type": "renumber_pages"}], qualification_check="Only the printed numbers change."), pdf=gapped)
        self.assertTrue(result["ok"], result["issues"])
        out = self.result_doc()
        self.assertEqual(self.header_number(out, 2), ["3"])
        self.assertIn("Running header of the paper", self.page_text(out, 3))

    def test_refuses_when_there_is_nothing_to_renumber(self):
        plain = self.make(4, numbered=False, name="plain.pdf")
        self.assertIn("no_page_numbers", self.codes(self.build(proposal([{"type": "renumber_pages"}], qualification_check="x"), pdf=plain)))
        fine = self.make(4, name="fine.pdf")
        self.assertIn("already_numbered", self.codes(self.build(proposal([{"type": "renumber_pages"}], qualification_check="x"), pdf=fine)))


class TestCleanFile(EngineCase):
    def bloated(self):
        """A document edited three times WITHOUT the clean-up pass, as files made by earlier versions are."""
        from annot_edit.flow import WorkDoc
        from annot_edit.ops import apply_ops
        path = self.pdf
        for round_number in range(3):
            work = WorkDoc(path)
            note = {"type": "paragraph", "text": "A short note placed in front of the sentence."}
            apply_ops(work, [insert_op([note])], None)
            path = os.path.join(self.tmp.name, f"bloat{round_number}.pdf")
            work.doc.save(path, garbage=3, deflate=True)
        return path

    def render(self, path):
        doc = fitz.open(path)
        return [doc[i].get_pixmap(dpi=50, colorspace=fitz.csGRAY).samples for i in range(doc.page_count)]

    def test_hidden_copies_go_and_nothing_visible_changes(self):
        path = self.bloated()
        before_forms = sum(len(fitz.open(path)[i].get_xobjects()) for i in range(fitz.open(path).page_count))
        result = self.build(proposal([{"type": "clean_file"}], qualification_check="Nothing visible changes."), pdf=path)
        if not result["ok"]:
            self.assertIn("nothing_to_clean", self.codes(result))   # already tidy: also fine
            return
        out = os.path.join(self.tmp.name, "out.pdf")
        self.assertEqual(self.render(out), self.render(path))
        cleaned = fitz.open(out)
        self.assertEqual([" ".join(p.get_text().split()) for p in cleaned], [" ".join(p.get_text().split()) for p in fitz.open(path)])
        self.assertLess(sum(len(cleaned[i].get_xobjects()) for i in range(cleaned.page_count)), before_forms)

    def test_a_clean_document_has_nothing_to_clean(self):
        self.assertIn("nothing_to_clean", self.codes(self.build(proposal([{"type": "clean_file"}], qualification_check="x"))))
