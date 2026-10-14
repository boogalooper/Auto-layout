"""Real dictionary: nominative surnames must not become masculine genitives."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
s=SourceFileLoader('name_regression',str(Path(__file__).resolve().parent.parent/'Photoshop-files/lib/auto-layout-api.pyw')).load_module()
for name,sex in [('Ахмедова Амина','F'),('Амина Ахмедова','F'),('Лунькова Таисия','F'),('Евдокимов Руслан','M'),('Литвиновская Мария','F'),('Шуйкина Анна','F'),('Лозягин Тимофей','M'),('Макаров Кирилл','M'),('Агеев Тимофей','M'),('Рубцова Ангелина','F'),('Аксёнова Анна','F'),('Иванова Мария','F'),('Иванов Никита','M'),('Иванов Илья','M')]:
 answer=s.classify_name(name);assert answer['sex']==sex,(name,answer)
assert s.classify_name('Ахмедова Амин')['sex']=='U'
assert s.classify_name('без имени')['sex']=='U'
s.analysis_pool.shutdown()
print('PASS: actual pymorphy3, nominative surname/name agreement, Амина vs masculine Амин, male Илья/Никита and safe unknown/conflict fallback')

assert s.classify_name('Молодцов Константин')['sex']=='M'
assert s.classify_name('Молодцов Мария')['sex']=='U'
assert s.classify_name('Иванов Иван Петрова Мария')['sex']=='U'
assert s.classify_name('Анна Мария')['sex']=='U'
print('PASS: strong given name confirms missing Молодцов surname; contradicting, double-identity and two-given-name labels stay unknown')
