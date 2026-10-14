from importlib.machinery import SourceFileLoader
from pathlib import Path
from concurrent.futures import Future
import time, statistics, json, argparse
parser=argparse.ArgumentParser(description="Compare warmed sequential and parallel native analysis, checking output parity.")
parser.add_argument("--models-dir",type=Path,required=True)
parser.add_argument("--repeats",type=int,default=6)
parser.add_argument("photos",nargs="+",type=Path)
args=parser.parse_args()
if args.repeats < 1: parser.error("--repeats must be positive")
s=SourceFileLoader('benchmark_server',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
for attr,name in [('FACE_MODEL_PATH','face.onnx'),('GENDER_MODEL_PATH','gender.onnx'),('HEAD_MODEL_PATH','face_landmarker.task'),('BODY_MODEL_PATH','pose_landmarker_full.task')]:setattr(s,attr,str((args.models_dir/name).resolve()))
def analyze(p):
 state=s.register_active_request("benchmark")
 try:return s.analyze_photo(p,state)
 finally:s.unregister_active_request("benchmark")
class SerialPool:
 def submit(self, fn):
  f=Future()
  try:f.set_result(fn())
  except BaseException as e:f.set_exception(e)
  return f
pool=s.analysis_pool
payloads=[dict(id=i,path=str(p.resolve()),gender=True,head_turn=True,color=True) for i,p in enumerate(args.photos)]
# Load once. Alternate order to reduce drift; compare all returned feature fields.
for p in payloads:analyze(p)
times={'serial':[],'parallel':[]};results={}
for repeat in range(args.repeats):
 for name in (['serial','parallel'] if repeat%2==0 else ['parallel','serial']):
  s.analysis_pool=SerialPool() if name=='serial' else pool
  t=time.perf_counter();answers=[analyze(p) for p in payloads];times[name].append(time.perf_counter()-t)
  if 'baseline' not in results:results['baseline']=answers
  assert answers==results['baseline'], (name,repeat,'result mismatch')
print(json.dumps({'seconds_for_three_photos':{k:round(statistics.median(v),4) for k,v in times.items()},'speedup':round(statistics.median(times['serial'])/statistics.median(times['parallel']),3),'output_parity':True,'opencv_threads':s.cv2.getNumThreads()}))
pool.shutdown()
