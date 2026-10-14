"""Actual OpenCV colour/preprocessing with controlled model outputs."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import numpy as np
s=SourceFileLoader('analysis_checks',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
class Net:
 def __init__(self,results):self.results=iter(results);self.inputs=[]
 def setInput(self,blob):self.inputs.append(blob.copy())
 def forward(self):return np.array(next(self.results),np.float32)
image=np.zeros((90,100,3),np.uint8);image[:,:,0]=np.arange(100,dtype=np.uint8)
for outputs,status,sex in [([[.95,.05],[.94,.06]],'ok','M'),([[.05,.95],[.06,.94]],'ok','F'),([[.95,.05],[.05,.95]],'uncertain','U'),([[.99,.01],[.75,.25]],'uncertain','U'),([[.75,.25],[.74,.26]],'uncertain','U'),([[float('nan'),.1],[.9,.1]],'technical_failure','U')]:
 net=Net(outputs);s.get_gender_net=lambda:net;r=s.classify_gender_crop(image,.99);assert (r['analysis_status'],r['sex'])==(status,sex),r
 assert len(net.inputs)==2 and net.inputs[0].shape==(1,3,224,224)
 assert np.allclose(net.inputs[0][:,:,:,::-1],net.inputs[1],atol=.002)
assert s.classify_gender_crop(image[:30],.99)['sex']=='U'
# Original/mirrored normalized head signs +6/-6 must not average to a false zero.
answers=iter([s.head_result('ok','test',yaw_degrees=6,pitch_degrees=0,roll_degrees=0),s.head_result('ok','test',yaw_degrees=6,pitch_degrees=0,roll_degrees=0)])
s.classify_head_once=lambda img:next(answers);assert s.classify_head_crop(image)['reason']=='head_mirror_disagreement'
# Full-height stratified sampling sees both halves, even when sample size is capped.
img=np.full((700,400,3),170,np.uint8);img[220:450,110:290]=(0,0,230);img[335:450,110:290]=(230,0,0);img[480:]=255
region=(150,100,250,200);r=s.classify_clothing_colors(img,region)
assert r['analysis_status']=='ok' and len(r['palette'])==2,r
for picture in [img,s.cv2.flip(img,1),s.cv2.resize(img,None,fx=1.4,fy=1.4,interpolation=s.cv2.INTER_NEAREST)]:
 factor=picture.shape[1]/400;box=tuple(v*factor for v in region);q=s.classify_clothing_colors(picture,box)
 a=sorted(r['palette'],key=lambda p:p['lab'][2]);b=sorted(q['palette'],key=lambda p:p['lab'][2]);assert len(a)==len(b)
 assert all(np.linalg.norm(np.array(x['lab'])-y['lab'])<3 and abs(x['weight']-y['weight'])<.04 for x,y in zip(a,b)),(r,q)
# Random single-pixel outliers must not consume dominant palette clusters.
rng=np.random.default_rng(31);noisy=img.copy();ys=rng.integers(230,450,80);xs=rng.integers(130,270,80);noisy[ys,xs]=rng.integers(0,256,(80,3),dtype=np.uint8)
q=s.classify_clothing_colors(noisy,region);assert len(q['palette'])==2,q
s.analysis_pool.shutdown()
print('PASS: real OpenCV mirrored gender tensors, agreement/weak/disagree/invalid abstention, head sign conflict, colour mirror/resize/noise stability and uniform capped sampling')

# User screenshot: white blouse vs black pinafore with white collar.
# Optional local regression input, not bundled with the project.
photo_path=Path(__file__).resolve().parents[3]/'upload/Screenshot 2026-10-13 222326.png'
model_path=Path(__file__).resolve().parents[3]/'checks/face.onnx'
if photo_path.exists() and model_path.exists():
 s.FACE_MODEL_PATH=str(model_path);frame=s.read_image(str(photo_path))
 for column,light in [(0,True),(1,False),(2,False),(4,False),(5,False)]:
  picture=frame[10:119,20+column*97:108+column*97];selected,reason=s.choose_face(picture,with_region=True);assert selected is not None,reason
  result=s.classify_clothing_colors(picture,selected[2]);tone=result['palette'][0]['lab'][0]
  assert tone>70 if light else tone<60,(column,result)
 print('PASS: genuine YuNet on user screenshot, white blouse vs dark jackets/pinafores with white collars')

net=Net([[.95,.05]]);s.get_gender_net=lambda:net
assert s.classify_gender_crop(image,.99,lambda:True)['reason']=='gender_cancelled';assert len(net.inputs)==1
print('PASS: gender cancellation prevents second native inference')
