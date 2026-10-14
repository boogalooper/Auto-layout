"""Regression for rectangular body frames, request ownership and worker lifetime."""
import sys, types, importlib.util, importlib.machinery, threading, socket, json, logging
from pathlib import Path
import numpy as np
logging.disable(logging.CRITICAL)
cv=types.ModuleType('cv2');cv.COLOR_BGR2RGB=1;cv.cvtColor=lambda img,code:img
sys.modules['cv2']=cv;sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
mp=types.ModuleType('mediapipe');mp.Image=lambda **kw:kw;mp.ImageFormat=types.SimpleNamespace(SRGB=1);sys.modules['mediapipe']=mp
loader=importlib.machinery.SourceFileLoader('audit',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'))
s=importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name,loader));loader.exec_module(s)
def point(x,y,z=0):return types.SimpleNamespace(x=x,y=y,z=z,visibility=.95,presence=.95)
screen=[point(.5,.2) for _ in range(13)];screen[11]=point(.4,.4);screen[12]=point(.5,.6)
world=[point(0,0) for _ in range(13)];world[11]=point(.3,0,.1)
result=types.SimpleNamespace(pose_landmarks=[screen],pose_world_landmarks=[world])
s.BODY_MODEL_PATH=__file__;s.get_body_landmarker=lambda:types.SimpleNamespace(detect=lambda img:result)
assert s.classify_body_once(np.zeros((300,100,3),np.uint8))['analysis_status']=='ok'
assert s.classify_body_once(np.zeros((100,100,3),np.uint8))['reason']=='shoulders_too_small'
# Duplicate socket request must never replace/unregister the running request.
state=s.register_active_request('same');replies=[];s.send_data_to_jsx=lambda answer:replies.append(answer)
a,b=socket.socketpair();a.sendall((json.dumps(dict(type='layout_zones',request_id='same',message={}))+'\n').encode());s.handle_client(b);a.close()
assert replies[-1]['type']=='error' and s.active_requests['same'] is state
assert s.heartbeat_request('same') and s.cancel_request('same') and state['cancel'].is_set();s.unregister_active_request('same')
# Both independent models start, and cancellation cannot release the image early.
s.read_image=lambda path:np.zeros((200,100,3),np.uint8);s.choose_face=lambda img,**kw:((img,.9),None)
head_started=threading.Event();body_started=threading.Event();release=threading.Event();finished=threading.Event()
def head(*args):
 head_started.set();assert release.wait(2);return s.head_result('ok','test',turn=30.)
def body(*args):
 body_started.set();assert release.wait(2);return dict(analysis_status='ok',body_yaw_degrees=30.,shoulder_visibility=.95)
s.classify_head_crop=head;s.classify_body_image=body
state=s.register_active_request('workers');answers=[]
def run():
 try:answers.append(s.analyze_photo(dict(id=1,path='mock',head_turn=True),state))
 finally:finished.set()
t=threading.Thread(target=run);t.start();assert head_started.wait(1) and body_started.wait(1)
s.cancel_request('workers');assert not finished.wait(.02);release.set();t.join(2);assert not t.is_alive() and answers[0]['head_turn'] is None
s.unregister_active_request('workers')
# A failed body model retains the successful head estimate.
s.classify_body_image=lambda *args:(_ for _ in ()).throw(RuntimeError('body failed'))
state=s.register_active_request('partial');answer=s.analyze_photo(dict(id=2,path='mock',head_turn=True),state)
assert answer['head_turn']['turn']==30 and answer['head_turn']['analysis_status']=='ok';s.unregister_active_request('partial')
s.analysis_pool.shutdown()
print('PASS: non-square shoulder pixel threshold, duplicate request ownership, simultaneous model execution, cancellation drains workers, independent body failure')
