"""Numerical pose and combined-pipeline tests; no downloaded models needed."""
import sys,types,importlib.util,importlib.machinery,math,time,logging
logging.disable(logging.CRITICAL)
from pathlib import Path
import numpy as np
sys.modules['cv2']=types.ModuleType('cv2')
sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
loader=importlib.machinery.SourceFileLoader('auto_layout_head',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'))
s=importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name,loader));loader.exec_module(s)
def matrix(yaw,pitch,roll):
    y,p,r=map(math.radians,(yaw,pitch,roll))
    rx=np.array([[1,0,0],[0,math.cos(p),-math.sin(p)],[0,math.sin(p),math.cos(p)]])
    ry=np.array([[math.cos(y),0,math.sin(y)],[0,1,0],[-math.sin(y),0,math.cos(y)]])
    rz=np.array([[math.cos(r),-math.sin(r),0],[math.sin(r),math.cos(r),0],[0,0,1]])
    a=np.eye(4);a[:3,:3]=1.6*rz@ry@rx;a[:3,3]=[4,-3,-30];return a
count=0
for yaw in [-75,-40,-10,0,10,40,75]:
 for pitch in [-35,0,35]:
  for roll in [-40,0,40]:
   actual=s.pose_from_matrix(matrix(yaw,pitch,roll));assert np.allclose(actual,[yaw,pitch,roll],atol=1e-8),actual;count+=1
for bad in [np.zeros((4,4)),np.ones((3,3)),matrix(0,0,0)*float('nan')]:
 try:s.pose_from_matrix(bad);raise AssertionError('invalid matrix accepted')
 except ValueError:pass
bad=matrix(0,0,0);bad[0,0]*=-1
try:s.pose_from_matrix(bad);raise AssertionError('reflected matrix accepted')
except ValueError:pass
# Same image read/crop reused for two features; errors/cancel stay independent.
calls=[]
s.read_image=lambda path: calls.append('read') or np.zeros((100,100,3),np.uint8)
s.choose_face=lambda img, **kwargs: (calls.append('crop') or (img,.9),None)
s.classify_gender_crop=lambda crop,score,*args: calls.append('gender') or {'sex':'M','source':'image','confidence':.9,'analysis_status':'ok'}
s.classify_head_crop=lambda crop, *args: calls.append('head') or s.head_result('ok','head_pose',turn=35.)
state=s.register_active_request('test');answer=s.analyze_photo({'id':9,'path':'mock.jpg','gender':True,'head_turn':True},state);assert calls[:2]==['read','crop'] and sorted(calls[2:])==['gender','head'];assert answer['id']==9 and answer['head_turn']['turn']==35
calls.clear();s.cancel_request('test');s.analyze_photo({'id':9,'path':'mock.jpg','gender':True,'head_turn':True},state);assert 'gender' not in calls and 'head' not in calls
s.unregister_active_request('test')
state=s.register_active_request('partial');s.classify_gender_crop=lambda *args: (_ for _ in ()).throw(RuntimeError('mock gender failed'));answer=s.analyze_photo({'id':9,'path':'mock.jpg','gender':True,'head_turn':True},state);assert answer['gender']['analysis_status']=='technical_failure';assert answer['head_turn']['analysis_status']=='ok';s.unregister_active_request('partial')
print('PASS:',count,'yaw/pitch/roll rotations, matrix validation, single read/crop, cancellation and independent model failures')
# Test the actual new head wrapper, independently of the mocked transport path.
l2=importlib.machinery.SourceFileLoader('head_mirror_tests',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'));h=importlib.util.module_from_spec(importlib.util.spec_from_loader(l2.name,l2));l2.exec_module(h)
sys.modules['cv2'].flip=lambda image,axis:image[:,::-1].copy()
answers=iter([h.head_result('ok','head_pose',turn=20,yaw_degrees=20,pitch_degrees=5,roll_degrees=3),h.head_result('ok','head_pose',turn=-22,yaw_degrees=-22,pitch_degrees=6,roll_degrees=-4)])
h.classify_head_once=lambda image:next(answers)
r=h.classify_head_crop(np.zeros((80,80,3),np.uint8));assert r['turn']==21 and r['head_mirror_difference']==2
answers=iter([h.head_result('ok','head_pose',turn=40,yaw_degrees=40,pitch_degrees=0,roll_degrees=0),h.head_result('ok','head_pose',turn=30,yaw_degrees=30,pitch_degrees=0,roll_degrees=0)])
r=h.classify_head_crop(np.zeros((80,80,3),np.uint8));assert r['analysis_status']=='uncertain' and r['head_mirror_difference']==70
answers=iter([h.head_result('ok','head_pose',turn=20,yaw_degrees=20,pitch_degrees=0,roll_degrees=0)])
r=h.classify_head_crop(np.zeros((80,80,3),np.uint8),lambda:True);assert r['reason']=='head_cancelled'
print('PASS: head mirrored sign, averaging, disagreement diagnostics and cancellation')
answers=iter([h.head_result('ok','head_pose',turn=6,yaw_degrees=6,pitch_degrees=5,roll_degrees=3),h.head_result('ok','head_pose',turn=-6,yaw_degrees=-6,pitch_degrees=5,roll_degrees=-3)])
r=h.classify_head_crop(np.zeros((80,80,3),np.uint8));assert r['turn']==6
print('PASS: mirror-confirmed 6-degree yaw is retained')
