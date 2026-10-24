"""Request-local snapshot adapter; no persistent database or filesystem authority.

No filesystem, network,
model, graph, or Vectorize operation. Full scans and exact cosine are intentional
for bounded snapshots. Lexical probe reuses upstream Chat BM25-lite + lemmatize_for_bm25;
this is not Qdrant sparse-BM25 retrieval equivalence.
"""
import json
import math
from hy_memory.data.vector_store_base import VectorStoreBase, node_effective_time
from hy_memory.models.memory import MemoryNode


def _value(item):
    return getattr(item, 'value', item)


def _vector(values):
    if not isinstance(values,list) or any(type(value) not in (int,float) for value in values):
        raise ValueError('SNAPSHOT_VECTOR_NUMBERS_REQUIRED')
    result = [float(value) for value in values]
    if not result or not all(math.isfinite(value) for value in result):
        raise ValueError('PROBE_VECTOR_MUST_BE_NONEMPTY_FINITE')
    return result


def _cosine(a, b):
    if len(a) != len(b):
        raise ValueError('PROBE_VECTOR_DIMENSION_MISMATCH')
    norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / norm if norm else 0.0



import copy

def lexical_tokens(text):
    from hy_memory.pipelines._retrieval.bm25 import tokenize
    from hy_memory.pipelines._retrieval.lemmatize import lemmatize_for_bm25
    return tokenize(lemmatize_for_bm25(text))


class SnapshotStore(VectorStoreBase):
    _supports_retrieval_clauses = True
    _supports_narrow_episode_queries = False
    _supports_tag_index = False
    _keyword_score_normalized = False
    MAX_WORKING_NODES = 2000

    def __init__(self, config, nodes, principal):
        super().__init__(config)
        self.rows = {}
        self.clauses = {}
        self.errors = []
        self.principal = principal
        if len(nodes) > self.MAX_WORKING_NODES:
            raise ValueError('WORKING_SET_CAPACITY_EXCEEDED')
        for item in nodes:
            payload = copy.deepcopy(item['payload'])
            node = MemoryNode.from_dict(payload)
            if payload.get('isolation_key', node.get_isolation_key()) != node.get_isolation_key():
                raise ValueError('SNAPSHOT_ISOLATION_KEY_INVALID')
            payload['isolation_key'] = node.get_isolation_key()
            self._assert_scope(payload)
            if payload['node_id'] in self.rows:
                raise ValueError('SNAPSHOT_DUPLICATE_NODE')
            self._save(payload, self._embedding(item['embedding']))

    def _assert_scope(self, payload):
        if payload.get('user_id') != self.principal['ownerRef'] or payload.get('agent_id') != self.principal['scopeRef']:
            raise ValueError('SNAPSHOT_SCOPE_MISMATCH')

    async def initialize(self):
        return None

    async def close(self):
        return None

    def _all(self):
        return [(copy.deepcopy(p), list(e)) for _, (p,e) in sorted(self.rows.items())]

    def export(self):
        return [{'payload':p,'embedding':e,'lexicalTokens':lexical_tokens(str(p.get('content',''))+' '+' '.join(p.get('tags') or []))} for p,e in self._all()]

    def _save(self, payload, embedding):
        self._assert_scope(payload)
        if payload['node_id'] not in self.rows and len(self.rows) >= self.MAX_WORKING_NODES:
            raise ValueError('WORKING_SET_CAPACITY_EXCEEDED')
        self.rows[payload['node_id']] = (copy.deepcopy(payload), list(embedding))

    async def get_by_id(self, node_id):
        item = self.rows.get(node_id)
        return self._node(copy.deepcopy(item[0]), list(item[1])) if item else None

    async def update_embedding(self, node_id, embedding):
        vector = self._embedding(embedding)
        if node_id not in self.rows: return False
        self._save(self.rows[node_id][0], vector)
        return True

    async def update_payload(self, node_id, updates):
        if node_id not in self.rows: return False
        p,e = self.rows[node_id]
        p = copy.deepcopy(p)
        if 'node_id' in updates and updates['node_id'] != node_id:
            raise ValueError('NODE_ID_IMMUTABLE')
        if set(updates) - set(p): raise ValueError('UNKNOWN_PAYLOAD_FIELDS')
        p.update({k:_value(v) for k,v in updates.items()})
        p['isolation_key'] = self._node(p).get_isolation_key()
        self._save(p,e)
        return True

    async def delete(self, node_id):
        self.clauses.pop(node_id,None)
        return self.rows.pop(node_id,None) is not None

    async def get_stats(self):
        return {'points_count':len(self.rows),'vectors_count':len(self.rows),'collection_name':self._collection_name,'backend':'request_local_snapshot_exact_scan'}

    async def replace_retrieval_clauses(self, parent, clauses, embeddings):
        if len(clauses) != len(embeddings): raise ValueError('CLAUSE_EMBEDDING_COUNT_MISMATCH')
        if parent.node_id not in self.rows: raise ValueError('CLAUSE_PARENT_MISSING')
        self.clauses[parent.node_id] = [(text,self._embedding(e)) for text,e in zip(clauses,embeddings)]
        return len(clauses)

    async def delete_retrieval_clauses(self, parent_id):
        return len(self.clauses.pop(parent_id,[]))

    async def search_retrieval_clauses(self, *,query_embedding,user_id,agent_ids=None,top_k=20,min_score=0.0):
        query=self._embedding(query_embedding)
        hits=[]
        for parent_id,clauses in self.clauses.items():
            p,_=self.rows[parent_id]
            if not self._matches(p,user_id=user_id,agent_ids=agent_ids,status_filter=['active'],only_latest=True): continue
            scores=[{'parent_id':parent_id,'score':_cosine(query,e),'clause':text} for text,e in clauses]
            best=max(scores,key=lambda x:x['score'],default=None)
            if best and best['score']>=min_score: hits.append(best)
        return sorted(hits,key=lambda x:(-x['score'],x['parent_id']))[:max(0,top_k)]

    def _serialize(self, node):
        payload = node.to_dict()
        payload['isolation_key'] = node.get_isolation_key()
        return payload


    def _embedding(self, values):
        result = _vector(values)
        expected = self.config.vector_store.embedding_dims
        if expected and len(result) != expected:
            raise ValueError('PROBE_CONFIGURED_DIMENSION_MISMATCH')
        return result


    @staticmethod
    def _node(payload, embedding=None):
        node = MemoryNode.from_dict(payload)
        if embedding is not None:
            node.embedding = embedding
        return node


    async def upsert(self, node):
        embedding = self._embedding(node.embedding or [])
        self._save(self._serialize(node), embedding)
        return node.node_id


    async def upsert_batch(self, nodes):
        # Prevalidate the whole batch before issuing its first SQL mutation.
        values = [(self._serialize(n), self._embedding(n.embedding or [])) for n in nodes]
        for payload, embedding in values:
            self._save(payload, embedding)
        return [p['node_id'] for p, _ in values]


    @staticmethod
    def _matches(p, *, isolation_key='', isolation_keys=None, user_id=None,
                 user_ids=None, agent_ids=None, include_sources=None,
                 exclude_sources=None, layers=None, status_filter=None,
                 only_latest=False, tags_match_any=None, created_after=None):
        if isolation_keys:
            if p['isolation_key'] not in isolation_keys:
                return False
        elif isolation_key:
            if p['isolation_key'] != isolation_key:
                return False
        else:
            users = user_ids or ([user_id] if user_id is not None else [])
            if not users:
                raise ValueError('PROBE_USER_OR_ISOLATION_SCOPE_REQUIRED')
            if p.get('user_id') not in users:
                return False
            if agent_ids and p.get('agent_id') not in agent_ids:
                return False
        if include_sources and p.get('source') not in include_sources:
            return False
        if exclude_sources and p.get('source') in exclude_sources:
            return False
        if layers and p.get('layer') not in [_value(v) for v in layers]:
            return False
        if status_filter is not None and p.get('status') not in [_value(v) for v in status_filter]:
            return False
        if only_latest and not p.get('is_latest', True):
            return False
        if tags_match_any and not set(tags_match_any).intersection(p.get('tags') or []):
            return False
        if created_after is not None:
            timestamp = node_effective_time(p)
            if timestamp is None or timestamp < created_after:
                return False
        return True


    async def search(self, query_embedding, isolation_key='', isolation_keys=None,
                     user_id=None, user_ids=None, agent_ids=None, include_sources=None,
                     exclude_sources=None, layers=None, limit=10, score_threshold=0.0,
                     status_filter=None, only_latest=True, tags_match_any=None, created_after=None):
        if not isolation_keys and not isolation_key and not user_ids and user_id is None:
            raise ValueError('PROBE_USER_OR_ISOLATION_SCOPE_REQUIRED')
        query = self._embedding(query_embedding)
        filters = dict(isolation_key=isolation_key, isolation_keys=isolation_keys,
                       user_id=user_id, user_ids=user_ids, agent_ids=agent_ids,
                       include_sources=include_sources, exclude_sources=exclude_sources,
                       layers=layers, status_filter=['active'] if status_filter is None else status_filter,
                       only_latest=only_latest, tags_match_any=tags_match_any, created_after=created_after)
        hits = []
        for payload, embedding in self._all():
            if self._matches(payload, **filters):
                score = _cosine(query, embedding)
                if score >= score_threshold:
                    hits.append({'node_id': payload['node_id'], 'score': score, 'node': self._node(payload, embedding)})
        return sorted(hits, key=lambda h: (-h['score'], h['node_id']))[:max(0, limit)]


    async def list_by_user(self, user_id=None, agent_id=None, limit=10000,
                           status_filter=None, layers=None, user_ids=None, agent_ids=None,
                           include_sources=None, exclude_sources=None, only_latest=False,
                           with_vectors=True, allow_raw_layer=False):
        # Validate scope even for an empty store.
        if not user_ids and user_id is None:
            raise ValueError('PROBE_USER_SCOPE_REQUIRED')
        filters = dict(user_id=user_id, user_ids=user_ids,
                       agent_ids=agent_ids or ([agent_id] if agent_id is not None else None),
                       layers=layers, status_filter=status_filter, include_sources=include_sources,
                       exclude_sources=exclude_sources, only_latest=only_latest)
        nodes=[self._node(p, e if with_vectors else None) for p, e in self._all()
               if (allow_raw_layer or p.get('layer') != 'l1_raw') and self._matches(p, **filters)][:max(0, limit)]
        if allow_raw_layer:
            for node in nodes:
                # Older adapter writes stored bare JSON. Repair only the history
                # projection using authenticated provenance, never source bytes
                # or persisted rows. New writes use Hy's own role formatter.
                if _value(node.layer)!='l1_raw' or not node.content.startswith('{'):
                    continue
                entries=(node.custom or {}).get('meta',[])
                roles={entry.get('role') for entry in entries if isinstance(entry,dict)}
                if len(roles)!=1 or not roles.issubset({'media-observation','owner-correction'}):
                    continue
                try: envelope=json.loads(node.content)
                except (TypeError,ValueError): continue
                role=next(iter(roles))
                if not isinstance(envelope,dict) or envelope.get('role')!=role:
                    continue
                label='tool' if role=='media-observation' else 'user'
                node.content=f'[{label}]: {node.content}'
        return nodes


    async def keyword_search(self, query, top_k=10, user_id=None, agent_ids=None,
                             layers=None, status_filter=None, only_latest=True,
                             isolation_key='', isolation_keys=None, include_sources=None,
                             exclude_sources=None):
        # Source: Hy-Memory 4c311b2 pipelines/_retrieval/bm25.py:
        # tokenize + compute_bm25_scores, with identical upstream preprocessing
        # for query and documents from _retrieval/lemmatize.py:200.
        # SQL-scoped tiny-corpus BM25-lite, NOT Qdrant sparse BM25 equivalence.
        from hy_memory.pipelines._retrieval.bm25 import compute_bm25_scores, tokenize
        from hy_memory.pipelines._retrieval.lemmatize import lemmatize_for_bm25
        filters = dict(user_id=user_id, agent_ids=agent_ids, layers=layers,
                       status_filter=['active'] if status_filter is None else status_filter,
                       only_latest=only_latest, isolation_key=isolation_key,
                       isolation_keys=isolation_keys, include_sources=include_sources,
                       exclude_sources=exclude_sources)
        if not isolation_keys and not isolation_key and user_id is None:
            raise ValueError('PROBE_USER_OR_ISOLATION_SCOPE_REQUIRED')
        candidates = [(p, e) for p, e in self._all() if self._matches(p, **filters)]
        q = tokenize(lemmatize_for_bm25(query))
        if not candidates or not q:
            return []
        # Same content-plus-tags field selection as VectorStoreBase.
        documents = [lemmatize_for_bm25(str(p.get('content', '')) + ' ' + ' '.join(p.get('tags') or []))
                     for p, _ in candidates]
        corpus = [tokenize(text) for text in documents]
        if not any(corpus):
            return []
        scores = compute_bm25_scores(q, documents)
        hits = []
        wanted = set(q)
        for (payload, embedding), tokens, score in zip(candidates, corpus, scores):
            # Zero lexical matches must not enter the retrieval lane.
            if wanted.intersection(tokens) and float(score) > 0:
                hits.append({'node_id': payload['node_id'], 'score': float(score),
                             'node': self._node(payload, embedding)})
        return sorted(hits, key=lambda h: (-h['score'], h['node_id']))[:max(0, top_k)]


    async def delete_by_isolation_key(self, isolation_key):
        if not isolation_key:
            raise ValueError('PROBE_ISOLATION_SCOPE_REQUIRED')
        ids = [p['node_id'] for p, _ in self._all() if p.get('isolation_key') == isolation_key]
        for node_id in ids:
            await self.delete(node_id)
        return len(ids)


    async def delete_by_metadata(self, user_id, agent_id=None, session_id=None):
        if not user_id:
            raise ValueError('PROBE_USER_SCOPE_REQUIRED')
        ids = [p['node_id'] for p, _ in self._all() if p.get('user_id') == user_id
               and (agent_id is None or p.get('agent_id') == agent_id)
               and (session_id is None or p.get('session_id') == session_id)]
        for node_id in ids:
            await self.delete(node_id)
        return len(ids)


    async def count(self, isolation_key):
        if not isolation_key:
            raise ValueError('PROBE_ISOLATION_SCOPE_REQUIRED')
        return sum(1 for p, _ in self._all() if p.get('isolation_key') == isolation_key)


    async def delete_retrieval_clauses_by_metadata(self, *, user_id, agent_id=None, session_id=None):
        if not user_id:
            raise ValueError('PROBE_USER_SCOPE_REQUIRED')
        count = 0
        for payload, _ in self._all():
            if payload.get('user_id') == user_id and (agent_id is None or payload.get('agent_id') == agent_id) and (session_id is None or payload.get('session_id') == session_id):
                count += await self.delete_retrieval_clauses(payload['node_id'])
        return count



# Record errors even when the upstream pipeline catches a store exception.
import functools
import inspect
for _name in dir(SnapshotStore):
    _method=getattr(SnapshotStore,_name)
    if _name.startswith('_') or not inspect.iscoroutinefunction(_method): continue
    def _wrap(name, method):
        @functools.wraps(method)
        async def call(self,*args,**kwargs):
            try: return await method(self,*args,**kwargs)
            except Exception:
                self.errors.append(name)
                raise
        return call
    setattr(SnapshotStore,_name,_wrap(_name,_method))
