import type { NodeRow, Perception, SourceRef, Source, Timeline } from './service.js';

/** Semantic proposals are model judgments; only the Memory transaction publishes them. */
export interface ClaimDraft {
  key: string; nodeId: string; text: string;
  subject: string; event: string; predicate: string; value: string;
  validTime: string; conditions: string; quote: string;
}
export interface Claim extends ClaimDraft {
  id: string; source: SourceRef; roots: string[]; observedAt: string;
  authority: 'owner' | 'observation';
}
export type RelationKind = 'same' | 'conflict' | 'revision' | 'different' | 'uncertain';
export interface RelationDraft {
  left: string; right: string; kind: RelationKind; reason: string;
  leftQuote: string; rightQuote: string;
  // Pair ordering is immutable; superseded names the replaced endpoint.
  revisionKind?: 'correction' | 'world-change'; effectiveTime?: string;
  superseded?: 'left' | 'right'; effectiveAt?: string | null;
}
export interface Relation extends RelationDraft {
  id: string; assessedAt: string; model: string;
}
export interface Knowledge { claims: Claim[]; relations: Relation[] }
export interface KnowledgeInput {
  source: SourceRef; perception: Perception; nodes: NodeRow[];
  authority: 'owner' | 'observation'; timeline?: Timeline; clip?: Source['clip'];
}
export interface KnowledgeModels {
  extract(input: KnowledgeInput): Promise<ClaimDraft[]>;
  relate(pairs: { left: Claim; right: Claim }[], evidence?: { source: SourceRef; text: string }[]): Promise<RelationDraft[]>;
  readonly model: string;
}
export type ClaimStatus = 'supported' | 'disputed' | 'superseded' | 'unresolved' | 'unavailable' | 'scheduled';
export interface KnowledgeView {
  revision: number;
  coverage?: {
    complete: boolean;
    exhaustiveGlobalConflicts: false;
    candidateRecallLimited: true;
    reason?: 'relationship-closure-paged';
    phase?: string;
    continuation?: string;
    evaluatedAt?: string;
  };
  validUntil?: string;
  claims: { id: string; text: string; subject: string; event: string; predicate: string; value: string;
    validTime: string; conditions: string; source: SourceRef; status: ClaimStatus; roots: string[] }[];
  relations: { id: string; left: string; right: string; kind: RelationKind; reason: string; active: boolean;
    revisionKind?: 'correction' | 'world-change'; effectiveTime?: string; superseded?: 'left' | 'right'; effectiveAt?: string | null;
    temporal?: 'effective' | 'scheduled' | 'unresolved' }[];
}
