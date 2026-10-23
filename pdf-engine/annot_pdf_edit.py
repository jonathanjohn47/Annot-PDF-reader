#!/usr/bin/env python3
"""Annot PDF edit engine entry point.

Two ways to call it:
  * JSON on stdin (used by the app):   {"action": "build" | "map" | "find" | "text" | "pages" | "outline" | "validate_pdf" | "render", ...}
  * Command line (usable by the AI assistant to read the document before proposing an edit):
        annot_pdf_edit.py map     --pdf FILE
        annot_pdf_edit.py outline --pdf FILE
        annot_pdf_edit.py pages   --pdf FILE [--pages 3-5]     per-page headings, captions, first line
        annot_pdf_edit.py text    --pdf FILE --pages 4         exact paragraph text with y-ranges (copy quotes from here)
        annot_pdf_edit.py find    --pdf FILE --term logit      where a term is used / defined first

Output is always JSON on stdout. Exit code is non-zero only for crashes, not for rejected edits.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from annot_edit import context, engine  # noqa: E402


def main() -> int:
    if len(sys.argv) == 1:
        payload = json.load(sys.stdin)
    else:
        parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
        parser.add_argument("action")
        parser.add_argument("--pdf", required=True)
        parser.add_argument("--pages")
        parser.add_argument("--term")
        args = parser.parse_args()
        payload = {"action": args.action, "pdfPath": args.pdf, "pages": args.pages, "term": args.term}
    action = payload["action"]
    if action == "build":
        result = engine.build(payload)
    else:
        result = context.run(action, payload)
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
