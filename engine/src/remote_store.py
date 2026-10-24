"""Read-only Hy adapter to the authenticated TS authority; no durable writes."""
import copy
import functools
import inspect
import json
from hy_memory.data.vector_store_base import VectorStoreBase
from snapshot import SnapshotStore, lexical_tokens


def _wire(value):
    if isinstance(value, dict): return {k:_wire(v) for k,v in value.items()}
    if isinstance(value, (list,tuple)): return [_wire(v) for v in value]
    return getattr(value, 'value', value)


class BindingTransport:
    def __init__(self, binding): self.binding=binding

    async def __call__(self, body):
        # Cloudflare Python FFI exposes native Request and ServiceBinding.fetch.
        from js import Request, Object
        from pyodide.ffi import to_js
        request=Request.new('https://memory/read-store', to_js({
            'method':'POST','headers':{'Content-Type':'application/json'},
            'body':json.dumps(body,ensure_ascii=False)}, dict_converter=Object.fromEntries))
        response=await self.binding.fetch(request)
        if response.status != 200: raise ValueError('REMOTE_READ_FAILED')
        return json.loads(await response.text())


class RemoteReadStore(VectorStoreBase):
    _supports_retrieval_clauses=False
    _supports_narrow_episode_queries=False
    _supports_tag_index=False
    _keyword_score_normalized=False
    MAX_READ_CALLS=256

    def __init__(self, config, principal, revision, transport):
        super().__init__(config)
        self.principal=copy.deepcopy(principal)
        self.revision=revision
        self.transport=transport
        self.errors=[]
        self.read_calls=0
        self.retrieval_coverage=[]

    async def initialize(self): pass
    async def close(self): pass

    async def _call(self, method, args):
        try:
            if self.read_calls>=self.MAX_READ_CALLS:
                raise ValueError('REMOTE_READ_BUDGET_EXCEEDED')
            self.read_calls+=1
            envelope=await self.transport({'principal':self.principal,'revision':self.revision,
                                          'method':method,'args':_wire(args)})
            if not isinstance(envelope,dict) or 'result' not in envelope or set(envelope)-{'result','coverage'}:
                raise ValueError('REMOTE_RESPONSE_INVALID')
            coverage=envelope.get('coverage')
            if coverage is None:
                coverage={'method':method,'exhaustive':False,'reason':'coverage-not-provided'}
            elif (not isinstance(coverage,dict) or coverage.get('method')!=method
                  or type(coverage.get('exhaustive')) is not bool
                  or set(coverage)-{'method','exhaustive','candidates','visitedLeaves','visitedNodes','scoringCorpus'}):
                raise ValueError('REMOTE_COVERAGE_INVALID')
            else:
                for key in ('candidates','visitedLeaves','visitedNodes'):
                    if key in coverage and (type(coverage[key]) is not int or coverage[key]<0):
                        raise ValueError('REMOTE_COVERAGE_INVALID')
                if 'scoringCorpus' in coverage and coverage['scoringCorpus']!='bounded-posting-candidates':
                    raise ValueError('REMOTE_COVERAGE_INVALID')
            self.retrieval_coverage.append(copy.deepcopy(coverage))
            return envelope['result']
        except Exception:
            self.errors.append(method)
            raise

    def _node(self,row):
        if not isinstance(row,dict) or not isinstance(row.get('payload'),dict):
            raise ValueError('REMOTE_ROW_INVALID')
        p=row['payload']
        if p.get('user_id')!=self.principal['ownerRef'] or p.get('agent_id')!=self.principal['scopeRef']:
            raise ValueError('REMOTE_SCOPE_MISMATCH')
        return SnapshotStore._node(copy.deepcopy(p),copy.deepcopy(row.get('embedding')))

    async def get_by_id(self,node_id):
        row=await self._call('get_by_id',{'node_id':node_id})
        if row is None: return None
        node=self._node(row)
        if node.node_id!=node_id: raise ValueError('REMOTE_NODE_ID_MISMATCH')
        return node

    async def get_by_ids(self,node_ids):
        rows=await self._call('get_by_ids',{'node_ids':node_ids})
        if not isinstance(rows,list): raise ValueError('REMOTE_RESPONSE_INVALID')
        nodes=[self._node(row) for row in rows]
        if any(n.node_id not in node_ids for n in nodes): raise ValueError('REMOTE_NODE_ID_MISMATCH')
        return nodes

    async def get_embeddings(self,node_ids):
        return {n.node_id:n.embedding for n in await self.get_by_ids(node_ids) if n.embedding is not None}

    async def _hits(self,method,args):
        rows=await self._call(method,args)
        if not isinstance(rows,list): raise ValueError('REMOTE_RESPONSE_INVALID')
        hits=[]
        for row in rows:
            node=self._node(row)
            if row.get('node_id')!=node.node_id: raise ValueError('REMOTE_NODE_ID_MISMATCH')
            hits.append({'node_id':node.node_id,'score':row['score'],'node':node})
        return hits

    async def search(self,query_embedding,**kwargs):
        return await self._hits('search',{'query_embedding':query_embedding,**kwargs})

    async def keyword_search(self,query,**kwargs):
        return await self._hits('keyword_search',{'query':query,'tokens':lexical_tokens(query),**kwargs})

    async def list_by_user(self,user_id=None,agent_id=None,limit=10000,**kwargs):
        rows=[]; cursor=None; seen=set()
        while len(rows)<max(0,limit):
            size=min(64,limit-len(rows))
            result=await self._call('list_by_user',{'user_id':user_id,'agent_id':agent_id,
                **kwargs,'pageSize':size,'cursor':cursor})
            if not isinstance(result,dict) or not isinstance(result.get('rows'),list) or len(result['rows'])>size:
                raise ValueError('REMOTE_PAGE_INVALID')
            rows.extend(self._node(row) for row in result['rows'])
            cursor=result.get('nextCursor')
            if cursor is None: break
            if not isinstance(cursor,str) or not cursor or cursor in seen:
                raise ValueError('REMOTE_CURSOR_INVALID')
            seen.add(cursor)
        if cursor is not None:
            self.retrieval_coverage.append({'method':'list_by_user','exhaustive':False,'candidates':len(rows)})
        if kwargs.get('allow_raw_layer'):
            for node in rows:
                if getattr(node.layer,'value',node.layer)!='l1_raw' or not node.content.startswith('{'): continue
                entries=(node.custom or {}).get('meta',[])
                roles={e.get('role') for e in entries if isinstance(e,dict)}
                if len(roles)!=1 or not roles.issubset({'media-observation','owner-correction'}): continue
                try: envelope=json.loads(node.content)
                except (TypeError,ValueError): continue
                role=next(iter(roles))
                if isinstance(envelope,dict) and envelope.get('role')==role:
                    node.content=f"[{'tool' if role=='media-observation' else 'user'}]: {node.content}"
        return rows

    async def _readonly(self,*args,**kwargs):
        raise ValueError('REMOTE_STORE_READ_ONLY')

    upsert=upsert_batch=update_embedding=update_payload=delete=_readonly
    delete_by_isolation_key=delete_by_metadata=_readonly
    upsert_tag_embedding=delete_tag_embedding=replace_retrieval_clauses=_readonly
    delete_retrieval_clauses=delete_retrieval_clauses_by_metadata=_readonly
    upsert_entity=delete_entities_for_memory=_readonly
    get_stats=count=_readonly


# Hy catches some store failures. Keep a request-local failure receipt regardless.
for _name in dir(RemoteReadStore):
    _method=getattr(RemoteReadStore,_name)
    if _name.startswith('_') or not inspect.iscoroutinefunction(_method): continue
    def _wrap(name,method):
        @functools.wraps(method)
        async def call(self,*args,**kwargs):
            try: return await method(self,*args,**kwargs)
            except Exception:
                self.errors.append(name)
                raise
        return call
    setattr(RemoteReadStore,_name,_wrap(_name,_method))
