"""Independent exhaustive feasible-partition oracle for row balancing."""
import sys,types,importlib.util,importlib.machinery
from pathlib import Path
sys.modules['cv2']=types.ModuleType('cv2');sys.modules['pymorphy3']=types.ModuleType('pymorphy3')
l=importlib.machinery.SourceFileLoader('row_balance',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw'));s=importlib.util.module_from_spec(importlib.util.spec_from_loader(l.name,l));l.exec_module(s)
def items(n):return [dict(id=i+1,width=100,height=140) for i in range(n)]
assert s.balanced_zone_counts(items(13),425.2,585.2,4,1,8.4,8.4,lambda:None)==[3,4,3,3]
def compositions(n,r):
 if r==1:return [[n]]
 return [[c]+rest for c in range(1,n-r+2) for rest in compositions(n-c,r-1)]
def score(cs):
 center=(len(cs)-1)/2-.1
 return (cs.count(1),sum(c*c for c in cs),round(sum(c*(i-center)**2 for i,c in enumerate(cs)),8))
checked=0
for n in range(4,13):
 for r in range(2,min(n,5)+1):
  for k in range(3):
   it=items(n)
   for i,x in enumerate(it):x.update(width=70+(i*17+k*3)%50,height=100+(i*29+k*11)%70)
   width,height=310+k*50,500+k*70
   def fits(cs):
    index=0;h=8.4*(r-1)
    for c in cs:
     row=it[index:index+c];index+=c
     if sum(x['width'] for x in row)+8.4*(c-1)>width+1e-9:return False
     h+=max(x['height'] for x in row)
    return h<=height+1e-9
   feasible=[cs for cs in compositions(n,r) if fits(cs)]
   if not feasible:continue
   out=s.balanced_zone_counts(it,width,height,r,1,8.4,8.4,lambda:None)
   if out is None:out=feasible[0]
   assert score(out)==min(map(score,feasible)),(n,r,k,out);checked+=1
s.request_cancelled=lambda state:False
payload=dict(items=items(26),zones=[dict(left=0,top=0,right=425.2,bottom=585.2,componentIndex=0),dict(left=600,top=0,right=1025.2,bottom=585.2,componentIndex=1)],baseGapX=8.4,baseGapY=8.4,maxGapMultiplier=3,horizontalAlign='center',rowRhythm='auto',rows=8)
result=s.calculate_zone_layout(payload,{})
for z in range(2):assert [len(r['ids']) for r in result['rows'] if r['zoneIndex']==z]==[3,4,3,3],result
payload.update(items=items(6),zones=[dict(left=0,top=0,right=100,bottom=460,componentIndex=0),dict(left=200,top=0,right=300,bottom=460,componentIndex=1)],rows=6)
result=s.calculate_zone_layout(payload,{})
assert all(len(r['ids'])==1 for r in result['rows']),result
try:s.balanced_zone_counts(items(13),425.2,585.2,4,1,8.4,8.4,lambda:(_ for _ in ()).throw(InterruptedError()));raise AssertionError('cancel ignored')
except InterruptedError:pass
print('PASS: %d exhaustive mixed-size partition cases, 26-child/two-zone 3/4/3/3, physically narrow singleton exception and cancellation'%checked)
