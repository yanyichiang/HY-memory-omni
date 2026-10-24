import { PersistentVectorIndex } from './vector-index.js';
import type { VectorIndexStore } from './vector-index.js';
export interface NodeStoreKV extends VectorIndexStore {
  page<T>(prefix: string, after: string | undefined, limit: number): Promise<{ entries: { key: string; value: T }[]; nextCursor?: string }>;
}
export interface StoredNodeRow { payload: Record<string, unknown>; embedding: number[]; lexicalTokens?: string[] }
export type NodeAvailability = (row: StoredNodeRow) => boolean | Promise<boolean>;
type Args = Record<string, unknown>;
export interface NodeReadCoverage { method: string; exhaustive: boolean; candidates?: number; visitedLeaves?: number; visitedNodes?: number; scoringCorpus?: 'bounded-posting-candidates' }
const CANDIDATES = 2048, LIST_SCAN = 256;
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function count(value: unknown, fallback: number, max: number): number {
  const n=value ?? fallback;
  if (!Number.isSafeInteger(n) || Number(n)<1 || Number(n)>max) throw new Error('NODE_READ_LIMIT_INVALID');
  return Number(n);
}
function matches(p: Record<string, unknown>, a: Args, activeDefault: boolean): boolean {
  const keys=list(a.isolation_keys), users=list(a.user_ids), agents=list(a.agent_ids);
  if (keys.length) { if (!keys.includes(p.isolation_key)) return false; }
  else if (a.isolation_key) { if (a.isolation_key!==p.isolation_key) return false; }
  else {
    const wanted=users.length ? users : a.user_id===undefined || a.user_id===null ? [] : [a.user_id];
    if (!wanted.length) throw new Error('NODE_READ_SCOPE_REQUIRED');
    if (!wanted.includes(p.user_id)) return false;
    const wantedAgents=agents.length ? agents : a.agent_id===undefined || a.agent_id===null ? [] : [a.agent_id];
    if (wantedAgents.length && !wantedAgents.includes(p.agent_id)) return false;
  }
  for (const [field,include] of [['include_sources',true],['exclude_sources',false]] as const) {
    const sources=list(a[field]); if (sources.length && sources.includes(p.source)!==include) return false;
  }
  if (list(a.layers).length && !list(a.layers).includes(p.layer)) return false;
  const statuses=a.status_filter===undefined || a.status_filter===null ? activeDefault ? ['active'] : [] : list(a.status_filter);
  if ((a.status_filter!==undefined && a.status_filter!==null || activeDefault) && !statuses.includes(p.status)) return false;
  if (a.only_latest===true && p.is_latest!==undefined && !p.is_latest) return false;
  if (list(a.tags_match_any).length && !list(a.tags_match_any).some(t=>list(p.tags).includes(t))) return false;
  if (a.created_after!==undefined && a.created_after!==null) {
    const raw=[p.memory_at,p.gmt_created].find(v=>v!=='' && v!==null && v!==undefined && Number.isFinite(Number(v)));
    if (raw===undefined || Number(raw)<Number(a.created_after)) return false;
  }
  return true;
}
/** All writes share the outer root transaction. Immutable node IDs must include
 * their source/generation identity. Old nodes/postings remain until external GC;
 * available is checked on every returned row. No enumeration scans the whole DB.
 * BM25 uses Hy's exact k1=1.5,b=.75 formula over a bounded posting candidate pool;
 * this pool's statistics differ from SnapshotStore's entire authorized snapshot.
 * lastCoverage must be propagated by the service, not interpreted as full recall.
 */
export class NodeStore {
  readonly vector: PersistentVectorIndex;
  lastCoverage: NodeReadCoverage | undefined;
  constructor(private readonly store: NodeStoreKV, private readonly prefix: string,
    private readonly principal: { ownerRef: string; scopeRef: string }) {
    this.vector=new PersistentVectorIndex(store,`${prefix}/hy-embedding`);
  }
  private key(id: string): string { return `${this.prefix}/nodes/${id}`; }
  private scope(row: StoredNodeRow): void {
    if (row.payload.user_id!==this.principal.ownerRef || row.payload.agent_id!==this.principal.scopeRef) throw new Error('NODE_SCOPE_MISMATCH');
  }
  private async termPrefix(token: string): Promise<string> {
    // Hy may emit a long unbroken Chinese token; fixed-size identity avoids
    // exceeding the persistent tree's key limit without changing its tokenizer.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    const key=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    return `${this.prefix}/terms/${key}/`;
  }
  async save(rows: StoredNodeRow[]): Promise<void> {
    for (const row of rows) {
      this.scope(row);
      const id=row.payload.node_id;
      if (typeof id!=='string' || !id) throw new Error('NODE_ID_INVALID');
      if (!row.lexicalTokens || row.lexicalTokens.some(t=>typeof t!=='string')) throw new Error('HY_LEXICAL_TOKENS_REQUIRED');
      const old=await this.store.get<StoredNodeRow>(this.key(id));
      if (old) {
        if (JSON.stringify(old)!==JSON.stringify(row)) throw new Error('NODE_ID_IMMUTABLE');
        continue;
      }
      await this.vector.add(id,row.embedding);
      await this.store.set(this.key(id),row);
      for (const token of new Set(row.lexicalTokens)) await this.store.set(`${await this.termPrefix(token)}${id}`,id);
    }
  }
  async get(id: string, available: NodeAvailability): Promise<StoredNodeRow | null> {
    const row=await this.store.get<StoredNodeRow>(this.key(id));
    if (!row) return null;
    this.scope(row);
    if (row.payload.node_id!==id) throw new Error('NODE_ID_MISMATCH');
    return await available(row) ? row : null;
  }
  async read(method: string, args: Args, available: NodeAvailability): Promise<unknown> {
    this.lastCoverage={method,exhaustive:true};
    if (method==='get_by_id') return this.get(String(args.node_id),available);
    if (method==='get_by_ids') {
      if (!Array.isArray(args.node_ids) || args.node_ids.length>4096) throw new Error('NODE_IDS_LIMIT');
      const rows=[];
      for (const id of args.node_ids) { const row=await this.get(String(id),available);if(row) rows.push(row); }
      return rows;
    }
    if (method==='list_by_user') return this.listPage(args,available);
    if (method==='search') {
      const limit=count(args.limit,10,2048);
      const found=await this.vector.search(args.query_embedding as number[],{limit,
        accept:async id=>{const row=await this.get(id,available);return !!row && matches(row.payload,{...args,only_latest:args.only_latest ?? true},true);}});
      this.lastCoverage={method,exhaustive:found.exhaustive,visitedLeaves:found.visitedLeaves,visitedNodes:found.visitedNodes};
      const hits=[];
      for (const hit of found.hits) {
        if (hit.score<Number(args.score_threshold ?? 0)) continue;
        const row=await this.get(hit.id,available);if(row) hits.push({...row,node_id:hit.id,score:hit.score});
      }
      return hits;
    }
    if (method==='keyword_search') return this.keyword(args,available);
    throw new Error('NODE_READ_METHOD_UNSUPPORTED');
  }
  private async listPage(args: Args,available: NodeAvailability): Promise<unknown> {
    const size=count(args.pageSize,64,64), prefix=`${this.prefix}/nodes/`;
    if (args.cursor!==undefined && args.cursor!==null && (typeof args.cursor!=='string' || !args.cursor.startsWith(prefix))) throw new Error('NODE_CURSOR_INVALID');
    let cursor=(args.cursor ?? undefined) as string|undefined, scanned=0;
    const rows: Partial<StoredNodeRow>[]=[];
    while (rows.length<size) {
      const page=await this.store.page<StoredNodeRow>(prefix,cursor,64);
      for (const [index,entry] of page.entries.entries()) {
        scanned++;cursor=entry.key;
        const row=entry.value;this.scope(row);
        if ((args.allow_raw_layer || row.payload.layer!=='l1_raw') && matches(row.payload,args,false) && await available(row)) {
          rows.push(args.with_vectors===false ? {payload:row.payload} : row);
          if (rows.length===size) return {rows,nextCursor:index<page.entries.length-1 || page.nextCursor ? cursor : null};
        }
      }
      if (!page.nextCursor) return {rows,nextCursor:null};
      if (scanned>=LIST_SCAN) { this.lastCoverage={method:'list_by_user',exhaustive:false};return {rows,nextCursor:cursor}; }
    }
    return {rows,nextCursor:cursor};
  }
  private async keyword(args: Args,available: NodeAvailability): Promise<unknown> {
    if (!Array.isArray(args.tokens)) throw new Error('HY_QUERY_TOKENS_REQUIRED');
    const tokens=list(args.tokens);
    if (tokens.length>256 || tokens.some(t=>typeof t!=='string')) throw new Error('HY_QUERY_TOKENS_REQUIRED');
    const terms=[...new Set(tokens as string[])].filter(Boolean), ids=new Set<string>();
    let exhaustive=true, visitedPostings=0;
    for (const term of terms) {
      const prefix=await this.termPrefix(term);
      let cursor: string|undefined;
      do {
        const page=await this.store.page<string>(prefix,cursor,64);
        for (const entry of page.entries) { visitedPostings++;ids.add(entry.value);if(ids.size===CANDIDATES || visitedPostings>=4096) break; }
        cursor=page.nextCursor;
        if (ids.size===CANDIDATES || visitedPostings>=4096) { exhaustive=false;break; }
      } while (cursor);
      if (!exhaustive) break;
    }
    const rows: StoredNodeRow[]=[];
    for (const id of ids) {const row=await this.get(id,available);if(row && matches(row.payload,{...args,only_latest:args.only_latest ?? true},true)) rows.push(row);}
    const n=rows.length, avg=rows.reduce((s,r)=>s+(r.lexicalTokens?.length ?? 0),0)/(n||1)||1;
    const df=new Map(terms.map(t=>[t,rows.filter(r=>r.lexicalTokens?.includes(t)).length]));
    const hits=rows.map(row=>{
      const doc=row.lexicalTokens ?? [], dl=doc.length||1;
      let score=0;
      for (const t of terms) {
        const tf=doc.filter(x=>x===t).length;if(!tf)continue;
        const frequency=df.get(t)!;
        score+=Math.log((n-frequency+.5)/(frequency+.5)+1)*tf*2.5/(tf+1.5*(1-.75+.75*dl/avg));
      }
      return {...row,node_id:String(row.payload.node_id),score};
    }).filter(h=>h.score>0).sort((a,b)=>b.score-a.score || (a.node_id<b.node_id?-1:a.node_id>b.node_id?1:0));
    this.lastCoverage={method:'keyword_search',exhaustive,candidates:n,scoringCorpus:'bounded-posting-candidates'};
    return hits.slice(0,count(args.top_k,10,2048));
  }
}
