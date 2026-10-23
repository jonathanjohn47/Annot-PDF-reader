// Strict validation of what the model asks for. Unknown keys are dropped, unknown operations are rejected,
// sizes are bounded. Only the normalised result is ever passed to the PDF engine.

import type {
  Block,
  Claim,
  Derived,
  DiagramSpec,
  EditIntent,
  EditOp,
  EditProposal,
  EdgeRelation,
  Fact,
  NodeStyle,
  Placement,
  Prerequisite,
} from './types.ts';

export type ValidationResult =
  | { ok: true; proposal: EditProposal }
  | { ok: false; errors: string[] };

const INTENTS: EditIntent[] = ['insert_visual', 'insert_text', 'revise', 'remove', 'reorganise', 'restructure'];
const NODE_STYLES: NodeStyle[] = ['plain', 'primary', 'secondary', 'result', 'muted'];
const RELATIONS: EdgeRelation[] = ['contains', 'then', 'computed_from', 'association', 'causes'];
const TONES = ['definition', 'note', 'example', 'caution', 'see_also'] as const;

export const LIMITS = {
  ops: 8,
  blocksPerOp: 24,
  text: 4000,
  quote: 600,
  nodes: 30,
  edges: 60,
  facts: 40,
  pages: 60,
} as const;

type Raw = Record<string, unknown>;

class Collector {
  errors: string[] = [];
  add(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(c: Collector, path: string, value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') {
    if (required) c.add(path, 'must be a string');
    return '';
  }
  const trimmed = value.trim();
  if (required && !trimmed) c.add(path, 'must not be empty');
  if (trimmed.length > max) c.add(path, `is too long (max ${max} characters)`);
  return trimmed;
}

function optStr(c: Collector, path: string, value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return str(c, path, value, max, false);
}

function int(c: Collector, path: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    c.add(path, `must be an integer between ${min} and ${max}`);
    return min;
  }
  return value;
}

function arr(c: Collector, path: string, value: unknown, max: number, required = true): unknown[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    c.add(path, 'must be an array');
    return [];
  }
  if (value.length > max) c.add(path, `has too many entries (max ${max})`);
  return value.slice(0, max);
}

function oneOf<T extends string>(c: Collector, path: string, value: unknown, allowed: readonly T[], fallback?: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  if (fallback !== undefined && (value === undefined || value === null)) return fallback;
  c.add(path, `must be one of: ${allowed.join(', ')}`);
  return (fallback ?? allowed[0]) as T;
}

function placement(c: Collector, path: string, value: unknown): Placement {
  if (!isObject(value)) {
    c.add(path, 'must be an object');
    return { page: 1 };
  }
  const out: Placement = { page: int(c, `${path}.page`, value.page, 1, 5000) };
  const mode = value.mode === undefined ? undefined : oneOf(c, `${path}.mode`, value.mode, ['inline', 'new_pages'] as const);
  if (mode) out.mode = mode;
  const after = optStr(c, `${path}.after_quote`, value.after_quote, LIMITS.quote);
  const before = optStr(c, `${path}.before_quote`, value.before_quote, LIMITS.quote);
  const position = value.position === undefined || value.position === null
    ? undefined
    : oneOf(c, `${path}.position`, value.position, ['page_start', 'page_end'] as const);
  if (after) out.after_quote = after;
  if (before) out.before_quote = before;
  if (position) out.position = position;
  const anchors = [after, before, position].filter(Boolean).length;
  if (anchors > 1) c.add(path, 'give exactly one of after_quote, before_quote or position');
  if (anchors === 0 && out.mode !== 'new_pages') {
    c.add(path, 'needs after_quote, before_quote or position so the location is explicit');
  }
  if (out.mode === 'new_pages' && (after || before)) {
    c.add(path, "mode 'new_pages' inserts whole pages; use position 'page_end' (after the page) or 'page_start' (before it) instead of a quote");
  }
  return out;
}

function diagram(c: Collector, path: string, value: unknown): DiagramSpec {
  const empty: DiagramSpec = { kind: 'flow', nodes: [] };
  if (!isObject(value)) {
    c.add(path, 'must be an object');
    return empty;
  }
  const kind = oneOf(c, `${path}.kind`, value.kind, ['hierarchy', 'flow', 'timeline'] as const);
  const spec: DiagramSpec = { kind, nodes: [] };
  if (value.direction !== undefined) spec.direction = oneOf(c, `${path}.direction`, value.direction, ['down', 'right'] as const);
  const ids = new Set<string>();
  for (const [i, n] of arr(c, `${path}.nodes`, value.nodes, LIMITS.nodes).entries()) {
    const p = `${path}.nodes[${i}]`;
    if (!isObject(n)) {
      c.add(p, 'must be an object');
      continue;
    }
    const id = str(c, `${p}.id`, n.id, 40);
    if (ids.has(id)) c.add(`${p}.id`, `duplicate id '${id}'`);
    ids.add(id);
    const node: DiagramSpec['nodes'][number] = { id, label: str(c, `${p}.label`, n.label, 120) };
    const sub = optStr(c, `${p}.sublabel`, n.sublabel, 160);
    if (sub) node.sublabel = sub;
    if (n.level !== undefined) node.level = int(c, `${p}.level`, n.level, 0, 12);
    if (n.style !== undefined) node.style = oneOf(c, `${p}.style`, n.style, NODE_STYLES);
    if (n.repeat !== undefined) node.repeat = int(c, `${p}.repeat`, n.repeat, 2, 1_000_000);
    spec.nodes.push(node);
  }
  if (spec.nodes.length === 0) c.add(`${path}.nodes`, 'needs at least one node');
  const edges = arr(c, `${path}.edges`, value.edges, LIMITS.edges, false);
  spec.edges = [];
  for (const [i, e] of edges.entries()) {
    const p = `${path}.edges[${i}]`;
    if (!isObject(e)) {
      c.add(p, 'must be an object');
      continue;
    }
    const from = str(c, `${p}.from`, e.from, 40);
    const to = str(c, `${p}.to`, e.to, 40);
    if (from && !ids.has(from)) c.add(`${p}.from`, `unknown node '${from}'`);
    if (to && !ids.has(to)) c.add(`${p}.to`, `unknown node '${to}'`);
    const edge: NonNullable<DiagramSpec['edges']>[number] = { from, to, relation: oneOf(c, `${p}.relation`, e.relation, RELATIONS, 'then') };
    const label = optStr(c, `${p}.label`, e.label, 60);
    if (label) edge.label = label;
    spec.edges.push(edge);
  }
  if (value.level_labels !== undefined) {
    spec.level_labels = arr(c, `${path}.level_labels`, value.level_labels, 13).map((t, i) => str(c, `${path}.level_labels[${i}]`, t, 60));
  }
  if (value.groups !== undefined) {
    spec.groups = arr(c, `${path}.groups`, value.groups, 10).flatMap((g, i) => {
      if (!isObject(g)) {
        c.add(`${path}.groups[${i}]`, 'must be an object');
        return [];
      }
      const members = arr(c, `${path}.groups[${i}].members`, g.members, LIMITS.nodes).map((m) => String(m));
      members.forEach((m) => { if (!ids.has(m)) c.add(`${path}.groups[${i}].members`, `unknown node '${m}'`); });
      return [{ label: str(c, `${path}.groups[${i}].label`, g.label, 60, false), members }];
    });
  }
  if (value.legend !== undefined) {
    spec.legend = arr(c, `${path}.legend`, value.legend, 10).flatMap((l, i) => {
      if (!isObject(l)) {
        c.add(`${path}.legend[${i}]`, 'must be an object');
        return [];
      }
      return [{ style: oneOf(c, `${path}.legend[${i}].style`, l.style, NODE_STYLES), label: str(c, `${path}.legend[${i}].label`, l.label, 80) }];
    });
  }
  if (value.notes !== undefined) {
    spec.notes = arr(c, `${path}.notes`, value.notes, 4).map((t, i) => str(c, `${path}.notes[${i}]`, t, 300));
  }
  return spec;
}

function block(c: Collector, path: string, value: unknown): Block | null {
  if (!isObject(value)) {
    c.add(path, 'must be an object');
    return null;
  }
  switch (value.type) {
    case 'heading':
      return { type: 'heading', level: int(c, `${path}.level`, value.level ?? 2, 1, 3) as 1 | 2 | 3, text: str(c, `${path}.text`, value.text, 200) };
    case 'paragraph':
      return { type: 'paragraph', text: str(c, `${path}.text`, value.text, LIMITS.text) };
    case 'bullets': {
      const items = arr(c, `${path}.items`, value.items, 20).map((t, i) => str(c, `${path}.items[${i}]`, t, 600));
      if (items.length === 0) c.add(`${path}.items`, 'needs at least one item');
      return { type: 'bullets', items, ordered: value.ordered === true };
    }
    case 'equation':
      return { type: 'equation', text: str(c, `${path}.text`, value.text, 400) };
    case 'callout': {
      const out: Block = { type: 'callout', tone: oneOf(c, `${path}.tone`, value.tone, TONES, 'note'), text: str(c, `${path}.text`, value.text, LIMITS.text) };
      const title = optStr(c, `${path}.title`, value.title, 80);
      if (title) out.title = title;
      return out;
    }
    case 'table': {
      const header = arr(c, `${path}.header`, value.header, 8).map((t, i) => str(c, `${path}.header[${i}]`, t, 120));
      const rows = arr(c, `${path}.rows`, value.rows, 30).map((r, i) => arr(c, `${path}.rows[${i}]`, r, 8).map((t, j) => str(c, `${path}.rows[${i}][${j}]`, t, 240, false)));
      if (header.length === 0) c.add(`${path}.header`, 'needs at least one column');
      rows.forEach((r, i) => { if (r.length !== header.length) c.add(`${path}.rows[${i}]`, 'must have as many cells as the header'); });
      const out: Block = { type: 'table', header, rows };
      const caption = optStr(c, `${path}.caption`, value.caption, 240);
      if (caption) out.caption = caption;
      return out;
    }
    case 'diagram':
      return { type: 'diagram', spec: diagram(c, `${path}.spec`, value.spec), caption: str(c, `${path}.caption`, value.caption, 400) };
    default:
      c.add(`${path}.type`, `unknown block type '${String(value.type)}'`);
      return null;
  }
}

function pages(c: Collector, path: string, value: unknown): number[] {
  return arr(c, path, value, LIMITS.pages).map((p, i) => int(c, `${path}[${i}]`, p, 1, 5000));
}

function op(c: Collector, path: string, value: unknown): EditOp | null {
  if (!isObject(value)) {
    c.add(path, 'must be an object');
    return null;
  }
  switch (value.type) {
    case 'insert_content': {
      const blocks = arr(c, `${path}.blocks`, value.blocks, LIMITS.blocksPerOp)
        .map((b, i) => block(c, `${path}.blocks[${i}]`, b))
        .filter((b): b is Block => b !== null);
      if (blocks.length === 0) c.add(`${path}.blocks`, 'needs at least one block');
      const out: EditOp = { type: 'insert_content', placement: placement(c, `${path}.placement`, value.placement), blocks };
      if (value.provenance_label === false) out.provenance_label = false;
      return out;
    }
    case 'replace_passage':
      return {
        type: 'replace_passage',
        page: int(c, `${path}.page`, value.page, 1, 5000),
        quote: str(c, `${path}.quote`, value.quote, LIMITS.quote),
        replacement: str(c, `${path}.replacement`, value.replacement, LIMITS.text),
        scope: oneOf(c, `${path}.scope`, value.scope, ['phrase', 'paragraph'] as const, 'phrase'),
      };
    case 'delete_passage':
      return {
        type: 'delete_passage',
        page: int(c, `${path}.page`, value.page, 1, 5000),
        quote: str(c, `${path}.quote`, value.quote, LIMITS.quote),
        scope: oneOf(c, `${path}.scope`, value.scope, ['phrase', 'paragraph'] as const, 'paragraph'),
      };
    case 'delete_pages':
      return { type: 'delete_pages', pages: pages(c, `${path}.pages`, value.pages) };
    case 'move_pages':
      return {
        type: 'move_pages',
        pages: pages(c, `${path}.pages`, value.pages),
        after_page: int(c, `${path}.after_page`, value.after_page, 0, 5000),
      };
    case 'move_section': {
      const from = isObject(value.from) ? value.from : {};
      if (!isObject(value.from)) c.add(`${path}.from`, 'must be an object');
      const out: EditOp = {
        type: 'move_section',
        from: {
          page: int(c, `${path}.from.page`, from.page, 1, 5000),
          start_quote: str(c, `${path}.from.start_quote`, from.start_quote, LIMITS.quote),
        },
        to: placement(c, `${path}.to`, value.to),
      };
      const end = optStr(c, `${path}.from.end_quote`, from.end_quote, LIMITS.quote);
      if (end) out.from.end_quote = end;
      if (out.to.mode === 'new_pages') c.add(`${path}.to`, 'move_section moves within the flow of a page; use mode inline');
      return out;
    }
    default:
      c.add(`${path}.type`, `unknown operation '${String(value.type)}'. Allowed: insert_content, replace_passage, delete_passage, delete_pages, move_pages, move_section`);
      return null;
  }
}

function sourceRef(c: Collector, path: string, value: unknown): { page: number; quote: string } {
  if (!isObject(value)) {
    c.add(path, 'must be an object with page and quote');
    return { page: 1, quote: '' };
  }
  return { page: int(c, `${path}.page`, value.page, 1, 5000), quote: str(c, `${path}.quote`, value.quote, LIMITS.quote) };
}

export function validateProposal(raw: unknown): ValidationResult {
  const c = new Collector();
  if (!isObject(raw)) return { ok: false, errors: ['proposal: must be a JSON object'] };

  const ops = arr(c, 'ops', raw.ops, LIMITS.ops)
    .map((o, i) => op(c, `ops[${i}]`, o))
    .filter((o): o is EditOp => o !== null);
  if (ops.length === 0) c.add('ops', 'needs at least one operation');

  const facts: Fact[] = arr(c, 'facts', raw.facts, LIMITS.facts, false).flatMap((f, i) => {
    if (!isObject(f)) {
      c.add(`facts[${i}]`, 'must be an object');
      return [];
    }
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) c.add(`facts[${i}].value`, 'must be a number');
    const out: Fact = {
      id: str(c, `facts[${i}].id`, f.id, 24),
      value: typeof f.value === 'number' ? f.value : 0,
      label: str(c, `facts[${i}].label`, f.label, 120),
      source: sourceRef(c, `facts[${i}].source`, f.source),
    };
    if (f.origin === 'assumption') out.origin = 'assumption';
    return [out];
  });

  const derived: Derived[] = arr(c, 'derived', raw.derived, LIMITS.facts, false).flatMap((d, i) => {
    if (!isObject(d)) {
      c.add(`derived[${i}]`, 'must be an object');
      return [];
    }
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) c.add(`derived[${i}].value`, 'must be a number');
    const out: Derived = { expr: str(c, `derived[${i}].expr`, d.expr, 120), value: typeof d.value === 'number' ? d.value : 0 };
    const why = optStr(c, `derived[${i}].explanation`, d.explanation, 300);
    if (why) out.explanation = why;
    return [out];
  });

  const claims: Claim[] = arr(c, 'claims', raw.claims, 40, false).flatMap((cl, i) => {
    if (!isObject(cl)) {
      c.add(`claims[${i}]`, 'must be an object');
      return [];
    }
    const status = oneOf(c, `claims[${i}].status`, cl.status, ['in_document', 'derived', 'assistant_interpretation', 'not_established'] as const);
    const out: Claim = { text: str(c, `claims[${i}].text`, cl.text, 400), status };
    if (status === 'in_document') out.source = sourceRef(c, `claims[${i}].source`, cl.source);
    return [out];
  });

  const prerequisites: Prerequisite[] = arr(c, 'prerequisites', raw.prerequisites, 30, false).flatMap((p, i) => {
    if (!isObject(p)) {
      c.add(`prerequisites[${i}]`, 'must be an object');
      return [];
    }
    const status = oneOf(c, `prerequisites[${i}].status`, p.status, ['defined_in_document', 'defined_by_this_edit', 'not_needed'] as const);
    const out: Prerequisite = { term: str(c, `prerequisites[${i}].term`, p.term, 80), status };
    if (status === 'defined_in_document') {
      out.page = int(c, `prerequisites[${i}].page`, p.page, 1, 5000);
      out.quote = str(c, `prerequisites[${i}].quote`, p.quote, LIMITS.quote);
    }
    return [out];
  });

  const termsDefined = arr(c, 'terms_defined', raw.terms_defined, 20, false).map((t, i) => str(c, `terms_defined[${i}]`, t, 80));
  // A prerequisite the edit defines is, by definition, a term the edit introduces.
  for (const p of prerequisites) {
    if (p.status === 'defined_by_this_edit' && !termsDefined.some((t) => t.toLowerCase() === p.term.toLowerCase())) {
      termsDefined.push(p.term);
    }
  }

  let coverage: EditProposal['existing_coverage'];
  if (isObject(raw.existing_coverage)) {
    const cov = raw.existing_coverage;
    coverage = {
      checked: cov.checked === true,
      found: arr(c, 'existing_coverage.found', cov.found, 20, false).flatMap((f) => (
        isObject(f) && typeof f.page === 'number' ? [{ page: f.page, quote: typeof f.quote === 'string' ? f.quote.slice(0, LIMITS.quote) : undefined }] : []
      )),
    };
    if (cov.decision !== undefined) coverage.decision = oneOf(c, 'existing_coverage.decision', cov.decision, ['none_found', 'cross_reference', 'complete_explanation'] as const);
  }

  const proposal: EditProposal = {
    intent: oneOf(c, 'intent', raw.intent, INTENTS, 'insert_text'),
    summary: str(c, 'summary', raw.summary, 400),
    rationale: str(c, 'rationale', raw.rationale, 800),
    placement_rationale: str(c, 'placement_rationale', raw.placement_rationale, 800),
    ops,
    facts,
    derived,
    claims,
    prerequisites,
    terms_defined: termsDefined,
    simplifications: arr(c, 'simplifications', raw.simplifications, 10, false).map((t, i) => str(c, `simplifications[${i}]`, t, 300)),
  };
  const diagnosis = optStr(c, 'diagnosis', raw.diagnosis, 600);
  if (diagnosis) proposal.diagnosis = diagnosis;
  if (coverage) proposal.existing_coverage = coverage;
  const qualification = optStr(c, 'qualification_check', raw.qualification_check, 600);
  if (qualification) proposal.qualification_check = qualification;

  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, proposal };
}
