import sys,types,importlib.util,importlib.machinery,math,logging
from pathlib import Path
import numpy as np
logging.disable(logging.CRITICAL)
cv=types.ModuleType('cv2');cv.flip=lambda image,axis:image[:,::-1].copy();sys.modules['cv2']=cv;sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
l=importlib.machinery.SourceFileLoader('body_tests',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'));s=importlib.util.module_from_spec(importlib.util.spec_from_loader(l.name,l));l.exec_module(s)
def point(x,y,z):return types.SimpleNamespace(x=x,y=y,z=z)
for angle in [-60,-35,-10,0,10,35,60]:
 a=math.radians(angle);right=point(0,0,0);left=point(.3*math.cos(a),0,.3*math.sin(a));assert abs(s.body_yaw_from_shoulders(right,left)-angle)<1e-8
for left in [point(0,0,0),point(-.3,0,0),point(.3,.4,0),point(float('nan'),0,0)]:
 try:s.body_yaw_from_shoulders(point(0,0,0),left);raise AssertionError('invalid shoulders accepted')
 except ValueError:pass
head={'analysis_status':'ok','turn':-20,'method':'face_transform'};body={'analysis_status':'ok','body_yaw_degrees':40,'shoulder_visibility':.95}
r=s.combine_body_and_head(head,body);assert r['turn']==40 and r['body_weight']==1 and r['pose_conflict']
r=s.combine_body_and_head(head,{'analysis_status':'uncertain'});assert r['turn']==-20 and r['method']=='face_transform'
r=s.combine_body_and_head({'analysis_status':'uncertain'},body);assert r['turn']==40 and r['body_weight']==1
r=s.combine_body_and_head({'analysis_status':'ok','turn':0},dict(body,body_yaw_degrees=9));assert 0 < r['turn'] < 1 and 0 < r['body_strength'] < .2
# Mirror-check enforces sign consistency, one body frame in memory, face ROI transformed correctly.
calls=[];answers=iter([dict(body,body_yaw_degrees=40),dict(body,body_yaw_degrees=-36)])
def once(image,region):calls.append(region);return next(answers)
s.classify_body_once=once;r=s.classify_body_image(np.zeros((200,100,3),np.uint8),(10,20,30,60));assert r['body_yaw_degrees']==38 and calls==[(10,20,30,60),(70,20,90,60)]
answers=iter([dict(body,body_yaw_degrees=40),dict(body,body_yaw_degrees=30)]);r=s.classify_body_image(np.zeros((200,100,3),np.uint8));assert r['analysis_status']=='uncertain' and r['reason']=='body_mirror_disagreement'
answers=iter([body]);r=s.classify_body_image(np.zeros((200,100,3),np.uint8),cancel_check=lambda:True);assert r['reason']=='body_cancelled'
print('PASS: shoulder yaw/sign, body priority, head fallback, frontal tolerance, mirrored ROI/consistency and cancellation')
r=s.combine_body_and_head(dict(head,turn=10),body);assert r['turn']==31 and r['body_weight']==.7 and not r['pose_conflict']
r=s.combine_body_and_head(dict(head,turn=-70),dict(body,body_yaw_degrees=30));assert r['turn']==30 and r['pose_conflict']
print('PASS: clear opposed poses cannot cancel into false frontal; aligned poses retain 70/30 weighting')
r=s.combine_body_and_head({'analysis_status':'ok','turn':6},dict(body,body_yaw_degrees=0));assert abs(r['turn']-6)<1e-8 and r['body_weight']==0
# Around the former 12-degree cliff, tiny measurement changes remain tiny.
a=s.combine_body_and_head({'analysis_status':'ok','turn':6},dict(body,body_yaw_degrees=11.9))
b=s.combine_body_and_head({'analysis_status':'ok','turn':6},dict(body,body_yaw_degrees=12.0))
assert abs(a['turn']-b['turn']) < .25,(a,b)
assert 0 < a['body_strength'] < b['body_strength'] < 1
# Strong turns preserve the historical 70/30 blend; body-only weak turns fade smoothly.
c=s.combine_body_and_head({'analysis_status':'ok','turn':10},dict(body,body_yaw_degrees=18));assert abs(c['body_weight']-.7)<1e-8 and abs(c['turn']-15.6)<1e-8
d=s.combine_body_and_head({'analysis_status':'uncertain'},dict(body,body_yaw_degrees=11.9));e=s.combine_body_and_head({'analysis_status':'uncertain'},dict(body,body_yaw_degrees=12.0));assert abs(d['turn']-e['turn']) < .25
print('PASS: frontal body no longer suppresses retained head yaw; body influence is smooth around 12 degrees')
