// The instructions that turn "edit the PDF intelligently" into an explicit, checkable procedure.
// Annot validates the result server-side (numbers, quotes, terms, wording), so these rules are backed by code.

import { EDIT_END, EDIT_START } from './directive.ts';

export interface EditPromptContext {
  allowed: boolean;
  pdfAbsPath?: string | null;
  scriptPath?: string;
  pythonCommand?: string;
  documentMap?: string;
  revisionNote?: string;
}

export const EDIT_NOT_ALLOWED_LINE =
  '- PDF editing is OFF for this message: do not change the PDF and do not emit any edit block. Answer in chat only. If an edit would help, offer it in one short line (the user can then ask "add this to the PDF" or switch on Edit mode).';

const EXAMPLE = `{
  "intent": "insert_visual",
  "summary": "Add a hierarchy diagram of seeds, checkpoints, examples and logits before the measurement paragraph.",
  "rationale": "The paragraph uses five nested levels the reader has not seen; the diagram shows which is inside which.",
  "placement_rationale": "Directly before the first paragraph that uses 'logit' (page 4), so the terms are explained before use.",
  "diagnosis": "Missing relationship between seeds, checkpoints, examples and logits; the quantities are defined but never placed in one picture.",
  "ops": [{
    "type": "insert_content",
    "placement": { "page": 4, "before_quote": "At every saved checkpoint, we ran the model" },
    "blocks": [
      { "type": "heading", "level": 3, "text": "What the experiment measures" },
      { "type": "paragraph", "text": "Each example gets one **logit** (raw score) per class: 113 in all." },
      { "type": "diagram", "caption": "Levels of the experiment, from seeds down to one measurement.",
        "spec": { "kind": "hierarchy", "level_labels": ["Experiment", "Seeds", "Logits"],
          "nodes": [ {"id": "e", "label": "Experiment", "level": 0, "style": "primary"},
                     {"id": "s", "label": "Seed", "sublabel": "40,000 epochs each", "level": 1, "repeat": 5},
                     {"id": "l", "label": "Output logits", "sublabel": "one per class", "level": 2} ],
          "edges": [ {"from": "e", "to": "s", "relation": "contains"}, {"from": "s", "to": "l", "relation": "contains"} ],
          "legend": [ {"style": "primary", "label": "whole experiment"} ] } }
    ]
  }],
  "facts": [
    { "id": "F1", "value": 5, "label": "random seeds", "source": { "page": 3, "quote": "five random seeds" } },
    { "id": "F2", "value": 40000, "label": "epochs per seed", "source": { "page": 3, "quote": "40,000 epochs" } },
    { "id": "F3", "value": 113, "label": "classes", "source": { "page": 3, "quote": "one of 113 classes" } }
  ],
  "derived": [ { "expr": "113 - 2", "value": 111, "explanation": "logits left after the correct one and the strongest wrong one" } ],
  "claims": [ { "text": "Each example has 113 logits", "status": "in_document", "source": { "page": 3, "quote": "one of 113 classes" } } ],
  "prerequisites": [ { "term": "logit", "status": "defined_by_this_edit" } ],
  "terms_defined": ["logit"],
  "existing_coverage": { "checked": true, "found": [ { "page": 7, "quote": "A logit is the raw score" } ], "decision": "complete_explanation" },
  "simplifications": ["One seed and one example are drawn; the badges show that each level repeats."],
  "qualification_check": "No limitation or caveat is touched."
}`;

export function buildEditPromptLines(ctx: EditPromptContext): string[] {
  if (!ctx.allowed || !ctx.pdfAbsPath) {
    return [EDIT_NOT_ALLOWED_LINE];
  }

  const helper = `${ctx.pythonCommand ?? 'python3'} "${ctx.scriptPath ?? 'pdf-engine/annot_pdf_edit.py'}"`;
  const pdf = `"${ctx.pdfAbsPath}"`;

  return [
    'PDF EDITING IS ENABLED for this message (the user asked for a change to the document, or Edit mode is on).',
    '- You may propose a change to the PDF itself. You must never modify the PDF file directly: do not run any command that writes, overwrites, or re-saves it. You describe the edit as typed operations in one hidden block; Annot validates it, shows the user a preview, and applies it only after approval (small additive edits may be applied at once). The PDF stays the only place the reader learns from, so improve it without damaging what is already good.',
    '',
    'Step 1 - Intent. Decide what the user wants: (a) an explanation in chat only, (b) a new visual in the PDF, (c) added text or an example, (d) a revised passage, (e) removed material, (f) reorganisation. A question such as "what does this mean?" is chat-only: answer it and emit NO edit block. Emit at most one edit block per reply, and only when the user clearly wants a persistent change. If it is ambiguous, answer in chat and offer the edit in one line.',
    '',
    'Step 2 - Inspect the document (do not rely on the visible page or on memory). Document map:',
    ctx.documentMap ? ctx.documentMap : '(no map available; use the helper below)',
    ctx.revisionNote ? ctx.revisionNote : '',
    `- Helper commands (read-only; run with Bash): ${helper} map --pdf ${pdf} | outline | pages --pages 3-5 | text --pages 4 (exact paragraph text and y-ranges: copy quotes from here) | find --term "logit" (first use, definitions, where else it appears).`,
    '- Read the target passage, its neighbours, and every figure, definition, equation or reference it depends on. For structural edits read the outline and the sections around the change.',
    '',
    'Step 3 - Diagnose. Name the real problem: a missing definition, a missing relationship, an unclear sequence, too much detail, or a poor visual. Is a diagram the best fix, or does a sentence, example or cross-reference solve it better? Does the document already explain it elsewhere? Respect an explicit request for a particular form (a diagram) unless it would clearly mislead.',
    '',
    'Step 4 - Design the smallest edit that fixes it. Local by default, but account for dependencies the edit creates. Never read "make this clearer" as "rewrite the page". If a broad reorganisation is really needed, do not do it: explain the scope in chat and ask first.',
    '- Humane document rules: (1) explain a prerequisite where the reader first needs it, never after: if a sentence needs a concept the document has not established, add that concept before the sentence, not a diagram of an unexplained term. (2) Think in dependency order (problem, system, units, measurements, meaning of each, transformations, quantities, method, results, limits) adapted to this document. (3) A visual must teach: say what it clarifies, use levels and labels so different things (seeds, epochs, checkpoints, examples, logits, summary variables) are never conflated; split a crowded explanation into two diagrams; give every visual a caption that makes sense on its own. (4) Place new material at the most natural point (just before first use, or after the paragraph it supports), not at the end of the document or on the visible page by default; add a one-line cross-reference ({{page:N}} becomes the right page number after the edit) instead of repeating an explanation that already exists. (5) Keep the document\'s level: layer intuition, example, then formal statement; do not delete equations or replace a precise statement with a misleading analogy.',
    '- Integrity rules: the PDF is the source of truth. Separate (i) facts stated in the PDF, (ii) things derived from them, (iii) your interpretation, (iv) what the PDF does not establish. Do not invent measurements, settings, results, citations or causes; do not turn an association into a cause or an exploratory result into a validated predictor; keep every limitation, caveat and negative result; check every count, label and equation in a visual against the PDF (113 total minus 2 is 111, not 112). If a needed fact is missing, leave it out or say so; never guess.',
    '- Write inserted text in the document\'s own language and register (usually English), not in the chat language. Use only plain characters, **bold**, *italic*, ^{superscript}, _{subscript}. Equations are plain Unicode text (for example H(X) = -Σ p(x) ln p(x)); the PDF cannot typeset LaTeX, so define every symbol you use.',
    '',
    'Step 5 - Self-check before emitting: every term used is defined earlier (in the PDF before the insertion point, or by this edit before first use); no duplicate of an existing explanation; every number is a declared fact (with an exact quote and page) or a derived value (with its arithmetic); no causal or predictive wording the PDF does not support; limitations kept; terminology and numbering consistent with the document (do not reuse an existing "Figure N" label).',
    '',
    `Step 6 - Emit. Reply with a short message for the user (what you propose, where, and why that place; two to four short lines, in the user's language), then, at the very end, exactly one block:`,
    EDIT_START,
    '<one JSON object, nothing else>',
    EDIT_END,
    '- Never mention the block, and never say the edit is done, saved or applied: Annot confirms that itself and shows the user a preview card. If you only have a proposal, say "proposed".',
    '- Operations (types are strict; unknown fields are dropped):',
    '  insert_content {placement:{page, after_quote | before_quote | position:"page_start"|"page_end", mode?:"inline"|"new_pages"}, blocks:[...]}  — page numbers are the PDF pages you read; quotes are 3-12 exact consecutive words copied from `text` output that appear exactly once on that page. inline flows the new content into the page and moves what follows (it keeps highlights and links). On multi-column pages use mode "new_pages" with position "page_end" (new page after) or "page_start".',
    '  blocks: heading{level 1-3,text} | paragraph{text} | bullets{items,ordered?} | equation{text} | callout{tone:"definition"|"note"|"example"|"caution"|"see_also",title?,text} | table{header,rows,caption?} | diagram{caption, spec}',
    '  diagram spec: {kind:"hierarchy"|"flow"|"timeline", direction?, nodes:[{id,label,sublabel?,level?,style?:"plain"|"primary"|"secondary"|"result"|"muted",repeat?}], edges:[{from,to,label?,relation:"contains"|"then"|"computed_from"|"association"|"causes"}], level_labels?, groups?, legend:[{style,label}] (required for every coloured style), notes?}. You give structure; Annot does the layout. "contains" builds the tree (one container per node), "then" is order in time, "computed_from" a calculation, "association" a link with no causal claim, "causes" only if the PDF states a cause. "repeat" draws a stacked node with a ×N badge. Keep about 6 nodes per level and 4 levels sideways or 9 levels downward per diagram; split anything bigger.',
    '  replace_passage {page, quote, replacement, scope?:"phrase"|"paragraph"}  delete_passage {page, quote, scope?:"paragraph"|"phrase"}  delete_pages {pages}  move_pages {pages, after_page (0 = to the start)}  move_section {from:{page,start_quote,end_quote?}, to:{placement}}. Replacements use a substitute font and must be about as long as the original unless the paragraph can reflow. Removal and revision always get reviewed by the user.',
    '- Required fields: intent (insert_visual|insert_text|revise|remove|reorganise|restructure), summary, rationale, placement_rationale, ops. Also give, whenever they apply: diagnosis; facts [{id,value,label,source:{page,quote}}] for every number that appears; derived [{expr,value,explanation}] for numbers computed from facts; claims [{text,status:"in_document"|"derived"|"assistant_interpretation"|"not_established",source?}] (a not_established claim must not be in the edit); prerequisites [{term,status:"defined_in_document"(+page,quote)|"defined_by_this_edit"|"not_needed"}]; terms_defined (terms this edit introduces); existing_coverage {checked,found:[{page,quote}],decision:"none_found"|"cross_reference"|"complete_explanation"}; simplifications (what a visual leaves out); qualification_check (for revision/removal).',
    '- If Annot rejects the proposal you will be sent the problems; correct exactly those and send the complete block again. Example of a complete block:',
    EXAMPLE,
  ].filter((line) => line !== '');
}
