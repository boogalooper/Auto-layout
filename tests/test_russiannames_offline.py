"""Real packaged dictionaries: no network, no environment-dependent data path."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import socket,os,time,threading
s=SourceFileLoader('offline_names',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
# Any attempted network connection is a test failure. Local parquet files only.
socket.create_connection=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('network attempted'))
socket.socket.connect=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('network attempted'))
os.environ['RUSSIANNAMES_DATA_DIR']='/deliberately-missing-data-directory'
start=time.perf_counter()
for name,sex in [('Ахмедова Амина','F'),('Амина','F'),('Константин','M'),('Молодцов Константин','M'),('Мария Неизвестнаяфамилия','F'),('Литвиновская Мария','F'),('Иванов Иван Иванович','M'),('Иванова Мария Ивановна','F'),('Саша Иванова','F'),('Саша Иванович','M'),('Саша','U'),('Иванов Мария','U'),('Иванов Иван Петрова Мария','U'),('Анна Мария','U')]:
 answer=s.classify_name(name);assert answer['sex']==sex,(name,answer)
print('First dictionary pass: %.3fs'%(time.perf_counter()-start))
assert s.classify_name('Мария')['name_engine']=='russiannames'
assert s.classify_name('Иванова')['sex']=='U'
errors=[]
def query():
 try:
  for i in range(100):assert s.classify_name('Ахмедова Амина')['sex']=='F'
 except Exception as e:errors.append(e)
threads=[threading.Thread(target=query) for _ in range(4)]
for t in threads:t.start()
for t in threads:t.join(5);assert not t.is_alive()
assert not errors
# Missing optional dictionary preserves the existing morphological pipeline.
store=s.russian_names_store;s.russian_names_store=None;s.russian_names_attempted=True
answer=s.classify_name('Иванов Иван');assert answer['sex']=='M' and answer['name_engine']=='pymorphy3'
s.russian_names_store=store;s.russian_name_record.cache_clear()
# A broken query also falls back without breaking other server features.
original=s.russian_name_record
s.russian_name_record=lambda *args:(_ for _ in ()).throw(RuntimeError('test dictionary error'))
s.russian_name_record.cache_clear=lambda:None
answer=s.classify_name('Иванов Иван');assert answer['sex']=='M' and answer['name_engine']=='pymorphy3'
s.russian_name_record=original;s.analysis_pool.shutdown()
print('PASS: genuine russiannames offline, names/FIO/patronymics/unisex/conflicts, bundled path ignores environment, concurrent cached queries and missing/broken dictionary fallback')
