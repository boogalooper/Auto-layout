"""Run standalone with real OpenCV/NumPy; no downloaded models required."""
import importlib.util, importlib.machinery, logging, sys, types
logging.disable(logging.CRITICAL)
from pathlib import Path
import numpy as np
sys.modules.setdefault('pymorphy3',types.ModuleType('pymorphy3'))
loader=importlib.machinery.SourceFileLoader('auto_layout_color',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'))
s=importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name,loader));loader.exec_module(s)
def portrait(color, caption=True):
    img=np.full((500,300,3),180,np.uint8)
    img[220:390,80:220]=color
    if caption:
        img[400:]=255
        img[430:440,100:200]=0
    return img
region=(100,80,200,200)
for color in [(0,0,220),(220,0,0),(0,180,0),(255,255,255),(15,15,15),(30,120,220)]:
    img=portrait(color);result=s.classify_clothing_colors(img,region)
    assert result['analysis_status']=='ok',result
    dominant=np.array(result['palette'][0]['lab'],np.float32).reshape(1,1,3)
    rgb=s.cv2.cvtColor(dominant,s.cv2.COLOR_LAB2RGB)[0,0]*255
    assert np.max(np.abs(rgb-np.array(color[::-1])))<5,(color,rgb,result)
    assert result==s.classify_clothing_colors(img,region),'non-deterministic'
    assert abs(sum(p['weight'] for p in result['palette'])-1)<1e-5
    assert result['sample_count']<=2500
# Pattern proportions remain represented, and paper/names contribute no colour.
img=portrait((0,0,220));img[220:390,150:220]=(220,0,0)
a=s.classify_clothing_colors(img,region)
assert len(a['palette'])==2 and all(.25<p['weight']<.75 for p in a['palette']),a
img[430:440]=[0,255,0];b=s.classify_clothing_colors(img,region);assert a==b
assert s.classify_clothing_colors(img,None)['analysis_status']=='uncertain'
assert s.classify_clothing_colors(img,(100,450,200,499))['analysis_status']=='uncertain'
assert s.classify_clothing_colors(img,region,lambda:True)['analysis_status']=='uncertain'

# Regression: broad white clothes/background immediately below the face are not
# mistaken for the caption separator. The old first-white-run rule cropped the
# ROI at the start of the white garment here and returned color_clothing_outside_image.
white=np.full((500,300,3),255,np.uint8)
white[:260]=180
white[80:200,100:200]=[160,160,160]
white_result=s.classify_clothing_colors(white,region)
assert white_result['analysis_status']=='ok',white_result
assert s.detect_caption_top(white,region) is None
# A genuine transition from photo content to a full-width white footer is kept.
footer=portrait((0,0,220));assert s.detect_caption_top(footer,region)==400
# Combined analysis reads/crops once, and a colour error keeps gender/head valid.
counts={'read':0,'face':0}
def read(path):counts['read']+=1;return img
def face(image,**kwargs):counts['face']+=1;return (img[:100,:100],.99,region),None
s.read_image=read;s.choose_face=face;s.request_cancelled=lambda state:False
s.classify_gender_crop=lambda *args:dict(analysis_status='ok',sex='F',confidence=.9)
s.classify_head_crop=lambda *args:dict(analysis_status='ok',turn=30)
s.classify_body_image=lambda *args:dict(analysis_status='uncertain')
def fail(*args):raise RuntimeError('synthetic color failure')
s.classify_clothing_colors=fail
answer=s.analyze_photo(dict(id=1,path='mock',gender=True,head_turn=True,color=True),{})
assert counts=={'read':1,'face':1};assert answer['color']['analysis_status']=='technical_failure';assert answer['gender']['sex']=='F';assert answer['head_turn']['analysis_status']=='ok'
print('PASS: real Lab extraction, dominant colours incl white/black/orange, deterministic weighted patterns, footer exclusion, uncertainty/cancellation, one read/crop and independent model failures')
