// Typed vocabulary of PDF edits. The model may only ask for these; everything else is rejected by schema.ts.

export type NodeStyle = 'plain' | 'primary' | 'secondary' | 'result' | 'muted';
export type EdgeRelation = 'contains' | 'then' | 'computed_from' | 'association' | 'causes';

export interface DiagramNode {
  id: string;
  label: string;
  sublabel?: string;
  level?: number;
  style?: NodeStyle;
  repeat?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  relation?: EdgeRelation;
}

export interface DiagramSpec {
  kind: 'hierarchy' | 'flow' | 'timeline';
  direction?: 'down' | 'right';
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  level_labels?: string[];
  groups?: Array<{ label: string; members: string[] }>;
  legend?: Array<{ style: NodeStyle; label: string }>;
  notes?: string[];
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[]; ordered?: boolean }
  | { type: 'equation'; text: string }
  | { type: 'callout'; tone: 'definition' | 'note' | 'example' | 'caution' | 'see_also'; title?: string; text: string }
  | { type: 'table'; header: string[]; rows: string[][]; caption?: string }
  | { type: 'diagram'; spec: DiagramSpec; caption: string };

export interface Placement {
  page: number;
  after_quote?: string;
  before_quote?: string;
  position?: 'page_start' | 'page_end';
  mode?: 'inline' | 'new_pages';
}

export interface InsertContentOp {
  type: 'insert_content';
  placement: Placement;
  blocks: Block[];
  provenance_label?: boolean;
}
export interface ReplacePassageOp {
  type: 'replace_passage';
  page: number;
  quote: string;
  replacement: string;
  scope?: 'phrase' | 'paragraph';
}
export interface DeletePassageOp {
  type: 'delete_passage';
  page: number;
  quote: string;
  scope?: 'phrase' | 'paragraph';
}
export interface DeletePagesOp {
  type: 'delete_pages';
  pages: number[];
}
export interface MovePagesOp {
  type: 'move_pages';
  pages: number[];
  after_page: number;
}
export interface MoveSectionOp {
  type: 'move_section';
  from: { page: number; start_quote: string; end_quote?: string };
  to: Placement;
}
export type EditOp =
  | InsertContentOp
  | ReplacePassageOp
  | DeletePassageOp
  | DeletePagesOp
  | MovePagesOp
  | MoveSectionOp;

export interface SourceRef {
  page: number;
  quote: string;
}
export interface Fact {
  id: string;
  value: number;
  label: string;
  source: SourceRef;
  origin?: 'document' | 'assumption';
}
export interface Derived {
  expr: string;
  value: number;
  explanation?: string;
}
export interface Claim {
  text: string;
  status: 'in_document' | 'derived' | 'assistant_interpretation' | 'not_established';
  source?: SourceRef;
}
export interface Prerequisite {
  term: string;
  status: 'defined_in_document' | 'defined_by_this_edit' | 'not_needed';
  page?: number;
  quote?: string;
}

export type EditIntent = 'insert_visual' | 'insert_text' | 'revise' | 'remove' | 'reorganise' | 'restructure';

export interface EditProposal {
  intent: EditIntent;
  summary: string;
  rationale: string;
  placement_rationale: string;
  diagnosis?: string;
  ops: EditOp[];
  facts: Fact[];
  derived: Derived[];
  claims: Claim[];
  prerequisites: Prerequisite[];
  terms_defined: string[];
  existing_coverage?: {
    checked?: boolean;
    found?: Array<{ page: number; quote?: string }>;
    decision?: 'none_found' | 'cross_reference' | 'complete_explanation';
  };
  simplifications: string[];
  qualification_check?: string;
}

export type IssueSeverity = 'error' | 'warning' | 'info';
export interface Issue {
  severity: IssueSeverity;
  code: string;
  message: string;
  op?: number;
  page?: number;
}

export interface PreviewImage {
  role: 'before' | 'after' | 'context';
  page: number;
  label: string;
  file: string;
  kind: 'orig' | 'changed' | 'added' | 'deleted';
}

export interface PageMark {
  page: number;
  kind: 'changed' | 'added';
  origin?: number | null;
}

export interface EngineStats {
  pagesBefore: number;
  pagesAfter: number;
  addedPages: number;
  changedPages: number;
  droppedHighlights: number;
  droppedAnnotations: number;
  removedWords: number;
}

export interface EngineResult {
  ok: boolean;
  stage?: string;
  issues: Issue[];
  pageMap?: Array<{ original: number; current: number }>;
  marks?: PageMark[];
  previews?: PreviewImage[];
  stats?: EngineStats;
  destructive?: boolean;
}

export type ProposalStatus = 'pending' | 'applied' | 'discarded' | 'rejected' | 'stale';

export interface StoredProposal {
  id: string;
  pdfPath: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
  sessionId?: string;
  userPrompt?: string;
  proposal: EditProposal | null;
  issues: Issue[];
  previews: PreviewImage[];
  stats?: EngineStats;
  marks: PageMark[];
  pageMap: Array<{ original: number; current: number }>;
  destructive: boolean;
  narrow: boolean;
  baseRevision: number;
  appliedRevision?: number;
  error?: string;
}

export interface HistoryEntry {
  revision: number;
  proposalId: string;
  at: string;
  summary: string;
  rationale: string;
  intent: EditIntent;
  opTypes: string[];
  marks: PageMark[];
}

export interface EditState {
  revision: number;
  file: string;
  entry: HistoryEntry | null;
  marks: PageMark[];
  pageCount: number;
}

export interface HistoryFile {
  version: 1;
  current: number;
  states: EditState[];
}

export interface EditSummary {
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  hasOriginal: boolean;
  marks: PageMark[];
  entries: Array<HistoryEntry & { applied: boolean }>;
}
