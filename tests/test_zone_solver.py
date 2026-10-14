"""Pure geometry tests and JSON bridge fixture generator; run standalone."""
import sys,types,importlib.util,importlib.machinery,json,math,time
from pathlib import Path
sys.modules['cv2']=types.ModuleType('cv2');sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
l=importlib.machinery.SourceFileLoader('zone_solver',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'))
s=importlib.util.module_from_spec(importlib.util.spec_from_loader(l.name,l));l.exec_module(s)
s.request_cancelled=lambda state:False
if '--solve' in sys.argv:
    print(json.dumps([s.calculate_zone_layout(p,{}) for p in json.load(sys.stdin)],allow_nan=False));sys.exit()
def payload(n,zone_sizes=((400,600),(700,600)),fixed=0):
    zones=[];left=0
    for i,(w,h) in enumerate(zone_sizes):
        zones.append(dict(left=left,top=0,right=left+w,bottom=h,componentIndex=i));left+=w+150
    return dict(items=[dict(id=i+1,width=100,height=140) for i in range(n)],zones=zones,rows=fixed,baseGapX=8.4,baseGapY=8.4,maxGapMultiplier=3,horizontalAlign='center',rowRhythm='auto')
def verify(p,q):
    assert q['status']=='ok',q
    scale=q['commonScale'];ids=[x['id'] for x in q['placements']]
    assert sorted(ids)==sorted(x['id'] for x in p['items']);assert all(x['scale']==scale for x in q['placements'])
    used=set()
    for row in q['rows']:
        z=p['zones'][row['zoneIndex']];used.add(z['componentIndex'])
        it=[next(i for i in p['items'] if i['id']==id_) for id_ in row['ids']]
        assert sum(i['width'] for i in it)*scale+row['gapX']*(len(it)-1)<=z['right']-z['left']+1e-6
        assert row['top']>=z['top']-1e-6 and row['top']+max(i['height'] for i in it)*scale<=z['bottom']+1e-6
    if len(p['items'])>=len(p['zones']):assert len(used)==len(p['zones'])
    if p['rows']:assert len(q['rows'])==p['rows']
# Independent capacity oracle for equal rectangles in auto mode.
for n in [2,3,7,12,21,40]:
    p=payload(n);q=s.calculate_zone_layout(p,{});verify(p,q)
    def capacity(scale,w,h):
        columns=math.floor((w/scale+p['baseGapX'])/(100+p['baseGapX'])+1e-9)
        rows=math.floor((h/scale+p['baseGapY'])/(140+p['baseGapY'])+1e-9)
        return columns*rows
    low,high=0,4
    for _ in range(45):
        scale=(low+high)/2;caps=[capacity(scale,w,h) for w,h in [(400,600),(700,600)]]
        if all(caps) and sum(caps)>=n:low=scale
        else:high=scale
    assert abs(q['commonScale']-low)<1e-5,(n,q['commonScale'],low)
for rows in [2,3,5,8]:verify(payload(12,fixed=rows),s.calculate_zone_layout(payload(12,fixed=rows),{}))
p=payload(15);p['items']=[dict(id=i+1,width=70+(i*17)%60,height=100+(i*23)%80) for i in range(15)]
for align in ['left','right','center','justify']:
 p['horizontalAlign']=align;verify(p,s.calculate_zone_layout(p,{}))
assert s.calculate_zone_layout(p,{},time_budget=-1)['status']=='fallback'
s.request_cancelled=lambda state:True
try:s.calculate_zone_layout(p,{});raise AssertionError('cancel ignored')
except InterruptedError:pass
s.request_cancelled=lambda state:False
for mutate in [lambda p:p['items'][0].update(width=float('nan')),lambda p:p['items'][0].update(id=p['items'][1]['id']),lambda p:p.update(rows=-1),lambda p:p['zones'][0].update(right=-1)]:
 p=payload(3);mutate(p)
 try:s.calculate_zone_layout(p,{});raise AssertionError('invalid payload accepted')
 except ValueError:pass
p=payload(100);start=time.monotonic();q=s.calculate_zone_layout(p,{});verify(p,q)
print('PASS: exact equal-rectangle capacity oracle, fixed rows, unequal sizes/all alignments, finite coordinates/IDs/containment/components, cancellation, budget and invalid inputs; 100 children %.3fs'%(time.monotonic()-start))
