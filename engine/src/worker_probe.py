"""CPython caller for a locally running synthetic fixture Worker; no real models."""
import json
import sys
import urllib.request
import urllib.error

endpoint=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8797/compute'

def call(body):
    request=urllib.request.Request(endpoint,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raw=error.read()
        try: return json.loads(raw)
        except ValueError: return {"success":False,"error":"NON_JSON_HTTP_RESPONSE","httpStatus":error.code}

report={'runtime':'actual local Python Worker/workerd','modelBoundary':'httpx.MockTransport','writes':{},'reads':{},'checks':{}}
for kind,model in [('image','fixture-vision'),('audio','fixture-asr'),('video','fixture-gemini-ub'),('image','owner-correction')]:
    label='correction' if model=='owner-correction' else kind
    text='Owner明确纠正：门牌是松桥。' if label=='correction' else ('会议室门牌为松桥。' if kind=='image' else '画面显示松桥门牌，同期录音说会议开始。' if kind=='video' else '录音中说会议室门牌为松桥。')
    source={'sourceId':label+'-source','revision':2 if label=='correction' else 1,'mediaRef':'media://'+label+'-v1'}
    request={'operation':'write','principal':{'ownerRef':'fixture-owner','scopeRef':'personal'},'requestId':label+'-write',
        'sessionRef':'session-a','nodes':[],'content':text,'sourceRef':source,
        'perception':{'model':model,'configKey':'fixture-v1','kind':kind,'text':text}}
    written=call(request); report['writes'][label]=written
    report['checks'][label+'_write']=written.get('success') is True
    if not written.get('success'): continue
    role='owner-correction' if label=='correction' else 'media-observation'
    report['checks'][label+'_attribution']=all(row['payload']['custom']['meta'][0]['role']==role and row['payload']['custom']['meta'][0]['sourceRef']==source for row in written['nodes'])
    read={'operation':'search','principal':request['principal'],'requestId':label+'-read','sessionRef':'session-b',
        'nodes':written['nodes'],'query':'会议室门牌是什么？','limit':5}
    found=call(read); report['reads'][label]=found
    report['checks'][label+'_cross_session']=found.get('success') is True and bool(found.get('memories'))
    read['principal']={'ownerRef':'other-owner','scopeRef':'personal'}
    rejected=call(read)
    report['checks'][label+'_isolation']=rejected.get('success') is False and 'nodes' not in rejected
report['ok']=len(report['checks'])==16 and all(report['checks'].values())
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if report['ok'] else 1)
