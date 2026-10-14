# Auto Layout для Photoshop — контекст проекта 0.10.9

В 0.10.9 одиночные shape-слои сохраняют исходный тип; группы и linked-наборы по-прежнему становятся Smart Object. Для рамок/нефотографических слоёв добавлен empty-breaker: после трёх подряд валидных ответов без полезного пола/позы/палитры покадровый Python-анализ и Python-packing прекращаются до конца запуска, а геометрия продолжается в JSX. Пол, уже найденный по имени, сохраняется.

# Изменения 0.10.9 — входные слои и no-data fallback

- Самостоятельные `layerKind 1/4/5` (pixel/shape/Smart Object) раскладываются напрямую. Shape больше не является причиной запуска preparation/conversion.
- Preparation остаётся только для групп и linked closure; такие наборы конвертируются в Smart Object временно для анализа и повторно внутри единого итогового History шага.
- Новый глобальный для запуска счётчик `semanticImageEmptyStreak`: если три подряд `analyze_image` дали только валидные пустые результаты по всем реально запрошенным признакам, выставляется `semanticImageAnalysisDisabledForRun` и `packingDisabledForRun`.
- Технический сбой не считается «пустым кадром» и обрабатывается прежними feature-breaker'ами. Любой полезный image-result сбрасывает empty streak.
- После no-data fallback новые превью не создаются. Уже полученный `gender_names` не стирается; поэтому JSX может продолжить М/Д по имени, но новых Python-вызовов и Python-packing больше нет.

# Изменения 0.10.8 — устойчивость позы и цвета

- Head yaw после зеркальной проверки: значения <2° нейтральны, от 2° сохраняются.
- Body yaw больше не имеет hard cutoff 12°. `body_turn_strength` = smoothstep по модулю yaw в диапазоне 6–18°. При body=0 надёжная голова получает 100% веса; при сильном body плавно восстанавливается 70/30. Противоположные направления усиливают приоритет корпуса через непрерывный conflict strength.
- Если голова недоступна, слабый body yaw плавно затухает к 0. Если корпус недоступен/uncertain, рабочая оценка головы остаётся без изменений.
- Поиск белого footer требует реального перехода в устойчивую полноширинную белую область. Белый run, уже идущий непосредственно под лицом, не используется как граница. При сомнении footer не режется.

# Изменения 0.10.7 — выравнивание интерфейса

- Панели используют одинаковые отступы и растягивают содержимое по ширине.
- Поле количества рядов и два списка в «Раскладке» начинаются на одной линии и заполняют оставшуюся ширину.
- Все три ползунка заполняют ширину панели; значения выровнены по её правому краю.
- Список цвета и пояснения используют всю доступную ширину.
- Логика раскладки, симметрия и цветовые режимы 0.10.6 не изменены. Версия сервера синхронизирована с JSX для штатного handshake.

Проверены синтаксис и существующая модель диалога/сохранения настроек. Настоящий ScriptUI Photoshop здесь недоступен, поэтому визуальная проверка в Photoshop не выполнена.

Обновление: заменить JSX и lib/auto-layout-api.pyw. Повторная установка runtime не требуется.



## Актуальные изменения 0.10.6 — симметрия рядов и цвет по всему листу

- При невозможности строгого М/Д-черёдования выбирается симметричный порядок с минимальным числом одинаковых соседей. Для 4 М + 2 Д — МДММДМ; для 2 М + 4 Д — ДМДДМД. ММДДММ не выбирается, когда доступен симметричный вариант с меньшим количеством повторов.
- Для известных полов шаблон ряда рассчитывается динамическим программированием по зеркальным парам: минимум повторов → минимум несовпадающих зеркальных пар → близость меньшинства к центру. Учитываются все допустимые сочетания при заданной квоте, результат кэшируется. Если полная симметрия невозможна по количествам, выбирается минимальная асимметрия. Сбалансированные ряды продолжают строго чередоваться. Для неопределённого пола остаётся ограниченное локальное улучшение без выдумывания М/Д.
- Квоты между рядами и итоговый semantic optimizer учитывают новую симметрию. Порядок приоритетов итоговой расстановки: геометрия → минимум повторов/максимум известных чередующихся пар → симметрия несбалансированных рядов → центральность меньшинства → межрядное чередование → поза. Итоговый оптимизатор проверяет также обратные варианты и обмены между рядами. При разных размерах фотографий допустимость каждой перестановки проверяется геометрически.
- Одинаковая семантическая обработка выполняется после геометрии JSX и после декодирования геометрии Python. Python не имеет второй независимой реализации пола/цвета; расстановка идёт через общий JSX-оптимизатор. Единый масштаб, интервалы, число фотографий в рядах и проверка выделения сохранены.
- В списке цвета: «Не учитывать», «Согласованные цвета», «Максимальный контраст». Согласование уменьшает различие палитр у соседей; контраст увеличивает. Оба режима оценивают весь лист по фактическим координатам: ближайший справа на той же линии и ближайший ниже; вес горизонтального соседства 1, нижнего 0.5. Обмены возможны между любыми рядами и площадками, а не только внутри ряда. Неизвестная палитра не подменяется цветом.
- Глобальная начальная сортировка для согласования — лишь кандидат; окончательный критерий — близость палитр соседей, а не направление светлое/тёмное. Для больших наборов каждый объект участвует в поиске с распределёнными по всему листу партнёрами (16 на проход), до 8 проходов. Это ограниченный поиск, без гарантии абсолютного глобального минимума/максимума всех перестановок.
- Цвет больше не требует математически неизменной стоимости позы. В каждой позиции допустим портрет с эффективным поворотом в пределах 12° от исходного, наклоном в пределах 8°, с тем же статусом достоверности. Все сравнения идут с исходным результатом расстановки по позе, поэтому допуски не накапливаются от обмена к обмену. Портрет с выраженным поворотом (от 12°), направленным внутрь, не переносится на сторону, где он будет смотреть наружу. Геометрия и показатели М/Д, симметрии, центральности и межрядного чередования не ухудшаются ради цвета. Порог — композиционная настройка, а не оценка точности модели.
- Прежние четыре направления цвета в настройках и экшенах переходят в «Согласованные цвета». «Максимальный контраст» и «Не учитывать» сохраняются. UUID экшена и зависимости прежние. Серверу обновлён номер версии для штатного перезапуска; анализ изображений/модели не изменены.

Проверено: 16 JSX-наборов проходят; 7 Python-наборов без дополнительных зависимостей проходят. Новые проверки: 50 сочетаний количеств против полного перебора всех строк длиной до 12; итоговые симметричные ряды с позой/без неё; настоящая геометрия Python и JSX для двух островов с рядами МДММДМ; оба режима цвета между рядами и островами, полезные обмены при близкой позе, защита сильных поворотов, участие всех 96 фото в ограниченном поиске; миграция/сохранение настроек. Существующие проверки History, подготовки групп/linked, Actions и отмены проходят на API-моделях. Синтаксис JSX/Python и кодировки проверены.

Ограничения: Photoshop/Windows здесь недоступны. Шесть Python-наборов анализа изображений/словарей не запустились из-за отсутствия cv2 в текущей среде; повторной проверки реальных моделей и палитр не было. Их код не менялся. Симметрия оценивается по порядку полов в ряду; при разных ширинах фото зеркальные расстояния могут отличаться. Для разных размеров и неопределённого пола общий поиск остаётся ограниченным. Исторические отчёты ниже относятся к прежним релизам.

Обновление с 0.10.4/0.10.5: заменить JSX и PYW из Photoshop-files. Повторная установка runtime не нужна, если зависимости 0.10.4 уже установлены.


## Предшествующий контекст

Правила 0.10.6 выше имеют приоритет над историческим описанием ниже.


## Назначение

Автоматически размещает выбранные пиксельные слои, shape-слои и смарт-объекты внутри ортогонального выделения Photoshop. Основной сценарий — школьные макеты. Выделение создаётся прямоугольными областями; допускаются L/U/C-формы, отверстия и несколько отдельных островов. Кривые/диагонали намеренно не поддерживаются.

## Пакет и runtime

```text
Auto-layout-v0.10.6/
  install_runtime.bat
  README.md
  CHANGES.md
  Photoshop-files/
    Auto-layout-v0.10.6.jsx
    lib/auto-layout-api.pyw
  tests/
```

Приватный runtime: `%LOCALAPPDATA%\JazzyScripts\AutoLayoutRuntime`.
Python и модели: `venv\Scripts\pythonw.exe`, `venv\models`.
Модели: `face.onnx`, `gender.onnx`, `face_landmarker.task`, `pose_landmarker_full.task`.
Launcher: `launcher.vbs`; marker: `runtime_version.txt`; журнал: `server.log` с ротацией 1 МБ и двумя резервными файлами.

Installer revision 4; russiannames 2.0.0 + DuckDB 1.4.4. CPython 3.11.16 x64 через uv 0.12.19; NumPy 1.26.4; OpenCV contrib 4.11.0.86; pymorphy3 2.0.6; русские словари 2.4.417150.4580142; dawg2-python 0.9.0; MediaPipe 0.10.21; JAX/JAXLIB 0.4.35. Normal/Kaspersky TLS режимы сохранены. Модели/uv скачиваются с SHA-256 проверкой, self-test и launcher создаются установщиком. Он завершает только проверенный Auto Layout server через handshake/shutdown до изменения зависимостей; занятый текущим анализом callback-порт означает отказ обновления.

JSX UTF-8 **с BOM**; BAT UTF-8 без BOM с CRLF. Не включать __pycache__ в архив.

## Зафиксированная архитектура

- JSX читает геометрию выделения/слоёв, валидирует план и выполняет Photoshop Transform/Move. При cfg.pythonPacking составную геометрию, общий scale, gaps и positions рассчитывает Python; без него — JSX. Это разрешённое пользователем изменение архитектуры в 0.9.0.
- Базовая раскладка полностью работает без Python. Ни установщик, ни обязательная установка Python не навязываются при обычном запуске.
- Преимущественно Action Manager: точечные getProperty, boundsNoEffects; DOM для History/progress.
- Общий scale для всех слоёв, никаких индивидуальных масштабов.
- Rectangle/shaped/multi-zone могут искать ряды по-разному, но финальная политика общая: row specs → vertical policy → horizontal gap policy → finalizeLayoutRows → LayoutPlan → validation.
- Паттерн применения: один Transform исходного выбранного набора, затем Select layerID, свежий boundsNoEffects и максимум один Move на слой.

## Геометрия

Selection временно преобразуется в Work Path, pathContents читается через AM, контуры нормализуются и проверяются на ортогональность. Work Path удаляется; pixel selection не меняется. Bands строятся с X-интервалами. Connected components определяются по связности интервалов соседних bands, независимо от направления контуров. Пустоты component: внутренние — holes, касающиеся внешней границы — openCutouts. Stable zones принадлежат components; flattenComponentZones нужен для multi-zone DP.

Geometry содержит bounds, contours, bands, yBreaks, components/zones, componentCount, zoneCount, holeCount, openCutoutCount, isRectangle, multiZone.

Rectangle — детерминированный solver, одиночная изменённая форма — band solver, острова/отверстия/параллельные интервалы — multi-zone DP. В auto выбирается масштаб и tie-break policy; фиксированные ряды поддерживаются. Вертикальный ритм soft: auto, centerWide, edgesWide, alternateWide, alternateNarrow. Не жертвовать заметно масштабом ради ритма.

Horizontal: left/center/right/justify. Для первых трёх общий gap X, ограниченный maxGapMultiplier; для justify gap общий в группах одинакового количества фото и без X-лимита multiplier. Gap Y общий, с multiplier. Min gap задаётся процентом median height. Multi-zone старается использовать каждый component при достаточном числе фото, сохраняет последовательные группы и кэширует реальные packing capacities.

У исправленного multi-zone packing нет допуска FIT_EPS, позволяющего залезть на доли пикселя за край площадки в отверстие.

## Слои, History, validation

Поддерживаются только layerKind 1/5, не background и не блокировки, запрещающие перемещение. Порядок источников — сверху вниз в Layers palette. Сохраняются id/name/order/itemIndex/bounds/width/height/center.

LayoutPlan содержит rows/distribution/placements/commonScale/gaps/solver metadata. До Apply проверяются конечные значения, scale, количество/уникальность/source IDs, внешние границы, допустимые интервалы сложной формы и непересечение.

Apply в suspendHistory('Auto layout'). Ошибка/ESC: откат истории и выделения. После preview выполняются refreshLayoutLayerReferences, восстановление IDs при необходимости по itemIndex+name, проверка source IDs. Общий Transform использует исходный palette-order набор, а не переставленный semantic порядок.

## Семантический анализ

UI:
- чередовать мальчиков и девочек — cfg.alternateGender;
- учитывать разворот тела и головы — cfg.considerHeadTurn (сохраняется прежний ключ настройки).

analyzeSemantics возвращает gender/headTurn summaries. У пола и позы свои OptionalPythonFeatures, один AutoLayoutApi. Три consecutive technical/not_applicable failures отключают соответствующую функцию до конца запуска. Uncertain сбрасывает серию ошибок. Ошибка корпуса сохраняет рабочую голову и пол; ошибка позы не удаляет уже надёжно определённый по имени пол.

Имена батчем gender_names через pymorphy3 Name+Surn. Ненадёжное имя → gender image fallback. Имя известного пола не требует gender inference, но при включённой позе всё равно требуется фото.

На слой создаётся одно превью, отправляется analyze_image с независимыми gender/head_turn flags. Ответ {id, gender, head_turn}; поля проверяются отдельно, с deferSuccess/recordSuccess, чтобы успешный сетевой ответ не сбрасывал ошибки одной модели.

Превью: rasterize SO при необходимости → convert to SO → open → flatten/RGB → Nearest Neighbor уменьшение при необходимости → JPEG ALG_* в temp → close without save → selectPreviousHistoryState. Размер 1024 по короткой стороне сохранён. Одна analysis history anchor, cleanup во всех ветках. Ошибки восстановления не должны незаметно оставлять изменённые исходные слои.

## Пол: дисбаланс внутри ряда

Для известных M/F solveKnownGenderAllocation распределяет квоты по всем рядам с точным минимумом повторов, затем central minority. При U используется прежний row-start поиск и local refinement. Гендерное исправление optimizeSemanticAssignment работает и без анализа позы, и для объектов без valid headTurn. При разнице количества M/F >= 2 меньшинство помещается в центральный чередующийся блок; остаток большинства распределяется между краями. Для U — локальное улучшение без ухудшения чередования.

minorityCenterPenalty для первоначальных tokens использует индексы, для полного plan — реальные X и центр содержимого ряда с нормировкой на расстояние между слотами. Например 1 М + 4 Д: Д Д М Д Д. Оценка actual horizontal/vertical statistics не использует выдуманную 100% шаблонную статистику.

## Поза: корпус + голова

Face Landmarker: IMAGE, transformation matrix, SVD удаление масштаба, yaw/pitch/roll. +yaw = вправо на изображении. |yaw| < 2° нейтрален после зеркальной проверки; extreme yaw/pitch/roll и некорректные landmarks/matrix отбрасываются.

Pose Landmarker Full: IMAGE, num_poses=2, без segmentation. RIGHT_SHOULDER=12, LEFT_SHOULDER=11. По разности их world depth и проекции плечевой линии оценивается body yaw. Требуются надёжные видимость/presence плеч, допустимая длина/ориентация, плечи внутри кадра. Нос позы сопоставляется с YuNet face ROI.

classify_body_image вызывает оригинал и зеркальную копию в памяти; разница оценок после коррекции знака <= 20°. Среднее body yaw. Его вклад в композицию плавно растёт через smoothstep в диапазоне 6–18° вместо hard cutoff 12°. При почти фронтальном корпусе надёжная голова сохраняет основной/полный вклад; при сильном body yaw достигается прежняя композиция 70% корпус / 30% голова. Противоположные направления получают непрерывный conflict strength и при сильном конфликте отдают приоритет корпусу, не позволяя двум ясным позам обнулиться в ложную frontal. Если голова unavailable/uncertain, слабый body yaw плавно затухает к нулю, сильный используется полностью. Это композиционные веса, не confidence. Внутри одного запроса JPEG читается один раз; full layer остаётся в памяти для body inference, crop — для head/gender. Проверка отмены между вызовами; нативный вызов не обрывается посреди inference.

На старом runtime без body task функция головы работает, UI предупреждает. Installer revision 3 добавляет task, зависимостей сверх 0.8.0 нет. Калиброванный процент точности yaw не выдумывать. Оценка тела по одной фотографии может ошибаться, особенно при обрезке, видах со спины и необычных позах; зеркальная проверка/visibility не гарантируют выявление всех ошибок.

## Совместная расстановка: важное отличие от 0.8.0

Старое закрепление пола в каждой позиции и высоты исходного ряда **снято**: оно мешало полезным обменам, отмеченным пользователем на скриншоте.

optimizeSemanticAssignment работает по готовой геометрической структуре. Приоритеты: valid geometry/common scale → минимум одинаковых известных соседей → максимум чередующихся пар → minority centrality → pose direction + smoothness → vertical M/F preference.

Перебирает сортировку одинаковых размеров, альтернативы начала/центрального блока ряда, парные обмены. Между рядами теперь допустимы обмены любого пола: сохраняются общее количество M/F/U и число фото по рядам, а квоты пола между рядами могут перераспределяться. Это исправляет лишние ММ/ДД, закреплявшиеся в 0.8.1. До 12 проходов. До 80 объектов — все допустимые пары; выше — проблемные и распределённые позиции (до 48), плюс глобальная сортировка и варианты рядов. Это локальный bounded search, не глобальный оптимум всех permutations.

rebuildAssignedLayout пересчитывает настоящие row dimensions и coordinates:
- Rectangle: placeContainerVerticalGroup внутри общих bounds с прежним gap Y.
- Multi-zone: группы исходных zones с прежним gap Y и назначением площадкам.
- Single shape: допустимые top ranges под новый height/width и placeRangeVerticalGroup.

Общий scale, число/наполнение рядов и gaps сохраняются. Y и высота рядов могут измениться, если всё помещается. Finalizer общий, с фиксированной прежней gap policy. Тестовые кандидаты проходят быстрые проверки контейнеров/диапазонов; quadratic validation — финальный победитель. При невалидном результате используется исходный plan.

Поза оценивается к общему centerX=(bounds.left+bounds.right)/2, не к каждой зоне. Стоимость направления — квадрат turn/80 - (centerX-itemCenterX)/(bounds.width/2). Дополнение за неестественные обратные скачки в ряду: 0.35 × squared reversal. Это soft правило; пол/центральность/геометрия важнее. Unknown не трактуется как frontal.

## Протокол, журнал и версия

JSX→Python 127.0.0.1:6341; ответ listener 6340. server_id auto-layout/0.10.6; idle 15 мин; request_id/heartbeat/cancel/shutdown сохранены. При смене версии handshake завершает предыдущий Auto Layout server. Legacy forced fallback JSX сохранён из старого кода только после подтверждения Auto Layout. Installer использует stdlib-only --prepare-install того же PYW.

Журнал: gender_result и head_turn_result JSON lines. Поза включает raw head, body yaw, mirror difference, weight, effective turn и причины fallback. Отчёт краткий: M/F/U и источники пола; разворот и числа body/head-only.

JSX UUID 4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a сохранён.

## Проверки и ограничения

Пройдены 891 сочетание М/Д/U, 88 прежних геометрических сценариев, 72 совместных разных размеров, центральные блоки меньшинства, synthetic Daniil/Konstantin cross-row swap (разные высоты), 63 pose matrices, shoulder/mirror/fallback/cancel tests. Реальные YuNet/Gender/FaceLandmarker/PoseLandmarker Full/morphology прошли Linux self-test и тесты на нескольких взрослых стандартных фотографиях и зеркалах. Не выдавать эти проверки за точность на всей детской съёмке.

Photoshop Apply/ScriptUI/History и Windows installer в этой среде не запускались. Скриншот пользователя просмотрен, но исходные слои и server.log не предоставлены; конкретные исходные yaw/body yaw всех детей не известны. Synthetic exchange воспроизводит тип ошибки, а не доказывает фактические измерения оригиналов.

Подробные версии моделей/SHA, тестовые команды и текущие правила — CHANGES.md внутри архива. Исходный код архива — источник истины.

## Продолжение разработки

Сначала читать приложенный реальный код. Сохранять JSX validation/apply, общий scale, AM стиль, optional Python packing с JSX fallback, preview rollback/cleanup и cancellation. Не возвращать жёсткие слоты пола/высоты из 0.8.0. Новые признаки пользуются общей semantic assignment policy. Геометрический Python solver разрешён новым запросом пользователя (0.9.0), но не должен обходить JSX validation/selection topology. JSX syntax check без #target и BOM; Python compile/tests; реальный Photoshop тест отдельно.

## Аудит 0.8.2

Python-опции находятся отдельно в «Дополнительно»; grouping/report в «Результат». Голова тоже проходит зеркало в памяти: yaw разница <=12°, pitch/roll <=15°. Несогласованность → uncertain, raw значения в журнале. И корпус, и голова по одному изображению могут ошибаться; зеркальная проверка не гарантирует истинность. Для реального ребёнка нужны исходник и/или server.log.

Исправлен compatible Surn parse при достоверном имени; имени не навязывается самый вероятный, но противоречащий род фамилии.

Добавлены 69 квотных случаев, независимый минимум повторов, регрессии ММ/ДД и ММДД во всех режимах позы. Runtime/models прежние; только JSX/PYW обновление. Подробности — начало CHANGES.md.

## Исправление 0.8.3: малые yaw и независимый lean

На фрагментах нового пользовательского снимка head yaw -6..+7° у всех пяти детей обнулялся старым порогом 8°. Теперь threshold=2°, и финальная body/head composition не имеет повторного 8° cutoff. Малые подтверждённые углы сохраняются.

JSX хранит headLeanValid, headLean=-roll_degrees, headLeanWeight=max(0,1-|pitch|/35). Признак используется только при valid head result; body-only result с сомнительной головой не даёт lean. В стоимость назначения отдельно добавляется 0.15 × headLeanWeight × (headLean/30 - desired)^2, где desired=(centerX-X)/halfWidth. Это мягкая композиция; ни yaw, ни body yaw не заменяются углом линии глаз и не смешиваются с roll в итоговом turn. Начальная сортировка и pair search учитывают этот отдельный признак.

При большой pitch боковой наклон не навязывает сторону, а yaw остаётся результатом 3D-оценки. Наклон линии глаз (roll), поворот лица (yaw) и запрокидывание (pitch) различны. Положение зрачков не используется.

Проверены реальные screenshot crops и synthetic small-yaw/lean/pitch cases; версии модели и runtime прежние. Подробная таблица yaw/roll/старого turn — начало CHANGES.md. Нельзя выдавать crop-анализ за точные значения исходных Photoshop previews или за проверку всей раскладки.

## Цветовые режимы 0.8.4

cfg.colorMode: off (default), harmonious, contrast. UI и persistence в JSX. colorFeatures — отдельный OptionalPythonFeatures breaker. analyze_image получает color:true и возвращает color:{analysis_status,palette:[{lab:[L,a,b],weight}],method,reason}; no extra preview/read/YuNet; неопределённость не technical failure. Основные цвета оцениваются в центральном face-anchored chest ROI, с консервативным исключением белого footer только после подтверждённого перехода из менее белого содержимого, осторожным skin/collar mask; нейтральные цвета не выбрасываются. Белый run, уже продолжающийся непосредственно под лицом, не считается границей подписи. Детерминированное farthest-point clustering (<=4 кластера, <=2500 samples, <=15 iterations), Lab float. Это ограниченная ROI-оценка; волосы/шарфы/фон могут остаться.

optimizeColorAssignment применяется после optimizeSemanticAssignment (либо геометрического плана при выключенных М/Д/pose). Он НЕ решает геометрию: каждый обмен проверяется существующим rebuildAssignedLayout. При М/Д swaps только same gender. horizontalBad/horizontal/minorityCenter/vertical и head cost не должны ухудшаться относительно фиксированного baseline (1e-9 numerical pose tolerance). Цветовая стоимость: energy distance weighted Lab palettes (чувствительна к долям), среднее по горизонтальным соседям (1) и ближайшим ниже в других рядах (0.5), в общем пространстве выделения. Harmonious min, contrast max. <=8 passes, <=80 deterministic sampled positions per pass for large layouts; palette distance cache. Это local optimization, не global optimum. Diagnostics/head/gender summary сохраняются при reflow.

Новые tests/test_color_order.js и tests/test_color_palette.py; Python тесты запускать отдельными процессами, старые модули намеренно подменяют cv2 в sys.modules. Реальный OpenCV и YuNet проверены на пяти пользовательских crops; волосы на одежде могут влиять на палитру. Photoshop/Windows apply не тестировались. Runtime/models/installer прежние; заменить JSX/PYW. Архив 0.8.4 — актуальный источник истины.

## Python multi-zone geometry — 0.9.0 (актуальная архитектура)

Новый запрос пользователя явно разрешил перенос геометрического поиска в Python для составного выделения. cfg.pythonPacking default=false; в «Дополнительно» «рассчитывать заполнение площадок в Python». buildLayoutPlan вызывает tryPythonZoneLayout только geometry.multiZone; обычный прямоугольник остаётся JSX. При неуспехе отмечает packingDisabledForRun и packingFallbackReason и запускает старый buildMultiZoneLayoutFast. ESC8007 пробрасывается без fallback. Настройка доступна и без runtime, тогда используется JSX; установка не навязывается.

layout_zones получает items:{id,width,height}, stable zones:{left,top,right,bottom,componentIndex}, baseGapX/Y, maxGapMultiplier, horizontalAlign,rowRhythm,rows (0 auto). Никаких images/model inference. Сервер возвращает status,commonScale,gapY,rows:{ids,zoneIndex,top,contentWidth,rowHeight,gapX},placements:{id,centerX,centerY,scale},tested,orders,budgetExhausted,elapsed.

calculate_zone_layout — bounded DP по consumed count/component mask/row count. Для каждого stable zone проверяет все consecutive row splits текущего порядка, actual sum width/max height. Для auto/auto-rhythm хранит minimum-height DP per consumed; для fixed/rhythm ещё row count. Главный objective commonScale; allocation penalty — normalized deviation исходной фото-площади от пропорций площадок, ритм мягкий. Исходный порядок + сортировки height/aspect asc/desc (<=4), binary probes20+16/order. Alternative сначала доказывает feasibility достигнутого scale. <=500 детей, <=128 площадок. Deadline30sec; valid incumbent возвращается с budgetExhausted, отсутствие полного плана → fallback. Cancellation checks в DP и между probes; InterruptedError → cancelled response.

Финальные X/Y и gaps вычислены Python по старой JSX policy. decodePythonZoneLayout не доверяет row dimensions и пересчитывает их из исходников; shared finalizeLayoutRows должен воспроизвести возвращённые coordinates/scale с tolerance. Проверки ID set, known zone/containment, fixed rows, use components, finite numbers,gaps,overlaps — до любого Apply. Семантика после геометрии может изменить IDs/positions через существующий rebuildAssignedLayout, общий scale/gaps неизменны. buildGenderAwareLayoutPlan возвращает Python seed без второй geometry search; основной semantic optimizer чинит М/Д. pythonPacking/budget/fallback metadata переносится shared finalizer/reflow и показывается в отчёте.

Server layout_zones использует existing request_lock и active request heartbeat/cancel lifecycle, finally release/unregister. Invalid payload/busy/error отвечают через прежний протокол. Models/runtime/dependencies/installer неизменны. Version 0.9.0 нужен в JSX и PYW; handshake заменяет предыдущий сервер.

tests/test_zone_solver.py — pure geometry (mock cv2/morph only, настоящая логика solver), oracle/cancel/deadline/fixed/mixed benchmark. tests/test_python_packing.js — настоящий Python subprocess + JSX decoder/validator, 12 разных split/holes/L, сравнение scale с JSX, semantic compatibility/fallback/corruption/ESC. tests/test_server.py расширен transport lifecycle geometry. Все прежние регрессии прошли. 100 одинаковых прямоугольников/2 зоны ~0.33sec в Linux, не end-to-end Photoshop benchmark. Local candidate orders/stable zone decomposition не гарантируют глобальный оптимум; Photoshop/Windows применять и измерять отдельно.

## Выравнивание наполнения рядов — 0.9.1

User: избегать 1/4/4/4 и 3/4/4/2 в нормальных площадках, предпочитать 3/4/3/3; singleton только при вынужденной вместимости. Добавлены balanceZoneRows (JSX) и balanced_zone_counts (Python). Они выполняются ОДИН раз для winning zone allocation при выбранном scale, фиксированных zone population и row count, до vertical gap resolution/final coordinates. Source sequence внутри zone сохраняется, меняются границы рядов.

Exact DP по row index и consumed count с Pareto frontier(height,lex objective). Objective additive: number of count==1 rows, sum(count²), sum(count*(rowIndex-((rows-1)/2-.1))²). При fixed total/count rows второй критерий эквивалентен minimum variance; третий помещает более длинный ряд ближе к центру с небольшим предпочтением верхней середины. Feasibility использует sum widths + minGapX*(count-1), sum row max heights + minGapY*(rows-1), настоящий zone rectangle и fixed commonScale. Не удалять higher-height states только потому, что shorter state существует: balance может улучшиться, сохраняя fit.

Python balancing deadline3sec после packing budget30sec; timeout сохраняет old valid counts, ESC/cancel прерываетоперацию. На предельно сложном наборе отсутствие улучшения не является доказательством физической невозможности. JSX проверяет progress/cancel между DP row layers. Схемы пола/позы/цвета по-прежнему идут после finalizer и сохраняют выбранные counts.

Регрессии: 13 children 1/4/4/4 и 3/4/4/2 → 3/4/3/3; real full algorithms26children2zones8rows; narrowzone singletons preserved. 41 mixed-size exact oracle cases для обоих языков, cancellation; общие регрессии прошли. Скриншот 204620 просмотрен; это не проверка Apply в Photoshop. Заменить JSX/PYW, зависимости и runtime прежние.

## Persisted color choice — 0.9.2

User reported colour dropdown returning to first item after restart. Explicit destructive path found: availability=false set dlColor.selection=0 AND cfg.colorMode='off'. Removed. Availability now disables colour control, preserving selected item/token. normalizeColorMode makes stable primitive strings (legacy0/1/2 and boxed String/Number accepted). Config read STRINGTYPE uses String(), putScriptSettings normalizes mode before app.putCustomOptions; explicit app.getCustomOptions and unchanged UUID.

ScriptUI restoration uses dlColor.items[colorModeIndex(cfg.colorMode)]. onChange reads closure dlColor.selection, numeric Number(index), skips null. OK explicitly commits current item before dlg.close(1); outside dialog existing save-on-confirm path remains. Cancel does not save, consistent with prior policy. Rhythm/alignment switches convert Number(index) too. No new saving keys or extra side files.

Tests/test_settings.js executes genuine Config/dialog functions with host descriptor/UI mocks; all3 modes round trip, boxed descriptor strings, numeric/string/boxed indices, missed onChange, unavailable/recovered runtime, invalid/legacy values. Full JS regression suite passed; actual Photoshop ScriptUI not run. Python algorithms unchanged, server ID0.9.2 for version handshake. Replace JSX/PYW, no runtime reinstall.

## Harmonious colour grouping — 0.9.3 (replaces prior harmonious objective)

User saw no visible effect with only color enabled and expected consecutive light then dark clothing. Prior harmonious 2D neighbour distance did not specify that row-order grouping. Now harmonious uses known palette sequence in plan.rows/items order over all zones. Cost =1000*mean positive adjacent lightness reversal +mean weighted-palette energy distance. Contrast retains spatial horizontal/nearest-below objective.

paletteTone.lightness = .8*dominant Lab L+.2*weighted average L; dominant is largest palette weight. Hue/chroma from weighted a/b. Global harmonious seed sorts known palettes light-to-dark/hue/source order, gender buckets if M/F enabled. Unknown items retain slots. Seed uses rebuildAssignedLayout and fixed geometry/semantic baseline checks; if geometry/pose rejects, pair search still operates with same constraints. No scale/gap/count changes. colourOrdering.moved counts changed slot IDs in color phase and report displays it alongside known/unknown.

Tests color-only26 light/gray/dark across rectangle and disconnected zones (nonincreasing tone), stable second run, dominant/secondary tone cases. All prior JS tests passed including actual Python→JSX packing fixtures. PYW only server version0.9.3, no extraction/runtime changes. Source sizes and higher-priority gender/pose can prevent complete grouping; ROI colours remain estimates. Photoshop real Apply not tested. Replace JSX/PYW without reinstall.

## Explicit color directions and label-based persistence — 0.9.4

User: selecting second item restored third (contrast); requested light↔dark and saturated↔muted directions, keep contrast. Inspected uploaded Face alignment; it creates dropdown items individually. Color dropdown now also individual add('item'). getColorModes registry6entries maps canonical labels to semantic keys off/lightToDark/darkToLight/vividToMuted/mutedToVivid/contrast.

colorModeFromSelection uses String(selection.text); never read color selection.index (onChange and explicit OK). restore selection =items[colorModeIndex(canonical saved key)] using array position, not native index. Legacy harmonious/1 migrateslightToDark, legacy2 remainscontrast only on reading old saved values. Previously incorrectly saved contrast cannot be automatically distinguished from intended choice: user chooses preferred direction once more. Persist string token in unchanged UUID custom options, no extrafiles.

Four sorting modes use colorSortValue =±paletteTone.lightness or±chroma, same global seed/same-gender buckets and scalar-reversal/energy objective, identical geometry/head/gender baseline constraints. Chroma=.8*dominant Lab sqrt(a²+b²)+.2*weighted individual cluster chroma; opposing colourful clusters remain saturated. Contrast retains prior spatial objective. Report mode label uses registry. Runtime/models unchanged; PYW version0.9.4.

Tests all6 modes with wrong/one-based/string/boxed native index, second visible selection with index2 remains second after reload, OK missed onChange/runtime fallback/legacy migration; all4 sorting directions and preserved M/F constraints; saturation complement case. Full JS regression and genuine Python bridge fixture tests passed. Actual Photoshop UI/apply not tested; attached Face alignment left unchanged.

## Stage-local native progress — 0.9.5

User requested clear stages/local progress like provided Align and fit layers.jsx. New layoutProgressRun/work/result globals and runLayoutProgressStage. app.doProgressSegmentTask(1,index-1,total,'executeLayoutProgressStage();'); execute invokes globally held closure work, captures result, completes stage. total=7+groupRows+2*semanticRequested (prep/layers/geometry/validation/transform/position/restore +optional analysis/semantic/group stages). No Apply/history/selection/rollback policy changes.

progress(value,text) adapts legacy data loop/solver ranges to stage local fraction; default0..1 stages ignore old absolute percentages and use layoutUnitProgress. setLayoutProgressRange splits repeated gender geometry candidates and MD/head vscolor phase. Native doProgressTask portion must be(delta/(1-oldDone)) because Photoshop taskLength consumes fraction of remaining progress, per Adobe JavaScript Reference. app.updateProgress rootonly finalcompletion. advance uses zero portions to refresh UI/ESC without invented progress. pulseLayoutProgress called socketwait every100ms, heartbeat1s/cancel unchanged. Wait label explicit, no exponential/time curve.

Actual completed counts: collection(8..30), photoanalysis(30..32) advanced in finally AFTER processing/cleanup; solver probes use pass/iterations BEFORE next operation instead ofpass+1; semantic pass positions use done/max bound; native end finishes when early search returns. Apply has separate Transform and Position stages; perMove doneafter actual operation. Group doneafter created group, restore own stage. User header `Этап n: Name — count/name [local%]`.

New test_progress genuine helper/main/apply with host mocks models remaining-fraction progress; waiting50pulses holdpercent; stagesreset/donemonotonic; optionalcounts; oneTransform/threeMoves/oneHistory; ESC afterfirstmove stops/restoreshistory/IDs/cleanup. All prior JS tests passed incl genuine Python fixtures. Pythonalgorithms unchanged; onlyID0.9.5. Native UI needs actual Photoshop visualcheck. Supplied Align and fit layers.jsx left unchanged.

## Actions with frozen metrics and time-estimated wait — 0.10.0

User provided new Face alignment with harvest javascriptresource/eventid/inAction action parameter and three run branches, requested optional fixed scale+gaps across same-selection/same-source-size sheets with different photo counts, plus Python wait animation. Source reference read-only.

AutoLayout JSX now has native javascriptresource name/category/eventid(current persistent UUID)/terminology marker inAction. runAutoLayoutEntry branches: marker/count>1 ->action params; else preferences+dialog. ALL editing reads action config, shows dialog(editing), puts action descriptor only, no job/document changes. Silent playback uses recorded params and no report. Manual confirmed job saves preferences; action descriptor published only after runSucceeded. Top last expression isCancelled?'cancel':undefined. Missing invalid locked profile rejects playback before Apply. Recorded actual profile cannot be enabled on a legacy action merely by toggling settings; re-record successfuljob. Resource registration requires install/restart/oneactiveJSX.

cfg.lockForAction persists only boolean in global prefs. Action descriptor stores settings+inAction marker and lockedReady/lockedScale/lockedGapX/lockedGapY doubles, never layerIDs/count/distribution/positions. readLockedActionProfile validates finite positive scale/nonnegativegaps. On first confirmed job main captures plan metrics after geometry, refinalizes uniformX and fixedY before semantics, applies that same result, writes action only after successful restore. Forjustify X uses min actualgap; one-axis noadjacent records scaledmin as future spacing. Actual source-size assumption belongs user; fixedscale gives equaloutputsize only for equalinputsize.

Playback buildLayoutPlan routes lockedLayoutActive to buildLockedLayoutPlan. Existing DP/findMultiZoneAllocation at exact frozen scale and pixelgap/scale; rectangularonezone or stableorthogonal zones; existing counts balancing; fixedverticalcontainer placement; shared finalize. Too manyphotos ->explicitno-fiterror, no auto shrinking/no Apply. Fixedpolicy groupsX at samevalue for allcounts includingjustify; shared finalizer rejects scale drift and reapplies fixedgaps; metadata lockedMetrics preserved in semanticreflow. Pythonpacking not invoked for lockedgeometry (no scale search required), semantic models stilloptional. Sameglobalcounts/MD/pose/color constraints unaffected. Editing unavailable runtime does not reset actionMD/head flags.

Progress changed per explicit steering: beginPythonProgressWait reserves quota (analysisinit/names, oneimage at a time, geometrywait). pulse timecurve=base+span*.95*(1-exp(-elapsed/expectedMs)); ~percentlabel, max95% of slice. End on actualresponse/finally; photoactualdone jumps quota to complete. No estimate consumes subsequentimages. Native cancellation/heartbeat/request/versionvalidation unchanged. PYW only ID0.10.0; models/runtime unchanged.

New action tests realhelper/descriptor/dispatcher mocks cover record/play/edit/cancel/failure/missing profile, separate global/action storage, multiplephoto counts shape rect/split/hole/justify, metricinvariance aftersemantics, capacityfailure. Progress tests execute actualmain/apply (with lock capture), controlled timecurve/slice caps, oneTransform/oneHistory and ESCrollback. Prior JS regressions pass including actualPython→JSXbridge. True Photoshop action recorder/nativeUI unavailable and NOT verified here. InstallbothJSX/PYW; no runtime reinstall.


## Аудит 0.10.1 (2026-10-13)

Подтверждённые исправления: правильное плечевое расстояние hypot(dx*width,dy*height); fail-closed восстановление превью/analysisBaseHistory с запасным anchor и передачей autoLayoutRestoreFailure наверх; main сообщает отказ отката даже при ESC. Duplicate active request ID не перезаписывает active_requests. JSX пропускает статистику М/Д и сбор позиций головы, когда соответствующая опция выключена; validateLayoutPlan заранее индексирует исходные ID. BAT больше не повторяет model self-test двумя Python-процессами; PYW проверяет parse('Иван'). Цветовые режимы README актуализированы.

Пул ThreadPoolExecutor(max_workers=2) живёт всё время сервера и лениво создаёт рабочие потоки. head_job/body_job идут параллельно, gender/color — в обработчике. Нативные модели защищены индивидуальными locks; создание MediaPipe защищено общим model_init_lock. analyze_photo в finally ждёт все futures до снятия request_lock/очистки JPG: отмена не оставляет вычисления старого фото в следующем запросе. На выходе основной сервер shutdown(wait=True). Pure-Python packing DP не распараллелен: алгоритм ограничен бюджетом, Cpython-потоки здесь не дают ожидаемого выигрыша; межпроцессная передача/отмена потребовали бы отдельного изменения архитектуры.

Реальный замер после прогрева, 3 фото × 6 повторов с чередованием последовательного/параллельного режимов: 0.4181 s → 0.2707 s, 1.545x; ответы точно совпали. Тестируется тот же analyze_photo, SerialPool лишь исполняет submit немедленно. Измерение не включает Photoshop/экспорт/IPC; среда Linux Python3.12/NumPy1.26.4/OpenCV4.11.0.86/MediaPipe0.10.21, OpenCV 8 потоков. benchmarks/analysis.py позволяет повторить на Windows runtime и своих фото. Итоговые проверки: все тесты tests по отдельности; новые test_audit.py и test_history_recovery.js; test_progress.js дополнен явным отказом main rollback. Проверены AST, ссылки BAT-меток, CRLF BAT без BOM и BOM JSX.

Обновление с 0.10.0: заменить JSX и PYW; переустановка runtime не требуется. Полный пакет содержит обновлённый BAT. Реальные Windows installer/Photoshop Action recorder/ScriptUI не выполнялись здесь; локальные проверки не заменяют проверку пользователем в Photoshop.


## Актуальные исправления 0.10.2 — приоритет М/Д, цвет, история и интерфейс

- Исправлена реальная DOM-ошибка: Document.activeHistoryState вместо несуществующего currentHistoryState. Предыдущие mocks повторяли неправильное свойство и пропустили ошибку; теперь проверки используют правильное свойство и запрещают прежнее обращение. Сохранены предыдущий History state и запасной anchor восстановления превью.
- Создание/удаление Work Path выполняется внутри временного suspendHistory. После чтения геометрии восстанавливается исходный activeHistoryState: точное пиксельное выделение и существовавший Work Path возвращаются до анализа/Apply. Итоговая трансформация и размещение остаются одним шагом Auto layout. При отмене или ошибке возвращается исходное состояние; отказ восстановления виден пользователю.
- В М/Д сначала минимизируются одинаковые соседи в ряду, затем улучшение чередования между рядами, затем центрирование меньшинства, и только затем поза. Цвет не ухудшает установленные оценки М/Д и позы.
- Уже известный пол/цвет больше не отбрасывается из-за отключения Python после серии ошибок на следующих фото. Неопределённые фото остаются неизвестными, пол не угадывается.
- Реальная ошибка словаря на примере пользователя: Ахмедова Амина определялась как M (родительный падеж мужских Ахмедов/Амин). Предпочитаются именительные формы фамилий, имена берутся в именительном падеже; Амина явно распознаётся как женское имя. Конфликт с именительной фамилией нельзя устранить мужской косвенной формой. Ненадёжные пары по-прежнему требуют фото.
- Для направленных цветовых режимов нарушение направления сравнивается первым, сходство палитр — только при равном нарушении. Мелкий прирост/убыль светлоты больше не приносится в жертву сходству оттенков. М/Д и поза остаются выше цвета; эти ограничения и реальные размеры фото могут мешать полностью монотонной сортировке.
- Прогресс: короткие названия этапов, процент перед подробностью, счётчики без имён слоёв; подробность ограничена 24 символами. Ожидание Python по времени сохранено.
- В здоровом runtime скрытый статус Python удаляется из окна, а не занимает зарезервированные 68 пикселей. Предупреждения остаются видимыми при необходимости.

Проверки: все 12 JSX-наборов и 8 Python-наборов прошли, включая новые сценарии МММДДД при всех цветовых режимах и позе, противоположные направления при близкой светлоте, сохранение частичных результатов, путь/выделение при успехе и исключении, короткий прогресс, пустое место в окне и настоящий pymorphy3 на именах скриншота. Photoshop, его Undo/ScriptUI и запись Actions здесь не запускались; DOM/History проверены моделями API и сопоставлением с Adobe reference. Модели и пакеты прежние; заменить JSX и PYW, переустановка runtime не требуется.


Важная поправка к прежнему аудиту: currentHistoryState в DOM Photoshop было ошибкой, перенесённой из примера Face alignment и повторённой в mocks. В Action Manager это имя может быть валидным property ID, но DOM Document использует activeHistoryState. Не возвращать старое имя в DOM. Screenshot 223452 подтвердил эту ошибку; Screenshot 222823 подтвердил резерв места скрытого статуса; Screenshot 222326 показал FMFMFM/MMMFFF и Ахмедова Амина. Реальный pymorphy3 подтвердил прежнюю ошибочную M-классификацию и исправленную F. Ссылочный материал: Adobe-CEP/CEP-Resources, Photoshop Scripting/photoshop-cc-javascript-ref-2019.pdf.


## Актуальные изменения 0.10.3 — надёжность Python и заполнение площади

- JSX: убрана тильда из процентов ожидания Python. Анимация по времени и реальные границы этапов сохранены. За исключением версии и этой строки JSX побайтово соответствует 0.10.2 после нормализации версии: геометрия JSX не ухудшена и не изменена.
- Пол по имени: сильное словарное имя может подтвердить типичную форму фамилии, которую словарь не пометил Surn (Молодцов Константин). Это ограниченный запасной способ: заглавная фамилия с обычным окончанием, имя с уверенностью словарного разбора >=0.8 и известным полом; противоречия не принимаются. Две достоверные противоположные пары в одной подписи означают U, а не произвольный выбор первой пары. Не используется пол по фамилии без надёжного имени.
- Пол по фото: две оценки одного кропа — исходная и зеркальная. Требуется одинаковый класс; заметная разница вероятностей (>0.20), маленький кроп (<48px), слабая уверенность лица (<0.80), слабая уверенность класса в любой из двух оценок дают U. Уверенность ответа — меньшая из двух, не завышенное среднее. После первой оценки проверяется отмена. Сохраняются приоритет имени и одно чтение фотографии. Предобработка соответствует исполняемому RGB-примеру ONNX Model Zoo (в их README есть противоречие RGB/BGR; порядок каналов здесь не менялся).
- Поза головы: матрица вращения, yaw/pitch/roll и зеркальная проверка сохранены. Проверяются ключевые точки на обрезку и достаточное расстояние глаз в пикселях. Согласование зеркальных оценок больше не превращает два противоположных поворота >=4° в ложную фронтальность. Не заменяли 3D yaw углом линии глаз. Проверки плеч/приоритет корпуса и параллельные модели сохранены.
- Цвет одежды: равномерная выборка по всей области до 2500 пикселей вместо обрезки первых 2500. Начальные центры Lab выбираются по поддержке гистограммы, а не по одиночному самому далёкому пикселю; случайность отсутствует. Область ниже воротника шире, чтобы узкий галстук или белый воротник не доминировали над пиджаком/сарафаном. Сохраняются несколько цветов и доли, нейтральные белый/чёрный, исключение подписей и одного чтения фото. Предварительный вариант с привязкой к неполному face box отброшен при проверке; остаётся проверенная привязка к расширенному кропу лица.
- Геометрия Python: точный предельный масштаб каждого полного допустимого разбиения по суммам ширин/максимумам высот и отступам вместо недозаполнения из-за двоичного поиска. Проверяются все различающиеся по размерам порядки для <=6 фото; для больших групп добавлены порядки по высоте вверх и площади вниз. Равные масштабы сравниваются детерминированно по распределению площади, ритму и числу рядов. Добавлен потолок числа поисковых операций, сохранены 30с бюджет поиска, отдельный ограниченный баланс рядов, heartbeat/ESC и лучший допустимый найденный план. Перекрывающиеся площадки отклоняются заранее.

Проверки: 12 JSX-наборов и 10 Python-наборов проходят. 36 настоящих Python→JSX сценариев (разорванные/Г-образные/с отверстием, разные размеры, 4 выравнивания, авто/фиксированные ряды) дали площадь фото больше неизменённого JSX во всех случаях: +0.0049%…+29.7705%. Восьми независимым полным переборам всех перестановок/разбиений пяти разных фото Python соответствует с ошибкой масштаба <1e-9, повторные строки/координаты/число поисковых шагов совпали. Реальный OpenCV: зеркальные тензоры пола, сдержанное U при неопределённости, цвет на шумах/зеркале/изменении размера, равномерная выборка; настоящие pymorphy3 и YuNet на примерах пользователя. Данные скриншотов и модели в архив не включены. Реальный анализ трёх фотографий: последовательный/параллельный ответы совпали, медиана 0.4685/0.2977с (1.574x), прогретые модели CPU, 6 повторов.

Ограничения: на 12 низкоразрешённых детских миниатюрах фото-модель до изменений дала 8 верных/4 неверных ответа; после зеркальной проверки — 7 верных/3 неверных/2 U. Это показывает сдерживание ошибок, но не доказательство достаточной точности модели на детях. Надёжные имена имеют приоритет. Точность угла позы без размеченных настоящих ракурсов не измерена: улучшены проверки надёжности. Цвет не является полноценной сегментацией одежды, волосы/фон/смешанная одежда ещё могут влиять. Малые группы полностью перебираются только если не исчерпан бюджет; на больших задачах нет гарантии глобального максимума всех перестановок. Под бюджетом времени разные процессоры могут остановиться на разных этапах поиска. 36 сравнений не доказывают превосходство Python над JSX на любом возможном выделении. Настоящие Windows/Photoshop Undo/ScriptUI/Actions в этой среде не выполнялись.

Обновление: заменить JSX и PYW; runtime, модели, пакеты и Action UUID прежние, переустановка не нужна.



## Актуальные изменения 0.10.4 — автономные словари russiannames

- Добавлены russiannames 2.0.0 и DuckDB 1.4.4, дополнительно к pymorphy3. Закреплённые версии устанавливаются в приватный venv. Словари names/surnames/midnames входят в wheel russiannames; ни внешняя БД, ни API, ни отдельные файлы в Photoshop не нужны. DuckDB — встроенный движок в том же процессе Python.
- Для определения пола используется точный поиск в локальном NamesDatastore russiannames. Не переносили автоматически все эвристики NamesParser: собственная проверка сигналов не позволяет решать пол только по окончанию фамилии. Из словарных ролей имени/фамилии/отчества учитываются частоты, чтобы редкая запись фамилии как имени не подменяла настоящую роль.
- Однозначное словарное имя работает самостоятельно и с отсутствующей в базе фамилией. Фамилия/отчество подтверждают его. Неоднозначные Саша/Женя/Валя/Шура разрешаются по согласованной фамилии или отчеству; без подтверждения U. Несколько обнаруженных имён или противоречащие сигналы дают U.
- Если словари не нашли имя, используется прежний pymorphy3. Если библиотека не установлена/база не читается, pymorphy3 также остаётся рабочим запасным способом, без отключения остальных Python-функций. Неопределённость явно найденного неоднозначного/противоречивого имени не отменяется произвольной догадкой морфологии; дальше возможен прежний анализ фото.
- База открывается один раз на сервер, запросы защищены RLock, точные словарные записи кэшируются (4096 ключей). Явно указан путь к данным установленного пакета, переменная RUSSIANNAMES_DATA_DIR не может заменить его внешним источником. Никаких сетевых запросов для ФИО в коде нет.
- Installer revision 4: новые зависимости включены в обычный и Kaspersky режимы, проверку закреплённых версий и общий PYW self-test. self-test проверяет наличие локальных parquet и имена Ахмедова Амина / Молодцов Константин. На выходе сервера база закрывается после ожидания анализа.

Проверки: 12 JSX- и 12 Python-наборов прошли; настоящий russiannames с DuckDB, заблокированные Python-сетевые соединения, игнорирование ошибочного внешнего пути данных, однозначные имена отдельно, оба порядка ФИО, отчества/неоднозначные имена/конфликты, 4 параллельных потока запросов, отсутствие и искусственный отказ базы с возвратом к pymorphy3. Первая группа словарных проверок 0.53–0.56с в Linux Python3.12; повторные запросы кэшируются. Настоящий self-test всей системы (словари, pymorphy3 и четыре модели) прошёл. Проверены версии/обе ветки BAT, метки переходов, CRLF без BOM у BAT и BOM у JSX. Windows installer/Photoshop UI/Actions здесь не исполнялись.

Обновление с 0.10.3: один раз запустить install_runtime.bat из этого пакета для установки новых библиотек; затем заменить JSX и PYW. Модели и настройки прежние. Интернет требуется установщику для скачивания зависимостей; после установки обработка ФИО полностью локальная. Если нужна установка на компьютер вообще без доступа к сети, этот BAT не является полным офлайн-установщиком: для этого отдельно потребуется комплект локальных wheels/runtime/models.

Словарь не является безошибочным источником и не гарантирует распознавание любого редкого имени. Фиксированные confidence .94/.98 — служебные оценки метода, не измеренная вероятность правильности. russiannames распространяется под BSD-3-Clause; DuckDB — MIT, лицензии устанавливаются вместе с пакетами. Геометрия, цвет и поза не менялись в этом выпуске.



## Исторические изменения 0.10.5 — группы, связанные слои и рамки

- Группировка рядов больше не передаёт имя «Ряд N». Photoshop сам назначает стандартные имена групп. По той же схеме создаётся временная группа для связанного набора.
- Входные группы конвертируются в Smart Object. Если выбраны группа и её дочерние слои, получается один объект, а не дубли. Связи слоёв (иконка цепочки, linkedLayerIDs) обходятся транзитивно, включая невыбранные связанные слои, обратные связи и связи изнутри выбранных групп. Набор объединяется в группу и конвертируется в один Smart Object. Внешний linked-файл уже существующего Smart Object не является этой связью: он остаётся обычным входным Smart Object.
- Все текстовые слои внутри подготавливаемого набора, в том числе во вложенных группах, читаются через textKey ActionDescriptor. Имя нового объекта — содержимое в порядке сверху вниз панели, пробельные переносы нормализованы, одинаковый текст не повторяется. Если текста нет, сохраняется подходящее исходное имя (приоритет Smart Object/пиксельному слою перед рамкой/пустым текстовым слоем). Текст не подставляется в исполняемые строки, переименование — через ActionDescriptor.
- В 0.10.5 отдельные векторные shape-слои предварительно конвертировались. **Это правило отменено в 0.10.9:** самостоятельные shape-слои теперь раскладываются напрямую; подготовка/Smart Object нужны только группе или linked-набору. Отдельный несвязанный текст/коррекция остаётся неподдерживаемым входом: включите его в группу/связанный набор. Артборд не преобразуется как обычная группа.
- Обход структуры адаптирован по приложенному пользователем «Layers - parse layers pallette to object.jsx». Один полный executeActionGet-дескриптор на индекс, bottom-up границы layerSection, сохранён parentId. Все новые чтения/выбор слоёв, создание групп, Smart Object и переименование — ActionManager. DOM не используется для обхода layers/grouped/linkedLayers/textItem или преобразования слоёв. Существующие Document.suspendHistory/activeHistoryState и однократный app.refresh после временной подготовки сохранены для транзакции/корректных якорей истории.
- Преобразования сначала выполняются временно для измерений и семантики. Перед итогом восстанавливается исходная история, затем подготовка и Apply выполняются в одном suspendHistory Auto layout. Повторные объекты сопоставляются по порядку единиц подготовки; проверяются имя, ширина, высота и исходное положение (0.05px). Новые ID переносятся в позиции и элементы рядов, исходные размеры/общий масштаб сохраняются. Отклонение/отмена откатывает всё к исходным группам, тексту, связям и выделению. Запись action-профиля остаётся только после успеха. Итог не оставляет отдельно применённого шага подготовки.
- Цена единого Undo: преобразование групп/связей выполняется дважды, временно и окончательно. Большие группы могут заметно увеличить время; обычные фото без подготовки второй раз не преобразуются.
- Предварительные проверки до модификаций: отсутствие ID связи, блокировки выбранных корней/родителей, пустая группа, разные непосредственные родители у связанного набора, неполная обтравочная цепочка, не изолированные коррекции/нестандартное наложение внутри Pass Through. Наборы из разных родительских групп требуют сначала собрать их в одном контейнере; скрипт не переносит автоматически посторонние маски/эффекты и не игнорирует эту неоднозначность. Изоляция оценивается только по группам ВНУТРИ будущего объекта, не по невыбранному родителю.
- С 0.10.5 отсутствие лица является штатным `not_applicable`, а не технической ошибкой. В 0.10.9 поверх этого добавлен отдельный no-data breaker: три подряд слоя без полезного результата прекращают дальнейший покадровый анализ и Python-packing. Пол рамки, уже определённый по имени, сохраняется; поза и палитра одежды без лица остаются неизвестными. Цвет самих рамок этот режим не сортирует.

Проверки: 15 JSX-наборов и 13 Python-наборов проходят. Новые тесты — дедупликация групп/потомков, связи из потомка, связанные невыбранные слои, структура с фоном/вложенными группами, имя из текста, фильтр опасных контейнеров/обтравки/коррекций/наложения; реальный main + временная подготовка + финальное применение на модели History, новые ID, М/Д/поза/цвет, фиксированные метрики экшена, обычное фото вместе с группами, группировка рядов без имён; отмена в обоих преобразованиях и Move, отказ при отличающихся размерах, единый Undo-модель; пять no-face рамок перед портретом не отключают признаки. Настоящий YuNet не нашёл лица на пяти цветных прямоугольных рамках. Синтаксис Python, CRLF BAT без BOM, BOM JSX и ссылки BAT-меток проверены.

Ограничение проверки: Photoshop недоступен, поэтому новые ActionManager-команды и настоящую историю/Undo/видимость/внешний вид групп здесь выполнить нельзя. API-модели проверяют алгоритм и транзакцию, но не заменяют проверку на реальном Photoshop. Сложные связки с разными родителями/зависимыми коррекциями намеренно останавливаются до изменений.

Обновление с 0.10.4: заменить JSX и PYW. Installer revision 4, пакеты/модели прежние; повторная установка не нужна, если runtime 0.10.4 уже обновлён.

