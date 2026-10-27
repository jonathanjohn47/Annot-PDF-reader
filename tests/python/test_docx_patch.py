"""Hand edits to a .docx: only the paragraphs the user changed may differ afterwards."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docx-engine"))
import annot_docx_patch as engine  # noqa: E402

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
      'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"')
ROOT_TAG = f"<w:document {NS}>"

BODY = """<w:body>
<w:p w14:paraId="0001"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="FF0000"/><w:sz w:val="32"/></w:rPr><w:t>Red courier text with a typo: recieve</w:t></w:r><w:r><w:t xml:space="preserve"> and plain tail.</w:t></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Centered bold line</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">The entropy </w:t></w:r><m:oMath><m:r><m:t>H=x</m:t></m:r></m:oMath><w:r><w:t xml:space="preserve"> is measured in nats.</w:t></w:r></w:p>
<w:p><w:r><w:t>A plain paragraph about seeds.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Seed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Epoch</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>0</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12987</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
<w:p><w:r><w:drawing/></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body>"""


def make_docx(path: str) -> None:
    content_types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n{ROOT_TAG}{BODY}</w:document>'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')


def read_xml(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        return z.read("word/document.xml").decode("utf-8")


def paragraph_xml(xml: str) -> list:
    return re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S)


def blocks_of(path: str) -> list:
    """What the viewer would send if nothing was edited."""
    _, root, _, _ = engine._document_xml(path)
    out = []
    for para in engine._paragraphs(root):
        if not engine._norm(para.text):
            continue
        segments, start = [], 0
        while start < len(para.text):
            end = start
            while end < len(para.text) and para.flags[end] == para.flags[start]:
                end += 1
            segments.append([para.text[start:end], para.flags[start]])
            start = end
        out.append({"tag": f"h{para.level}" if para.level else ("li" if para.is_list else "p"), "segments": segments})
    return out


def texts(blocks: list) -> list:
    return ["".join(s[0] for s in b["segments"]) for b in blocks]


class DocxPatchCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.src = os.path.join(self.dir, "in.docx")
        self.out = os.path.join(self.dir, "out.docx")
        make_docx(self.src)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_patch(self, blocks):
        return engine.patch(self.src, self.out, blocks)

    def index(self, blocks, start):
        return next(i for i, t in enumerate(texts(blocks)) if t.startswith(start))

    def test_no_change_writes_nothing(self):
        result = self.run_patch(blocks_of(self.src))
        self.assertTrue(result["ok"] and result.get("unchanged"))
        self.assertFalse(os.path.exists(self.out))

    def test_an_untouched_block_is_never_rewritten_for_formatting_alone(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "A plain")
        blocks[i]["segments"] = [["A plain paragraph about seeds.", 7]]      # the HTML described it differently
        blocks[i]["touched"] = False
        result = self.run_patch(blocks)
        self.assertTrue(result.get("unchanged"), result)
        blocks[i]["touched"] = True
        self.assertEqual(self.run_patch(blocks)["changed"], 1)

    def test_a_typo_fix_keeps_every_other_paragraph_and_the_run_formatting(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "Red courier")
        blocks[i]["segments"] = [["Red courier text with a typo: receive and plain tail.", 0]]
        result = self.run_patch(blocks)
        self.assertEqual((result["changed"], result["inserted"], result["deleted"]), (1, 0, 0), result)
        before, after = read_xml(self.src), read_xml(self.out)
        self.assertIn("receive and plain tail", after.replace("</w:t></w:r><w:r><w:t>", "").replace('</w:t></w:r><w:r><w:t xml:space="preserve">', ""))
        self.assertIn('w:val="FF0000"', after)
        self.assertIn("Courier New", after)
        old, new = paragraph_xml(before), paragraph_xml(after)
        self.assertEqual(len(old), len(new))
        self.assertEqual([p for k, p in enumerate(old) if k != 1], [p for k, p in enumerate(new) if k != 1])

    def test_the_saved_file_keeps_the_original_permissions(self):
        os.chmod(self.src, 0o644)
        blocks = blocks_of(self.src)
        blocks[self.index(blocks, "A plain")]["segments"] = [["A plain paragraph, edited.", 0]]
        self.run_patch(blocks)
        self.assertEqual(os.stat(self.out).st_mode & 0o777, 0o644)

    def test_root_tag_and_other_parts_are_untouched(self):
        blocks = blocks_of(self.src)
        blocks[self.index(blocks, "A plain")]["segments"] = [["A plain paragraph about seeds and checkpoints.", 0]]
        self.run_patch(blocks)
        self.assertIn(ROOT_TAG, read_xml(self.out))
        self.assertIn("w14:paraId=\"0001\"", read_xml(self.out))
        with zipfile.ZipFile(self.src) as a, zipfile.ZipFile(self.out) as b:
            self.assertEqual(a.namelist(), b.namelist())
            for name in a.namelist():
                if name != "word/document.xml":
                    self.assertEqual(a.read(name), b.read(name), name)

    def test_bold_applied_to_a_word_is_written_as_a_run_property(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "A plain")
        blocks[i]["segments"] = [["A plain ", 0], ["paragraph", 1], [" about seeds.", 0]]
        result = self.run_patch(blocks)
        self.assertEqual(result["changed"], 1)
        match = re.search(r"<w:r><w:rPr><w:b ?/></w:rPr><w:t[^>]*>paragraph</w:t></w:r>", read_xml(self.out))
        self.assertIsNotNone(match, read_xml(self.out))

    def test_text_around_an_equation_can_change_and_the_equation_stays(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "The entropy")
        blocks[i]["segments"] = [["The entropy ￼ is measured in bits.", 0]]
        result = self.run_patch(blocks)
        self.assertEqual(result["changed"], 1, result)
        after = read_xml(self.out)
        self.assertIn("<m:oMath>", after)
        self.assertIn("is measured in bits.", after)
        self.assertNotIn("nats", after)

    def test_a_new_paragraph_copies_the_alignment_of_its_neighbour(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "Centered")
        blocks.insert(i + 1, {"tag": "p", "segments": [["A fresh centered sentence.", 0]]})
        result = self.run_patch(blocks)
        self.assertEqual(result["inserted"], 1)
        paragraphs = paragraph_xml(read_xml(self.out))
        fresh = next(p for p in paragraphs if "A fresh centered sentence." in p)
        self.assertIn('<w:jc w:val="center"', fresh)
        self.assertLess(read_xml(self.out).index("Centered bold line"), read_xml(self.out).index("A fresh centered"))
        self.assertLess(read_xml(self.out).index("A fresh centered"), read_xml(self.out).index("The entropy"))

    def test_a_deleted_paragraph_goes_but_a_cells_only_paragraph_is_emptied_not_removed(self):
        blocks = blocks_of(self.src)
        blocks = [b for b in blocks if not b["segments"][0][0].startswith(("A plain", "12987"))]
        result = self.run_patch(blocks)
        self.assertEqual(result["deleted"], 2)
        after = read_xml(self.out)
        self.assertNotIn("A plain paragraph", after)
        self.assertEqual(after.count("<w:tc>"), 4)                 # the table kept all of its cells
        self.assertEqual(after.count("<w:tc><w:p>"), 4)

    def test_heading_level_changes_follow_the_tag(self):
        blocks = blocks_of(self.src)
        blocks[self.index(blocks, "Quarterly")]["tag"] = "h2"
        blocks[self.index(blocks, "A plain")]["tag"] = "h3"
        result = self.run_patch(blocks)
        self.assertEqual(result["changed"], 2)
        after = read_xml(self.out)
        self.assertIn('w:val="Heading2"', after)
        self.assertIn('w:val="Heading3"', after)

    def test_a_list_item_added_by_enter_stays_in_the_list(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "First item")
        blocks.insert(i + 1, {"tag": "li", "segments": [["Second item", 0]]})
        self.run_patch(blocks)
        fresh = next(p for p in paragraph_xml(read_xml(self.out)) if "Second item" in p)
        self.assertIn("<w:numPr>", fresh)

    @unittest.skipUnless(shutil.which("pandoc"), "pandoc is not installed")
    def test_the_result_is_a_readable_word_file(self):
        blocks = blocks_of(self.src)
        blocks[self.index(blocks, "A plain")]["segments"] = [["A plain paragraph about seeds and epochs.", 0]]
        self.run_patch(blocks)
        text = subprocess.run(["pandoc", "-f", "docx", "-t", "plain", self.out], capture_output=True, text=True, check=True).stdout
        self.assertIn("seeds and epochs", text)
        self.assertIn("Quarterly Report", text)

    def picture(self, width=400, height=200, mime="image/png"):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        return {"tag": "image", "segments": [], "touched": True, "image": {"mime": mime, "data": png, "width": width, "height": height}}

    def test_a_pasted_picture_becomes_a_real_word_picture_after_its_neighbour(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "A plain")
        blocks.insert(i + 1, self.picture())
        result = self.run_patch(blocks)
        self.assertEqual(result["images"], 1, result)
        with zipfile.ZipFile(self.out) as z:
            names = z.namelist()
            self.assertIn("word/media/annot-picture-1.png", names)
            self.assertTrue(z.read("word/media/annot-picture-1.png").startswith(b"\x89PNG"))
            rels = z.read("word/_rels/document.xml.rels").decode()
            types = z.read("[Content_Types].xml").decode()
            document = z.read("word/document.xml").decode()
        self.assertIn('Id="rIdAnnotPicture1"', rels)
        self.assertIn('Target="media/annot-picture-1.png"', rels)
        self.assertIn('Extension="png"', types)
        self.assertIn('r:embed="rIdAnnotPicture1"', document)
        self.assertIn('xmlns:wp="', document.split(">", 2)[1])
        self.assertLess(document.index("A plain paragraph"), document.index("<w:drawing>"))
        self.assertLess(document.index("<w:drawing>"), document.index("<w:tbl>"))
        self.assertIn('<wp:extent cx="3810000" cy="1905000"', document)
        self.assertEqual(len(paragraph_xml(document)), len(paragraph_xml(read_xml(self.src))) + 1)

    def test_a_wide_picture_is_scaled_to_the_column_and_a_table_cell_is_narrower(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "Seed")
        blocks.insert(i + 1, self.picture(width=4000, height=2000))
        self.run_patch(blocks)
        document = read_xml(self.out)
        extent = re.search(r'<wp:extent cx="(\d+)" cy="(\d+)"', document)
        self.assertEqual(int(extent.group(1)), 2743200)
        self.assertEqual(int(extent.group(2)), 1371600)
        self.assertLess(document.index("Seed"), document.index("<w:drawing>"))
        self.assertLess(document.index("<w:drawing>"), document.index("Epoch"))

    def test_two_pictures_get_their_own_files_and_ids(self):
        blocks = blocks_of(self.src)
        i = self.index(blocks, "A plain")
        blocks[i + 1:i + 1] = [self.picture(), self.picture(100, 50)]
        result = self.run_patch(blocks)
        self.assertEqual(result["images"], 2)
        with zipfile.ZipFile(self.out) as z:
            media = sorted(n for n in z.namelist() if n.startswith("word/media/"))
            document = z.read("word/document.xml").decode()
        self.assertEqual(media, ["word/media/annot-picture-1.png", "word/media/annot-picture-2.png"])
        self.assertEqual(sorted(re.findall(r'<wp:docPr id="(\d+)"', document)), ["1", "2"])
        self.assertIn("rIdAnnotPicture2", document)

    def test_a_picture_type_that_word_cannot_hold_is_refused(self):
        blocks = blocks_of(self.src)
        blocks.append(self.picture(mime="image/webp"))
        with self.assertRaises(engine.PatchError):
            self.run_patch(blocks)

    @unittest.skipUnless(shutil.which("pandoc"), "pandoc is not installed")
    def test_pandoc_sees_the_picture(self):
        blocks = blocks_of(self.src)
        blocks.insert(self.index(blocks, "A plain") + 1, self.picture())
        self.run_patch(blocks)
        html = subprocess.run(["pandoc", "-f", "docx", "-t", "html5", "--embed-resources", "--standalone", "--metadata", "pagetitle=x", self.out],
                              capture_output=True, text=True, check=True).stdout
        self.assertRegex(html, r'<img[^>]+src="data:image/png;base64,')

    def test_a_file_that_is_not_a_docx_is_reported(self):
        bad = os.path.join(self.dir, "bad.docx")
        with open(bad, "wb") as handle:
            handle.write(b"not a zip")
        process = subprocess.run([sys.executable, engine.__file__], input=json.dumps({"docxPath": bad, "outPath": self.out, "blocks": []}),
                                 capture_output=True, text=True)
        result = json.loads(process.stdout)
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
