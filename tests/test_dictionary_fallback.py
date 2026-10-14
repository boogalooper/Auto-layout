"""Decision policy without native DuckDB; dependency fallback tested separately."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import types
s=SourceFileLoader('dictionary_policy',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
records={('names','Иван'):{'gender':'m','count':1000},('names','Мария'):{'gender':'f','count':1000},('names','Саша'):{'gender':'u','count':100},('names','Анна'):{'gender':'f','count':1000},('surnames','Иванов'):{'gender':'m','count':1000},('surnames','Иванова'):{'gender':'f','count':1000},('midnames','Иванович'):{'gender':'m','count':500},('midnames','Ивановна'):{'gender':'f','count':500}}
s.get_russian_names=lambda:object();s.russian_name_record=lambda kind,t:records.get((kind,t.title()))
for name,sex in [('Мария','F'),('Иван','M'),('Иванова Мария','F'),('Мария Иванова','F'),('Иванова Саша','F'),('Саша Иванович','M'),('Саша','U'),('Мария Иванович','U'),('Иванов Мария','U'),('Мария Анна','U'),('Иванов Иван Иванова Мария','U')]:
 answer=s.classify_name_dictionary(name);assert answer['sex']==sex,(name,answer)
assert s.classify_name_dictionary('Иванова') is None
s.analysis_pool.shutdown()
print('PASS: firstname alone, both FIO orders, patronymic/surname disambiguation, conflicts, multiple names and surname-only refusal')
