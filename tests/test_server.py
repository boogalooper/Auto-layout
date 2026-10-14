import sys,types,importlib.util,importlib.machinery,threading,socket,json,time,tempfile,os,logging,io
sys.modules['cv2']=types.ModuleType('cv2')
sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
from pathlib import Path
p=str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')
loader=importlib.machinery.SourceFileLoader('layout_server',p)
spec=importlib.util.spec_from_loader(loader.name,loader);s=importlib.util.module_from_spec(spec);loader.exec_module(s)
import numpy as np
for vals in [[.95,.05],[1000,-1000],[-1,1]]:
    probs=s.binary_probabilities(vals);assert np.isclose(probs.sum(),1) and np.isfinite(probs).all()
for vals in [[],[1],[1,2,3],[float('nan'),0],[0,float('inf')]]:assert s.binary_probabilities(vals) is None
replies=[];s.send_data_to_jsx=lambda obj:replies.append(obj)
log=io.StringIO();handler=logging.StreamHandler(log);logging.getLogger().addHandler(handler);logging.getLogger().setLevel(logging.INFO)
def name(n):return {'sex':'M','confidence':.98,'source':'name','analysis_status':'ok','needs_image':False,'reason':'name_surname'}
s.classify_name=name

def call(message):
    a,b=socket.socketpair();a.sendall((json.dumps(message)+'\n').encode());thread=threading.Thread(target=s.handle_client,args=(b,));thread.start();return a,thread
conn,t=call({'type':'gender_names','request_id':'names','message':[{'id':1,'name':'Иванов Иван'},{'id':2,'name':'Тест\nдве строки'}]});t.join(2);conn.close();assert len(replies[-1]['message'])==2;assert not s.active_requests
records=log.getvalue().splitlines();assert len(records)==2
for record in records:obj=json.loads(record.split('gender_result ',1)[1]);assert obj['method']=='name' and obj['confidence']==.98
# Abort a batch between layers, leaving no active request behind.
calls=[]
def slow(n):calls.append(n);time.sleep(.05);return name(n)
s.classify_name=slow
conn,t=call({'type':'gender_names','request_id':'cancelme','message':[{'id':i,'name':str(i)} for i in range(30)]})
deadline=time.monotonic()+2
while 'cancelme' not in s.active_requests and time.monotonic()<deadline:time.sleep(.001)
assert s.heartbeat_request('cancelme');assert s.cancel_request('cancelme');t.join(2);conn.close();assert not t.is_alive();assert replies[-1]['type']=='cancelled';assert len(calls)<30;assert not s.active_requests
# Errors must also release active state.
s.classify_name=lambda n: (_ for _ in ()).throw(RuntimeError('mock morphology failed'))
conn,t=call({'type':'gender_names','request_id':'failed','message':[{'id':1,'name':'x'}]});t.join(2);conn.close();assert replies[-1]['type']=='error';assert not s.active_requests
state=s.register_active_request('expired');state['last_heartbeat']-=5;assert s.request_cancelled(state);s.unregister_active_request('expired')
# Preview cleanup accepts only owned temporary files.
fd,path=tempfile.mkstemp(prefix='ALG_1_2_',suffix='.jpg');os.close(fd)
# mkstemp suffix is alphanumeric, so use prescribed numeric filename instead.
os.remove(path);path=os.path.join(tempfile.gettempdir(),'ALG_123_456_789.jpg');open(path,'wb').close();assert s.queue_preview_cleanup(path);assert not os.path.exists(path)
assert not s.queue_preview_cleanup(os.path.join(tempfile.gettempdir(),'unrelated.jpg'))
print('PASS: probability validation, batch transport, diagnostics, heartbeat/cancel, error cleanup and preview cleanup (morphology/OpenCV mocked)')
# Geometry transport follows the same request lock and cancellation lifecycle.
s.calculate_zone_layout=lambda payload,state:dict(status='ok',commonScale=1)
conn,t=call({'type':'layout_zones','request_id':'geometry','message':{}});t.join(2);conn.close();assert replies[-1]['message']['status']=='ok';assert not s.active_requests and not s.request_lock.locked()
s.calculate_zone_layout=lambda *args: (_ for _ in ()).throw(ValueError('invalid dimensions'))
conn,t=call({'type':'layout_zones','request_id':'geometry_bad','message':{}});t.join(2);conn.close();assert replies[-1]['type']=='error';assert not s.active_requests and not s.request_lock.locked()
def cancel_layout(payload,state):
    while not s.request_cancelled(state):time.sleep(.005)
    raise InterruptedError('cancelled')
s.calculate_zone_layout=cancel_layout
conn,t=call({'type':'layout_zones','request_id':'geometry_cancel','message':{}})
deadline=time.monotonic()+2
while 'geometry_cancel' not in s.active_requests and time.monotonic()<deadline:time.sleep(.001)
assert s.heartbeat_request('geometry_cancel');assert s.cancel_request('geometry_cancel');t.join(2);conn.close();assert not t.is_alive();assert replies[-1]['type']=='cancelled';assert not s.active_requests and not s.request_lock.locked()
s.calculate_zone_layout=lambda payload,state:dict(status='ok')
s.request_lock.acquire()
conn,t=call({'type':'layout_zones','request_id':'geometry_busy','message':{}});t.join(2);conn.close();s.request_lock.release();assert replies[-1]['type']=='error';assert not s.active_requests
conn,t=call({'type':'layout_zones','request_id':'geometry_next','message':{}});t.join(2);conn.close();assert replies[-1]['type']=='answer';assert not s.active_requests and not s.request_lock.locked()
print('PASS: geometry transport success/error/busy/heartbeat/cancel and following request')
