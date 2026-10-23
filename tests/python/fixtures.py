"""Deterministic sample PDFs used by the edit-engine tests (and for manual end-to-end runs)."""
from __future__ import annotations

import os
import sys
from typing import List, Optional

import fitz

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "pdf-engine"))

TITLE = "Information Dynamics in a Modular Classifier"

PAGES = [
    # page 1
    [
        ("h1", "Information Dynamics in a Modular Classifier"),
        ("p", "<b>Abstract.</b> We study how a small classifier organises information about its own outputs while it trains. "
              "We follow five independently trained copies of the model and record how three summaries of its output scores "
              "relate to each other over time. The relationship changes sharply early in training and then settles."),
        ("p", "The results are exploratory. They describe an association between the summaries; they do not identify a mechanism."),
    ],
    # page 2
    [
        ("h2", "1 Introduction"),
        ("p", "Classifiers are usually judged by their accuracy. Accuracy hides how the model spreads its confidence across the wrong answers, "
              "and that spread is the subject of this paper. We ask whether the spread carries information about the right answer."),
        ("p", "Section 2 describes the experiment, Section 3 the measurements, and Section 4 the results. Terms used throughout are collected in Appendix A on page 7."),
    ],
    # page 3
    [
        ("h2", "2 Experimental setup"),
        ("p", "The model is a small feed-forward network trained to recognise one of 113 classes. We train it from five random seeds. "
              "Each seed is trained for 40,000 epochs, and a checkpoint of the model is saved at regular intervals along the way."),
        ("p", "After training, each checkpoint is evaluated on a held-out test set of 8,939 examples that the model never saw during training."),
    ],
    # page 4
    [
        ("h2", "3 Measurements"),
        ("p", "At every saved checkpoint, we ran the model on the 8,939 unseen test examples. From each example's 113 output logits, "
              "we kept three summaries: the correct-answer logit, the strongest wrong logit and the background logit. "
              "We then measured how these three quantities share information across the test population."),
        ("p", "The measurement is repeated at every checkpoint, so each seed yields a time series of the same quantity."),
    ],
    # page 5
    [
        ("h2", "4 Results"),
        ("p", "In all five seeds the shared information rises quickly in the first few thousand epochs and then flattens. "
              "The background logit contributes most of the late-training change."),
        ("p", "However, we only observed this association; we did not intervene on the background logit, so we cannot say that it causes the change."),
    ],
    # page 6
    [
        ("h2", "4.1 Figure"),
        ("fig", "Figure 1. Shared information over training for one seed (schematic)."),
        ("p", "Further detail on the definitions is given on page 7."),
    ],
    # page 7
    [
        ("h2", "Appendix A: Terms"),
        ("p", "<b>Logit.</b> A logit is the raw score the network produces for one class before the scores are turned into probabilities. "
              "A larger logit for a class means the network favours that class more."),
        ("p", "<b>Checkpoint.</b> A saved copy of the model's parameters at one moment of training."),
    ],
    # page 8
    [
        ("h2", "5 Conclusion and limitations"),
        ("p", "The three summaries become more strongly related early in training. The result is preliminary and limited to one small model; "
              "we make no claim that it holds for larger systems."),
        ("p", "This paragraph repeats a point made earlier and could be removed without loss: the shared information flattens after the early rise."),
    ],
]


def _css(serif: bool) -> str:
    family = "serif" if serif else "sans-serif"
    return ("body{font-family:%s;font-size:11pt;line-height:1.3}"
            "p{margin:0 0 7pt 0;text-align:left}h1{font-size:20pt;margin:0 0 10pt 0}"
            "h2{font-size:14pt;margin:0 0 8pt 0}" % family)


def make_sample_paper(path: str, serif: bool = True, with_highlight: bool = True, pages: Optional[List] = None,
                      page_numbers: bool = True) -> str:
    doc = fitz.open()
    for number, items in enumerate(pages or PAGES, start=1):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 40), TITLE, fontsize=8, fontname="helv", color=(0.4, 0.4, 0.4))
        if page_numbers:
            page.insert_text((300, 810), str(number), fontsize=9, fontname="helv", color=(0.3, 0.3, 0.3))
        y = 84.0
        for kind, text in items:
            if kind == "fig":
                shape = page.new_shape()
                shape.draw_rect(fitz.Rect(120, y, 475, y + 170))
                shape.finish(color=(0.2, 0.3, 0.6), fill=(0.9, 0.93, 0.98), width=1)
                shape.draw_polyline([(140, y + 150), (200, y + 90), (260, y + 50), (340, y + 40), (450, y + 38)])
                shape.finish(color=(0.8, 0.2, 0.2), width=2)
                shape.commit()
                y += 178
                page.insert_htmlbox(fitz.Rect(72, y, 523, y + 40), "<p><i>%s</i></p>" % text, css=_css(serif))
                y += 34
                continue
            html = "<%s>%s</%s>" % (kind if kind != "p" else "p", text, kind if kind != "p" else "p")
            spare, _ = page.insert_htmlbox(fitz.Rect(72, y, 523, 760), html, css=_css(serif))
            used = (760 - y) - spare
            y += used + 4
    doc.set_toc([
        [1, "Introduction", 2], [1, "Experimental setup", 3], [1, "Measurements", 4],
        [1, "Results", 5], [1, "Appendix A: Terms", 7], [1, "Conclusion and limitations", 8],
    ])
    if with_highlight:
        page = doc[3]
        hits = page.search_for("the strongest wrong logit")
        annot = page.add_highlight_annot(hits[0])
        annot.set_colors(stroke=(0.99, 0.70, 0.35))
        annot.set_info(title="Annot", subject="important", content='{"annot":"annot-v1","text":"the strongest wrong logit","note":"check"}')
        annot.update()
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    return path


def make_two_column_paper(path: str) -> str:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    css = "body{font-family:serif;font-size:9pt}p{margin:0 0 6pt 0}"
    left = "<p>" + ("Left column text about the model and its training. " * 14) + "</p><p>" + ("More left text here. " * 20) + "</p>"
    right = "<p>" + ("Right column text about measurements and logits. " * 14) + "</p><p>" + ("More right text here. " * 20) + "</p>"
    page.insert_htmlbox(fitz.Rect(40, 60, 285, 780), left, css=css)
    page.insert_htmlbox(fitz.Rect(310, 60, 555, 780), right, css=css)
    doc.save(path)
    doc.close()
    return path


if __name__ == "__main__":
    # python3 tests/python/fixtures.py out.pdf  -> writes the sample paper (used by the TypeScript tests)
    make_sample_paper(sys.argv[1])
