"""Service-binding-only Python Worker. TS authority owns authentication, publication and revision-bound reads."""
import json
from workers import WorkerEntrypoint, Response
from engine import compute, model_config
from remote_store import BindingTransport

MAX_REQUEST_BYTES=16*1024*1024

async def read_request(request):
    declared=request.headers.get("content-length")
    if declared is not None and int(declared)>MAX_REQUEST_BYTES:
        raise ValueError("REQUEST_TOO_LARGE")
    chunks=[]; size=0
    if request.body is None: return ""
    reader=request.body.getReader()
    try:
        while True:
            part=await reader.read()
            if part.done: break
            size+=int(part.value.byteLength)
            if size>MAX_REQUEST_BYTES:
                await reader.cancel()
                raise ValueError("REQUEST_TOO_LARGE")
            chunks.append(bytes(part.value.to_py()))
    finally:
        reader.releaseLock()
    return b"".join(chunks).decode("utf-8")


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != 'POST' or str(request.url).split('?',1)[0].rsplit('/',1)[-1] != 'compute':
            return Response('Not found',status=404)
        # No public route: the caller's authenticated TS authority supplies principal.
        try:
            values={key:str(getattr(self.env,key)) for key in ['HY_LLM_URL','HY_LLM_MODEL','HY_LLM_KEY','HY_EMBED_URL','HY_EMBED_MODEL','HY_EMBED_KEY','HY_EMBED_DIMS']}
            raw=await read_request(request)
            if len(raw)>16*1024*1024:
                return Response(json.dumps({'success':False,'error':'REQUEST_TOO_LARGE'}),status=413)
            result=await compute(json.loads(raw),config=model_config(values),
                                 read_transport=BindingTransport(self.env.MEMORY_READ))
        except ValueError as exc:
            if str(exc)=="REQUEST_TOO_LARGE":
                return Response(json.dumps({"success":False,"error":"REQUEST_TOO_LARGE"}),status=413)
            result={"success":False,"error":"ENGINE_REQUEST_FAILED"}
        except Exception:
            result={'success':False,'error':'ENGINE_REQUEST_FAILED'}
        return Response(json.dumps(result,ensure_ascii=False,default=str),status=200 if result['success'] else 422,
                        headers={'Content-Type':'application/json'})
