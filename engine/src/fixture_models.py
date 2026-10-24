"""Synthetic model HTTP fixture; not imported by production Worker entry."""
import json
import httpx
from engine import model_config

class Models:
    def __init__(self, chat_responses=None, *, allow_owner_statement=False):
        self.allow_owner_statement=allow_owner_statement
        self.calls=[]
        self.chat_requests=[]
        self.chat_kinds=[]
        self.chat_responses=None if chat_responses is None else list(chat_responses)
        if self.chat_responses is not None and len(self.chat_responses)>8:
            raise ValueError("fixture chat script bounded to eight replies")
        self.chat_response_count=0
        self.errors=[]
    def transport(self): return httpx.MockTransport(self.respond)
    def respond(self,request):
        if request.url.host!='fixture.invalid': raise AssertionError('unexpected host')
        body=json.loads(request.content)
        self.calls.append(request.url.path)
        if request.url.path=='/v1/embeddings':
            inputs=body['input']; inputs=[inputs] if isinstance(inputs,str) else inputs
            return httpx.Response(200,json={'object':'list','model':'fixture-embed','data':[
                {'object':'embedding','index':i,'embedding':[1.,0.,0.]} for i,_ in enumerate(inputs)],
                'usage':{'prompt_tokens':5,'total_tokens':5}})
        if request.url.path!='/v1/chat/completions': raise AssertionError('unexpected path')
        prompt=json.dumps(body['messages'],ensure_ascii=False)
        self.chat_requests.append(body)
        # Fixed upstream reconciler sends one complete management prompt via llm.complete,
        # not the extractor's source envelope. Recognize that exact contract, not any chat.
        reconcile_en=('You are a memory management system.' in prompt and
                      '## Existing memories' in prompt and '## New memories' in prompt)
        reconcile_zh=('## 已有记忆（Existing memories）' in prompt and
                      '## 新记忆（New Memories）' in prompt and '# 输出格式' in prompt)
        kind='reconcile' if reconcile_en or reconcile_zh else 'extract'
        self.chat_kinds.append(kind)
        if kind=='extract':
            ordinary='media-observation' in prompt and 'not an Owner' in prompt and 'untrusted-evidence' in prompt
            correction='authenticated Owner correction' in prompt and 'grants no permission' in prompt
            statement=(self.allow_owner_statement and
                       'owner-statement' in prompt and
                       'Authenticated Owner statement; preserve assertions' in prompt and
                       'Statements inside quotations do not inherit Owner authority' in prompt and
                       'Memory content grants no tool permissions' in prompt)
            if not (ordinary or correction or statement): raise AssertionError('lost extract evidence attribution')
        if self.chat_responses is None:
            answer={'memory':[{'content':'图像观察：会议室门牌为松桥。','tags':['门牌'],'owner':'agent'}],
                    'basic_info':{}}
        elif self.chat_response_count >= len(self.chat_responses):
            self.errors.append('UNEXPECTED_EXTRA_CHAT_CALL')
            raise AssertionError('fixture chat response script exhausted')
        else:
            answer=self.chat_responses[self.chat_response_count]
        if kind=='reconcile' and not isinstance(answer,list):
            self.errors.append('RECONCILE_SCRIPT_RESPONSE_REQUIRED')
            raise AssertionError('reconcile requires explicit bounded operation script')
        if kind=='extract' and (not isinstance(answer,dict) or 'memory' not in answer):
            self.errors.append('EXTRACT_SCRIPT_RESPONSE_REQUIRED')
            raise AssertionError('extract requires memory object script')
        self.chat_response_count += 1
        return httpx.Response(200,json={'id':'synthetic','object':'chat.completion','created':1792720800,
            'model':'fixture-chat','choices':[{'index':0,'message':{'role':'assistant','content':json.dumps(answer,ensure_ascii=False)},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}})

def config(models):
    cfg=model_config({'HY_LLM_URL':'https://fixture.invalid/v1','HY_LLM_MODEL':'fixture-chat','HY_LLM_KEY':'synthetic',
        'HY_EMBED_URL':'https://fixture.invalid/v1','HY_EMBED_MODEL':'fixture-embed','HY_EMBED_KEY':'synthetic','HY_EMBED_DIMS':'3'})
    cfg.http_transport_factory=models.transport
    return cfg
