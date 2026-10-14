"""Blank frames are inapplicable, not technical model errors."""
from pathlib import Path
from importlib.machinery import SourceFileLoader
import numpy as np
s=SourceFileLoader('frames',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
original_choose=s.choose_face;s.read_image=lambda path:np.zeros((100,100,3),np.uint8);s.choose_face=lambda *args,**kw:(None,'face_not_found');s.request_cancelled=lambda state:False
for name in ['classify_gender_crop','classify_head_crop','classify_body_image','classify_clothing_colors']:
 setattr(s,name,lambda *args:(_ for _ in ()).throw(AssertionError('model should not be called without face')))
answer=s.analyze_photo(dict(id=1,path='frame',gender=True,head_turn=True,color=True),{})
assert answer['gender']['sex']=='U' and answer['gender']['analysis_status']=='not_applicable'
assert answer['head_turn']['analysis_status']=='not_applicable' and answer['color']['analysis_status']=='uncertain'
model=Path(__file__).resolve().parents[3]/'checks/face.onnx'
if model.exists():
 s.FACE_MODEL_PATH=str(model)
 for color in [(0,0,255),(0,255,0),(255,0,0),(50,50,50),(240,240,240)]:
  frame=np.full((300,200,3),255,np.uint8);s.cv2.rectangle(frame,(12,12),(188,288),color,10);assert original_choose(frame,with_region=True)[0] is None
 print('PASS: genuine YuNet does not detect faces in five coloured rectangular frames')
s.analysis_pool.shutdown()
print('PASS: no-face status envelope, unknown gender/pose/palette, no downstream inference')
