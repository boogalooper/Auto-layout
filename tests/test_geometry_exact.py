"""Independent global permutation/partition oracle for small multi-zone jobs."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import types,sys,itertools,math,random
sys.modules['cv2']=types.ModuleType('cv2');sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
s=SourceFileLoader('geometry_checks',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module();s.request_cancelled=lambda state:False
rng=random.Random(84)
def oracle(p):
 best=0;n=len(p['items']);gx=p['baseGapX'];gy=p['baseGapY']
 for order in itertools.permutations(p['items']):
  for boundaries in range(1<<(n-1)):
   rows=[];start=0
   for i in range(n):
    if i==n-1 or boundaries&(1<<i):rows.append(order[start:i+1]);start=i+1
   if p['rows'] and len(rows)!=p['rows']:continue
   for split in range(1,len(rows)):
    scale=math.inf
    for z,group in zip(p['zones'],(rows[:split],rows[split:])):
     scale=min(scale,(z['bottom']-z['top'])/(sum(max(i['height'] for i in row) for row in group)+gy*(len(group)-1)))
     for row in group:scale=min(scale,(z['right']-z['left'])/(sum(i['width'] for i in row)+gx*(len(row)-1)))
    best=max(best,scale)
 return best
for case in range(8):
 p=dict(items=[dict(id=i,width=rng.randrange(70,180),height=rng.randrange(110,250)) for i in range(5)],zones=[dict(left=0,top=0,right=350,bottom=600,componentIndex=0),dict(left=600,top=50,right=1050,bottom=550,componentIndex=1)],baseGapX=9.,baseGapY=7.,maxGapMultiplier=3,rows=0 if case%2 else 3,horizontalAlign='center',rowRhythm='auto')
 q=s.calculate_zone_layout(p,{});assert q['status']=='ok' and not q['budgetExhausted'];expected=oracle(p);assert abs(q['commonScale']-expected)<1e-9,(case,q['commonScale'],expected)
 repeat=s.calculate_zone_layout(p,{});assert q['rows']==repeat['rows'] and q['placements']==repeat['placements'] and q['searchSteps']==repeat['searchSteps']
# Overlapping rectangular zones are rejected before any placement work.
p['zones'][1].update(left=100,top=100)
try:s.calculate_zone_layout(p,{});raise AssertionError('overlap accepted')
except ValueError:pass
s.analysis_pool.shutdown()
print('PASS: 8 heterogeneous five-photo cases equal global permutation/partition oracle at <1e-9 scale error, repeatable rows/coordinates/searchSteps, invalid zone overlap')
