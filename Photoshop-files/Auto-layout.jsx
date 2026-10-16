#target photoshop

/*
// BEGIN__HARVEST_EXCEPTION_ZSTRING
<javascriptresource>
<name>Auto Layout</name>
<category>alignment</category>
<enableinfo>true</enableinfo>
<eventid>4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a</eventid>
<terminology><![CDATA[<< /Version 1
 /Events << /4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a [(Auto Layout) <<
 /inAction [(action settings) /boolean]
 >>] >> >> ]]></terminology>
</javascriptresource>
// END__HARVEST_EXCEPTION_ZSTRING
*/

/** Auto Layout v0.10.38 - Geometry + optional semantic ordering
 *  Geometry works in JSX with optional validated Python multi-zone packing. Local
 *  Python features are enabled only when their runtime is available. Repeated
 *  optional-analysis failures trip a per-run circuit breaker and fall back to
 *  the unchanged geometry core.
 *
 *  Current scope:
 *  - orthogonal Photoshop selections, including disconnected areas, holes and open cut-outs;
 *  - connected selected components are identified independently from holes/cut-outs;
 *  - each connected component owns its stable rectangular layout zones;
 *  - pixel, shape and Smart Object layers; groups/linked sets use temporary Smart Object proxies for measurement and remain editable after layout;
 *  - automatic or fixed row count;
 *  - selectable soft vertical row rhythm (auto / wider center / wider edges / alternating);
 *  - optional boy/girl checkerboard ordering using Cyrillic names first and local image fallback;
 *  - optional 3D body/head composition towards the global center, preserving row gender counts;
 *  - one common scale for all selected layers;
 *  - bounds are read from boundsNoEffects;
 *  - hard whole-sheet beginning/end categories selected by layer color labels;
 *  - palette order is the default within each category;
 *  - items inside each row are aligned by their top edge;
 *  - rows support left / center / right / justified horizontal distribution;
 *  - shared horizontal and vertical policies finalize rectangle, shaped and multi-zone layouts;
 *  - horizontal gap rules are shared across zones; one uniform vertical gap policy is used across the whole layout;
 *  - minimum gaps may grow up to a configurable multiplier (horizontal max is ignored in justified mode);
 *  - every row can be placed into its own Photoshop layer group.
 */

$.localize = true;

var ver = '0.10.38',
    UUID = '4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a',
    PATH_TOLERANCE = 0.5,
    GEOMETRY_EPS = 0.75,
    FIT_EPS = 0.02,
    API_HOST = '127.0.0.1',
    API_PORT_SEND = 6341,
    API_PORT_LISTEN = 6340,
    API_FILE = 'auto-layout-api',
    INIT_DELAY = 60000,
    ANALYSIS_DELAY = 60000,
    GENDER_PREVIEW_SIZE = 1024,
    COMPOSITION_MAX_SCALE_LOSS = 0.01,
    OPTIONAL_PYTHON_FAILURE_LIMIT = 3,
    OPTIONAL_PYTHON_EMPTY_LIMIT = 3;

var s2t = stringIDToTypeID,
    apl = new AM('application'),
    doc = new AM('document'),
    lr = new AM('layer'),
    pth = new AM('path'),
    str = new Locale(),
    cfg = new Config(),
    pythonApi = new AutoLayoutApi(API_HOST, API_PORT_SEND, API_PORT_LISTEN, API_FILE),
    pythonFeatures = new OptionalPythonFeatures(pythonApi, OPTIONAL_PYTHON_FAILURE_LIMIT),
    headTurnFeatures = new OptionalPythonFeatures(pythonApi, OPTIONAL_PYTHON_FAILURE_LIMIT),
    colorFeatures = new OptionalPythonFeatures(pythonApi, OPTIONAL_PYTHON_FAILURE_LIMIT),
    packingDisabledForRun = false,
    packingFallbackReason = '',
    semanticImageAnalysisDisabledForRun = false,
    semanticImageEmptyStreak = 0,
    semanticImageFallbackReason = '',
    selectedLayerDescriptorCache = null,
    layoutPlan = null,
    sourceState = null,
    inputPreparation = null,
    preparedAnalysisItems = null,
    selectionGeometry = null,
    genderSummary = null,
    headTurnSummary = null,
    pendingPreviews = [],
    previewWork = null,
    actionPlayback = false,
    actionLayoutProfile = null,
    runSucceeded = false,
    layoutProgressRun = null,
    layoutProgressWork = null,
    layoutProgressResult = undefined,
    currentProgressValue = 0,
    isCancelled = false;

try { runAutoLayoutEntry(); }
catch (entryError) {
    isCancelled = true;
    if (!entryError.number || entryError.number != 8007) alert(entryError.message || entryError, 'Auto Layout');
}
isCancelled ? 'cancel' : undefined;

function throwCancelled() {
    isCancelled = true
    var e = new Error('Operation cancelled');
    e.number = 8007;
    throw e
}

function progress(value, text) {
    currentProgressValue = Math.round(value);
    if (typeof layoutProgressRun != 'undefined' && layoutProgressRun && layoutProgressRun.active) {
        var run = layoutProgressRun, fraction = (value - run.low) / Math.max(1e-9, run.high - run.low);
        run.waiting = false;
        advanceLayoutProgress(run.low == 0 && run.high == 1 ? run.done : run.base + run.length * Math.max(0, Math.min(1, fraction)), text);
    } else {
        if (text) app.changeProgressText(text);
        if (app.updateProgress(currentProgressValue, 100) === false) throwCancelled();
    }
}

function main() {
    runSucceeded = false;
    packingDisabledForRun = false;
    packingFallbackReason = '';
    semanticImageAnalysisDisabledForRun = false;
    semanticImageEmptyStreak = 0;
    semanticImageFallbackReason = '';
    selectedLayerDescriptorCache = null;
    var historyState;
    inputPreparation = null; preparedAnalysisItems = null; sourceState = null;
    try {
        if (!apl.getProperty('numberOfDocuments')) throw new Error(str.t('Нет активного документа.', 'No active document.'))

        isCancelled = false;
        historyState = activeDocument.activeHistoryState;
        validatePrioritySettings();
        sourceState = collectDocumentState();
        inputPreparation = buildInputPreparation(sourceState.layerIds);
        var alphabetical = alphabetOrderActive(),
            semanticRequested = !alphabetical && !!(cfg.alternateGender || cfg.considerHeadTurn || (cfg.colorMode && cfg.colorMode != 'off')),
            items, originalItems, analysis = null, useGender = false, useHead = false;
        layoutProgressRun = { index: 0, total: 7 + (inputPreparation ? 2 : 0) + (cfg.groupRows ? 1 : 0) + (semanticRequested ? 2 : 0) + (alphabetical ? 1 : 0), active: false };
        runLayoutProgressStage('Preparation and selection', function () {
            historyState = activeDocument.activeHistoryState;
            layoutUnitProgress(1, 2, 'Selected layers read');
            selectionGeometry = collectSelectionGeometryWithHistory();
            layoutUnitProgress(2, 2, 'Selection geometry read');
        });
        if (inputPreparation) runLayoutProgressStage('Preparing objects for analysis', function () {
            activeDocument.suspendHistory('Auto layout prepare', 'prepareLayoutSources();');
            // Flush Photoshop's suspended-history cache before preview anchors.
            if (typeof app.refresh == 'function') app.refresh();
        });
        items = runLayoutProgressStage('Reading layer sizes', function () {
            return collectLayoutItems(sourceState.layerIds);
        }, 8, 30);
        originalItems = items; // Keep proxy-to-root correspondence before any sorting.
        items = assignLabelPriorities(items);
        if (alphabetical) runLayoutProgressStage('Reading alphabetical names', function () {
            prepareAlphabeticalKeys(items);
            if (cfg.alphabetOrder == 'page') items = sortAlphabeticalItems(items);
        });
        genderSummary = null; headTurnSummary = null;
        if (semanticRequested) runLayoutProgressStage('Analyzing photos', function () {
            analysis = analyzeSemantics(items);
            genderSummary = analysis.gender; headTurnSummary = analysis.headTurn;
            if (analysis.previewHistoryTouched) {
                refreshLayoutLayerReferences(items);
                restoreLayerSelection(sourceState.layerIds, sourceState.activeLayerId);
            }
            useGender = !!(genderSummary && !genderSummary.fallbackToGeometry);
            useHead = !!(headTurnSummary && !headTurnSummary.fallbackToGeometry);
        }, 30, 32);
        layoutPlan = runLayoutProgressStage('Calculating selection packing', function () {
            if (cfg.noEnlarge && cfg.pythonPacking && !lockedLayoutActive() && !alphabetOrderActive()) {
                var median = getMedianHeight(items), cappedPlan = tryPythonZoneLayout(items, selectionGeometry,
                    median * cfg.gapX / 100, median * cfg.gapY / 100);
                if (cappedPlan) return cappedPlan;
            }
            var seed = useGender ? buildGenderAwareLayoutPlan(items, selectionGeometry) : buildLayoutPlan(items, selectionGeometry);
            if (cfg.pythonPacking && !alphabetical && !lockedLayoutActive() && !seed.pythonPacking) {
                var expanded = tryPythonZoneLayout(items, selectionGeometry, seed.baseGapX, seed.baseGapY, seed);
                if (expanded) return expanded;
            }
            return seed;
        }, 32, 55);
        if (alphabetical && cfg.alphabetOrder == 'zone')
            layoutPlan = sortAlphabeticalZones(layoutPlan, selectionGeometry);
        layoutPlan.genderSummary = genderSummary;
        if (semanticRequested) runLayoutProgressStage('Semantic ordering', function () {
            var useColor = !!(analysis.color && !analysis.color.fallbackToGeometry),
                joint = !!layoutPlan.pythonComposition,
                phases = (useGender || useHead || joint ? 1 : 0) + (useColor && !joint ? 1 : 0), phase = 0;
            if (useGender || useHead || joint) {
                setLayoutProgressRange(phase++ / phases, 1 / phases);
                layoutPlan = optimizeCompositionAssignment(layoutPlan, selectionGeometry, useGender, useHead, useColor);
                layoutUnitProgress(1, 1, 'Gender and pose ordering complete');
            }
            layoutPlan.headTurnSummary = headTurnSummary;
            if (useColor && !joint) {
                setLayoutProgressRange(phase++ / phases, 1 / phases);
                layoutPlan = optimizeColorAssignment(layoutPlan, selectionGeometry, useGender, useHead, cfg.colorMode);
                layoutUnitProgress(1, 1, 'Color ordering complete');
            }
            layoutPlan.colorSummary = analysis.color;
        });
        // Capture fixed metrics only after final semantic/alphabetical ordering.
        if (cfg.lockForAction && !lockedLayoutActive()) {
            actionLayoutProfile = profileFromLayout(layoutPlan);
            layoutPlan = freezeLayoutMetrics(layoutPlan, selectionGeometry);
        }
        runLayoutProgressStage('Validating layout', function () {
            validateLayoutPlan(layoutPlan, selectionGeometry);
            layoutUnitProgress(1, 2, 'Bounds and overlaps checked');
            validateSourceLayersBeforeApply();
            layoutUnitProgress(2, 2, 'Source layers checked');
        });
        // All modifying stages retain the single original History/rollback boundary.
        if (inputPreparation) {
            preparedAnalysisItems = originalItems;
            activeDocument.activeHistoryState = historyState;
            activeDocument.suspendHistory('Auto layout', 'commitPreparedLayout();');
        } else activeDocument.suspendHistory('Auto layout', 'applyLayoutPlan()');
        runLayoutProgressStage('Restoring layer selection', function () {
            restoreLayerSelection(sourceState.layerIds, sourceState.activeLayerId);
        });
        if (shouldCollapseAllGroupsAfterLayout()) collapseAllLayerGroups();
        layoutProgressRun.active = false;
        app.changeProgressText('Done');
        if (app.updateProgress(100, 100) === false) throwCancelled();
        runSucceeded = true;
    } catch (e) {
        if (historyState) {
            try { activeDocument.activeHistoryState = historyState } catch (restoreError) {
                e = new Error((e.message || String(e)) + '\n' + str.t('Не удалось отменить изменения документа: ', 'Could not roll back document changes: ') + restoreError.message);
            }
        }
        if (sourceState) {
            var restoreIds = sourceState.originalLayerIds || sourceState.layerIds,
                restoreActive = sourceState.originalActiveLayerId != undefined ? sourceState.originalActiveLayerId : sourceState.activeLayerId;
            if (restoreIds) {
                try { restoreLayerSelection(restoreIds, restoreActive) } catch (selectionError) { }
            }
        }
        if (e.number && e.number == 8007) {
            isCancelled = true
        } else {
            alert(e.message ? e.message : e, 'Auto layout')
        }
    } finally {
        if (layoutProgressRun) layoutProgressRun.active = false;
        cleanupPreviews();
    }
    if (runSucceeded && analysis && analysis.failureMessage)
        alert(str.t('Раскладка выполнена, но часть выбранного анализа не выполнена:\n', 'Layout completed, but some selected analysis could not be completed:\n') + analysis.failureMessage, 'Auto layout');
}

function hasLayoutActionParameters(d) {
    try { return !!(d && d.count > 1 && d.hasKey(app.stringIDToTypeID('inAction')) && d.getBoolean(app.stringIDToTypeID('inAction'))); }
    catch (e) { return false; }
}

function readLockedActionProfile(d) {
    try {
        if (!d.hasKey(app.stringIDToTypeID('lockedReady')) || !d.getBoolean(app.stringIDToTypeID('lockedReady'))) return null;
        var result = {
            scale: Number(d.getDouble(app.stringIDToTypeID('lockedScale'))),
            gapY: Number(d.getDouble(app.stringIDToTypeID('lockedGapY'))),
            gapX: Number(d.getDouble(app.stringIDToTypeID('lockedGapX'))),
            height: Number(d.getDouble(app.stringIDToTypeID('lockedHeight')))
        };
        validateLockedProfile(result);
        return result;
    } catch (e) { return null; }
}

function validateLockedProfile(profile) {
    if (!profile || typeof profile.scale != 'number' || !isFinite(profile.scale) || profile.scale <= 0 ||
        typeof profile.gapY != 'number' || !isFinite(profile.gapY) || profile.gapY < 0 ||
        typeof profile.gapX != 'number' || !isFinite(profile.gapX) || profile.gapX < 0 ||
        typeof profile.height != 'number' || !isFinite(profile.height) || profile.height <= 0)
        throw new Error(str.t('В экшене нет корректного масштаба и интервалов. Запишите шаг заново на готовой раскладке.', 'The action does not contain valid scale and gap values. Record the step again using a completed layout.'));
}

function runAutoLayoutEntry() {
    actionPlayback = hasLayoutActionParameters(app.playbackParameters);
    cfg.getScriptSettings(actionPlayback);
    actionLayoutProfile = actionPlayback && cfg.lockForAction ? readLockedActionProfile(app.playbackParameters) : null;
    var editing = actionPlayback && app.playbackDisplayDialogs == DialogModes.ALL;
    if (!actionPlayback || editing) {
        var window = dialog(editing), result = window.show();
        if (result !== 1) { isCancelled = true; return; }
        if (editing) {
            if (cfg.lockForAction) validateLockedProfile(actionLayoutProfile);
            cfg.putScriptSettings(true);
            return; // Editing the action updates its descriptor without modifying the document.
        }
        cfg.putScriptSettings(false);
    }
    if (actionPlayback && cfg.lockForAction) validateLockedProfile(actionLayoutProfile);
    app.doProgress('Auto Layout', 'main();');
    if (!runSucceeded) { isCancelled = true; return; }
    if (!actionPlayback) cfg.putScriptSettings(true); // Recording publishes parameters only after a successful manual run.
}

function lockedLayoutActive() {
    return !!(cfg.lockForAction && typeof actionLayoutProfile != 'undefined' && actionLayoutProfile);
}

// Only fixed Actions normalize scale by the median object height.
// A few protruding captions/decorations do not determine the whole-sheet scale.
// This measures boundsNoEffects, not an inferred inner photographic frame.
function resolveLockedScale(items, profile) {
    var height = getMedianHeight(items), scale = profile.height / height;
    if (!isFinite(height) || height <= 0 || !isFinite(scale) || scale <= 0)
        throw new Error(str.t('Не удалось определить опорную высоту объектов для экшена.',
            'Could not determine the reference object height for the action.'));
    if (cfg.noEnlarge && scale > 1 + 1e-12)
        throw new Error(str.t('Фиксированный экшен требует увеличить слои, но увеличение запрещено. Используйте объекты большего размера или перезапишите экшен.', 'The fixed action requires enlargement, but enlargement is disabled. Use larger source objects or record the action again.'));
    return cfg.noEnlarge ? Math.min(1, scale) : scale;
}

function lockedRuntimeScale() {
    return actionLayoutProfile.runtimeScale != undefined ? actionLayoutProfile.runtimeScale : actionLayoutProfile.scale;
}

function profileFromLayout(plan) {
    var p = {
        scale: plan.commonScale,
        gapY: plan.actualGapY > 0 ? plan.actualGapY : plan.minFinalGapY,
        gapX: plan.actualGapXMin > 0 ? plan.actualGapXMin : plan.minFinalGapX,
        height: 0
    };
    p.height = getMedianDimension(plan.placements, 'height');
    validateLockedProfile(p);
    return p;
}

function lockedGapPolicy(specs, profile) {
    // A fixed action uses one global X gap, including Justify.
    var byRow = {}, adjacent = false;
    for (var i = 0; i < specs.length; i++) {
        var count = specs[i].items.length, gap = count > 1 ? profile.gapX : 0;
        byRow[String(i)] = gap;
        if (count > 1) adjacent = true;
    }
    return {
        minFinalGapX: profile.gapX,
        actualGapX: profile.gapX,
        byRow: byRow,
        actualGapXMin: adjacent ? profile.gapX : 0,
        actualGapXMax: adjacent ? profile.gapX : 0
    };
}

function freezeLayoutMetrics(plan, geometry) {
    var profile = actionLayoutProfile, specs = [];
    for (var r = 0; r < plan.rows.length; r++) {
        var row = plan.rows[r];
        specs.push({ items: row.items.slice(0), contentWidth: row.contentWidth, rowHeight: row.rowHeight,
            top: row.y, interval: row.availableInterval, zoneIndex: row.zoneIndex, componentIndex: row.componentIndex });
    }
    var baseGapX = profile.gapX / profile.scale,
        frozen = finalizeLayoutRows(specs, profile.scale, baseGapX, profile.gapY / profile.scale,
            plan.actualGapY, plan, lockedGapPolicy(specs, profile));
    if (!frozen) throw new Error(str.t('Не удалось зафиксировать интервалы раскладки.', 'Could not lock the layout gaps.'));
    frozen.autoRows = plan.autoRows;
    frozen.lockedMetrics = true;
    validateLayoutPlan(frozen, geometry);
    return frozen;
}

function buildLockedLayoutPlan(items, geometry) {
    var profile = actionLayoutProfile;
    validateLockedProfile(profile);
    var scale = resolveLockedScale(items, profile),
        gx = profile.gapX / scale,
        gy = profile.gapY / scale, zones;
    profile.runtimeScale = scale;
    if (geometry.isRectangle) {
        zones = [{ left: geometry.bounds.left, right: geometry.bounds.right, top: geometry.bounds.top,
            bottom: geometry.bounds.bottom, width: geometry.bounds.width, height: geometry.bounds.height,
            zoneIndex: 0, componentIndex: 0 }];
    } else {
        if (!geometry.multiZone) buildStableLayoutZones(geometry.bands, geometry.components, GEOMETRY_EPS);
        zones = flattenComponentZones(geometry.components);
    }
    var desiredRows = cfg.autoRows ? 0 : Math.max(1, Math.min(cfg.rows, items.length)),
        allocation = findMultiZoneAllocation(items, zones, scale, gx, gy, buildFastShapeSegmentCache(items),
            desiredRows, geometry.componentCount || 1);
    if (!allocation) throw new Error(str.t('Фотографии не помещаются при масштабе и интервалах, записанных в экшене. Уменьшите количество фото или запишите новую раскладку.', 'The photos do not fit with the scale and gaps recorded in the action. Reduce the number of photos or record a new layout.'));
    var specs = [], hasLockedVerticalGap = false;
    for (var a = 0; a < allocation.assignments.length; a++) {
        var assignment = allocation.assignments[a];
        if (!assignment || !assignment.rows.length) continue;
        if (assignment.rows.length > 1) hasLockedVerticalGap = true;
        var zone = zones[assignment.zoneIndex], start = assignment.start, indices = [];
        for (var r = 0; r < assignment.rows.length; r++) {
            var packed = assignment.rows[r]; indices.push(specs.length);
            specs.push({ items: items.slice(start, start + packed.count), contentWidth: packed.contentWidth,
                rowHeight: packed.rowHeight, interval: { left: zone.left, right: zone.right },
                zoneIndex: assignment.zoneIndex, componentIndex: zone.componentIndex });
            start += packed.count;
        }
        balanceZoneRows(specs, indices, zone, scale, gx, gy,
            getRowRhythmProfile(allocation.rowCount, cfg.rowRhythm).slice(specs.length - indices.length, specs.length));
        if (!placeContainerVerticalGroup(specs, indices, scale, profile.gapY, zone.top, zone.bottom))
            throw new Error(str.t('Ряды не помещаются с зафиксированным интервалом.', 'The rows do not fit with the locked gap.'));
    }
    var plan = finalizeLayoutRows(specs, scale, gx, gy, hasLockedVerticalGap ? profile.gapY : 0, {
        shapedSelection: !geometry.isRectangle, multiZoneSelection: !!geometry.multiZone,
        zoneCount: zones.length, usedZoneCount: allocation.usedZones, usedComponentCount: allocation.usedComponentCount,
        solverPasses: 1, lockedMetrics: true }, lockedGapPolicy(specs, profile));
    if (!plan) throw new Error(str.t('Не удалось построить раскладку с параметрами экшена.', 'Could not build a layout using the action parameters.'));
    plan.autoRows = cfg.autoRows;
    validateLayoutPlan(plan, geometry);
    progress(55, 'Action layout calculated');
    return plan;
}

function runLayoutProgressStage(name, work, low, high) {
    var run = layoutProgressRun;
    run.index++;
    run.name = name; run.done = 0; run.base = 0; run.length = 1;
    run.low = low == undefined ? 0 : low; run.high = high == undefined ? 1 : high;
    run.detail = ''; run.waiting = false; run.active = true;
    layoutProgressWork = work; layoutProgressResult = undefined;
    renderLayoutProgress();
    if (app.doProgressSegmentTask(1, run.index - 1, run.total, 'executeLayoutProgressStage();') === false) throwCancelled();
    run.active = false;
    return layoutProgressResult;
}

function executeLayoutProgressStage() {
    layoutProgressResult = layoutProgressWork();
    layoutProgressRun.waiting = false;
    advanceLayoutProgress(1, 'Completed');
}

function renderLayoutProgress() {
    var run = layoutProgressRun;
    if (!run) return;
    var stageNames = { 'Preparation and selection': 'Selection', 'Reading layer sizes': 'Sizes',
        'Analyzing photos': 'Analysis', 'Calculating selection packing': 'Packing',
        'Semantic ordering': 'Ordering', 'Validating layout': 'Validation',
        'Scaling layers': 'Scale', 'Positioning photos': 'Positions', 'Calculating object transforms': 'Transforms',
        'Transforming source objects': 'Source objects', 'Restoring layer selection': 'Layer selection',
        'Grouping rows': 'Groups', 'Preparing objects for analysis': 'Objects', 'Restoring source objects': 'Source layers' },
        title = run.index + '. ' + (stageNames[run.name] || run.name),
        detail = run.waiting ? 'waiting for Python' : String(run.detail || '');
    if (title.length > 22) title = title.substr(0, 21) + '…';
    if (detail.length > 24) detail = detail.substr(0, 23) + '…';
    app.changeProgressText(title + ' [' + Math.round(run.done * 100) + '%]' +
        (detail ? ' — ' + detail : ''));
}

function autoLayoutProgressPulse() {
    renderLayoutProgress();
    if (typeof $ != 'undefined') $.sleep(0);
}

function advanceLayoutProgress(fraction, text) {
    var run = layoutProgressRun, previous = run.done, next = Math.max(previous, Math.min(1, Math.max(0, fraction))),
        delta = next - previous, portion = delta > 0 ? Math.min(1, delta / Math.max(1e-9, 1 - previous)) : 0;
    run.done = next;
    if (text) run.detail = text;
    renderLayoutProgress();
    // Zero slices pump the native UI/cancel channel without inventing progress.
    // Photoshop taskLength is a fraction of the REMAINING segment, not its original length.
    if (app.doProgressTask(portion, 'autoLayoutProgressPulse();') === false) throwCancelled();
}

function beginPythonProgressWait(fraction, expectedMs) {
    if (typeof layoutProgressRun == 'undefined' || !layoutProgressRun || !layoutProgressRun.active) return;
    var run = layoutProgressRun;
    if (run.waiting && run.waitStarted != undefined) return;
    run.waiting = true;
    run.waitStarted = (new Date()).getTime(); run.waitBase = run.done;
    var quota = fraction == undefined ? (run.name == 'Analyzing photos' ? .05 : 1) : fraction;
    run.waitSpan = Math.min(1 - run.done, run.length * quota);
    run.waitExpected = Math.max(250, expectedMs || 4000);
    renderLayoutProgress();
}

function endPythonProgressWait() {
    if (typeof layoutProgressRun == 'undefined' || !layoutProgressRun) return;
    layoutProgressRun.waiting = false; layoutProgressRun.waitStarted = undefined;
}

function pulseLayoutProgress(waiting) {
    if (typeof layoutProgressRun != 'undefined' && layoutProgressRun && layoutProgressRun.active) {
        if (waiting === true) beginPythonProgressWait();
        if (waiting === false) endPythonProgressWait();
        var run = layoutProgressRun;
        if (run.waiting && run.waitStarted != undefined) {
            var elapsed = Math.max(0, (new Date()).getTime() - run.waitStarted),
                estimate = run.waitBase + run.waitSpan * .95 * (1 - Math.exp(-elapsed / run.waitExpected));
            advanceLayoutProgress(estimate);
        } else advanceLayoutProgress(run.done);
    } else if (typeof app != 'undefined' && typeof app.updateProgress == 'function' && app.updateProgress(currentProgressValue, 100) === false) throwCancelled();
    return true;
}

function setLayoutProgressRange(base, length) {
    if (typeof layoutProgressRun == 'undefined' || !layoutProgressRun || !layoutProgressRun.active) return;
    layoutProgressRun.base = base; layoutProgressRun.length = length;
}

function layoutUnitProgress(done, total, text) {
    if (typeof layoutProgressRun != 'undefined' && layoutProgressRun && layoutProgressRun.active) {
        var run = layoutProgressRun;
        run.waiting = false;
        advanceLayoutProgress(run.base + run.length * Math.max(0, Math.min(1, done / Math.max(1, total))), text);
    } else progress(currentProgressValue, text);
}

function dialog(editingAction) {
    var dlg = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:14}"),
        pnLayout = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        chAutoRows = pnLayout.add('checkbox'),
        grRows = pnLayout.add("group{orientation:'row',alignChildren:['left','center'],spacing:8,margins:0}"),
        stRows = grRows.add("statictext{preferredSize:[125,-1]}"),
        edRows = grRows.add("edittext{characters:5}"),
        grRhythm = pnLayout.add("group{orientation:'row',alignChildren:['left','center'],spacing:8,margins:0}"),
        stRhythm = grRhythm.add("statictext{preferredSize:[125,-1]}"),
        dlRhythm = grRhythm.add("dropdownlist{preferredSize:[170,-1]}"),
        grAlign = pnLayout.add("group{orientation:'row',alignChildren:['left','center'],spacing:8,margins:0}"),
        stAlign = grAlign.add("statictext{preferredSize:[125,-1]}"),
        dlAlign = grAlign.add("dropdownlist{preferredSize:[170,-1]}"),
        chNoEnlarge = pnLayout.add('checkbox'),

        pnGaps = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        grGapX = pnGaps.add("group{orientation:'column',alignChildren:['fill','center'],spacing:0,margins:0}"),
        grGapXTitle = grGapX.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
        stGapXTitle = grGapXTitle.add("statictext{preferredSize:[210,-1]}"),
        stGapXValue = grGapXTitle.add("statictext{preferredSize:[45,-1],justify:'right'}"),
        slGapX = grGapX.add("slider{minvalue:0,maxvalue:30,preferredSize:[255,-1]}"),

        grGapY = pnGaps.add("group{orientation:'column',alignChildren:['fill','center'],spacing:0,margins:0}"),
        grGapYTitle = grGapY.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
        stGapYTitle = grGapYTitle.add("statictext{preferredSize:[210,-1]}"),
        stGapYValue = grGapYTitle.add("statictext{preferredSize:[45,-1],justify:'right'}"),
        slGapY = grGapY.add("slider{minvalue:0,maxvalue:30,preferredSize:[255,-1]}"),

        grGapMax = pnGaps.add("group{orientation:'column',alignChildren:['fill','center'],spacing:0,margins:0}"),
        grGapMaxTitle = grGapMax.add("group{orientation:'row',alignChildren:['left','center'],spacing:0,margins:0}"),
        stGapMaxTitle = grGapMaxTitle.add("statictext{preferredSize:[210,-1]}"),
        stGapMaxValue = grGapMaxTitle.add("statictext{preferredSize:[45,-1],justify:'right'}"),
        slGapMax = grGapMax.add("slider{minvalue:1,maxvalue:4,preferredSize:[255,-1]}"),

        pnAdditional = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        dlAlphabet = pnAdditional.add('dropdownlist'),
        chPythonPacking = pnAdditional.add('checkbox'),
        chAlternateGender = pnAdditional.add('checkbox'),
        chHeadTurn = pnAdditional.add('checkbox'),
        stColor = pnAdditional.add('statictext', undefined, str.colorTitle),
        dlColor = pnAdditional.add('dropdownlist'),
        stPythonStatus = pnAdditional.add("statictext{properties:{multiline:true},preferredSize:[255,-1]}"),
        pnPriority = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        grPriorityStart = pnPriority.add("group{orientation:'row',alignChildren:['left','center'],spacing:8}"),
        stPriorityStart = grPriorityStart.add("statictext{preferredSize:[125,-1]}"),
        dlPriorityStart = grPriorityStart.add("dropdownlist{preferredSize:[170,-1]}"),
        grPriorityEnd = pnPriority.add("group{orientation:'row',alignChildren:['left','center'],spacing:8}"),
        stPriorityEnd = grPriorityEnd.add("statictext{preferredSize:[125,-1]}"),
        dlPriorityEnd = grPriorityEnd.add("dropdownlist{preferredSize:[170,-1]}"),
        pnOutput = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        chGroupRows = pnOutput.add('checkbox'),
        pnAction = dlg.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:[10,18,10,10]}"),
        chLockAction = pnAction.add('checkbox'),

        grButtons = dlg.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:0}"),
        ok = grButtons.add('button', undefined, undefined, { name: 'ok' });

    dlg.addEventListener('keydown', function (event) {
        if (event.keyName == 'Escape') {
            event.preventDefault();
            dlg.close(2);
        }
    }, true);

    // Common panel edges and label column; native ScriptUI performs final sizing.
    grRows.alignment = grRhythm.alignment = grAlign.alignment = ['fill', 'center'];
    edRows.alignment = dlRhythm.alignment = dlAlign.alignment = ['fill', 'center'];
    grGapX.alignment = grGapY.alignment = grGapMax.alignment = ['fill', 'top'];
    grGapXTitle.alignment = grGapYTitle.alignment = grGapMaxTitle.alignment = ['fill', 'center'];
    stGapXTitle.alignment = stGapYTitle.alignment = stGapMaxTitle.alignment = ['fill', 'center'];
    stGapXValue.alignment = stGapYValue.alignment = stGapMaxValue.alignment = ['right', 'center'];
    slGapX.alignment = slGapY.alignment = slGapMax.alignment = ['fill', 'center'];
    stPythonStatus.alignment = ['fill', 'top'];
    dlColor.alignment = dlAlphabet.alignment = ['fill', 'center'];
    grPriorityStart.alignment = grPriorityEnd.alignment = ['fill', 'center'];
    dlPriorityStart.alignment = dlPriorityEnd.alignment = ['fill', 'center'];
    pnPriority.text = str.t('Приоритеты по меткам', 'Layer label priorities');
    stPriorityStart.text = str.t('В начале листа', 'At sheet beginning');
    stPriorityEnd.text = str.t('В конце листа', 'At sheet end');
    populatePriorityDropdown(dlPriorityStart, cfg.priorityStartLabel);
    populatePriorityDropdown(dlPriorityEnd, cfg.priorityEndLabel);
    dlPriorityStart.helpTip = dlPriorityEnd.helpTip = str.t('Строгий порядок для всего листа: начало, остальные, конец. Внутри категории действует выбранный способ раскладки.', 'Strict whole-sheet order: beginning, remaining photos, end. The selected layout policy applies within each category.');

    dlg.text = 'Auto layout ' + ver
    pnLayout.text = str.layoutPanel
    pnGaps.text = str.gapsPanel
    pnAdditional.text = str.additionalPanel
    pnOutput.text = str.outputPanel
    pnAction.text = str.actionPanel

    chAutoRows.text = str.autoRows
    stRows.text = str.rows
    stRhythm.text = str.verticalRhythm
    dlRhythm.add('item', str.rhythmAuto)
    dlRhythm.add('item', str.rhythmCenterWide)
    dlRhythm.add('item', str.rhythmEdgesWide)
    dlRhythm.add('item', str.rhythmAlternateWide)
    dlRhythm.add('item', str.rhythmAlternateNarrow)
    stAlign.text = str.horizontal
    dlAlign.add('item', str.alignLeft)
    dlAlign.add('item', str.alignCenter)
    dlAlign.add('item', str.alignRight)
    dlAlign.add('item', str.alignJustify)
    dlAlign.helpTip = str.t('Если блок не заполняет площадку при рассчитанных размерах и интервалах, он центрируется; короткие ряды сохраняют выравнивание внутри блока.', 'If the block does not fill its zone at the calculated sizes and gaps, the block is centered; shorter rows keep their alignment within it.');
    stGapXTitle.text = str.gapX
    stGapYTitle.text = str.gapY
    stGapMaxTitle.text = str.maxGap
    dlAlphabet.add('item', str.alphabetOff);
    dlAlphabet.add('item', str.alphabetPage);
    dlAlphabet.add('item', str.alphabetZone);
    dlAlphabet.helpTip = str.alphabetTip;
    chNoEnlarge.text = str.t('Не увеличивать размер слоёв', 'Do not enlarge layers');
    chNoEnlarge.helpTip = str.t('Масштаб не выше 100%. Уменьшение разрешено, увеличение запрещено. Если объекты уже помещаются, геометрический расчёт сохраняет их размер.', 'Scale is capped at 100%. Shrinking is allowed, enlargement is disabled. Geometry preserves the current sizes when they already fit.');
    chPythonPacking.text = str.pythonPacking;
    chPythonPacking.helpTip = str.pythonPackingTip;
    chAlternateGender.text = str.alternateGender
    chHeadTurn.text = str.headTurn
    chHeadTurn.helpTip = str.headTurnTip
    chGroupRows.text = str.groupRows
    ok.text = editingAction ? str.saveAction : str.layoutLayers
    chLockAction.text = str.lockAction
    chLockAction.helpTip = str.lockActionTip;
    if (editingAction && !cfg.lockForAction && !actionLayoutProfile) {
        chLockAction.enabled = false;
        chLockAction.helpTip = str.lockActionRecordFirst;
    }

    edRows.text = cfg.rows
    edRows.enabled = !cfg.autoRows
    var rhythmValues = ['auto', 'centerWide', 'edgesWide', 'alternateWide', 'alternateNarrow'],
        alignmentValues = ['left', 'center', 'right', 'justify'];
    setChoice(dlRhythm, rhythmValues, cfg.rowRhythm, 0);
    setChoice(dlAlign, alignmentValues, cfg.horizontalAlign, 1);
    slGapX.value = cfg.gapX
    slGapY.value = cfg.gapY
    slGapMax.value = cfg.maxGapMultiplier
    var pythonAvailability = pythonApi.getAvailability(),
        headAvailability = pythonApi.getHeadTurnAvailability(pythonAvailability);
    var colorModes = getColorModes();
    for (var cm = 0; cm < colorModes.length; cm++) dlColor.add('item', colorModes[cm].label);
    cfg.colorMode = normalizeColorMode(cfg.colorMode);
    dlColor.selection = dlColor.items[colorModeIndex(cfg.colorMode)];
    dlColor.enabled = pythonAvailability.available;
    dlColor.onChange = function () {
        if (dlColor.selection) cfg.colorMode = colorModeFromSelection(dlColor.selection);
    };
    dlColor.helpTip = str.colorTip;
    chHeadTurn.enabled = headAvailability.available;
    chAlternateGender.enabled = pythonAvailability.available
    stPythonStatus.visible = !pythonAvailability.available || !headAvailability.available || !!headAvailability.message
    stPythonStatus.text = pythonAvailability.available ? headAvailability.message :
        str.pythonUnavailablePrefix + pythonAvailability.message + '\n' + str.geometryWithoutPython
    if (!stPythonStatus.visible) pnAdditional.remove(stPythonStatus);
    var checkboxSettings = [
        [chNoEnlarge, 'noEnlarge'], [chAutoRows, 'autoRows'],
        [chPythonPacking, 'pythonPacking'], [chAlternateGender, 'alternateGender'],
        [chHeadTurn, 'considerHeadTurn'], [chGroupRows, 'groupRows'], [chLockAction, 'lockForAction']
    ];
    function bindCheckbox(control, key) {
        control.value = !!cfg[key];
        control.onClick = function () { cfg[key] = !!this.value; };
    }
    for (var cb = 0; cb < checkboxSettings.length; cb++)
        bindCheckbox(checkboxSettings[cb][0], checkboxSettings[cb][1]);
    chLockAction.onClick = function () { cfg.lockForAction = !!this.value; updateAdditionalEnabled(); };
    dlAlphabet.selection = dlAlphabet.items[cfg.alphabetOrder == 'page' ? 1 : cfg.alphabetOrder == 'zone' ? 2 : 0];
    dlAlphabet.enabled = true; // Always allow disabling a saved mode if Python is unavailable.
    dlAlphabet.onChange = function () { readAlphabetSelection(); updateAdditionalEnabled(); };
    updateAdditionalEnabled();

    function readAlphabetSelection() {
        var text = dlAlphabet.selection ? String(dlAlphabet.selection.text) : '';
        cfg.alphabetOrder = text == str.alphabetPage ? 'page' : text == str.alphabetZone ? 'zone' : 'off';
    }
    function updateAdditionalEnabled() {
        var normal = !alphabetOrderActive(),
            fixed = !!(editingAction && cfg.lockForAction && typeof actionLayoutProfile != 'undefined' && actionLayoutProfile);
        pnGaps.enabled = slGapX.enabled = slGapY.enabled = slGapMax.enabled = !fixed;
        pnGaps.helpTip = fixed ? str.t('Используются записанные в экшене интервалы X/Y в пикселях. Чтобы задать их заново, перезапишите экшен.', 'Uses the X/Y pixel gaps recorded in the action. Record the action again to set new gaps.') : '';
        chPythonPacking.enabled = normal && !fixed;
        chAlternateGender.enabled = normal && pythonAvailability.available;
        chHeadTurn.enabled = normal && headAvailability.available;
        dlColor.enabled = stColor.enabled = normal && pythonAvailability.available;
        updateGapLabels();
    }

    updateGapLabels()
    updateGapMaxTitle()

    chAutoRows.onClick = function () {
        cfg.autoRows = this.value
        edRows.enabled = !this.value
    }

    edRows.onChange = function () {
        var v = Math.round(Number(this.text));
        if (!isFinite(v) || v < 1) v = 1
        if (v > 999) v = 999
        cfg.rows = v
        this.text = v
    }

    function readChoice(control, values, fallback) {
        if (control.selection) for (var i = 0; i < control.items.length; i++)
            if (String(control.selection.text) == String(control.items[i].text)) return values[i];
        return fallback;
    }
    function readRhythmSelection() {
        cfg.rowRhythm = readChoice(dlRhythm, rhythmValues, 'auto');
    }
    function readAlignmentSelection() {
        cfg.horizontalAlign = readChoice(dlAlign, alignmentValues, 'center');
    }
    dlRhythm.onChange = readRhythmSelection;
    dlAlign.onChange = function () { readAlignmentSelection(); updateGapMaxTitle(); };

    slGapX.onChanging = function () {
        cfg.gapX = Math.round(this.value * 10) / 10
        updateGapLabels()
    }
    slGapX.onChange = slGapX.onChanging

    slGapY.onChanging = function () {
        cfg.gapY = Math.round(this.value * 10) / 10
        updateGapLabels()
    }
    slGapY.onChange = slGapY.onChanging

    slGapMax.onChanging = function () {
        this.value = Math.round(this.value)
        cfg.maxGapMultiplier = Math.max(1, Math.min(4, this.value))
        updateGapLabels()
    }
    slGapMax.onChange = slGapMax.onChanging

    ok.onClick = function () {
        cfg.priorityStartLabel = priorityDropdownValue(dlPriorityStart);
        cfg.priorityEndLabel = priorityDropdownValue(dlPriorityEnd);
        try { validatePrioritySettings(); } catch (priorityError) { alert(priorityError.message, 'Auto layout'); return; }
        // Read every visible control on OK. ScriptUI event delivery must not
        // determine either the saved settings or the options used for this run.
        for (var cb = 0; cb < checkboxSettings.length; cb++)
            cfg[checkboxSettings[cb][1]] = !!checkboxSettings[cb][0].value;
        cfg.rows = Math.max(1, Math.min(999, Math.round(Number(edRows.text) || 1)));
        cfg.gapX = Math.max(0, Math.min(30, Math.round(Number(slGapX.value) * 10) / 10 || 0));
        cfg.gapY = Math.max(0, Math.min(30, Math.round(Number(slGapY.value) * 10) / 10 || 0));
        cfg.maxGapMultiplier = Math.max(1, Math.min(4, Math.round(Number(slGapMax.value) || 1)));
        readRhythmSelection();
        readAlignmentSelection();
        readAlphabetSelection();
        // Read the selected item explicitly, even if ScriptUI skipped onChange.
        if (dlColor.selection) cfg.colorMode = colorModeFromSelection(dlColor.selection);
        if (editingAction && cfg.lockForAction && !actionLayoutProfile) {
            alert(str.lockActionRecordFirst, 'Auto layout');
            return;
        }
        dlg.close(1);
    };

    dlg.onShow = function () {
        ok.enabled = editingAction || canRun()
    }

    function setChoice(control, values, value, fallback) {
        var index = fallback;
        for (var i = 0; i < values.length; i++) if (values[i] == value) { index = i; break; }
        control.selection = index;
    }

    function updateGapLabels() {
        var fixed = !!(editingAction && cfg.lockForAction && typeof actionLayoutProfile != 'undefined' && actionLayoutProfile);
        stGapXValue.text = fixed ? round2(actionLayoutProfile.gapX) + ' px' : cfg.gapX + '%';
        stGapYValue.text = fixed ? round2(actionLayoutProfile.gapY) + ' px' : cfg.gapY + '%';
        stGapMaxValue.text = fixed ? '—' : '×' + cfg.maxGapMultiplier;
    }

    function updateGapMaxTitle() {
        stGapMaxTitle.text = cfg.horizontalAlign == 'justify' ? str.maxGapY : str.maxGap
    }

    return dlg
}

function canRun() {
    try {
        return !!(apl.getProperty('numberOfDocuments') &&
            doc.getProperty('selection') &&
            getSelectedLayerCount())
    } catch (e) {
        return false
    }
}

function getColorModes() {
    return [
        { key: 'off', label: str.colorOff },
        { key: 'harmonious', label: str.colorHarmonious },
        { key: 'contrast', label: str.colorContrast }
    ];
}

function normalizeColorMode(value) {
    var token = String(value);
    // Old profiles/actions migrate to the new neighbourhood objective.
    if (/^(harmonious|lightToDark|darkToLight|vividToMuted|mutedToVivid|1)$/.test(token)) return 'harmonious';
    if (token == 'contrast' || token == '2') return 'contrast';
    return 'off';
}

function colorModeIndex(value) {
    var mode = normalizeColorMode(value), modes = getColorModes();
    for (var i = 0; i < modes.length; i++) if (modes[i].key == mode) return i;
    return 0;
}

function colorModeFromSelection(selection) {
    if (!selection) return 'off';
    var text = String(selection.text), modes = getColorModes();
    for (var i = 0; i < modes.length; i++) if (text == modes[i].label) return modes[i].key;
    return 'off';
}



function Locale() {
    var locale = String($.locale || '').toLowerCase(),
        isRu = locale.indexOf('ru') == 0;
    this.t = function (ru, en) { return isRu ? ru : en; };

    this.layoutPanel = this.t('Раскладка', 'Layout');
    this.gapsPanel = this.t('Интервалы', 'Gaps');
    this.additionalPanel = this.t('Дополнительно', 'Additional');
    this.outputPanel = this.t('Результат', 'Result');
    this.actionPanel = this.t('Запись в экшен', 'Action recording');
    this.autoRows = this.t('автоматически подбирать количество рядов', 'automatically choose number of rows');
    this.rows = this.t('Количество рядов:', 'Number of rows:');
    this.verticalRhythm = this.t('Вертикальный ритм:', 'Vertical rhythm:');
    this.rhythmAuto = this.t('Авто', 'Auto');
    this.rhythmCenterWide = this.t('Шире к центру', 'Wider toward center');
    this.rhythmEdgesWide = this.t('Шире к краям', 'Wider toward edges');
    this.rhythmAlternateWide = this.t('Чередование — длинный сверху', 'Alternating — long row on top');
    this.rhythmAlternateNarrow = this.t('Чередование — короткий сверху', 'Alternating — short row on top');
    this.horizontal = this.t('По горизонтали:', 'Horizontal:');
    this.alignLeft = this.t('По левому краю', 'Left');
    this.alignCenter = this.t('По центру', 'Center');
    this.alignRight = this.t('По правому краю', 'Right');
    this.alignJustify = this.t('По ширине', 'Justify');
    this.gapX = this.t('Минимальный интервал X, %', 'Minimum gap X, %');
    this.gapY = this.t('Минимальный интервал Y, %', 'Minimum gap Y, %');
    this.maxGap = this.t('Максимальное увеличение', 'Maximum increase');
    this.maxGapY = this.t('Максимальное увеличение (Y)', 'Maximum increase (Y)');
    this.alphabetOff = this.t('Без сортировки по алфавиту', 'No alphabetical ordering');
    this.alphabetPage = this.t('По алфавиту в пределах страницы', 'Alphabetical across the page');
    this.alphabetZone = this.t('По алфавиту в пределах зоны', 'Alphabetical within each zone');
    this.alphabetTip = this.t('Фамилия и имя из названия слоя; номера и служебные приписки пропускаются. Нужен Python для разбора имён. Остальные дополнительные опции игнорируются.',
        'Surname and given name from the layer name; numbers and service labels are skipped. Python is required to parse names. Other additional options are ignored.');
    this.pythonPacking = this.t('рассчитывать заполнение площадок в Python', 'calculate zone packing in Python');
    this.pythonPackingTip = this.t(
        'Расширенный поиск геометрии. С М/Д, поворотом или цветом одежды — совместный подбор состава рядов и позиций, с потерей масштаба до 1%. Фиксированные экшены сохраняют размеры и интервалы. При недоступности сервера расчёт выполняет JSX.',
        'Extended geometry search. With gender, pose or clothing color enabled, jointly searches row composition and positions with at most 1% scale loss. Fixed actions preserve sizes and gaps. Falls back to JSX if the server is unavailable.');
    this.alternateGender = this.t('чередовать мальчиков и девочек', 'alternate boys and girls');
    this.headTurn = this.t('учитывать разворот тела и головы', 'consider body and head turn');
    this.headTurnTip = this.t(
        'Поворот лица, корпус и мягкое предпочтение наклона головы к центру. Запрокидывание не считается боковым поворотом.',
        'Face turn, body orientation, and a soft preference for head tilt toward the center. Looking up or down is not treated as a side turn.');
    this.colorTitle = this.t('Расстановка по цвету одежды:', 'Clothing color arrangement:');
    this.colorTip = this.t(
        'По всему листу, включая обмены между рядами и площадками. Близкие цвета рядом или контраст соседей; схема М/Д сохраняется, близкие повороты допускают обмен.',
        'Across the whole sheet, including swaps between rows and zones. Similar colors can be kept together or neighboring contrast maximized; the boy/girl pattern is preserved and similar poses may swap.');
    this.groupRows = this.t('объединять каждый ряд в группу', 'group each row');
    this.saveAction = this.t('Сохранить настройки экшена', 'Save action settings');
    this.layoutLayers = this.t('Разложить слои', 'Arrange layers');
    this.lockAction = this.t('фиксировать отступы и трансформацию', 'lock gaps and transform');
    this.lockActionTip = this.t(
        'В экшен записываются типичная высота объектов в пикселях и общие интервалы X/Y. Количество фото может меняться. При фиксации режим «По ширине» центрирует ряды с единым сохранённым X-интервалом. Масштаб определяется по типичной (медианной) высоте объектов.',
        'Records the typical object height in pixels and common X/Y gaps. Photo count may change. With locking enabled, Justify centers rows using the saved common X gap. Scale is based on the typical (median) object height.');
    this.lockActionRecordFirst = this.t(
        'Чтобы включить фиксацию, заново запишите шаг Auto Layout на готовой раскладке: масштаб и интервалы вычисляются только во время успешного запуска.',
        'To enable locking, record the Auto Layout step again on a completed layout: scale and gaps are calculated only during a successful run.');
    this.colorOff = this.t('Не учитывать', 'Do not use');
    this.colorHarmonious = this.t('Согласованные цвета', 'Harmonious colors');
    this.colorContrast = this.t('Максимальный контраст', 'Maximum contrast');
    this.pythonUnavailablePrefix = this.t('Python-функции недоступны: ', 'Python features are unavailable: ');
    this.geometryWithoutPython = this.t('Обычная геометрическая раскладка работает без Python.', 'Standard geometric layout works without Python.');
}

function Config() {
    var settingsObj = this;

    this.priorityStartLabel = 'off'
    this.priorityEndLabel = 'off'
    this.noEnlarge = false
    this.autoRows = true
    this.rows = 5
    this.rowRhythm = 'auto'
    this.horizontalAlign = 'center'
    this.gapX = 6
    this.gapY = 6
    this.maxGapMultiplier = 3
    this.alphabetOrder = 'off'
    this.alternateGender = false
    this.considerHeadTurn = false
    this.colorMode = 'off'
    this.pythonPacking = false
    this.lockForAction = false
    this.groupRows = true

    this.getScriptSettings = function (fromAction) {
        try {
            var d = fromAction ? app.playbackParameters : app.getCustomOptions(UUID);
            descriptorToObject(settingsObj, d)
        } catch (e) { }

        this.priorityStartLabel = normalizePriorityLabel(this.priorityStartLabel);
        this.priorityEndLabel = normalizePriorityLabel(this.priorityEndLabel);
        this.noEnlarge = this.noEnlarge === true;
        this.alphabetOrder = normalizeAlphabetOrder(this.alphabetOrder);
        this.colorMode = normalizeColorMode(this.colorMode);
        this.rows = Math.max(1, Math.round(Number(this.rows) || 1))
        if (this.rowRhythm != 'auto' && this.rowRhythm != 'centerWide' && this.rowRhythm != 'edgesWide' &&
            this.rowRhythm != 'alternateWide' && this.rowRhythm != 'alternateNarrow') this.rowRhythm = 'auto'
        if (this.horizontalAlign != 'left' && this.horizontalAlign != 'center' && this.horizontalAlign != 'right' && this.horizontalAlign != 'justify') this.horizontalAlign = 'center'
        this.gapX = Math.max(0, Math.min(30, Number(this.gapX) || 0))
        this.gapY = Math.max(0, Math.min(30, Number(this.gapY) || 0))
        this.maxGapMultiplier = Math.max(1, Math.min(4, Math.round(Number(this.maxGapMultiplier) || 1)))
    }

    this.putScriptSettings = function (toAction) {
        settingsObj.priorityStartLabel = normalizePriorityLabel(settingsObj.priorityStartLabel);
        settingsObj.priorityEndLabel = normalizePriorityLabel(settingsObj.priorityEndLabel);
        settingsObj.alphabetOrder = normalizeAlphabetOrder(settingsObj.alphabetOrder);
        settingsObj.colorMode = normalizeColorMode(settingsObj.colorMode);
        var d = objectToDescriptor(settingsObj);
        if (toAction) {
            d.putBoolean(app.stringIDToTypeID('inAction'), true);
            if (settingsObj.lockForAction) {
                validateLockedProfile(actionLayoutProfile);
                d.putBoolean(app.stringIDToTypeID('lockedReady'), true);
                d.putDouble(app.stringIDToTypeID('lockedScale'), actionLayoutProfile.scale);
                d.putDouble(app.stringIDToTypeID('lockedGapY'), actionLayoutProfile.gapY);
                d.putDouble(app.stringIDToTypeID('lockedGapX'), actionLayoutProfile.gapX);
                d.putDouble(app.stringIDToTypeID('lockedHeight'), actionLayoutProfile.height);
            }
            app.playbackParameters = d;
        } else app.putCustomOptions(UUID, d, true)
    }

    function descriptorToObject(o, d) {
        for (var i = 0; i < d.count; i++) {
            var k = d.getKey(i),
                t = d.getType(k),
                s = app.typeIDToStringID(k);

            if (!o.hasOwnProperty(String(s)) || typeof o[s] == 'function') continue;
            switch (t) {
                case DescValueType.BOOLEANTYPE: o[s] = d.getBoolean(k); break;
                case DescValueType.STRINGTYPE: o[s] = String(d.getString(k)); break;
                case DescValueType.DOUBLETYPE: o[s] = d.getDouble(k); break;
                case DescValueType.INTEGERTYPE: o[s] = d.getInteger(k); break;
            }
        }
    }

    function objectToDescriptor(o) {
        var d = new ActionDescriptor,
            properties = ['priorityStartLabel', 'priorityEndLabel', 'noEnlarge', 'autoRows', 'rows', 'rowRhythm', 'horizontalAlign', 'gapX', 'gapY', 'maxGapMultiplier', 'alphabetOrder', 'alternateGender', 'considerHeadTurn', 'colorMode', 'pythonPacking', 'lockForAction', 'groupRows'];

        for (var i = 0; i < properties.length; i++) {
            var key = properties[i],
                value = o[key],
                id = app.stringIDToTypeID(key);

            if (typeof value == 'boolean') d.putBoolean(id, value)
            else if (typeof value == 'number') d.putDouble(id, value)
            else if (typeof value == 'string') d.putString(id, value)
        }

        return d
    }
}

function readSelectedLayerSnapshot() {
    var sel = doc.getProperty('targetLayersIDs'), selected = [], output = [], descriptors = {};
    if (!sel || !sel.count) return { ids: output, descriptors: descriptors };

    for (var i = 0; i < sel.count; i++) {
        var id = sel.getReference(i).getIdentifier(), d = lr.getDescriptor(id, false), itemIndex = NaN;
        if (d && d.hasKey(s2t('itemIndex'))) itemIndex = d.getInteger(s2t('itemIndex'));
        else itemIndex = Number(lr.getProperty('itemIndex', id));
        if (!isFinite(itemIndex)) throw new Error(str.t('Не удалось определить положение выбранного слоя в палитре.', 'Could not determine the selected layer position in the Layers panel.'));
        selected.push({ id: id, itemIndex: itemIndex });
        if (d) descriptors[String(id)] = d;
    }

    selected.sort(function (a, b) { return a.itemIndex < b.itemIndex ? 1 : -1 });
    for (i = 0; i < selected.length; i++) output.push(selected[i].id);
    return { ids: output, descriptors: descriptors };
}

function collectDocumentState() {
    var snapshot = readSelectedLayerSnapshot(), ids = snapshot.ids;
    if (!ids.length) throw new Error(str.t('Не выбраны слои для раскладки.', 'No layers are selected for layout.'));

    // Keep these exact descriptors for buildInputPreparation/collectLayoutItems.
    // This removes the former second ActionManager read of every selected layer.
    selectedLayerDescriptorCache = snapshot.descriptors;
    var activeId = lr.getProperty('layerID');
    return {
        layerIds: ids.slice(0),
        activeLayerId: activeId,
        originalLayerIds: ids.slice(0),
        originalActiveLayerId: activeId
    };
}


function getSelectedLayerCount() {
    var sel = doc.getProperty('targetLayersIDs');
    return sel && sel.count ? sel.count : 0;
}

function selectedLayerSetMatches(ids) {
    if (!ids) return false;
    var sel = doc.getProperty('targetLayersIDs');
    if (!sel || sel.count != ids.length) return false;
    var wanted = {}, i;
    for (i = 0; i < ids.length; i++) wanted[String(ids[i])] = true;
    for (i = 0; i < sel.count; i++) {
        var id = sel.getReference(i).getIdentifier(), key = String(id);
        if (!wanted[key]) return false;
        delete wanted[key];
    }
    return true;
}

function collectSelectionGeometryWithHistory() {
    var originalHistory = activeDocument.activeHistoryState;
    try {
        app.activeDocument.suspendHistory('Auto layout selection', 'selectionGeometry = collectSelectionGeometry();');
        return selectionGeometry;
    } finally {
        // The temporary Work Path may replace a user's existing Work Path.
        // Restore the exact selection AND path before analysis and final Apply.
        try { activeDocument.activeHistoryState = originalHistory; }
        catch (restoreError) {
            var error = new Error(str.t('Не удалось восстановить выделение после чтения пути: ', 'Could not restore the selection after reading the path: ') + restoreError.message);
            error.autoLayoutRestoreFailure = true;
            throw error;
        }
    }
}

function collectSelectionGeometry() {
    if (!doc.getProperty('selection')) throw new Error(str.t('Сначала создайте выделение из прямоугольных областей.', 'First create a selection made of rectangular areas.'))

    var components,
        tempPathCreated = false;

    try {
        pth.makePathFromSelection(PATH_TOLERANCE)
        tempPathCreated = true
        var contents = pth.getProperty('pathContents');
        if (!contents || !contents.value) throw new Error(str.t('Не удалось получить геометрию выделения.', 'Could not read the selection geometry.'))
        components = pth.convertToObject(contents.value, 'pathComponents')
    } finally {
        // Work Path is only a temporary geometry carrier. Pixel selection itself
        // is never modified, so the exact original selection remains active.
        if (tempPathCreated) pth.deleteWorkPath()
    }

    var rawContours = getSelectionContours(components),
        contours = [],
        ci;

    for (ci = 0; ci < rawContours.length; ci++) {
        var normalized = normalizeContour(rawContours[ci].points, GEOMETRY_EPS);
        validateOrthogonalContour(normalized, GEOMETRY_EPS)
        contours.push({ points: normalized })
    }

    var bounds = getContoursBounds(contours);
    if (bounds.width <= GEOMETRY_EPS || bounds.height <= GEOMETRY_EPS)
        throw new Error(str.t('Размер выделения слишком мал.', 'The selection is too small.'))

    var bands = buildSelectionBandsFromContours(contours, GEOMETRY_EPS),
        isRectangle = contours.length == 1 && isRectangleContour(contours[0].points, bounds, GEOMETRY_EPS);

    if (!bands.length) throw new Error(str.t('Не удалось построить горизонтальные полосы выделения.', 'Could not build horizontal bands for the selection.'))

    // Connectivity is derived from the filled horizontal intervals themselves,
    // not from Photoshop path direction. This lets us reliably distinguish
    // separate selected islands from holes and open cut-outs in one island.
    var selectionComponents = buildConnectedSelectionComponents(bands, GEOMETRY_EPS),
        topology = analyzeSelectionTopology(selectionComponents, bands, GEOMETRY_EPS),
        hasMultipleIntervals = false;

    for (var bi = 0; bi < bands.length; bi++) {
        if (bands[bi].intervals.length > 1) {
            hasMultipleIntervals = true
            break;
        }
    }

    var multiZone = contours.length > 1 || selectionComponents.length > 1 || topology.holeCount > 0 ||
            hasMultipleIntervals || hasVerticalBandGaps(bands, GEOMETRY_EPS),
        stableZones = multiZone ? buildStableLayoutZones(bands, selectionComponents, GEOMETRY_EPS) : [];

    if (multiZone && !stableZones.length)
        throw new Error(str.t('Не удалось разделить выделение на доступные площадки.', 'Could not split the selection into available layout zones.'));

    return {
        bounds: bounds,
        contours: contours,
        bands: bands,
        yBreaks: getBandBreaks(bands),
        isRectangle: isRectangle,
        multiZone: multiZone,
        components: selectionComponents,
        componentCount: selectionComponents.length,
        zoneCount: stableZones.length,
        holes: topology.holes,
        holeCount: topology.holeCount,
        openCutouts: topology.openCutouts,
        openCutoutCount: topology.openCutoutCount,
        structureType: selectionComponents.length > 1 ? 'multiple' :
            (topology.holeCount > 0 ? 'singleWithHoles' :
            (isRectangle ? 'rectangle' : 'singleModified'))
    }
}

function getContoursBounds(contours) {
    var left = 1e100,
        top = 1e100,
        right = -1e100,
        bottom = -1e100;

    for (var c = 0; c < contours.length; c++) {
        var points = contours[c].points;
        for (var i = 0; i < points.length; i++) {
            if (points[i].x < left) left = points[i].x
            if (points[i].y < top) top = points[i].y
            if (points[i].x > right) right = points[i].x
            if (points[i].y > bottom) bottom = points[i].y
        }
    }

    return {
        left: left,
        top: top,
        right: right,
        bottom: bottom,
        width: right - left,
        height: bottom - top,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2
    }
}

function buildSelectionBandsFromContours(contours, eps) {
    var ys = [], i, c;
    for (c = 0; c < contours.length; c++) {
        for (i = 0; i < contours[c].points.length; i++)
            pushUniqueNumber(ys, contours[c].points[i].y, eps)
    }
    ys.sort(function (a, b) { return a - b })

    var bands = [];
    for (i = 0; i < ys.length - 1; i++) {
        var top = ys[i],
            bottom = ys[i + 1];
        if (bottom - top <= eps) continue;

        var y = top + (bottom - top) / 2,
            intervals = getContoursIntervalsAtY(contours, y, eps);

        if (!intervals.length) continue;
        bands.push({ top: top, bottom: bottom, intervals: intervals })
    }
    return bands
}

function getContoursIntervalsAtY(contours, y, eps) {
    var xs = [];

    for (var c = 0; c < contours.length; c++) {
        var points = contours[c].points;
        for (var i = 0; i < points.length; i++) {
            var a = points[i],
                b = points[(i + 1) % points.length];

            if (!near(a.x, b.x, eps)) continue;
            var minY = Math.min(a.y, b.y),
                maxY = Math.max(a.y, b.y);
            if (y > minY + eps * 0.01 && y < maxY - eps * 0.01)
                xs.push((a.x + b.x) / 2)
        }
    }

    xs.sort(function (a, b) { return a - b })
    if (xs.length % 2)
        throw new Error(str.t('Не удалось однозначно разобрать составное выделение. Проверьте, что оно создано только прямоугольными областями.', 'Could not parse the compound selection unambiguously. Make sure it was created using rectangular areas only.'))

    var intervals = [];
    for (i = 0; i < xs.length; i += 2) {
        if (xs[i + 1] - xs[i] > eps)
            intervals.push({ left: xs[i], right: xs[i + 1], width: xs[i + 1] - xs[i] })
    }
    return mergeIntervals(intervals, eps)
}

function buildConnectedSelectionComponents(bands, eps) {
    var nodes = [],
        parent = [],
        rank = [],
        bi, ii;

    for (bi = 0; bi < bands.length; bi++) {
        for (ii = 0; ii < bands[bi].intervals.length; ii++) {
            var interval = bands[bi].intervals[ii],
                nodeIndex = nodes.length;

            interval._componentNode = nodeIndex;
            interval.componentIndex = -1;
            nodes.push({
                nodeIndex: nodeIndex,
                bandIndex: bi,
                intervalIndex: ii,
                left: interval.left,
                right: interval.right,
                top: bands[bi].top,
                bottom: bands[bi].bottom
            });
            parent[nodeIndex] = nodeIndex;
            rank[nodeIndex] = 0;
        }
    }

    function findRoot(x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    }

    function unionNodes(a, b) {
        var ra = findRoot(a),
            rb = findRoot(b);
        if (ra == rb) return;
        if (rank[ra] < rank[rb]) parent[ra] = rb;
        else if (rank[ra] > rank[rb]) parent[rb] = ra;
        else {
            parent[rb] = ra;
            rank[ra]++;
        }
    }

    // Both interval lists are already sorted and internally disjoint. A two-
    // pointer sweep connects adjacent bands in O(A+B), instead of O(A*B).
    for (bi = 1; bi < bands.length; bi++) {
        var currentBand = bands[bi],
            previousBand = bands[bi - 1];
        if (Math.abs(currentBand.top - previousBand.bottom) > eps) continue;

        var ci = 0,
            pi = 0;
        while (ci < currentBand.intervals.length && pi < previousBand.intervals.length) {
            var current = currentBand.intervals[ci],
                previous = previousBand.intervals[pi];

            if (intervalsTouchOrOverlap(current, previous, eps))
                unionNodes(current._componentNode, previous._componentNode);

            if (current.right < previous.right - eps) ci++;
            else if (previous.right < current.right - eps) pi++;
            else { ci++; pi++; }
        }
    }

    var groups = {},
        components = [];

    for (var ni = 0; ni < nodes.length; ni++) {
        var root = findRoot(ni),
            key = String(root);
        if (!groups[key]) groups[key] = [];
        groups[key].push(nodes[ni]);
    }

    for (var groupKey in groups) {
        if (!groups.hasOwnProperty(groupKey)) continue;
        var groupNodes = groups[groupKey],
            left = 1e100,
            top = 1e100,
            right = -1e100,
            bottom = -1e100,
            filledArea = 0;

        for (var gn = 0; gn < groupNodes.length; gn++) {
            var n = groupNodes[gn];
            if (n.left < left) left = n.left;
            if (n.top < top) top = n.top;
            if (n.right > right) right = n.right;
            if (n.bottom > bottom) bottom = n.bottom;
            filledArea += (n.right - n.left) * (n.bottom - n.top);
        }

        components.push({
            componentIndex: -1,
            nodes: groupNodes,
            left: left,
            top: top,
            right: right,
            bottom: bottom,
            width: right - left,
            height: bottom - top,
            filledArea: filledArea,
            holes: [],
            openCutouts: [],
            zones: []
        });
    }

    components.sort(function (a, b) {
        if (Math.abs(a.top - b.top) > eps) return a.top - b.top;
        if (Math.abs(a.left - b.left) > eps) return a.left - b.left;
        if (Math.abs(a.bottom - b.bottom) > eps) return a.bottom - b.bottom;
        return a.right - b.right;
    });

    for (var componentIndex = 0; componentIndex < components.length; componentIndex++) {
        var component = components[componentIndex];
        component.componentIndex = componentIndex;
        component.bounds = {
            left: component.left,
            top: component.top,
            right: component.right,
            bottom: component.bottom,
            width: component.width,
            height: component.height,
            centerX: (component.left + component.right) / 2,
            centerY: (component.top + component.bottom) / 2
        };

        for (var cn = 0; cn < component.nodes.length; cn++) {
            var node = component.nodes[cn],
                sourceInterval = bands[node.bandIndex].intervals[node.intervalIndex];
            sourceInterval.componentIndex = componentIndex;
            try { delete sourceInterval._componentNode; } catch (e) { sourceInterval._componentNode = undefined; }
        }
    }

    return components;
}

function intervalsTouchOrOverlap(a, b, eps) {
    return Math.min(a.right, b.right) >= Math.max(a.left, b.left) - eps
}

function analyzeSelectionTopology(components, bands, eps) {
    var holes = [],
        openCutouts = [];

    for (var ci = 0; ci < components.length; ci++) {
        var result = analyzeComponentVoids(components[ci], bands, eps);
        components[ci].holes = result.holes
        components[ci].openCutouts = result.openCutouts
        components[ci].holeCount = result.holes.length
        components[ci].openCutoutCount = result.openCutouts.length

        for (var hi = 0; hi < result.holes.length; hi++) {
            result.holes[hi].componentIndex = ci
            holes.push(result.holes[hi])
        }
        for (var oi = 0; oi < result.openCutouts.length; oi++) {
            result.openCutouts[oi].componentIndex = ci
            openCutouts.push(result.openCutouts[oi])
        }
    }

    return {
        holes: holes,
        holeCount: holes.length,
        openCutouts: openCutouts,
        openCutoutCount: openCutouts.length
    }
}

function analyzeComponentVoids(component, bands, eps) {
    var yValues = [component.top, component.bottom],
        voidNodes = [],
        nodesBySlice = [],
        parent = [],
        rank = [],
        bi, yi;

    for (bi = 0; bi < bands.length; bi++) {
        if (bands[bi].bottom <= component.top + eps || bands[bi].top >= component.bottom - eps) continue;
        pushUniqueNumber(yValues, Math.max(component.top, bands[bi].top), eps);
        pushUniqueNumber(yValues, Math.min(component.bottom, bands[bi].bottom), eps);
    }
    yValues.sort(function (a, b) { return a - b; });

    for (yi = 0; yi < yValues.length - 1; yi++) {
        var top = yValues[yi],
            bottom = yValues[yi + 1];
        if (bottom - top <= eps) continue;

        var probeY = top + (bottom - top) / 2,
            filled = getComponentIntervalsAtYFromBands(component.componentIndex, bands, probeY,
                component.left, component.right, eps),
            gaps = complementIntervals(filled, component.left, component.right, eps);

        nodesBySlice[yi] = [];
        for (var gi = 0; gi < gaps.length; gi++) {
            var gap = gaps[gi],
                index = voidNodes.length,
                node = {
                    nodeIndex: index,
                    sliceIndex: yi,
                    left: gap.left,
                    right: gap.right,
                    top: top,
                    bottom: bottom,
                    area: (gap.right - gap.left) * (bottom - top),
                    touchesBoundary: gap.left <= component.left + eps || gap.right >= component.right - eps ||
                        top <= component.top + eps || bottom >= component.bottom - eps
                };
            voidNodes.push(node);
            nodesBySlice[yi].push(node);
            parent[index] = index;
            rank[index] = 0;
        }
    }

    function findRoot(x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    }

    function unionNodes(a, b) {
        var ra = findRoot(a),
            rb = findRoot(b);
        if (ra == rb) return;
        if (rank[ra] < rank[rb]) parent[ra] = rb;
        else if (rank[ra] > rank[rb]) parent[rb] = ra;
        else {
            parent[rb] = ra;
            rank[ra]++;
        }
    }

    // Voids can connect only between adjacent horizontal slices. Since each
    // slice is ordered and disjoint, use the same linear interval sweep.
    for (yi = 1; yi < nodesBySlice.length; yi++) {
        var previous = nodesBySlice[yi - 1] || [],
            current = nodesBySlice[yi] || [],
            aIndex = 0,
            bIndex = 0;
        while (aIndex < previous.length && bIndex < current.length) {
            var a = previous[aIndex],
                b = current[bIndex];
            if (Math.abs(a.bottom - b.top) <= eps && intervalsTouchOrOverlap(a, b, eps))
                unionNodes(a.nodeIndex, b.nodeIndex);

            if (a.right < b.right - eps) aIndex++;
            else if (b.right < a.right - eps) bIndex++;
            else { aIndex++; bIndex++; }
        }
    }

    var groups = {};
    for (var i = 0; i < voidNodes.length; i++) {
        var root = findRoot(i),
            key = String(root);
        if (!groups[key]) groups[key] = [];
        groups[key].push(voidNodes[i]);
    }

    var holes = [],
        openCutouts = [];

    for (var groupKey in groups) {
        if (!groups.hasOwnProperty(groupKey)) continue;
        var group = groups[groupKey],
            touchesBoundary = false,
            left = 1e100,
            regionTop = 1e100,
            right = -1e100,
            regionBottom = -1e100,
            area = 0;

        for (i = 0; i < group.length; i++) {
            var v = group[i];
            if (v.touchesBoundary) touchesBoundary = true;
            if (v.left < left) left = v.left;
            if (v.top < regionTop) regionTop = v.top;
            if (v.right > right) right = v.right;
            if (v.bottom > regionBottom) regionBottom = v.bottom;
            area += v.area;
        }

        var region = {
            left: left,
            top: regionTop,
            right: right,
            bottom: regionBottom,
            width: right - left,
            height: regionBottom - regionTop,
            area: area
        };
        if (touchesBoundary) openCutouts.push(region);
        else holes.push(region);
    }

    sortRegionsByReadingOrder(holes, eps);
    sortRegionsByReadingOrder(openCutouts, eps);
    return { holes: holes, openCutouts: openCutouts };
}

function getComponentIntervalsAtYFromBands(componentIndex, bands, y, left, right, eps) {
    var intervals = [];
    for (var i = 0; i < bands.length; i++) {
        var band = bands[i];
        if (y <= band.top + eps * 0.01 || y >= band.bottom - eps * 0.01) continue;

        for (var j = 0; j < band.intervals.length; j++) {
            var source = band.intervals[j];
            if (source.componentIndex != componentIndex) continue;
            var a = Math.max(left, source.left),
                b = Math.min(right, source.right);
            if (b - a > eps) intervals.push({ left: a, right: b, width: b - a });
        }
        break;
    }
    return mergeIntervals(intervals, eps);
}

function complementIntervals(intervals, left, right, eps) {
    var out = [],
        cursor = left;

    intervals = mergeIntervals(intervals, eps)
    for (var i = 0; i < intervals.length; i++) {
        var a = Math.max(left, intervals[i].left),
            b = Math.min(right, intervals[i].right);
        if (b <= left + eps || a >= right - eps) continue;
        if (a > cursor + eps) out.push({ left: cursor, right: a, width: a - cursor })
        if (b > cursor) cursor = b
    }
    if (cursor < right - eps) out.push({ left: cursor, right: right, width: right - cursor })
    return out
}

function sortRegionsByReadingOrder(regions, eps) {
    regions.sort(function (a, b) {
        if (Math.abs(a.top - b.top) > eps) return a.top - b.top
        if (Math.abs(a.left - b.left) > eps) return a.left - b.left
        if (Math.abs(a.bottom - b.bottom) > eps) return a.bottom - b.bottom
        return a.right - b.right
    })
}

function hasVerticalBandGaps(bands, eps) {
    for (var i = 1; i < bands.length; i++) {
        if (bands[i].top > bands[i - 1].bottom + eps) return true
    }
    return false
}

function buildStableLayoutZones(bands, components, eps) {
    var zones = [],
        active = [],
        nextActive,
        i, j, k;

    for (i = 0; i < components.length; i++) {
        components[i].zones = [];
        components[i].zoneCount = 0;
    }

    for (i = 0; i < bands.length; i++) {
        var band = bands[i];
        nextActive = [];

        for (j = 0; j < band.intervals.length; j++) {
            var interval = band.intervals[j],
                match = null;

            for (k = 0; k < active.length; k++) {
                var z = active[k];
                if (z.componentIndex == interval.componentIndex &&
                    Math.abs(z.bottom - band.top) <= eps &&
                    Math.abs(z.left - interval.left) <= eps &&
                    Math.abs(z.right - interval.right) <= eps) {
                    match = z;
                    break;
                }
            }

            if (match) {
                match.bottom = band.bottom;
                match.height = match.bottom - match.top;
                match.area = match.width * match.height;
                nextActive.push(match);
            } else {
                var zone = {
                    componentIndex: interval.componentIndex,
                    left: interval.left,
                    right: interval.right,
                    top: band.top,
                    bottom: band.bottom,
                    width: interval.right - interval.left,
                    height: band.bottom - band.top
                };
                zone.area = zone.width * zone.height;
                zones.push(zone);
                nextActive.push(zone);
            }
        }
        active = nextActive;
    }

    zones.sort(function (a, b) {
        if (Math.abs(a.top - b.top) > eps) return a.top - b.top;
        if (Math.abs(a.left - b.left) > eps) return a.left - b.left;
        if (Math.abs(a.bottom - b.bottom) > eps) return a.bottom - b.bottom;
        return a.right - b.right;
    });

    for (i = 0; i < zones.length; i++) {
        zones[i].zoneIndex = i;
        if (zones[i].componentIndex >= 0 && zones[i].componentIndex < components.length)
            components[zones[i].componentIndex].zones.push(zones[i]);
    }

    for (i = 0; i < components.length; i++)
        components[i].zoneCount = components[i].zones.length;

    return zones;
}

function flattenComponentZones(components) {
    var zones = [];
    for (var c = 0; c < components.length; c++) {
        var componentZones = components[c].zones || [];
        for (var z = 0; z < componentZones.length; z++) zones.push(componentZones[z]);
    }
    zones.sort(function (a, b) { return a.zoneIndex - b.zoneIndex; });
    return zones;
}

function getSelectionContours(components) {
    var contours = [],
        a, b, c;

    for (a in components) {
        var pc = components[a];
        if (!pc.subpathListKey) continue;

        for (b in pc.subpathListKey) {
            var slk = pc.subpathListKey[b];
            if (!slk.closedSubpath || !slk.points) continue;

            var points = [];
            for (c in slk.points) {
                var anchor = slk.points[c].anchor;
                if (!anchor || !anchor.horizontal || !anchor.vertical) continue;
                points.push({
                    x: getPathValue(anchor.horizontal),
                    y: getPathValue(anchor.vertical)
                });
            }
            if (points.length) contours.push({ points: points });
        }
    }

    if (!contours.length) throw new Error(str.t('Не удалось прочитать контур выделения.', 'Could not read the selection contour.'));
    return contours;
}

function getPathValue(v) {
    return Number(v._value != undefined ? v._value : v)
}

function normalizeContour(points, eps) {
    var out = [], i;

    for (i = 0; i < points.length; i++) {
        if (!out.length || !samePoint(out[out.length - 1], points[i], eps))
            out.push({ x: points[i].x, y: points[i].y })
    }

    if (out.length > 1 && samePoint(out[0], out[out.length - 1], eps)) out.pop()

    var changed = true;
    while (changed && out.length > 4) {
        changed = false;
        for (i = 0; i < out.length; i++) {
            var p0 = out[(i + out.length - 1) % out.length],
                p1 = out[i],
                p2 = out[(i + 1) % out.length];

            if ((near(p0.x, p1.x, eps) && near(p1.x, p2.x, eps)) ||
                (near(p0.y, p1.y, eps) && near(p1.y, p2.y, eps))) {
                out.splice(i, 1)
                changed = true
                break;
            }
        }
    }

    return out
}

function validateOrthogonalContour(points, eps) {
    if (points.length < 4) throw new Error(str.t('Контур выделения содержит слишком мало точек.', 'The selection contour contains too few points.'))

    for (var i = 0; i < points.length; i++) {
        var a = points[i],
            b = points[(i + 1) % points.length],
            vertical = near(a.x, b.x, eps),
            horizontal = near(a.y, b.y, eps);

        if (vertical == horizontal)
            throw new Error(str.t('Auto Layout поддерживает только прямоугольную геометрию без диагоналей и кривых.', 'Auto Layout supports rectangular geometry only, without diagonals or curves.'))
    }
}

function isRectangleContour(points, bounds, eps) {
    if (points.length != 4) return false

    var corners = [
        { x: bounds.left, y: bounds.top },
        { x: bounds.right, y: bounds.top },
        { x: bounds.right, y: bounds.bottom },
        { x: bounds.left, y: bounds.bottom }
    ],
        found = [false, false, false, false];

    for (var i = 0; i < points.length; i++) {
        var match = -1;
        for (var j = 0; j < corners.length; j++) {
            if (samePoint(points[i], corners[j], eps)) {
                match = j
                break;
            }
        }
        if (match < 0 || found[match]) return false
        found[match] = true
    }
    return true
}



function getBandBreaks(bands) {
    var out = [];
    for (var i = 0; i < bands.length; i++) {
        pushUniqueNumber(out, bands[i].top, GEOMETRY_EPS)
        pushUniqueNumber(out, bands[i].bottom, GEOMETRY_EPS)
    }
    out.sort(function (a, b) { return a - b })
    return out
}

function getIntervalsForVerticalSpan(geometry, top, bottom) {
    var eps = FIT_EPS,
        current = null,
        coveredTop = top,
        touched = false;

    if (bottom - top <= eps || top < geometry.bounds.top - eps || bottom > geometry.bounds.bottom + eps)
        return []

    for (var i = 0; i < geometry.bands.length; i++) {
        var band = geometry.bands[i],
            overlapTop = Math.max(top, band.top),
            overlapBottom = Math.min(bottom, band.bottom);

        if (overlapBottom - overlapTop <= eps * 0.01) continue;
        touched = true

        if (overlapTop > coveredTop + eps) return []
        coveredTop = Math.max(coveredTop, overlapBottom)

        current = current == null ? copyIntervals(band.intervals) : intersectIntervals(current, band.intervals, eps)
        if (!current.length) return []
    }

    if (!touched || coveredTop < bottom - eps) return []
    return current
}

function intersectIntervals(a, b, eps) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
        for (var j = 0; j < b.length; j++) {
            var left = Math.max(a[i].left, b[j].left),
                right = Math.min(a[i].right, b[j].right);
            if (right - left > eps)
                out.push({ left: left, right: right, width: right - left })
        }
    }
    return mergeIntervals(out, eps)
}

function mergeIntervals(intervals, eps) {
    if (!intervals.length) return []
    intervals.sort(function (a, b) { return a.left - b.left })

    var out = [{ left: intervals[0].left, right: intervals[0].right }];
    for (var i = 1; i < intervals.length; i++) {
        var last = out[out.length - 1],
            cur = intervals[i];
        if (cur.left <= last.right + eps) {
            if (cur.right > last.right) last.right = cur.right
        } else {
            out.push({ left: cur.left, right: cur.right })
        }
    }
    for (i = 0; i < out.length; i++) out[i].width = out[i].right - out[i].left
    return out
}

function copyIntervals(intervals) {
    var out = [];
    for (var i = 0; i < intervals.length; i++)
        out.push({ left: intervals[i].left, right: intervals[i].right, width: intervals[i].right - intervals[i].left })
    return out
}

function pushUniqueNumber(a, value, eps) {
    for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - value) <= eps) return;
    a.push(value)
}


// One full ActionManager descriptor per layer, using the bottom-up group
// boundaries from the user's Layers - parse layers pallette to object example.
function readPreparationLayer(d, index) {
    function has(key) { return d.hasKey(s2t(key)); }
    var section = has('layerSection') ? typeIDToStringID(d.getEnumerationValue(s2t('layerSection'))) : 'layerSectionContent';
    if (section == 'layerSectionEnd') return { section: section };
    var node = { id: d.getInteger(s2t('layerID')), name: d.getString(s2t('name')),
        kind: has('layerKind') ? d.getInteger(s2t('layerKind')) : 7, section: section,
        colorLabel: readLayerColorLabel(d),
        itemIndex: index, parentId: null, children: [], links: [], text: '', clipped: has('group') && d.getBoolean(s2t('group')),
        background: has('background') && d.getBoolean(s2t('background')),
        artboard: has('artboardEnabled') && d.getBoolean(s2t('artboardEnabled')), locking: {}, blendMode: '' };
    if (has('layerLocking')) node.locking = lr.descToObject(d.getObjectValue(s2t('layerLocking')));
    if (has('mode')) node.blendMode = typeIDToStringID(d.getEnumerationValue(s2t('mode')));
    if (has('textKey')) {
        var text = d.getObjectValue(s2t('textKey'));
        if (text.hasKey(s2t('textKey'))) node.text = text.getString(s2t('textKey')).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }
    if (has('linkedLayerIDs')) {
        var list = d.getList(s2t('linkedLayerIDs'));
        for (var i = 0; i < list.count; i++) {
            var type = list.getType(i), linkedId;
            if (type == DescValueType.INTEGERTYPE) linkedId = list.getInteger(i);
            else if (type == DescValueType.REFERENCETYPE) linkedId = list.getReference(i).getIdentifier();
            else throw new Error(str.t('Не удалось прочитать связи слоя "', 'Could not read links for layer "') + node.name + str.t('".', '".'));
            if (linkedId != node.id && !arrayContains(node.links, linkedId)) node.links.push(linkedId);
        }
    }
    return node;
}

function collectPreparationLayers() {
    var from = doc.getProperty('hasBackgroundLayer') ? 0 : 1, to = doc.getProperty('numberOfLayers'),
        containers = [[]], nodes = [], byId = {};
    for (var i = from; i <= to; i++) {
        if ((i - from) % 20 == 0) progress(0, 'Structure ' + (i - from) + '/' + (to - from + 1));
        var d = lr.getDescriptor(i, true);
        if (!d) throw new Error(str.t('Не удалось прочитать структуру слоёв.', 'Could not read the layer structure.'));
        var node = readPreparationLayer(d, i);
        if (node.section == 'layerSectionEnd') { containers.push([]); continue; }
        if (node.section == 'layerSectionStart') {
            if (containers.length < 2) throw new Error(str.t('Нарушена структура групп документа.', 'The document group structure is invalid.'));
            node.children = containers.pop();
            for (var c = 0; c < node.children.length; c++) node.children[c].parentId = node.id;
        }
        nodes.push(node); byId[String(node.id)] = node;
        containers[containers.length - 1].push(node);
    }
    if (containers.length != 1) throw new Error(str.t('Незавершённая структура групп документа.', 'The document group structure is incomplete.'));
    return { nodes: nodes, byId: byId, roots: containers[0] };
}

function buildInputPreparation(ids) {
    var needed = false, cache = selectedLayerDescriptorCache || {};
    // The snapshot belongs to the current unmodified document only. If input
    // preparation becomes necessary it is discarded before Photoshop changes it.
    selectedLayerDescriptorCache = null;
    for (var i = 0; i < ids.length; i++) {
        if (i % 20 == 0) progress(0, 'Selection ' + i + '/' + ids.length);
        var key = String(ids[i]), d = cache[key] || lr.getDescriptor(ids[i], false);
        if (!d) throw new Error(str.t('Один из выбранных слоёв недоступен.', 'One of the selected layers is unavailable.'));
        cache[key] = d;
        var node = readPreparationLayer(d, 0);
        if (node.section == 'layerSectionStart' || node.links.length) needed = true;
    }
    // If no preparation is required, the same descriptors can also supply
    // bounds/type/name to collectLayoutItems with no additional AM round-trip.
    selectedLayerDescriptorCache = needed ? null : cache;
    if (!needed) return null;
    return planInputPreparation(collectPreparationLayers(), ids);
}

function planInputPreparation(tree, selectedIds) {
    var selected = {}, owner = {}, visited = {}, units = [], byId = tree.byId, incoming = {}, i, j;
    for (i = 0; i < selectedIds.length; i++) {
        if (!byId[String(selectedIds[i])]) throw new Error(str.t('Выбранный слой отсутствует в структуре документа.', 'A selected layer is missing from the document structure.'));
        selected[String(selectedIds[i])] = true;
    }
    for (i = 0; i < tree.nodes.length; i++) {
        var node = tree.nodes[i], parent = node, top = node.id;
        while (parent) {
            if (selected[String(parent.id)] && parent.section == 'layerSectionStart') top = parent.id;
            parent = parent.parentId == null ? null : byId[String(parent.parentId)];
        }
        owner[String(node.id)] = top;
        for (j = 0; j < node.links.length; j++) {
            var key = String(node.links[j]);
            if (!byId[key]) throw new Error(str.t('Связь слоя "', 'A link from layer "') + node.name + str.t('" указывает на отсутствующий слой.', '" points to a missing layer.'));
            if (!incoming[key]) incoming[key] = [];
            incoming[key].push(node.id);
        }
    }
    for (i = 0; i < selectedIds.length; i++) {
        var start = owner[String(selectedIds[i])];
        if (visited[String(start)]) continue;
        var queue = [start], members = {}, all = [];
        for (var q = 0; q < queue.length; q++) {
            var id = queue[q], owned = owner[String(id)];
            if (owned != id) { queue.push(owned); continue; }
            key = String(id);
            if (members[key]) continue;
            node = byId[key]; members[key] = true; visited[key] = true; all.push(node);
            for (j = 0; j < node.children.length; j++) {
                // A group contains its children even though their selected owner
                // is the group itself: inspect their links as well.
                var descend = [node.children[j]];
                for (var di = 0; di < descend.length; di++) {
                    var child = descend[di], ck = String(child.id);
                    if (!members[ck]) { members[ck] = true; visited[ck] = true; all.push(child); }
                    queue = queue.concat(child.links, incoming[ck] || []);
                    for (var ci = 0; ci < child.children.length; ci++) descend.push(child.children[ci]);
                }
            }
            queue = queue.concat(node.links, incoming[key] || []);
        }
        var roots = [], texts = [], seenText = {};
        all.sort(function (a, b) { return b.itemIndex - a.itemIndex; });
        for (j = 0; j < all.length; j++) {
            node = all[j];
            if (node.parentId == null || !members[String(node.parentId)]) roots.push(node);
            if (node.kind == 3 && node.text && !seenText['$' + node.text]) { texts.push(node.text); seenText['$' + node.text] = true; }
        }
        var convert = roots.length > 1 || roots[0].section == 'layerSectionStart';
        if (!convert && roots[0].kind != 1 && roots[0].kind != 4 && roots[0].kind != 5)
            throw new Error(str.t('Слой "', 'Layer "') + roots[0].name + str.t('": включите текст/коррекцию в группу или связанный набор.', '": include the text/adjustment layer in a group or linked set.'));
        var parentId = roots[0].parentId;
        for (j = 0; j < roots.length; j++) {
            node = roots[j];
            if (node.artboard) throw new Error(str.t('Артборд нельзя преобразовать как обычную группу. Выберите группы внутри него.', 'An artboard cannot be processed as a regular group. Select groups inside the artboard instead.'));
            if (node.parentId != parentId) throw new Error(str.t('Связанные слои находятся в разных родительских группах. Объединение может изменить маски и оформление; перенесите набор в один контейнер.', 'Linked layers are in different parent groups. Combining them may change masks or appearance; move the set into one container.'));
            for (parent = node; parent; parent = parent.parentId == null ? null : byId[String(parent.parentId)])
                if (parent.background || parent.locking.protectAll || parent.locking.protectPosition || parent.locking.protectComposite)
                    throw new Error(str.t('Набор содержит заблокированный слой или родительскую группу "', 'The set contains a locked layer or parent group "') + parent.name + str.t('".', '".'));
            if (node.section == 'layerSectionStart' && !node.children.length) throw new Error(str.t('Группа "', 'Group "') + node.name + str.t('" пуста.', '" is empty.'));
        }
        var fallback = roots[0], rank = { '5': 4, '1': 3, '7': 2, '4': 1, '3': 0 };
        for (j = 1; j < roots.length; j++) if ((rank[String(roots[j].kind)] || 0) > (rank[String(fallback.kind)] || 0)) fallback = roots[j];
        var unit = { roots: roots, members: all, convert: convert, name: convert && texts.length ? texts.join(' ') : fallback.name,
            order: roots[0].itemIndex, priority: priorityForRoots(roots) };
        if (convert) validatePreparationContext(unit, tree);
        units.push(unit);
    }
    units.sort(function (a, b) { return b.order - a.order; });
    return { units: units, tree: tree, originalSelectedIds: selectedIds.slice(0) };
}

function validatePreparationContext(unit, tree) {
    var roots = {}, members = {}, i, j, node, parentId = unit.roots[0].parentId,
        siblings = parentId == null ? tree.roots.slice(0) : tree.byId[String(parentId)].children.slice(0);
    for (i = 0; i < unit.roots.length; i++) roots[String(unit.roots[i].id)] = true;
    for (i = 0; i < unit.members.length; i++) members[String(unit.members[i].id)] = true;
    siblings.sort(function (a, b) { return b.itemIndex - a.itemIndex; });
    for (i = 0; i < siblings.length; i++) {
        var chain = [siblings[i]];
        while (siblings[i].clipped && i + 1 < siblings.length) chain.push(siblings[++i]);
        var included = 0;
        for (j = 0; j < chain.length; j++) if (roots[String(chain[j].id)]) included++;
        if (included && (included != chain.length || chain[chain.length - 1].clipped)) throw new Error(str.t('Набор включает только часть цепочки обтравки. Добавьте её целиком в группу или связь.', 'The set contains only part of a clipping chain. Include the entire chain in the group or linked set.'));
    }
    for (i = 0; i < unit.members.length; i++) {
        node = unit.members[i];
        var blending = node.section != 'layerSectionStart' && node.blendMode && node.blendMode != 'normal';
        if ((node.kind != 2 && !blending) || node.clipped) continue;
        // An unclipped adjustment only stays local if an enclosing non-pass-
        // through group is already part of this self-contained object.
        var p = node.parentId == null ? null : tree.byId[String(node.parentId)], isolated = false;
        while (p && members[String(p.id)]) {
            if (p.blendMode && p.blendMode != 'passThrough') { isolated = true; break; }
            if (roots[String(p.id)]) break;
            p = p.parentId == null ? null : tree.byId[String(p.parentId)];
        }
        if (!isolated) throw new Error(str.t('Коррекция или режим наложения слоя "', 'The adjustment or blend mode of layer "') + node.name + str.t('" может влиять на слои вне набора. Изолируйте его в группе с обычным режимом наложения.', '" may affect layers outside the set. Isolate it in a group using Normal blend mode.'));
    }
}

function prepareLayoutSources() {
    var ids = [], activeId = null;
    for (var i = 0; i < inputPreparation.units.length; i++) {
        var unit = inputPreparation.units[i], roots = [];
        layoutUnitProgress(i, inputPreparation.units.length, 'Objects ' + i + '/' + inputPreparation.units.length);
        for (var r = 0; r < unit.roots.length; r++) roots.push(unit.roots[r].id);
        lr.selectLayers(roots);
        if (unit.convert) {
            if (roots.length > 1) lr.groupSelectedLayers();
            lr.convertToSmartObject();
            lr.setLayerName(unit.name);
        }
        var id = lr.getProperty('layerID');
        if (!isFinite(Number(id)) || (unit.convert && lr.getProperty('layerKind', id) != 5)) throw new Error(str.t('Не удалось подготовить смарт-объект "', 'Could not prepare Smart Object "') + unit.name + str.t('".', '".'));
        ids.push(id);
        for (r = 0; r < unit.members.length; r++)
            if (unit.members[r].id == sourceState.originalActiveLayerId) activeId = id;
        layoutUnitProgress(i + 1, inputPreparation.units.length, 'Objects ' + (i + 1) + '/' + inputPreparation.units.length);
    }
    sourceState.layerIds = ids;
    sourceState.activeLayerId = activeId == null ? ids[0] : activeId;
    restoreLayerSelection(ids, sourceState.activeLayerId);
}

function commitPreparedLayout() {
    var preparedMap = null;
    runLayoutProgressStage('Restoring source objects', function () {
        preparedMap = buildPreparedOriginalMap();
        validateOriginalPreparationUnits(preparedMap);
        // The temporary proxy IDs disappeared when main() restored the original
        // History state. From this point the public selection state refers only
        // to the user's original layers/groups again.
        sourceState.layerIds = sourceState.originalLayerIds.slice(0);
        sourceState.activeLayerId = sourceState.originalActiveLayerId;
        layoutUnitProgress(1, 1, 'Source groups and links restored');
    });
    applyPreparedLayoutPlan(preparedMap);
}

function buildPreparedOriginalMap() {
    if (!inputPreparation || !preparedAnalysisItems || inputPreparation.units.length != preparedAnalysisItems.length)
        throw new Error(str.t('Потеряно соответствие временных объектов исходным группам.', 'The mapping between temporary objects and source groups was lost.'));

    var byProxyId = {}, placementByProxyId = {}, i;
    for (i = 0; i < layoutPlan.placements.length; i++)
        placementByProxyId[String(layoutPlan.placements[i].layerId)] = layoutPlan.placements[i];

    for (i = 0; i < inputPreparation.units.length; i++) {
        var unit = inputPreparation.units[i], proxy = preparedAnalysisItems[i], roots = [], r;
        if (!proxy || placementByProxyId[String(proxy.id)] == undefined)
            throw new Error(str.t('Потеряно соответствие позиции объекту "', 'The position mapping was lost for object "') + (unit.name || '') + str.t('".', '".'));
        for (r = 0; r < unit.roots.length; r++) roots.push(unit.roots[r].id);
        byProxyId[String(proxy.id)] = {
            unit: unit,
            roots: roots,
            proxy: proxy,
            placement: placementByProxyId[String(proxy.id)]
        };
    }
    return byProxyId;
}

function validateOriginalPreparationUnits(preparedMap) {
    var usedRoots = {}, mapped = 0, proxyKey, r;
    for (proxyKey in preparedMap) if (preparedMap.hasOwnProperty(proxyKey)) {
        mapped++;
        var entry = preparedMap[proxyKey];
        if (!entry.roots.length) throw new Error(str.t('У подготовленного объекта отсутствуют исходные слои.', 'A prepared object has no source layers.'));
        for (r = 0; r < entry.unit.roots.length; r++) {
            var original = entry.unit.roots[r], key = String(original.id), d = lr.getDescriptor(original.id, false);
            if (!d) throw new Error(str.t('Исходный слой "', 'Source layer "') + original.name + str.t('" не восстановился.', '" was not restored.'));
            var current = readPreparationLayer(d, original.itemIndex);
            if (!current || current.section == 'layerSectionEnd' || current.name != original.name || current.kind != original.kind)
                throw new Error(str.t('Исходная группа/слой "', 'Source group/layer "') + original.name + str.t('" восстановилась в другом состоянии. Раскладка остановлена.', '" was restored in a different state. Layout has been stopped.'));
            if (usedRoots[key]) throw new Error(str.t('Один исходный слой попал сразу в несколько объектов раскладки.', 'One source layer was assigned to multiple layout objects.'));
            usedRoots[key] = true;
        }
    }
    if (mapped != inputPreparation.units.length || mapped != layoutPlan.placements.length)
        throw new Error(str.t('Количество исходных объектов не совпадает с рассчитанной раскладкой.', 'The number of source objects does not match the calculated layout.'));
}

function getPreparedUnitTransformBounds(rootIds) {
    var result = null;
    for (var i = 0; i < rootIds.length; i++) {
        var property = lr.getProperty('boundsNoEffects', rootIds[i]);
        if (!property || !property.value) throw new Error(str.t('Не удалось получить границы исходной группы/слоя.', 'Could not get the bounds of the source group/layer.'));
        var b = lr.descToObject(property.value), left = Number(b.left), top = Number(b.top), right = Number(b.right), bottom = Number(b.bottom);
        if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom) || right <= left || bottom <= top)
            throw new Error(str.t('Исходная группа/слой имеет некорректные границы трансформации.', 'The source group/layer has invalid transform bounds.'));
        if (!result) result = { left: left, top: top, right: right, bottom: bottom };
        else {
            if (left < result.left) result.left = left;
            if (top < result.top) result.top = top;
            if (right > result.right) result.right = right;
            if (bottom > result.bottom) result.bottom = bottom;
        }
    }
    result.centerX = (result.left + result.right) / 2;
    result.centerY = (result.top + result.bottom) / 2;
    return result;
}

function applyPreparedLayoutPlan(preparedMap) {
    if (!preparedMap) throw new Error(str.t('Нет соответствия исходным группам.', 'Source group mapping is missing.'));
    var scale = layoutPlan.commonScale, total = layoutPlan.placements.length, i;
    if (!isFinite(scale) || scale <= 0) throw new Error(str.t('Некорректный общий масштаб.', 'Invalid common scale.'));

    // Derive one affine transform per original layout-unit. The temporary proxy
    // defines the visual bbox, while QCSAverage uses the native root-set bbox as
    // the transform centre. The offset below compensates that difference exactly.
    runLayoutProgressStage('Calculating object transforms', function () {
        for (i = 0; i < total; i++) {
            var p = layoutPlan.placements[i], entry = preparedMap[String(p.layerId)];
            if (!entry) throw new Error(str.t('Не найден исходный объект для "', 'Source object not found for "') + p.name + str.t('".', '".'));
            layoutUnitProgress(i, total, i + '/' + total);
            var transformBounds = getPreparedUnitTransformBounds(entry.roots),
                cx = transformBounds.centerX, cy = transformBounds.centerY,
                scaledProxyLeft = cx + (entry.proxy.left - cx) * scale,
                scaledProxyTop = cy + (entry.proxy.top - cy) * scale;
            entry.transformOffsetX = p.left - scaledProxyLeft;
            entry.transformOffsetY = p.top - scaledProxyTop;
            entry.expectedBounds = {
                left: cx + (transformBounds.left - cx) * scale + entry.transformOffsetX,
                top: cy + (transformBounds.top - cy) * scale + entry.transformOffsetY,
                right: cx + (transformBounds.right - cx) * scale + entry.transformOffsetX,
                bottom: cy + (transformBounds.bottom - cy) * scale + entry.transformOffsetY
            };
            if (!isFinite(entry.transformOffsetX) || !isFinite(entry.transformOffsetY))
                throw new Error(str.t('Не удалось рассчитать трансформацию исходного объекта "', 'Could not calculate the transform for source object "') + p.name + str.t('".', '".'));
            layoutUnitProgress(i + 1, total, (i + 1) + '/' + total);
        }
    });

    runLayoutProgressStage('Transforming source objects', function () {
        for (i = 0; i < total; i++) {
            var p = layoutPlan.placements[i], entry = preparedMap[String(p.layerId)];
            layoutUnitProgress(i, total, i + '/' + total);
            lr.selectLayers(entry.roots);
            if (cfg.noEnlarge && scale > 1 + 1e-12) throw new Error(str.t('Увеличение слоёв запрещено.', 'Layer enlargement is disabled.'));
            if (cfg.noEnlarge && Math.abs(scale - 1) <= 1e-12) {
                if (Math.abs(entry.transformOffsetX) > 0.0001 || Math.abs(entry.transformOffsetY) > 0.0001)
                    lr.move(entry.transformOffsetX, entry.transformOffsetY);
            } else if (Math.abs(scale - 1) > 0.0000001 || Math.abs(entry.transformOffsetX) > 0.0001 || Math.abs(entry.transformOffsetY) > 0.0001)
                lr.transformSelection(scale * 100, entry.transformOffsetX, entry.transformOffsetY);
            if (layoutPlan.lockedMetrics)
                validateAppliedBounds(entry.expectedBounds, getPreparedUnitTransformBounds(entry.roots), p.name);
            layoutUnitProgress(i + 1, total, (i + 1) + '/' + total);
        }
    });

    if (cfg.groupRows) runLayoutProgressStage('Grouping rows', function () { groupLayoutRows(layoutPlan.rows, preparedMap); });
}

function readLayoutLayerDescriptor(d, fallbackId, order) {
    function has(key) { return d.hasKey(s2t(key)); }
    function numberFrom(desc, key) {
        if (!desc || !desc.hasKey(s2t(key))) return NaN;
        var type = desc.getType(s2t(key));
        if (type == DescValueType.UNITDOUBLE) return Number(desc.getUnitDoubleValue(s2t(key)));
        if (type == DescValueType.DOUBLETYPE) return Number(desc.getDouble(s2t(key)));
        if (type == DescValueType.INTEGERTYPE) return Number(desc.getInteger(s2t(key)));
        return NaN;
    }

    if (!d) throw new Error(str.t('Один из выбранных слоёв недоступен.', 'One of the selected layers is unavailable.'));
    var id = has('layerID') ? d.getInteger(s2t('layerID')) : fallbackId,
        name = has('name') ? d.getString(s2t('name')) : '',
        kind = has('layerKind') ? d.getInteger(s2t('layerKind')) : 7,
        background = has('background') && d.getBoolean(s2t('background')),
        locking = has('layerLocking') ? lr.descToObject(d.getObjectValue(s2t('layerLocking'))) : null,
        itemIndex = has('itemIndex') ? d.getInteger(s2t('itemIndex')) : NaN,
        boundsDesc = has('boundsNoEffects') ? d.getObjectValue(s2t('boundsNoEffects')) : null;

    if (kind != 1 && kind != 4 && kind != 5)
        throw new Error(str.t('Слой "', 'Layer "') + name + str.t('" имеет неподдерживаемый тип. Используются пиксельные слои, векторные shape-слои и Smart Object.', '" has an unsupported type. Pixel layers, vector shape layers, and Smart Objects are supported.'));
    if (background)
        throw new Error(str.t('Фоновый слой "', 'Background layer "') + name + str.t('" нельзя перемещать. Сначала преобразуйте его в обычный слой.', '" cannot be moved. Convert it to a regular layer first.'));
    if (locking && (locking.protectAll || locking.protectPosition || locking.protectComposite))
        throw new Error(str.t('Слой "', 'Layer "') + name + str.t('" заблокирован для перемещения или трансформации.', '" is locked against moving or transforming.'));
    if (!boundsDesc)
        throw new Error(str.t('Не удалось получить boundsNoEffects слоя "', 'Could not get boundsNoEffects for layer "') + name + str.t('".', '".'));
    if (!isFinite(itemIndex))
        throw new Error(str.t('Не удалось получить позицию слоя "', 'Could not get the Layers panel position of layer "') + name + str.t('" в палитре слоёв.', '".'));

    var bounds = {
        left: numberFrom(boundsDesc, 'left'),
        top: numberFrom(boundsDesc, 'top'),
        right: numberFrom(boundsDesc, 'right'),
        bottom: numberFrom(boundsDesc, 'bottom')
    };
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
    bounds.centerX = bounds.left + bounds.width / 2;
    bounds.centerY = bounds.top + bounds.height / 2;
    if (!isFinite(bounds.width) || !isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0)
        throw new Error(str.t('Слой "', 'Layer "') + name + str.t('" имеет некорректный bounding box.', '" has an invalid bounding box.'));

    return {
        id: id, name: name, kind: kind, order: order, itemIndex: itemIndex, colorLabel: readLayerColorLabel(d),
        left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom,
        width: bounds.width, height: bounds.height, centerX: bounds.centerX, centerY: bounds.centerY
    };
}

function collectLayoutItems(ids) {
    var output = [], count = ids.length, cache = selectedLayerDescriptorCache;
    // The cached descriptors are snapshots and are valid only before any input
    // preparation. Consume the cache once so it cannot leak into later stages.
    selectedLayerDescriptorCache = null;

    for (var i = 0; i < count; i++) {
        var id = ids[i];
        progress(8 + 22 * (i / Math.max(1, count)), 'Layers ' + i + '/' + count);
        var d = cache && cache[String(id)] ? cache[String(id)] : lr.getDescriptor(id, false);
        var item = readLayoutLayerDescriptor(d, id, i);
        if (typeof inputPreparation != 'undefined' && inputPreparation) item.priority = inputPreparation.units[i].priority;
        output.push(item);
        progress(8 + 22 * ((i + 1) / Math.max(1, count)), 'Layers ' + (i + 1) + '/' + count);
    }
    return output;
}


function getPriorityLabels() {
    // Dropdown swatches from Batch for layers; all behaviour belongs to Auto Layout.
    return [
        { value: 'off', label: str.t('Не задано', 'Not set'), icon: null },
        { value: 'none', label: str.t('Без цветовой метки', 'No color label'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00\u00CEIDAT\x18\u0095\u008D\u0090A\x0BE@\x14\u0085\u00CFLS\u00A2,D6~\u0083R\u00CAF\u00E4WS\u0094\u0094\u00C8N\u00F9\x19R\u00D6\x12^s\u00DF3\u00CF\u00EA\u00F5NM3\u00E7\u00CE\u0099\u00B9_\u0097\x15Eq\u00E1\x0F\t\x19\t\u0082\x00\u00D7uA\bA\u00FBS\u00D2\u008F\u00E3\b\u008E\u008F\x19\u0086\x01\u0086a\u00C0u]Z\u009A\u00A6\u00A1\u00EB:\u00F5\u0090\u0082\u009CsDQ\u0084\u00B2,\u00B1m\x1B\u00D6uE]\u00D7H\u0092\x04\u008C1\nRk)\u00CF\u00F3\u00E0\u00FB>\u00F2<'\x1F\u00C71\x1C\u00C7\u00C1<\u00CF\u00DF\x1Fo\u0099\u00A6\u00A9\u00CE\x12\u00E3)\u00C5\u00B8,\x0B\u00FA\u00BEG\u009A\u00A6\b\u00C3\x10UU\x11\u00C2-j-9\u00DA\u00B6E\u0096e\u00B0,\x0B\u00B6mC\u00D7u4MC\b\u00F2\u009E\u0082\u00C7qPa\u00DFw\u00C5ts\u009E\u00E7\u00F9\x1E\u009D,L\u00D3\u00F4{\u00E2\x00^\u00D6\u0089Tf\u00E31\u0087\u00CC\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'red', label: str.t('Красный', 'Red'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00;IDAT\x18\u0095c\u00FCci\u00F3\u009F\u0081\b\u00C0\x02R\u00C2((\u0084W\u00E5\u00FF\u00F7\u00EF \n\u00C1\u0080\u0087\x17\u00BB\u00AA/\u009F\u00C1\x14\x131\u00D6\x0E\x15\u0085\b_C}\u0087W!(\u009C\u00F0\x02\x06\x06\x06\x00\x18\u00EF\fO\u0083\b\u00CC\u00FD\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'orange', label: str.t('Оранжевый', 'Orange'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00=IDAT\x18\u0095c\u00FC\u00D2\u00A1\u00FA\u009F\u0081\b\u00C0\x02R\u00C2$\u00C8\u008DW\u00E5\u00BF\u00F7_!\nA\u0080\u0091\u0097\x03\u00AB\u00A2\u00FF\u009F\x7F\u0080i&b\u00AC\x1D*\n\u00E1\u00BE\u0086\u00F9\x0E\u00AFBP8\u00E1\x05\f\f\f\x00\u00D6!\x0E\u0088\x06d\u00F3\x07\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'yellowColor', label: str.t('Жёлтый', 'Yellow'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00;IDAT\x18\u0095c\u00FCp@\u00ED?\x03\x11\u0080\x05\u00A4\u0084\u0089\u0093\x1B\u00AF\u00CA\x7F\u00DF\u00BFB\x14\u0082\x15\u00B3s`W\u00F4\u00F3\x07D\u009E\x18k\u0087\u008AB\u00B8\u00AFa\u00BE\u00C3\u00AB\x10\x14Nx\x01\x03\x03\x03\x00+\u00AA\x0E\u00CA*\u0090\u00C3\u00A2\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'grain', label: str.t('Зелёный', 'Green'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00=IDAT\x18\u0095c\u00F4\u00DEo\u00F8\u009F\u0081\b\u00C0\x02R\"\u00C6\u00C9\u008FW\u00E5\u00AB\u00EF\x1F!\nA@\u0090\u009D\x1B\u00AB\u00A2\u00F7?\u00BF\u0082i&b\u00AC\x1D*\n\u00E1\u00BE\u0086\u00F9\x0E\u00AFBP8\u00E1\x05\f\f\f\x000\x1F\x0E\x05z4V\u0094\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'blue', label: str.t('Синий', 'Blue'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00=IDAT\x18\u0095c4\u0099\u00F7\u00E1?\x03\x11\u0080\x05\u00A4D\u0080\u009F\t\u00AF\u00CA\x0F\x1F\u00FFA\x14\u0082\x007\x17v\u00C5_\u00BF\u00FD\x03\u00D3\u00F8\u008DB\x02CA!\u00DC\u00D70\u00DF\u00E1U\b\n'\u00BC\u0080\u0081\u0081\x01\x00\b\u00DD\x0E\u00A5\x7F\u00E7e\u008B\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'violet', label: str.t('Фиолетовый', 'Violet'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00=IDAT\x18\u0095c\u00DC\x1Fv\u00FD?\x03\x11\u0080\x05\u00A4\u0084S\u0092\r\u00AF\u00CA\u00EF\u00CF\x7FA\x14\u0082\x00\u00BB\x10\x0BVE?\u00DF\u00FD\x01\u00D3L\u00C4X;T\x14\u00C2\u00BD\n\u00F3\x1D^\u0085\u00A0p\u00C2\x0B\x18\x18\x18\x00KM\x0E\u00C2\u00AA\x19\u00A8d\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'gray', label: str.t('Серый', 'Gray'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00=IDAT\x18\u0095clk\u00EB\u00FC\u00CF@\x04`\x01)\x11\x12\x12\u00C4\u00AB\u00F2\u00DD\u00BB\u00F7\x10\u0085 \u00C0\u00CB\u00CB\u008BU\u00D1\u00E7\u00CF\u009F\u00C14\x131\u00D6\x0E\x15\u0085p_\u00C3|\u0087W!(\u009C\u00F0\x02\x06\x06\x06\x00\u00BE\u00A9\x0ET.#\u00D2&\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'magenta', label: str.t('Пурпурный', 'Magenta'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00\tpHYs\x00\x00\x0B\x13\x00\x00\x0B\x13\x01\x00\u009A\u009C\x18\x00\x00\x00DIDAT\x18\u0095c\u00EC\u0095w\u00FA\u00CF@\x04`a```\x10\u00E4\x14\u00C6\u00AB\u00E8\u00FD\u00F7\u00B7\x10\u0085\f\f\f\f<\u00EC\u00FCX\x15}\u00F9\u00F9\u0091\u0081\u0081\u0081\u0081\u0081\u0089\x18k\u0087\u008AB\u00B8\u00AFa\u00BE\u00C3\u00AB\u00F0\u00FD\u00F7\u00B7\x04M\x04\x00\u00B5\u00CE\r\u00BAV\u009F\u00F8\u00CD\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'fuchsia', label: str.t('Фуксия', 'Fuchsia'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x06\x00\x00\x00\u008D2\u00CF\u00BD\x00\x00\x00\tpHYs\x00\x00\x0B\x13\x00\x00\x0B\x13\x01\x00\u009A\u009C\x18\x00\x00\x00DIDAT\x18\u0095c\u008C\u0095\u0088\u00FB\u00CF@\x04`a```\x10\u00E7\u0090\u00C0\u00AB\u00E8\u00E5\u008F\x17\x10\u0085\f\f\f\fB\u00AC\u0082X\x15\u00BD\u00FB\u00FD\u009E\u0081\u0081\u0081\u0081\u0081\u0089\x18k\u0087\u008AB\u00B8\u00AFa\u00BE\u00C3\u00AB\u00F0\u00E5\u008F\x17\x04M\x04\x00\u00897\r\u008F\u00D9\u0098\u0090\u009F\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'seafoam', label: str.t('Морская пена', 'Seafoam'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x03\x00\x00\x00\u00BA\u00EC?\u008F\x00\x00\x00\x12PLTE\x00\x00\x00\u00FF\u00FF\u00FF\x00fb\x00WT\x00CA\u00FF\u00FF\u00FF'Q\x10A\x00\x00\x00\x06tRNS\u00FF\u00FF\u00FF\u00FF\u00FF\x00\u00B3\u00BF\u00A4\u00BF\x00\x00\x00\tpHYs\x00\x00\x0B\x13\x00\x00\x0B\x13\x01\x00\u009A\u009C\x18\x00\x00\x00%IDAT\b\u0099cda\u0080\x01\x16\u0086\u00FFP\x16#\x0B\x03\u0094\u00CD\u00C8\u00C0\x04\u0097'\u0089\u00C9\u00C2\u00C0\u00C0\bg\u00C2X\f\x00\u00BE4\x02\"/\u0092wL\x00\x00\x00\x00IEND\u00AEB`\u0082" },
        { value: 'indigo', label: str.t('Индиго', 'Indigo'), icon: "\u0089PNG\r\n\x1A\n\x00\x00\x00\rIHDR\x00\x00\x00\n\x00\x00\x00\n\b\x03\x00\x00\x00\u00BA\u00EC?\u008F\x00\x00\x00\x12PLTE\x00\x00\x00\u00FF\u00FF\u00FFFI\u00A0<>\u0092.0\u0080\u00FF\u00FF\u00FFth\u00F2\x01\x00\x00\x00\x06tRNS\u00FF\u00FF\u00FF\u00FF\u00FF\x00\u00B3\u00BF\u00A4\u00BF\x00\x00\x00\tpHYs\x00\x00\x0B\x13\x00\x00\x0B\x13\x01\x00\u009A\u009C\x18\x00\x00\x00%IDAT\b\u0099cda\u0080\x01\x16\u0086\u00FFP\x16#\x0B\x03\u0094\u00CD\u00C8\u00C0\x04\u0097'\u0089\u00C9\u00C2\u00C0\u00C0\bg\u00C2X\f\x00\u00BE4\x02\"/\u0092wL\x00\x00\x00\x00IEND\u00AEB`\u0082" }
    ];
}

function normalizePriorityLabel(value) {
    var token = String(value || 'off'), allowed = 'off|none|red|orange|yellowColor|grain|blue|violet|gray|magenta|fuchsia|seafoam|indigo'.split('|');
    for (var i = 0; i < allowed.length; i++) if (token == allowed[i]) return token;
    return 'off';
}

function populatePriorityDropdown(control, value) {
    var labels = getPriorityLabels(), selected = normalizePriorityLabel(value);
    for (var i = 0; i < labels.length; i++) {
        var item = control.add('item', labels[i].label);
        item.priorityLabel = labels[i].value;
        if (labels[i].icon) try { item.image = labels[i].icon; } catch (iconError) { }
        if (labels[i].value == selected) control.selection = item;
    }
}

function priorityDropdownValue(control) {
    return normalizePriorityLabel(control.selection ? control.selection.priorityLabel : 'off');
}

function validatePrioritySettings() {
    var first = normalizePriorityLabel(cfg.priorityStartLabel), last = normalizePriorityLabel(cfg.priorityEndLabel);
    if (first != 'off' && first == last)
        throw new Error(str.t('Выберите разные метки для начала и конца листа.', 'Choose different labels for the beginning and end of the sheet.'));
}

function readLayerColorLabel(descriptor) {
    if (!descriptor.hasKey(s2t('color'))) return 'none';
    return String(typeIDToStringID(descriptor.getEnumerationValue(s2t('color'))));
}

function priorityForLabel(label) {
    // Unknown future Photoshop labels remain ordinary, never become "unlabeled".
    var first = normalizePriorityLabel(cfg.priorityStartLabel), last = normalizePriorityLabel(cfg.priorityEndLabel);
    if (first != 'off' && String(label || 'none') == first) return 0;
    if (last != 'off' && String(label || 'none') == last) return 2;
    return 1;
}

function priorityForRoots(roots) {
    var result = 1;
    for (var i = 0; i < roots.length; i++) {
        var rank = priorityForLabel(roots[i].colorLabel);
        if (rank == 1) continue;
        if (result != 1 && result != rank)
            throw new Error(str.t('Связанный набор имеет метки и начала, и конца листа. Измените метки корневых слоёв набора.', 'A linked set has both beginning and end labels. Change its root layer labels.'));
        result = rank;
    }
    return result;
}

function getItemPriority(item) { return item.priority === 0 ? 0 : item.priority === 2 ? 2 : 1; }

function assignLabelPriorities(items) {
    var indexed = [], output = [], i;
    for (i = 0; i < items.length; i++) {
        if (items[i].priority == undefined) items[i].priority = priorityForLabel(items[i].colorLabel);
        indexed.push({ item: items[i], index: i });
    }
    indexed.sort(function (a, b) { return (getItemPriority(a.item) - getItemPriority(b.item)) || (a.index - b.index); });
    for (i = 0; i < indexed.length; i++) output.push(indexed[i].item);
    return output;
}

function priorityOrderValid(rows) {
    var previous = 0;
    for (var r = 0; r < rows.length; r++) for (var c = 0; c < rows[r].length; c++) {
        var rank = getItemPriority(rows[r][c]);
        if (rank < previous) return false;
        previous = rank;
    }
    return true;
}

function normalizeAlphabetOrder(value) {
    var v = String(value || 'off');
    return v == 'page' || v == 'zone' ? v : 'off';
}

function alphabetOrderActive() { return normalizeAlphabetOrder(cfg.alphabetOrder) != 'off'; }

function prepareAlphabeticalKeys(items) {
    pythonFeatures.resetForRun();
    if (!pythonFeatures.ensureReady()) throw new Error(str.t('Для сортировки имён нужен Python: ', 'Python is required for name ordering: ') + pythonFeatures.getState().message);
    var payload = [], expected = {}, i;
    for (i = 0; i < items.length; i++) { payload.push({ id: items[i].id, name: items[i].name }); expected[String(items[i].id)] = items[i]; }
    beginPythonProgressWait(1, 1500);
    var call;
    try { call = pythonFeatures.call('alphabet_names', payload, { photo: false }); }
    finally { endPythonProgressWait(); }
    if (!call.ok || !(call.value instanceof Array) || call.value.length != items.length)
        throw new Error(str.t('Не удалось разобрать имена для алфавитной сортировки.', 'Could not parse names for alphabetical ordering.'));
    var seen = {};
    for (i = 0; i < call.value.length; i++) {
        var row = call.value[i], key = row ? String(row.id) : '', item = expected[key];
        if (!item || seen[key] || typeof row.id != 'number' || typeof row.key != 'string' || row.key.length > 1024 || typeof row.named != 'boolean' || (row.named && !row.key))
            throw new Error(str.t('Некорректный ответ сортировки имён.', 'Invalid name-ordering response.'));
        seen[key] = true; item.alphabetKey = row.key; item.alphabetNamed = row.named;
    }
    layoutUnitProgress(1, 1, 'Names parsed');
}

function sortAlphabeticalItems(items) {
    return items.slice(0).sort(function (a, b) {
        var priority = getItemPriority(a) - getItemPriority(b);
        if (priority) return priority;
        if (a.alphabetNamed != b.alphabetNamed) return a.alphabetNamed ? -1 : 1;
        if (a.alphabetKey < b.alphabetKey) return -1;
        if (a.alphabetKey > b.alphabetKey) return 1;
        return a.order - b.order; // Stable ties, independent of engine sort stability.
    });
}

function sortAlphabeticalZones(plan, geometry) {
    var groups = {}, rows = [], r, i;
    for (r = 0; r < plan.rows.length; r++) {
        var key = String(plan.rows[r].zoneIndex == undefined ? 0 : plan.rows[r].zoneIndex);
        if (!groups[key]) groups[key] = { items: [], offset: 0 };
        groups[key].items = groups[key].items.concat(plan.rows[r].items);
    }
    for (key in groups) if (groups.hasOwnProperty(key)) groups[key].items = sortAlphabeticalItems(groups[key].items);
    for (r = 0; r < plan.rows.length; r++) {
        key = String(plan.rows[r].zoneIndex == undefined ? 0 : plan.rows[r].zoneIndex);
        var group = groups[key], count = plan.rows[r].items.length;
        rows.push(group.items.slice(group.offset, group.offset + count)); group.offset += count;
    }
    var candidate = rebuildAssignedLayout(plan, geometry, rows, true);
    if (!candidate && !plan.lockedMetrics) {
        // Different widths can require a slightly smaller common scale. Keep zone
        // membership and row counts instead of silently breaking alphabetical order.
        var low = 0, high = plan.commonScale, seed = {}, k;
        for (k in plan) if (plan.hasOwnProperty(k)) seed[k] = plan[k];
        for (i = 0; i < 28; i++) {
            seed.commonScale = (low + high) / 2;
            var trial = rebuildAssignedLayout(seed, geometry, rows, true);
            if (trial) { candidate = trial; low = seed.commonScale; } else high = seed.commonScale;
        }
    }
    if (!candidate) throw new Error(str.t('Не удалось разместить алфавитный порядок с заданными размерами и интервалами.', 'Could not fit alphabetical order using the specified sizes and gaps.'));
    validateLayoutPlan(candidate, geometry);
    return candidate;
}

function analyzeSemantics(items) {
    pythonFeatures.resetForRun();
    semanticImageAnalysisDisabledForRun = false;
    semanticImageEmptyStreak = 0;
    semanticImageFallbackReason = '';
    headTurnFeatures.resetForRun();
    var colorRequested = !!(cfg.colorMode && cfg.colorMode != 'off');
    if (colorRequested) colorFeatures.resetForRun();
    initializeUnknownGenders(items);
    for (var i = 0; i < items.length; i++) {
        items[i].colorPalette = null;
        items[i].headTurnValid = false;
        items[i].headTurn = 0;
        items[i].headTurnReason = '';
        items[i].headLeanValid = false;
        items[i].headLean = 0;
        items[i].headLeanWeight = 0;
    }
    var hasPhotoCapableLayer = false;
    for (i = 0; i < items.length; i++) if (items[i].kind != 4) { hasPhotoCapableLayer = true; break; }
    var genderReady = cfg.alternateGender && pythonFeatures.ensureReady(),
        headReady = cfg.considerHeadTurn && hasPhotoCapableLayer && headTurnFeatures.ensureReady(),
        colorReady = colorRequested && hasPhotoCapableLayer && colorFeatures.ensureReady(),
        byId = {}, payload = [], result;
    if (genderReady) {
        for (i = 0; i < items.length; i++) payload.push({ id: items[i].id, name: items[i].name });
        var nameCall = pythonFeatures.call('gender_names', payload, { photo: false });
        if (nameCall.ok && nameCall.value instanceof Array) {
            for (i = 0; i < nameCall.value.length; i++) {
                result = nameCall.value[i];
                if (result && result.id != undefined) byId[String(result.id)] = result;
            }
        } else if (nameCall.ok) pythonFeatures.recordFailure('gender_names_invalid', str.t('Некорректный ответ анализа имён.', 'Invalid name-analysis response.'));
        for (i = 0; i < items.length; i++) applyGenderResult(items[i], byId[String(items[i].id)]);
    }
    setLayoutProgressRange(.1, .9); // Reserve initialization/name analysis before the per-photo slices.
    var photoItems = [], previewHistoryTouched = false;
    for (i = 0; i < items.length; i++)
        // Native vector shape layers are layout objects, not photographs. Their
        // names may still resolve gender, but JPEG/vision analysis is skipped.
        if (items[i].kind != 4 && (colorReady || headReady || (genderReady && items[i].gender == 'U'))) photoItems.push(items[i]);
    if (photoItems.length) {
        var parentDocumentId = doc.getProperty('documentID'),
            analysisBaseHistory = activeDocument.activeHistoryState,
            analysisAnchorHistory = null;
        app.activeDocument.suspendHistory('Auto layout analysis', 'function autoLayoutAnalysisAnchor () {return}');
        analysisAnchorHistory = activeDocument.activeHistoryState;
        try {
            for (i = 0; i < photoItems.length; i++) {
                var target = photoItems[i],
                    wantGender = genderReady && !pythonFeatures.isDisabled() && target.gender == 'U',
                    wantHead = headReady && !headTurnFeatures.isDisabled(),
                    wantColor = colorReady && !colorFeatures.isDisabled();
                if (!wantGender && !wantHead && !wantColor) continue;
                progress(30 + 2 * i / Math.max(1, photoItems.length), 'Photo ' + i + '/' + photoItems.length);
                var previewPath = null;
                try {
                    previewHistoryTouched = true;
                    previewPath = createGenderPreview(target, parentDocumentId, analysisAnchorHistory);
                    beginPythonProgressWait(1 / Math.max(1, photoItems.length), 4000);
                    var driver = wantGender ? pythonFeatures : wantHead ? headTurnFeatures : colorFeatures,
                        other = wantGender && wantHead ? headTurnFeatures : null,
                        call = driver.call('analyze_image', {
                            id: target.id, name: target.name, path: previewPath,
                            gender: wantGender, head_turn: wantHead, color: wantColor
                        }, { photo: true, deferSuccess: true });
                    if (!call.ok) {
                        semanticImageEmptyStreak = 0;
                        if (other) other.recordPhotoFailure(call.reason || 'python_error', call.message);
                        if (wantColor && driver != colorFeatures) colorFeatures.recordPhotoFailure(call.reason || 'python_error', call.message);
                        target.headTurnReason = call.reason || 'python_error';
                        if (wantGender) target.genderReason = call.reason || 'python_error';
                        continue;
                    }
                    var answer = call.value,
                        validEnvelope = answer && answer.id == target.id,
                        semanticRequestedCount = 0,
                        semanticUsefulCount = 0,
                        semanticResultFailure = !validEnvelope;
                    if (wantGender) {
                        semanticRequestedCount++;
                        var genderResult = validEnvelope ? answer.gender : null,
                            genderOutcome = classifyPhotoAnalysisOutcome(genderResult);
                        if (genderOutcome.failure) {
                            semanticResultFailure = true;
                            pythonFeatures.recordPhotoFailure(genderOutcome.reason, genderOutcome.message);
                            target.genderReason = genderOutcome.reason;
                        } else {
                            pythonFeatures.recordSuccess();
                            applyGenderResult(target, genderResult);
                            if (genderResult.analysis_status == 'ok' && (genderResult.sex == 'M' || genderResult.sex == 'F')) semanticUsefulCount++;
                        }
                    }
                    if (wantColor) {
                        semanticRequestedCount++;
                        var colorResult = validEnvelope ? answer.color : null, colorOutcome = classifyColorOutcome(colorResult);
                        if (colorOutcome.failure) {
                            semanticResultFailure = true;
                            colorFeatures.recordPhotoFailure(colorOutcome.reason, colorOutcome.message);
                        } else {
                            colorFeatures.recordSuccess();
                            if (colorResult.analysis_status == 'ok') {
                                target.colorPalette = colorResult.palette;
                                semanticUsefulCount++;
                            }
                        }
                    }
                    if (wantHead) {
                        semanticRequestedCount++;
                        var headResult = validEnvelope ? answer.head_turn : null,
                            headOutcome = classifyHeadTurnOutcome(headResult);
                        if (headOutcome.failure) {
                            semanticResultFailure = true;
                            headTurnFeatures.recordPhotoFailure(headOutcome.reason, headOutcome.message);
                            target.headTurnReason = headOutcome.reason;
                        } else {
                            headTurnFeatures.recordSuccess();
                            target.headTurnValid = headResult.analysis_status == 'ok';
                            target.headTurn = target.headTurnValid ? Number(headResult.turn) : 0;
                            target.headTurnReason = headResult.reason || '';
                            target.headTurnByBody = headResult.method == 'body_head_combined';
                            if (target.headTurnValid) semanticUsefulCount++;
                            target.headLeanValid = target.headTurnValid && headResult.head_status != 'uncertain' &&
                                typeof headResult.roll_degrees == 'number' && isFinite(headResult.roll_degrees) &&
                                typeof headResult.pitch_degrees == 'number' && isFinite(headResult.pitch_degrees);
                            if (target.headLeanValid) {
                                // MediaPipe +roll leans toward image-left; yaw's +sign is image-right.
                                target.headLean = -headResult.roll_degrees;
                                target.headLeanWeight = Math.max(0, 1 - Math.abs(headResult.pitch_degrees) / 35);
                            }
                        }
                    }
                    if (semanticRequestedCount) {
                        if (semanticResultFailure) semanticImageEmptyStreak = 0;
                        else recordSemanticImageOutcome(semanticUsefulCount > 0);
                    }
                } catch (e) {
                    if (e.number == 8007 || e.autoLayoutRestoreFailure) throw e;
                    var message = e.message ? e.message : String(e);
                    semanticImageEmptyStreak = 0;
                    if (wantGender) pythonFeatures.recordPhotoFailure('preview_error', message);
                    if (wantHead) headTurnFeatures.recordPhotoFailure('preview_error', message);
                    if (wantColor) colorFeatures.recordPhotoFailure('preview_error', message);
                    target.headTurnReason = 'preview_error';
                    if (wantGender) target.genderReason = 'preview_error';
                } finally {
                    if (previewPath && !removePreview(previewPath)) {
                        try { pythonApi.cleanup(previewPath); } catch (cleanupError) { }
                    }
                    progress(30 + 2 * (i + 1) / Math.max(1, photoItems.length), 'Photo ' + (i + 1) + '/' + photoItems.length);
                }
                if (semanticImageAnalysisDisabledForRun) break;
            }
        } finally {
            restoreAnalysisHistory(parentDocumentId, analysisBaseHistory, false);
        }
    }
    var failureMessages = [], featureStates = [];
    if (cfg.alternateGender) featureStates.push(pythonFeatures.getState());
    if (cfg.considerHeadTurn && hasPhotoCapableLayer) featureStates.push(headTurnFeatures.getState());
    if (colorRequested && hasPhotoCapableLayer) featureStates.push(colorFeatures.getState());
    for (i = 0; i < featureStates.length; i++) {
        var message = featureStates[i].message;
        if (message && !arrayContains(failureMessages, message)) failureMessages.push(message);
    }
    progress(32, 'Analysis complete');
    return {
        failureMessage: failureMessages.join('\n'),
        gender: cfg.alternateGender ? finalizeGenderSummary(items, !genderReady || pythonFeatures.isDisabled()) : null,
        headTurn: cfg.considerHeadTurn ? finalizeHeadTurnSummary(items, !headReady || headTurnFeatures.isDisabled()) : null,
        color: colorRequested ? finalizeColorSummary(items) : null,
        previewHistoryTouched: previewHistoryTouched
    };
}

function recordSemanticImageOutcome(hasUsefulValue) {
    if (semanticImageAnalysisDisabledForRun) return;
    if (hasUsefulValue) {
        semanticImageEmptyStreak = 0;
        return;
    }

    semanticImageEmptyStreak++;
    if (semanticImageEmptyStreak < OPTIONAL_PYTHON_EMPTY_LIMIT) return;

    semanticImageAnalysisDisabledForRun = true;
    semanticImageFallbackReason = str.t('Покадровый Python-анализ отключён до конца запуска после ', 'Per-image Python analysis was disabled for the rest of this run after ') +
        OPTIONAL_PYTHON_EMPTY_LIMIT + str.t(' последовательных слоёв без полезного результата запрошенных признаков.', ' consecutive layers returned no useful result for the requested features.');
    // Once the input looks like non-photographic frames, do not spend more time
    // on the optional Python packing either. The JSX geometry core remains active.
    packingDisabledForRun = true;
    if (!packingFallbackReason) packingFallbackReason = semanticImageFallbackReason;
}

function classifyColorOutcome(result) {
    if (!result || !/^(ok|uncertain|technical_failure)$/.test(String(result.analysis_status)))
        return { failure: true, reason: 'color_invalid', message: str.t('Некорректный результат оценки цвета.', 'Invalid color-analysis result.') };
    if (result.analysis_status == 'technical_failure')
        return { failure: true, reason: result.reason || 'color_failed', message: result.message || str.t('Не удалось оценить цвета одежды.', 'Could not analyze clothing colors.') };
    if (result.analysis_status == 'uncertain') return { failure: false };
    var p = result.palette, sum = 0;
    if (!p || !p.length || p.length > 4) return { failure: true, reason: 'color_invalid' };
    for (var i = 0; i < p.length; i++) {
        if (!p[i] || !p[i].lab || p[i].lab.length != 3 || typeof p[i].weight != 'number' || !isFinite(p[i].weight) || p[i].weight <= 0 || p[i].weight > 1)
            return { failure: true, reason: 'color_invalid' };
        for (var j = 0; j < 3; j++) if (typeof p[i].lab[j] != 'number' || !isFinite(p[i].lab[j]) ||
            (j == 0 ? p[i].lab[j] < 0 || p[i].lab[j] > 100 : Math.abs(p[i].lab[j]) > 128))
            return { failure: true, reason: 'color_invalid' };
        sum += p[i].weight;
    }
    return { failure: Math.abs(sum - 1) > .01, reason: 'color_invalid' };
}

function finalizeColorSummary(items) {
    var known = 0;
    for (var i = 0; i < items.length; i++) if (items[i].colorPalette) known++;
    return { known: known, unknown: items.length - known, fallbackToGeometry: known < 2,
        mode: cfg.colorMode, pythonMessage: colorFeatures.getState().message };
}

function paletteDistance(a, b) {
    // Energy distance between weighted Lab palettes: recognises different
    // proportions even when both garments contain the same set of colours.
    function expected(p, q) {
        var total = 0;
        for (var i = 0; i < p.length; i++) for (var j = 0; j < q.length; j++) {
            var d = 0;
            for (var k = 0; k < 3; k++) { var v = p[i].lab[k] - q[j].lab[k]; d += v * v; }
            total += p[i].weight * q[j].weight * Math.sqrt(d);
        }
        return total;
    }
    return Math.sqrt(Math.max(0, 2 * expected(a, b) - expected(a, a) - expected(b, b)));
}

function paletteTone(palette) {
    var l = 0, a = 0, b = 0, chroma = 0, dominant = palette[0];
    for (var i = 0; i < palette.length; i++) {
        if (palette[i].weight > dominant.weight) dominant = palette[i];
        l += palette[i].weight * palette[i].lab[0];
        chroma += palette[i].weight * Math.sqrt(palette[i].lab[1] * palette[i].lab[1] + palette[i].lab[2] * palette[i].lab[2]);
        a += palette[i].weight * palette[i].lab[1]; b += palette[i].weight * palette[i].lab[2];
    }
    return { lightness: .8 * dominant.lab[0] + .2 * l, hue: Math.atan2(b, a), chroma: .8 * Math.sqrt(dominant.lab[1] * dominant.lab[1] + dominant.lab[2] * dominant.lab[2]) + .2 * chroma };
}

function colorAssignmentCost(plan, mode, distances) {
    mode = normalizeColorMode(mode);
    distances = distances || {};
    // Build a fixed positional neighbour graph from actual physical rows:
    // adjacent portraits in the same physical row and the nearest portrait only
    // in the immediately following physical row. Rows from separate zones that
    // share the same Y coordinate belong to one physical row.
    var positions = {}, physicalRows = [], rowRefs = [], total = 0, weights = 0, edges = {};
    for (var pi = 0; pi < plan.placements.length; pi++) positions[String(plan.placements[pi].layerId)] = plan.placements[pi];
    for (var r = 0; r < plan.rows.length; r++) rowRefs.push({ index: r, top: Number(plan.rows[r].y) });
    rowRefs.sort(function (a, b) { return a.top == b.top ? a.index - b.index : a.top - b.top; });

    for (var rr = 0; rr < rowRefs.length; rr++) {
        var ref = rowRefs[rr], group = null;
        if (physicalRows.length && Math.abs(physicalRows[physicalRows.length - 1].top - ref.top) < 1)
            group = physicalRows[physicalRows.length - 1];
        else {
            group = { top: ref.top, entries: [] };
            physicalRows.push(group);
        }
        var row = plan.rows[ref.index];
        for (var c = 0; c < row.items.length; c++) {
            var item = row.items[c], placement = positions[String(item.id)];
            if (placement) group.entries.push({ item: item, x: placement.targetCenterX, y: placement.targetCenterY });
        }
    }
    for (rr = 0; rr < physicalRows.length; rr++)
        physicalRows[rr].entries.sort(function (a, b) { return a.x == b.x ? a.item.order - b.item.order : a.x - b.x; });

    function edge(a, b, weight) {
        if (!a || !b || !a.item.colorPalette || !b.item.colorPalette) return;
        var edgeKey = Math.min(a.item.id, b.item.id) + ':' + Math.max(a.item.id, b.item.id);
        if (edges[edgeKey]) return;
        edges[edgeKey] = true;
        var pair = edgeKey;
        if (distances[pair] == undefined) distances[pair] = paletteDistance(a.item.colorPalette, b.item.colorPalette);
        total += weight * distances[pair];
        weights += weight;
    }

    for (rr = 0; rr < physicalRows.length; rr++) {
        var current = physicalRows[rr].entries;
        for (var i = 0; i + 1 < current.length; i++) edge(current[i], current[i + 1], 1);
        if (rr + 1 >= physicalRows.length) continue;
        var below = physicalRows[rr + 1].entries;
        for (i = 0; i < current.length; i++) {
            var nearest = null, nearestDist = Infinity;
            for (var j = 0; j < below.length; j++) {
                var dx = below[j].x - current[i].x, dy = below[j].y - current[i].y,
                    d = dx * dx + dy * dy;
                if (d < nearestDist) { nearest = below[j]; nearestDist = d; }
            }
            if (nearest) edge(current[i], nearest, .5);
        }
    }
    return (mode == 'contrast' ? -1 : 1) * (weights ? total / weights : 0);
}


function betterColorOrder(cost, bestCost) {
    return cost < bestCost - 1e-8;
}

// Compare every trial with the original semantic result, never the last swap:
// this prevents successive small concessions from accumulating into large turns.
function buildColorPoseContext(baseline, geometry) {
    var positions = {}, photos = {}, i, r, c;
    for (i = 0; i < baseline.placements.length; i++)
        positions[String(baseline.placements[i].layerId)] = baseline.placements[i].targetCenterX;
    for (r = 0; r < baseline.rows.length; r++) for (c = 0; c < baseline.rows[r].items.length; c++)
        photos[String(baseline.rows[r].items[c].id)] = baseline.rows[r].items[c];
    return { positions: positions, photos: photos, center: (geometry.bounds.left + geometry.bounds.right) / 2 };
}

function colorPoseCompatible(candidate, baseline, geometry, context) {
    context = context || buildColorPoseContext(baseline, geometry);
    var positions = context.positions, photos = context.photos, center = context.center;
    for (var r = 0; r < candidate.rows.length; r++) for (var c = 0; c < candidate.rows[r].items.length; c++) {
        var item = candidate.rows[r].items[c], original = baseline.rows[r].items[c];
        if (!!item.headTurnValid != !!original.headTurnValid) return false;
        if (item.headTurnValid && Math.abs(item.headTurn - original.headTurn) > 12) return false;
        if (!!item.headLeanValid != !!original.headLeanValid) return false;
        if (item.headLeanValid && Math.abs(item.headLean - original.headLean) > 8) return false;
    }
    for (var i = 0; i < candidate.placements.length; i++) {
        var placement = candidate.placements[i], photo = photos[String(placement.layerId)];
        if (photo && photo.headTurnValid && Math.abs(photo.headTurn) >= 12 &&
            photo.headTurn * (center - positions[String(photo.id)]) >= 0 &&
            photo.headTurn * (center - placement.targetCenterX) < -1e-8) return false;
    }
    return true;
}

function colorSemanticsCompatible(score, baseline) {
    return score.horizontalBad <= baseline.horizontalBad && score.horizontal >= baseline.horizontal &&
        score.symmetry <= baseline.symmetry && score.minorityCenter <= baseline.minorityCenter + 1e-8 &&
        score.vertical >= baseline.vertical;
}

function optimizeColorAssignment(plan, geometry, useGender, useHead, mode) {
    mode = normalizeColorMode(mode);
    var distances = {}, tones = {}, best = plan, baseline = getSemanticAssignmentScore(plan, geometry, useGender, useHead),
        bestCost = colorAssignmentCost(plan, mode, distances), initialCost = bestCost, slots = [],
        poseContext = useHead ? buildColorPoseContext(plan, geometry) : null;
    function cachedTone(item) {
        var key = String(item.id);
        if (!tones[key]) tones[key] = paletteTone(item.colorPalette);
        return tones[key];
    }
    for (var r = 0; r < plan.rows.length; r++) for (var c = 0; c < plan.rows[r].items.length; c++) slots.push({ row: r, col: c });
    if (mode == 'harmonious') {
        // Global seed makes color-only behaviour visible even when pairwise
        // neighbourhood search gets trapped at a local minimum.
        var pools = {}, locations = {}, seedRows = [], rr, cc;
        for (rr = 0; rr < plan.rows.length; rr++) {
            seedRows.push(plan.rows[rr].items.slice(0));
            for (cc = 0; cc < plan.rows[rr].items.length; cc++) {
                var seedItem = plan.rows[rr].items[cc];
                if (!seedItem.colorPalette) continue;
                var bucket = getItemPriority(seedItem) + '|' + (useGender ? String(seedItem.gender) : 'all');
                if (!pools[bucket]) { pools[bucket] = []; locations[bucket] = []; }
                pools[bucket].push(seedItem); locations[bucket].push({ row: rr, col: cc });
            }
        }
        for (var bk in pools) if (pools.hasOwnProperty(bk)) {
            pools[bk].sort(function (a, b) {
                var ta = cachedTone(a), tb = cachedTone(b),
                    va = ta.lightness, vb = tb.lightness;
                if (Math.abs(va - vb) > 1e-8) return vb - va;
                if (Math.abs(ta.hue - tb.hue) > 1e-8) return ta.hue - tb.hue;
                return a.order - b.order;
            });
            for (var pp = 0; pp < pools[bk].length; pp++) {
                var location = locations[bk][pp]; seedRows[location.row][location.col] = pools[bk][pp];
            }
        }
        var seeded = rebuildAssignedLayout(plan, geometry, seedRows, true);
        if (seeded) {
            var seedScore = getSemanticAssignmentScore(seeded, geometry, useGender, useHead), seedCost = colorAssignmentCost(seeded, mode, distances);
            if (colorSemanticsCompatible(seedScore, baseline) &&
                (!useHead || colorPoseCompatible(seeded, plan, geometry, poseContext)) && betterColorOrder(seedCost, bestCost)) {
                best = seeded; bestCost = seedCost;
            }
        }
    }
    // Preserve gender composition and symmetry; allow bounded pose alternatives.
    // Trials use the same reflow/containment validator and unchanged scale/gaps.
    for (var pass = 0; pass < 8; pass++) {
        layoutUnitProgress(pass, 8, 'Color: pass ' + (pass + 1) + ' of max 8');
        var changed = false;
        // Every photo participates, including sheets above 80 items. Large
        // sheets use globally spaced partners, not a fixed subset of photos.
        var search = slots, partnerCount = Math.min(16, Math.max(0, slots.length - 1));
        for (var a = 0; a < search.length; a++) {
          if (a % 8 == 0) layoutUnitProgress(pass + a / Math.max(1, search.length), 8, 'Color: pass ' + (pass + 1) + ', positions ' + a + '/' + search.length);
          for (var pairIndex = 0; pairIndex < (slots.length > 80 ? partnerCount : search.length - a - 1); pairIndex++) {
            var b = slots.length > 80 ? (a + 1 + (Math.floor(pairIndex * (slots.length - 1) / partnerCount) + pass) % (slots.length - 1)) % slots.length : a + 1 + pairIndex;
            var sa = search[a], sb = search[b], ia = best.rows[sa.row].items[sa.col], ib = best.rows[sb.row].items[sb.col];
            if (getItemPriority(ia) != getItemPriority(ib)) continue;
            if (!ia.colorPalette || !ib.colorPalette || (useGender && ia.gender != ib.gender)) continue;
            var pairKey = Math.min(ia.id, ib.id) + ':' + Math.max(ia.id, ib.id);
            if (distances[pairKey] == undefined) distances[pairKey] = paletteDistance(ia.colorPalette, ib.colorPalette);
            if (distances[pairKey] < 1e-8) continue;
            var rows = [];
            for (r = 0; r < best.rows.length; r++) rows.push(best.rows[r].items.slice(0));
            rows[sa.row][sa.col] = ib; rows[sb.row][sb.col] = ia;
            var candidate = rebuildAssignedLayout(best, geometry, rows, true);
            if (!candidate) continue;
            var score = getSemanticAssignmentScore(candidate, geometry, useGender, useHead);
            if (!colorSemanticsCompatible(score, baseline) ||
                (useHead && !colorPoseCompatible(candidate, plan, geometry, poseContext))) continue;
            var cost = colorAssignmentCost(candidate, mode, distances);
            if (betterColorOrder(cost, bestCost)) { best = candidate; bestCost = cost; changed = true; }
        }
        }
        if (!changed) break;
        progress(currentProgressValue, 'Color optimization: ' + (pass + 1));
    }
    validateLayoutPlan(best, geometry);
    if (best == plan) { best = {}; for (var key in plan) if (plan.hasOwnProperty(key)) best[key] = plan[key]; }
    best.headTurnSummary = plan.headTurnSummary;
    best.semanticAssignment = getSemanticAssignmentScore(best, geometry, useGender, useHead);
    if (plan.headTurnOrdering) {
        best.headTurnOrdering = {};
        for (var hk in plan.headTurnOrdering) if (plan.headTurnOrdering.hasOwnProperty(hk)) best.headTurnOrdering[hk] = plan.headTurnOrdering[hk];
        best.headTurnOrdering.finalCost = best.semanticAssignment.head;
    }
    if (useGender) {
        best.genderCheckerboard = getGenderCheckerboardStats(best);
    }
    var moved = 0;
    for (var mr = 0; mr < plan.rows.length; mr++) for (var mc = 0; mc < plan.rows[mr].items.length; mc++)
        if (plan.rows[mr].items[mc].id != best.rows[mr].items[mc].id) moved++;
    best.colorOrdering = { initialCost: initialCost, finalCost: bestCost, mode: mode, moved: moved };
    return best;
}

function classifyHeadTurnOutcome(result) {
    if (!result || !/^(ok|uncertain|not_applicable|technical_failure)$/.test(String(result.analysis_status)))
        return { failure: true, reason: 'head_result_invalid', message: str.t('Некорректный ответ анализа поворота головы.', 'Invalid head-turn analysis response.') };
    if (result.analysis_status == 'ok' && (typeof result.turn != 'number' || !isFinite(result.turn) || Math.abs(result.turn) > 80))
        return { failure: true, reason: 'head_result_invalid', message: str.t('Некорректный угол поворота головы.', 'Invalid head-turn angle.') };
    if (result.analysis_status == 'not_applicable') return { failure: false };
    if (result.analysis_status == 'technical_failure')
        return { failure: true, reason: result.reason || 'head_analysis_failed', message: result.message || str.t('Не удалось оценить поворот головы.', 'Could not analyze head turn.') };
    return { failure: false };
}

function finalizeHeadTurnSummary(items, fallback) {
    var state = headTurnFeatures.getState(), summary = {
        total: items.length, known: 0, frontal: 0, left: 0, right: 0, unknown: 0,
        byBody: 0, byHeadOnly: 0, fallbackToGeometry: !!fallback, pythonMessage: state.message
    };
    for (var i = 0; i < items.length; i++) {
        if (!items[i].headTurnValid) summary.unknown++;
        else {
            summary.known++;
            if (items[i].headTurnByBody) summary.byBody++; else summary.byHeadOnly++;
            if (items[i].headTurn == 0) summary.frontal++;
            else if (items[i].headTurn < 0) summary.left++;
            else summary.right++;
        }
    }
    return summary;
}

function initializeUnknownGenders(items) {
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
        items[i].gender = 'U';
        items[i].genderSource = 'unknown';
        items[i].genderConfidence = 0;
        items[i].genderReason = '';
    }
}

function classifyPhotoAnalysisOutcome(result) {
    if (!result || (result.sex != 'M' && result.sex != 'F' && result.sex != 'U') ||
        !isFinite(Number(result.confidence)) || Number(result.confidence) < 0 || Number(result.confidence) > 1 ||
        !/^(ok|uncertain|technical_failure|not_applicable)$/.test(String(result.analysis_status)))
        return { failure: true, reason: 'invalid_result', message: str.t('Python вернул некорректный результат анализа изображения.', 'Python returned an invalid image-analysis result.') };

    var status = result.analysis_status ? String(result.analysis_status) : '',
        reason = result.reason ? String(result.reason) : '';

    if ((status == 'ok' && result.sex == 'U') || ((status == 'uncertain' || status == 'not_applicable') && result.sex != 'U'))
        return { failure: true, reason: 'invalid_result', message: str.t('Несогласованный результат анализа изображения.', 'Inconsistent image-analysis result.') };

    if (status == 'technical_failure')
        return { failure: true, reason: reason || 'technical_failure', message: photoAnalysisReasonText(reason, true) };
    if (status == 'not_applicable')
        return { failure: false };

    // "uncertain" is a valid model result: the method worked, confidence was
    // simply insufficient. It must reset the consecutive-failure streak.
    return { failure: false };
}

function photoAnalysisReasonText(reason, technical) {
    switch (reason) {
        case 'face_not_found': return str.t('лицо не найдено', 'face not found');
        case 'face_low_confidence': return str.t('лицо найдено недостаточно уверенно', 'face confidence is too low');
        case 'multiple_faces': return str.t('обнаружено несколько сопоставимых лиц', 'multiple comparable faces detected');
        case 'image_too_small': return str.t('изображение слишком мало для анализа', 'image is too small for analysis');
        case 'face_crop_too_small': return str.t('область лица слишком мала для анализа', 'face crop is too small for analysis');
        case 'image_read_failed': return str.t('Python не смог прочитать превью', 'Python could not read the preview');
        case 'classifier_output_invalid': return str.t('модель вернула некорректный результат', 'the model returned an invalid result');
        default: return technical ? str.t('техническая ошибка анализа изображения', 'technical image-analysis error') : str.t('изображение не подходит для этого анализа', 'image is not suitable for this analysis');
    }
}

function finalizeGenderSummary(items, forceFallback) {
    var state = pythonFeatures.getState(),
        summary = {
            total: items ? items.length : 0,
            male: 0,
            female: 0,
            unknown: 0,
            byName: 0,
            byImage: 0,
            fallbackToGeometry: !!forceFallback,
            pythonDisabled: state.disabled,
            pythonReason: state.reason,
            pythonMessage: state.message,
            pythonFailureLimit: state.failureLimit,
            pythonConsecutiveFailures: state.consecutiveFailures,
            pythonTotalFailures: state.totalFailures,
            pythonPhotoFailures: state.photoFailures
        };

    if (!items) return summary;
    for (var i = 0; i < items.length; i++) {
        if (items[i].gender == 'M') summary.male++;
        else if (items[i].gender == 'F') summary.female++;
        else summary.unknown++;
        if (items[i].genderSource == 'name') summary.byName++;
        else if (items[i].genderSource == 'image') summary.byImage++;
    }
    summary.fallbackToGeometry = summary.male + summary.female == 0;
    return summary;
}

function applyGenderResult(item, result) {
    var sex = result && (result.sex == 'M' || result.sex == 'F') ? result.sex : 'U';
    item.gender = sex;
    item.genderSource = result && result.source ? String(result.source) : 'unknown';
    item.genderConfidence = result && isFinite(Number(result.confidence)) ? Number(result.confidence) : 0;
    item.genderReason = result && result.reason ? String(result.reason) : '';
}

function restoreAnalysisHistory(parentDocumentId, anchorHistory, usePrevious) {
    try {
        if (doc.getProperty('documentID') != parentDocumentId) doc.close(false);
        if (doc.getProperty('documentID') != parentDocumentId) throw new Error(str.t('Исходный документ недоступен.', 'The source document is unavailable.'));
        if (usePrevious) doc.selectPreviousHistoryState();
        else if (anchorHistory) activeDocument.activeHistoryState = anchorHistory;
        else throw new Error(str.t('Точка восстановления истории недоступна.', 'The history restore point is unavailable.'));
        return;
    } catch (historyError) {
        // A failed previous-state rollback may still recover through the anchor.
        try {
            if (doc.getProperty('documentID') != parentDocumentId) doc.close(false);
            if (doc.getProperty('documentID') != parentDocumentId || !anchorHistory) throw historyError;
            activeDocument.activeHistoryState = anchorHistory;
            return;
        } catch (restoreError) {
            var error = new Error(str.t('Не удалось восстановить документ после анализа фото. Раскладка остановлена: ', 'Could not restore the document after photo analysis. Layout has been stopped: ') + restoreError.message);
            error.autoLayoutRestoreFailure = true;
            throw error;
        }
    }
}

// Use a global suspendHistory entry point, independent of caller-local lookup.
// The callback holds the per-photo state through a normal JavaScript closure.
function autoLayoutPreviewWork() {
    if (typeof previewWork != 'function') throw new Error('Preview callback is unavailable');
    previewWork();
}

function createGenderPreview(item, parentDocumentId, analysisAnchorHistory) {
    var result = { path: null },
        previewStateCreated = false;

    lr.selectLayers([item.id]);
    var previousWork = typeof previewWork == 'undefined' ? null : previewWork;
    previewWork = function () { makePreview(result); };
    try {
        app.activeDocument.suspendHistory('Auto layout preview', 'autoLayoutPreviewWork();');
        previewStateCreated = true;
    } catch (previewError) {
        if (previewError.number == 8007) throw previewError;
        throw new Error(str.t('Не удалось подготовить превью слоя "', 'Could not prepare a preview of layer "') + item.name + '": ' + (previewError.message || String(previewError)));
    } finally {
        previewWork = previousWork;
        restoreAnalysisHistory(parentDocumentId, analysisAnchorHistory, previewStateCreated);
    }

    if (!result.path) throw new Error(str.t('Не удалось создать превью слоя "', 'Could not create a preview for layer "') + item.name + str.t('".', '".'));
    return result.path;

    function makePreview(o) {
        if (lr.hasProperty('smartObject')) lr.rasterize();
        lr.convertToSmartObject();
        lr.editSmartObject();
        doc.flatten();
        doc.convertToRGB();

        var docRes = doc.getProperty('resolution'),
            docW = doc.getProperty('width') * docRes / 72,
            docH = doc.getProperty('height') * docRes / 72,
            f = new File(Folder.temp + '/ALG_' + doc.getProperty('documentID') + '_' +
                (new Date()).getTime() + '_' + Math.floor(Math.random() * 1000000) + '.jpg'),
            k = GENDER_PREVIEW_SIZE / Math.min(docW, docH);

        pendingPreviews.push(f.fsName);
        if (k < 1) doc.setScale(k);
        doc.saveACopy(f);
        o.path = f.fsName;
        doc.close(false);
    }
}

function refreshLayoutLayerReferences(items) {
    if (!items || !items.length) return;

    function readIdentity(id) {
        var d = lr.getDescriptor(id, false);
        if (!d) return null;
        function has(key) { return d.hasKey(s2t(key)); }
        return {
            id: has('layerID') ? d.getInteger(s2t('layerID')) : id,
            name: has('name') ? d.getString(s2t('name')) : null,
            itemIndex: has('itemIndex') ? d.getInteger(s2t('itemIndex')) : null
        };
    }

    var oldToNew = {}, refreshedIds = [], i;
    for (i = 0; i < items.length; i++) {
        var item = items[i], oldId = item.id,
            current = readIdentity(oldId),
            valid = current && current.name !== null && current.itemIndex !== null &&
                String(current.name) == String(item.name) && Number(current.itemIndex) == Number(item.itemIndex),
            resolvedId = oldId;

        if (!valid) {
            resolvedId = lr.getProperty('layerID', item.itemIndex, true);
            if (resolvedId === false || resolvedId == undefined)
                throw new Error(str.t('После подготовки превью Photoshop потерял ссылку на слой "', 'After preparing the preview, Photoshop lost the reference to layer "') + item.name + str.t('".', '".'));

            var resolved = readIdentity(resolvedId);
            if (!resolved || resolved.name === null || resolved.itemIndex === null ||
                String(resolved.name) != String(item.name) || Number(resolved.itemIndex) != Number(item.itemIndex))
                throw new Error(str.t('После подготовки превью не удалось безопасно восстановить слой "', 'After preparing the preview, layer "') + item.name + str.t('" не удалось безопасно восстановить.', '" could not be restored safely.'));
            item.id = resolvedId;
        }

        oldToNew[String(oldId)] = item.id;
        refreshedIds.push(item.id);
    }

    if (sourceState) {
        sourceState.layerIds = refreshedIds;
        var activeKey = String(sourceState.activeLayerId);
        if (oldToNew[activeKey] != undefined) sourceState.activeLayerId = oldToNew[activeKey];
    }
}


function validateSourceLayersBeforeApply() {
    if (!sourceState || !sourceState.layerIds || !sourceState.layerIds.length)
        throw new Error(str.t('Не удалось восстановить выбранные слои перед применением раскладки.', 'Could not restore the selected layers before applying the layout.'));

    var seen = {}, placementIds = {}, i;
    for (i = 0; i < layoutPlan.placements.length; i++) placementIds[String(layoutPlan.placements[i].layerId)] = true;

    for (i = 0; i < sourceState.layerIds.length; i++) {
        var id = sourceState.layerIds[i],
            key = String(id),
            kind = lr.getProperty('layerKind', id);
        if (seen[key]) throw new Error(str.t('Перед применением раскладки обнаружена повторная ссылка на слой ID ', 'A duplicate layer reference was found before applying the layout. Layer ID ') + id + '.');
        seen[key] = true;
        if (kind != 1 && kind != 4 && kind != 5)
            throw new Error(str.t('Один из исходных слоёв недоступен после анализа. Раскладка не применена.', 'One of the source layers is unavailable after analysis. The layout was not applied.'));
        if (!placementIds[key])
            throw new Error(str.t('План раскладки потерял соответствие с исходным слоем ID ', 'The layout plan lost its mapping to source layer ID ') + id + '.');
    }
}

function removePreview(path) {
    for (var attempt = 0; attempt < 3; attempt++) {
        var file = new File(path);
        try { if (!file.exists || file.remove()) return true; } catch (e) { }
        $.sleep(50);
    }
    return false;
}

function cleanupPreviews() {
    for (var i = 0; i < pendingPreviews.length; i++) {
        var path = pendingPreviews[i];
        if (!removePreview(path)) {
            try { pythonApi.cleanup(path); } catch (e) { }
            if (!removePreview(path)) $.writeln('Auto layout: deferred JPEG cleanup: ' + path);
        }
    }
    pendingPreviews = [];
}

// Assign children to a valid geometric skeleton, then reflow the SAME row count,
// scale and gaps. This permits useful cross-row swaps of different-size photos.
function measureLayoutRow(items) {
    var width = 0, height = 0;
    for (var i = 0; i < items.length; i++) {
        width += items[i].width;
        height = Math.max(height, items[i].height);
    }
    return { items: items, contentWidth: width, rowHeight: height };
}

function assignedRowSpec(items, original) {
    var spec = measureLayoutRow(items);
    spec.interval = original.availableInterval;
    spec.top = original.y;
    spec.zoneIndex = original.zoneIndex;
    spec.componentIndex = original.componentIndex;
    return spec;
}

function setClosestRowRange(spec, geometry, scale, width, top) {
    var ranges = getFastRowTopRanges(geometry, spec.rowHeight * scale, width),
        closest = null, distance = 1e100;
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i], d = Math.max(range.topMin - top, top - range.topMax, 0);
        if (d < distance) { distance = d; closest = range; }
    }
    if (!closest) return false;
    spec.allowedTopMin = closest.topMin;
    spec.allowedTopMax = closest.topMax;
    spec.interval = closest.interval;
    return true;
}

function rebuildAssignedLayout(plan, geometry, itemRows, trialOnly) {
    if (!priorityOrderValid(itemRows)) return null;
    var specs = [], fixed = { minFinalGapX: plan.minFinalGapX, actualGapX: plan.actualGapXMin,
        actualGapXMin: plan.actualGapXMin, actualGapXMax: plan.actualGapXMax, byRow: {} }, r, c;
    for (r = 0; r < itemRows.length; r++) {
        var original = plan.rows[r], spec = assignedRowSpec(itemRows[r], original),
            width = spec.contentWidth, count = itemRows[r].length,
            intervalWidth = original.availableInterval.right - original.availableInterval.left;
        fixed.byRow[String(r)] = original.gapX;
        // Left / Center / Right preserve one common visual gap during semantic swaps.
        // Unlocked Justify is different: its gap is recalculated from the FINAL
        // row contents so that the row still reaches both interval edges.
        if (cfg.horizontalAlign != 'justify' &&
            width * plan.commonScale + original.gapX * Math.max(0, count - 1) > intervalWidth + 1e-7) return null;
        if (cfg.horizontalAlign == 'justify' && count > 1 &&
            width * plan.commonScale + plan.minFinalGapX * (count - 1) > intervalWidth + 1e-7) return null;
        specs.push(spec);
    }
    if (geometry.isRectangle) {
        var indices = [];
        for (r = 0; r < specs.length; r++) indices.push(r);
        if (!placeContainerVerticalGroup(specs, indices, plan.commonScale, plan.actualGapY,
            geometry.bounds.top, geometry.bounds.bottom)) return null;
    } else if (geometry.multiZone) {
        var zones = flattenComponentZones(geometry.components), groups = {};
        for (r = 0; r < specs.length; r++) {
            var key = String(specs[r].zoneIndex);
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        }
        for (key in groups) {
            if (!groups.hasOwnProperty(key)) continue;
            var zone = zones[Number(key)];
            if (!zone || !placeContainerVerticalGroup(specs, groups[key], plan.commonScale, plan.actualGapY, zone.top, zone.bottom)) return null;
        }
    } else {
        indices = [];
        for (r = 0; r < specs.length; r++) {
            spec = specs[r];
            var semanticGap = cfg.horizontalAlign == 'justify' ? plan.minFinalGapX : plan.rows[r].gapX,
                needed = spec.contentWidth * plan.commonScale + semanticGap * Math.max(0, spec.items.length - 1);
            if (!setClosestRowRange(spec, geometry, plan.commonScale, needed, plan.rows[r].y)) return null;
            indices.push(r);
        }
        if (!placeRangeVerticalGroup(specs, indices, plan.commonScale, plan.actualGapY, geometry.bounds.top, geometry.bounds.bottom)) return null;
    }
    var metadata = {};
    copyDefinedPlanMetadata(metadata, plan, ['scaleX', 'scaleY', 'fitDifference', 'rhythmPenalty']);
    copyLayoutMetadata(metadata, plan);
    var semanticFixed = cfg.horizontalAlign == 'justify' ? null : fixed,
        candidate = finalizeLayoutRows(specs, plan.commonScale, plan.baseGapX, plan.baseGapY, plan.actualGapY, metadata, semanticFixed);
    if (!candidate) return null;
    candidate.autoRows = plan.autoRows;
    candidate.genderSummary = plan.genderSummary;
    candidate.genderPasses = plan.genderPasses;
    // Row containers/ranges prove non-overlap. Trial permutations preserve IDs;
    // do not run the quadratic pairwise placement check for every candidate.
    for (r = 0; r < candidate.rows.length; r++) {
        var cr = candidate.rows[r], bottom = cr.y + cr.rowHeight * plan.commonScale;
        if (cr.y < geometry.bounds.top - 0.05 || bottom > geometry.bounds.bottom + 0.05) return null;
        if (!geometry.isRectangle) {
            var allowed = getIntervalsForVerticalSpan(geometry, cr.y, bottom), contained = false;
            for (c = 0; c < allowed.length; c++)
                if (cr.availableInterval.left >= allowed[c].left - 0.05 && cr.availableInterval.right <= allowed[c].right + 0.05) { contained = true; break; }
            if (!contained) return null;
        }
    }
    if (!trialOnly) {
        try { validateLayoutPlan(candidate, geometry); }
        catch (e) { if (e.number == 8007) throw e; return null; }
    }
    return candidate;
}

function getSemanticAssignmentScore(plan, geometry, useGender, useHead) {
    var stats = useGender ? getGenderCheckerboardStats(plan) : {}, centerPenalty = stats.minorityCenterPenalty, headCost = 0, smoothCost = 0, leanCost = 0,
        center = (geometry.bounds.left + geometry.bounds.right) / 2, half = Math.max(1, geometry.bounds.width / 2),
        positions = {}, r, c;
    if (useHead) for (var i = 0; i < plan.placements.length; i++) positions[String(plan.placements[i].layerId)] = plan.placements[i].targetCenterX;
    for (r = 0; r < plan.rows.length; r++) {
        var items = plan.rows[r].items, previous = null;
        if (!useHead) continue;
        for (c = 0; c < items.length; c++) {
            var item = items[c];
            if (!item.headTurnValid) { previous = null; continue; }
            var turn = item.headTurn / 80, desired = (center - positions[String(item.id)]) / half, delta = turn - desired;
            headCost += delta * delta;
            if (item.headLeanValid) {
                var leanDelta = item.headLean / 30 - desired;
                leanCost += item.headLeanWeight * leanDelta * leanDelta;
            }
            if (previous != null) {
                var reversal = Math.max(0, turn - previous);
                smoothCost += reversal * reversal;
            }
            previous = turn;
        }
    }
    return { horizontalBad: useGender ? stats.horizontalBad : 0,
        horizontal: useGender ? stats.horizontalGood - stats.horizontalBad : 0,
        symmetry: useGender ? stats.symmetryPenalty : 0,
        minorityCenter: useGender ? centerPenalty : 0,
        head: useHead ? headCost + 0.35 * smoothCost + 0.15 * leanCost : 0,
        vertical: useGender ? stats.verticalGood - (stats.verticalKnown - stats.verticalGood) : 0,
        directionCost: headCost, smoothCost: smoothCost, leanCost: leanCost };
}

function betterSemanticAssignment(a, b, useHead) {
    if (!a) return false;
    if (!b) return true;
    if (a.horizontalBad != b.horizontalBad) return a.horizontalBad < b.horizontalBad;
    if (a.horizontal != b.horizontal) return a.horizontal > b.horizontal;
    if (a.symmetry != b.symmetry) return a.symmetry < b.symmetry;
    if (Math.abs(a.minorityCenter - b.minorityCenter) > 1e-8) return a.minorityCenter < b.minorityCenter;
    if (a.vertical != b.vertical) return a.vertical > b.vertical;
    if (useHead && Math.abs(a.head - b.head) > 1e-9) return a.head < b.head;
    return false;
}

function optimizeSemanticAssignment(plan, geometry, useGender, useHead) {
    var best = plan, initial = getSemanticAssignmentScore(plan, geometry, useGender, useHead), bestScore = initial,
        slots = [], r, c;
    for (r = 0; r < plan.rows.length; r++) for (c = 0; c < plan.rows[r].items.length; c++) slots.push({ row: r, column: c });
    function copyRows(p) {
        var result = [];
        for (var rr = 0; rr < p.rows.length; rr++) result.push(p.rows[rr].items.slice(0));
        return result;
    }
    function consider(rows) {
        var candidate = rebuildAssignedLayout(plan, geometry, rows, true);
        if (!candidate) return null;
        var score = getSemanticAssignmentScore(candidate, geometry, useGender, useHead);
        if (betterSemanticAssignment(score, roundScore, useHead)) { roundBest = candidate; roundScore = score; }
        return candidate;
    }
    function sortedEqualSizeRows(p) {
        var rows = copyRows(p), buckets = {}, position = {}, rr, cc;
        for (var i = 0; i < p.placements.length; i++) position[String(p.placements[i].layerId)] = p.placements[i].targetCenterX;
        for (rr = 0; rr < rows.length; rr++) for (cc = 0; cc < rows[rr].length; cc++) {
            var item = rows[rr][cc];
            if (!item.headTurnValid) continue;
            var key = getItemPriority(item) + '|' + (useGender ? item.gender : 'any') + '|' + item.width.toFixed(6) + '|' + item.height.toFixed(6);
            if (!buckets[key]) buckets[key] = [];
            buckets[key].push({ row: rr, column: cc, item: item, x: position[String(item.id)] });
        }
        for (key in buckets) {
            if (!buckets.hasOwnProperty(key)) continue;
            var photos = [], targets = buckets[key].slice(0);
            for (i = 0; i < targets.length; i++) photos.push(targets[i].item);
            targets.sort(function (a, b) { return (a.x - b.x) || (a.row - b.row) || (a.column - b.column); });
            photos.sort(function (a, b) {
                var av = a.headTurn / 80 + (a.headLeanValid ? 0.15 * a.headLeanWeight * a.headLean / 30 : 0),
                    bv = b.headTurn / 80 + (b.headLeanValid ? 0.15 * b.headLeanWeight * b.headLean / 30 : 0);
                return (bv - av) || (a.order - b.order);
            });
            for (i = 0; i < targets.length; i++) rows[targets[i].row][targets[i].column] = photos[i];
        }
        return rows;
    }
    function rowWidthFits(rowIndex, rawWidth) {
        var original = plan.rows[rowIndex], available = original.availableInterval.right - original.availableInterval.left;
        return rawWidth * plan.commonScale + original.gapX * Math.max(0, original.items.length - 1) <= available + 1e-7;
    }
    // Multi-pass whole-plan refinement: all same-sex cross-row exchanges, and
    // alternative row patterns with equal counts, are assessed after real reflow.
    // Reuse candidates that were already rebuilt for the immediate head-order
    // follow-up instead of rebuilding the same assignment twice.
    for (var pass = 0; pass < 12; pass++) {
        layoutUnitProgress(pass, 12, 'Gender and pose: pass ' + (pass + 1) + ' of max 12');
        var roundBest = best, roundScore = bestScore, baseRows = copyRows(best), rowWidths = [];
        for (r = 0; r < baseRows.length; r++) {
            var rawWidth = 0;
            for (c = 0; c < baseRows[r].length; c++) rawWidth += baseRows[r][c].width;
            rowWidths[r] = rawWidth;
        }
        if (useGender) {
            var allItems = [];
            for (var gr = 0; gr < baseRows.length; gr++) allItems = allItems.concat(baseRows[gr]);
            var globalOrder = reorderItemsForGenderCheckerboard(allItems, plan.distribution), globalRows = [], offset = 0;
            for (gr = 0; gr < plan.distribution.length; gr++) {
                globalRows.push(globalOrder.slice(offset, offset + plan.distribution[gr]));
                offset += plan.distribution[gr];
            }
            var globalTrial = consider(globalRows);
            if (useHead && globalTrial) consider(sortedEqualSizeRows(globalTrial));
        }
        if (useHead) consider(sortedEqualSizeRows(best));
        for (r = 0; useGender && r < baseRows.length; r++) {
            var variants = [baseRows[r].slice(0).reverse()], tokens = [], pools = { M: [], F: [], U: [] };
            for (c = 0; c < baseRows[r].length; c++) {
                var item = baseRows[r][c];
                tokens.push(item.gender); pools[item.gender].push(item);
            }
            var centered = [{ tokens: tokens.slice(0) }];
            centerMinorityGenderRows(centered);
            variants.push(centered[0].tokens);
            variants.push(centered[0].tokens.slice(0).reverse());
            for (var v = 0; v < variants.length; v++) {
                var rows = copyRows(best), counters = { M: 0, F: 0, U: 0 }, variant = variants[v];
                for (c = 0; c < variant.length; c++) {
                    var sex = typeof variant[c] == 'string' ? variant[c] : variant[c].gender;
                    rows[r][c] = pools[sex][counters[sex]++];
                }
                var trial = consider(rows);
                if (useHead && trial) consider(sortedEqualSizeRows(trial));
            }
        }
        var searchSlots = slots;
        if ((useGender || useHead) && slots.length > 80) {
            var rankPositions = {}, ranked = slots.slice(0), searchSlots = [];
            for (var pi = 0; pi < best.placements.length; pi++) rankPositions[String(best.placements[pi].layerId)] = best.placements[pi].targetCenterX;
            var cx = (geometry.bounds.left + geometry.bounds.right) / 2, hw = Math.max(1, geometry.bounds.width / 2);
            ranked.sort(function (a, b) {
                var ai = baseRows[a.row][a.column], bi = baseRows[b.row][b.column],
                    da = ai.headTurnValid ? ai.headTurn / 80 - (cx - rankPositions[String(ai.id)]) / hw : 0,
                    db = bi.headTurnValid ? bi.headTurn / 80 - (cx - rankPositions[String(bi.id)]) / hw : 0;
                return db * db - da * da;
            });
            for (var si = 0; si < 24; si++) searchSlots.push(ranked[si]);
            for (si = 0; si < 24; si++) {
                var sample = slots[Math.floor(si * (slots.length - 1) / 23)], duplicate = false;
                for (var qi = 0; qi < searchSlots.length; qi++) if (searchSlots[qi] == sample) duplicate = true;
                if (!duplicate) searchSlots.push(sample);
            }
        }
        if (useGender || useHead) for (var a = 0; a < searchSlots.length; a++) {
            if ((a % 8) == 0) layoutUnitProgress(pass + a / Math.max(1, searchSlots.length), 12, 'Gender and pose: pass ' + (pass + 1) + ', positions ' + a + '/' + searchSlots.length);
            for (var b = a + 1; b < searchSlots.length; b++) {
                var sa = searchSlots[a], sb = searchSlots[b], ai = baseRows[sa.row][sa.column], bi = baseRows[sb.row][sb.column];
                if (getItemPriority(ai) != getItemPriority(bi)) continue;
                var genderChange = useGender && ai.gender != bi.gender,
                    poseChange = useHead && ai.headTurnValid && bi.headTurnValid && (ai.headTurn != bi.headTurn ||
                        (ai.headLeanValid ? ai.headLeanWeight * ai.headLean : 0) != (bi.headLeanValid ? bi.headLeanWeight * bi.headLean : 0));
                if (!genderChange && !poseChange) continue;
                // Fast reject is exactly the first horizontal-fit condition used
                // by rebuildAssignedLayout; it only skips candidates that would
                // be rejected there anyway.
                if (sa.row != sb.row) {
                    var widthA = rowWidths[sa.row] - ai.width + bi.width,
                        widthB = rowWidths[sb.row] - bi.width + ai.width;
                    if (!rowWidthFits(sa.row, widthA) || !rowWidthFits(sb.row, widthB)) continue;
                }
                // Gender repair does not depend on pose availability. Counts
                // may move between rows; only total M/F/U counts are invariant.
                var rows = copyRows(best);
                rows[sa.row][sa.column] = bi; rows[sb.row][sb.column] = ai;
                consider(rows);
            }
        }
        if (roundBest == best) break;
        best = roundBest; bestScore = roundScore;
    }
    try { validateLayoutPlan(best, geometry); }
    catch (finalError) { if (finalError.number == 8007) throw finalError; best = plan; bestScore = initial; }
    if (best == plan) {
        var unchanged = {};
        for (var property in plan) if (plan.hasOwnProperty(property)) unchanged[property] = plan[property];
        best = unchanged;
    }
    if (useGender) best.genderCheckerboard = getGenderCheckerboardStats(best);
    if (useHead) best.headTurnOrdering = { centerX: (geometry.bounds.left + geometry.bounds.right) / 2,
        initialCost: initial.head, finalCost: bestScore.head, smoothCost: bestScore.smoothCost, passes: pass };
    best.semanticAssignment = bestScore;
    return best;
}


function buildGenderAwareLayoutPlan(items, geometry) {
    // Geometry stays authoritative. First discover the geometric row distribution,
    // then feed a checkerboard ordering through the same unchanged solver. If the
    // reordered dimensions change the chosen distribution, converge for at most
    // two additional passes.
    setLayoutProgressRange(0, .25);
    var seedPlan = buildLayoutPlan(items, geometry);
    if (!seedPlan) return null;

    if (seedPlan.pythonPacking || seedPlan.lockedMetrics) return seedPlan; // The shared semantic optimizer handles M/F without a second Python search.
    var distribution = seedPlan.distribution.slice(0),
        best = null,
        previousSignature = '',
        pass;

    for (pass = 0; pass < 3; pass++) {
        setLayoutProgressRange(.25 + pass * .25, .25);
        var ordered = reorderItemsForGenderCheckerboard(items, distribution),
            signature = getItemOrderSignature(ordered) + '|' + distribution.join(','),
            candidate = null;
        try { candidate = buildLayoutPlan(ordered, geometry); }
        catch (semanticLayoutError) {
            if (semanticLayoutError.number == 8007) throw semanticLayoutError;
            // The original palette-order plan already fits. A semantic reorder
            // must not make a valid geometry-only layout fail.
            break;
        }
        if (!candidate) break;

        var stats = getGenderCheckerboardStats(candidate);
        candidate.genderCheckerboard = stats;
        candidate.genderPasses = pass + 1;

        if (!best || isBetterGenderPlan(candidate, best)) best = candidate;
        if (signature == previousSignature || arraysEqual(candidate.distribution, distribution)) break;

        previousSignature = signature;
        distribution = candidate.distribution.slice(0);
    }

    if (!best) {
        seedPlan.genderCheckerboard = getGenderCheckerboardStats(seedPlan);
        seedPlan.genderPasses = 0;
        return seedPlan;
    }
    return best;
}


function reorderItemsForGenderCheckerboard(items, distribution) {
    // Split only at category boundaries, retaining the real row intersections.
    if (!items.length || getItemPriority(items[0]) == getItemPriority(items[items.length - 1]))
        return reorderGenderPool(items, distribution);
    var result = [], start = 0, rowStart, i, end, counts;
    while (start < items.length) {
        end = start + 1;
        while (end < items.length && getItemPriority(items[end]) == getItemPriority(items[start])) end++;
        counts = []; rowStart = 0;
        for (i = 0; i < distribution.length; i++) {
            var overlap = Math.min(end, rowStart + distribution[i]) - Math.max(start, rowStart);
            if (overlap > 0) counts.push(overlap);
            rowStart += distribution[i];
        }
        result = result.concat(reorderGenderPool(items.slice(start, end), counts)); start = end;
    }
    return result;
}

function reorderGenderPool(items, distribution) {
    var male = [], female = [], unknown = [], i;
    for (i = 0; i < items.length; i++) {
        if (items[i].gender == 'M') male.push(items[i]);
        else if (items[i].gender == 'F') female.push(items[i]);
        else unknown.push(items[i]);
    }

    var layout = solveGenderRowTemplates(distribution, male.length, female.length, unknown.length),
        output = [], mi = 0, fi = 0, ui = 0, r, c, token;

    if (!layout || !layout.rows || !layout.rows.length) {
        layout = { rows: [] };
        for (r = 0; r < distribution.length; r++) {
            layout.rows.push({ tokens: buildGenderRowTemplate(distribution[r], (r % 2 == 0) ? 'M' : 'F') });
        }
    }

    improveGenderRowTokens(layout.rows);
    centerMinorityGenderRows(layout.rows);

    for (r = 0; r < layout.rows.length; r++) {
        var tokens = layout.rows[r].tokens;
        for (c = 0; c < tokens.length; c++) {
            token = tokens[c];
            if (token == 'M' && mi < male.length) output.push(male[mi++]);
            else if (token == 'F' && fi < female.length) output.push(female[fi++]);
            else if (token == 'U' && ui < unknown.length) output.push(unknown[ui++]);
        }
    }

    while (mi < male.length) output.push(male[mi++]);
    while (fi < female.length) output.push(female[fi++]);
    while (ui < unknown.length) output.push(unknown[ui++]);
    return output;
}

// Improve actual adjacency after choosing row starts. This redistributes scarce
// known genders and unknown separators instead of exhausting them in early rows.
// Swaps keep counts intact; materialization below retains order within each pool.
function improveGenderRowTokens(rows) {
    var tokens = [], rowOf = [], localOf = [], r, c, i, j;
    for (r = 0; r < rows.length; r++) {
        for (c = 0; c < rows[r].tokens.length; c++) {
            tokens.push(rows[r].tokens[c]); rowOf.push(r); localOf.push(c);
        }
    }
    function edge(a, b) {
        if (a == 'U' || b == 'U') return 0;
        return a != b ? 1 : -1;
    }
    function changedValue(index, a, b) {
        return index == a ? tokens[b] : (index == b ? tokens[a] : tokens[index]);
    }
    function delta(a, b) {
        var edges = [], k, left, out = 0;
        // Only the horizontal edges incident to the two positions can change.
        var positions = [a - 1, a, b - 1, b];
        for (k = 0; k < positions.length; k++) {
            left = positions[k];
            if (left < 0 || left + 1 >= tokens.length || rowOf[left] != rowOf[left + 1] || arrayContains(edges, left)) continue;
            edges.push(left);
            out += edge(changedValue(left, a, b), changedValue(left + 1, a, b)) - edge(tokens[left], tokens[left + 1]);
        }
        return out;
    }
    // Bounded local refinement: strict improvement prevents cycles. Row-start DP
    // still supplies the initial global template and its vertical preference.
    for (var pass = 0; pass < 8; pass++) {
        var bestDelta = 0, bestA = -1, bestB = -1;
        for (i = 0; i < tokens.length; i++) {
            if ((i % 32) == 0) progress(currentProgressValue);
            for (j = i + 1; j < tokens.length; j++) {
                if (tokens[i] == tokens[j]) continue;
                var gain = delta(i, j);
                if (gain > bestDelta) { bestDelta = gain; bestA = i; bestB = j; }
            }
        }
        if (bestA < 0) break;
        var value = tokens[bestA]; tokens[bestA] = tokens[bestB]; tokens[bestB] = value;
    }
    for (i = 0; i < tokens.length; i++) rows[rowOf[i]].tokens[localOf[i]] = tokens[i];
}

function genderRowSymmetryPenalty(items) {
    var m = 0, f = 0, tokens = [], penalty = 0;
    for (var i = 0; i < items.length; i++) {
        var sex = typeof items[i] == 'string' ? items[i] : items[i].gender;
        tokens.push(sex); if (sex == 'M') m++; else if (sex == 'F') f++;
    }
    // Balanced rows keep strict alternation, not a forced palindrome.
    if (!m || !f || Math.abs(m - f) <= 1) return 0;
    for (i = 0; i < Math.floor(tokens.length / 2); i++)
        if (tokens[i] != tokens[tokens.length - 1 - i]) penalty++;
    return penalty;
}

function getPlanGenderSymmetryPenalty(plan) {
    var total = 0;
    for (var r = 0; r < plan.rows.length; r++) total += genderRowSymmetryPenalty(plan.rows[r].items);
    return total;
}

function symmetricKnownGenderTokens(male, female) {
    var n = male + female, small = Math.min(male, female), minority = male < female ? 'M' : 'F',
        majority = oppositeGender(minority), memo = {}, cache = symmetricKnownGenderTokens.cache;
    if (!cache) cache = symmetricKnownGenderTokens.cache = {};
    var cacheKey = male + ':' + female;
    if (cache[cacheKey]) return cache[cacheKey].slice(0);
    function rec(depth, leftSmall, outerLeft, outerRight) {
        var len = n - 2 * depth, key = depth + ':' + leftSmall + ':' + outerLeft + ':' + outerRight;
        if (leftSmall < 0 || leftSmall > len) return null;
        if (memo[key] !== undefined) return memo[key];
        if (!len) return { bad: outerLeft == outerRight ? 1 : 0, symmetry: 0, center: 0, tokens: [] };
        if (len == 1) {
            var value = leftSmall ? minority : majority;
            return { bad: (outerLeft == value ? 1 : 0) + (outerRight == value ? 1 : 0), symmetry: 0, center: 0, tokens: [value] };
        }
        var best = null;
        for (var a = 0; a <= 1; a++) for (var b = 0; b <= 1; b++) {
            var l = a ? minority : majority, r = b ? minority : majority,
                inner = rec(depth + 1, leftSmall - a - b, l, r);
            if (!inner) continue;
            var distance = (n - 1) / 2 - depth,
                candidate = { bad: inner.bad + (outerLeft == l ? 1 : 0) + (outerRight == r ? 1 : 0),
                    symmetry: inner.symmetry + (l != r ? 1 : 0), center: inner.center + (a + b) * distance * distance,
                    tokens: [l].concat(inner.tokens, [r]) };
            if (!best || candidate.bad < best.bad || (candidate.bad == best.bad &&
                (candidate.symmetry < best.symmetry || (candidate.symmetry == best.symmetry && candidate.center < best.center)))) best = candidate;
        }
        memo[key] = best;
        return best;
    }
    var answer = rec(0, small, '', '');
    cache[cacheKey] = answer.tokens;
    return answer.tokens.slice(0);
}

function minorityCenterPenalty(rowItems, positions, commonScale) {
    var male = 0, female = 0, i;
    for (i = 0; i < rowItems.length; i++) {
        var sex = typeof rowItems[i] == 'string' ? rowItems[i] : rowItems[i].gender;
        if (sex == 'M') male++; else if (sex == 'F') female++;
    }
    if (!male || !female || Math.abs(male - female) <= 1) return 0;
    var minority = male < female ? 'M' : 'F', center = (rowItems.length - 1) / 2, penalty = 0, pitch = 1;
    if (positions && rowItems.length > 1) {
        var first = rowItems[0], last = rowItems[rowItems.length - 1],
            firstX = positions[String(first.id)], lastX = positions[String(last.id)];
        center = (firstX - first.width * commonScale / 2 + lastX + last.width * commonScale / 2) / 2;
        pitch = Math.max(1e-7, (lastX - firstX) / (rowItems.length - 1));
    }
    for (i = 0; i < rowItems.length; i++) {
        sex = typeof rowItems[i] == 'string' ? rowItems[i] : rowItems[i].gender;
        if (sex == minority) {
            var distance = ((positions ? positions[String(rowItems[i].id)] : i) - center) / pitch;
            penalty += distance * distance;
        }
    }
    return penalty;
}

function centerMinorityGenderRows(rows) {
    function horizontal(tokens) {
        var score = 0;
        for (var c = 1; c < tokens.length; c++)
            if (tokens[c] != 'U' && tokens[c - 1] != 'U') score += tokens[c] != tokens[c - 1] ? 1 : -1;
        return score;
    }
    for (var r = 0; r < rows.length; r++) {
        var tokens = rows[r].tokens, male = 0, female = 0, unknown = 0, c;
        for (c = 0; c < tokens.length; c++) {
            if (tokens[c] == 'M') male++; else if (tokens[c] == 'F') female++; else unknown++;
        }
        if (!male || !female || Math.abs(male - female) <= 1) continue;
        if (!unknown) {
            // Exact minimum repeats, then mirror symmetry, then centrality.
            rows[r].tokens = symmetricKnownGenderTokens(male, female);
            continue;
        }
        // Unknowns remain neutral. Refine within the row without sacrificing
        // its existing known-sex alternation, then prefer central minority slots.
        for (var pass = 0; pass < tokens.length; pass++) {
            var h = horizontal(tokens), centerCost = minorityCenterPenalty(tokens), bestA = -1, bestB = -1, bestH = h, bestCenter = centerCost, bestSymmetry = genderRowSymmetryPenalty(tokens);
            for (var a = 0; a < tokens.length; a++) for (var b = a + 1; b < tokens.length; b++) {
                if (tokens[a] == tokens[b]) continue;
                var tmp = tokens[a]; tokens[a] = tokens[b]; tokens[b] = tmp;
                var candidateH = horizontal(tokens), candidateCenter = minorityCenterPenalty(tokens), candidateSymmetry = genderRowSymmetryPenalty(tokens);
                tmp = tokens[a]; tokens[a] = tokens[b]; tokens[b] = tmp;
                if (candidateH > bestH || (candidateH == bestH && (candidateSymmetry < bestSymmetry ||
                    (candidateSymmetry == bestSymmetry && candidateCenter < bestCenter - 1e-9)))) {
                    bestH = candidateH; bestCenter = candidateCenter; bestSymmetry = candidateSymmetry; bestA = a; bestB = b;
                }
            }
            if (bestA < 0) break;
            tmp = tokens[bestA]; tokens[bestA] = tokens[bestB]; tokens[bestB] = tmp;
        }
    }
}

// Exact row allocation for known M/F counts. Greedy consumption by a row-start
// template can strand the other sex in later rows even though it can alternate.
function solveKnownGenderAllocation(distribution, maleCount, femaleCount) {
    var prefix = [0], memo = {}, r;
    for (r = 0; r < distribution.length; r++) prefix[r + 1] = prefix[r] + distribution[r];
    function rec(index, usedMale, previousStart) {
        var key = index + '|' + usedMale + '|' + previousStart;
        if (memo[key] !== undefined) return memo[key];
        if (index == distribution.length) return usedMale == maleCount ? { ok: true, bad: 0, symmetry: 0, center: 0, vertical: 0, rows: [] } : null;
        var len = distribution[index], mLeft = maleCount - usedMale,
            fLeft = femaleCount - (prefix[index] - usedMale), best = null;
        for (var m = Math.max(0, len - fLeft); m <= Math.min(len, mLeft); m++) {
            var f = len - m, starts = m == f ? ['M', 'F'] : [m > f ? 'M' : 'F'];
            for (var s = 0; s < starts.length; s++) {
                var row = buildGenderRowFromPools(len, starts[s], m, f, 0), centered = [{ start: starts[s], tokens: row.tokens }];
                centerMinorityGenderRows(centered);
                var next = rec(index + 1, usedMale + m, starts[s]);
                if (!next || !next.ok) continue;
                var bad = Math.max(0, Math.abs(m - f) - 1) + next.bad,
                    symmetry = genderRowSymmetryPenalty(centered[0].tokens) + next.symmetry,
                    center = minorityCenterPenalty(centered[0].tokens) + next.center,
                    vertical = next.vertical + (previousStart && previousStart != starts[s] ? Math.min(distribution[index - 1], len) : 0),
                    candidate = { ok: true, bad: bad, symmetry: symmetry, center: center, vertical: vertical,
                        rows: centered.concat(next.rows), remainingUnknown: 0 };
                if (!best || bad < best.bad || (bad == best.bad && (symmetry < best.symmetry ||
                    (symmetry == best.symmetry && (center < best.center - 1e-8 ||
                    (Math.abs(center - best.center) <= 1e-8 && vertical > best.vertical)))))) best = candidate;
            }
        }
        memo[key] = best;
        return best;
    }
    return rec(0, 0, '');
}

function solveGenderRowTemplates(distribution, maleCount, femaleCount, unknownCount) {
    if (!unknownCount) return solveKnownGenderAllocation(distribution, maleCount, femaleCount);
    var prefix = [0], i;
    for (i = 0; i < distribution.length; i++) prefix[i + 1] = prefix[i] + distribution[i];
    var total = prefix[distribution.length], memo = {};

    function scoreKey(stats) {
        // Strong priority: horizontal alternation within rows.
        // Softer priority: checkerboard alternation between neighbouring rows.
        // Unknowns are better than forced wrong known-sex placements.
        return stats.horizontalGood * 1000 - stats.horizontalBad * 1000 +
            stats.rowMatched * 100 - stats.rowMismatched * 100 +
            stats.usedUnknown * 5 + stats.verticalGood * 10 - stats.verticalBad * 10;
    }

    function betterCandidate(a, b) {
        if (!a) return false;
        if (!b) return true;
        var ak = scoreKey(a.stats), bk = scoreKey(b.stats);
        if (ak > bk) return true;
        if (ak < bk) return false;
        if (a.remainingUnknown < b.remainingUnknown) return true;
        if (a.remainingUnknown > b.remainingUnknown) return false;
        return false;
    }

    function rec(rowIndex, maleUsed, femaleUsed, prevStart) {
        var key = rowIndex + '|' + maleUsed + '|' + femaleUsed + '|' + prevStart;
        if (memo[key] !== undefined) return memo[key];
        if (rowIndex >= distribution.length) {
            return memo[key] = {
                ok: true,
                stats: { horizontalGood: 0, horizontalBad: 0, rowMatched: 0, rowMismatched: 0, usedUnknown: 0, verticalGood: 0, verticalBad: 0 },
                rows: [],
                remainingUnknown: unknownCount - (total - maleUsed - femaleUsed)
            };
        }

        var placedBefore = prefix[rowIndex],
            unknownUsed = placedBefore - maleUsed - femaleUsed,
            maleLeft = maleCount - maleUsed,
            femaleLeft = femaleCount - femaleUsed,
            unknownLeft = unknownCount - unknownUsed,
            len = distribution[rowIndex],
            starts = ['M', 'F'],
            best = null,
            s;

        for (s = 0; s < starts.length; s++) {
            var start = starts[s],
                row = buildGenderRowFromPools(len, start, maleLeft, femaleLeft, unknownLeft),
                next, candidate, overlap;
            if (!row) continue;
            next = rec(rowIndex + 1, maleUsed + row.usedMale, femaleUsed + row.usedFemale, start);
            if (!next || !next.ok) continue;

            candidate = {
                ok: true,
                rows: [{ start: start, tokens: row.tokens }].concat(next.rows),
                remainingUnknown: next.remainingUnknown,
                stats: mergeGenderStats(row.stats, next.stats)
            };

            if (prevStart) {
                overlap = rowIndex > 0 ? Math.min(distribution[rowIndex - 1], len) : 0;
                if (overlap > 0) {
                    if (start != prevStart) candidate.stats.verticalGood += overlap;
                    else candidate.stats.verticalBad += overlap;
                }
            }

            if (betterCandidate(candidate, best)) best = candidate;
        }

        if (!best) {
            best = { ok: false, rows: [] };
        }
        memo[key] = best;
        return best;
    }

    return rec(0, 0, 0, '');
}

function buildGenderRowTemplate(len, start) {
    var tokens = [], c;
    for (c = 0; c < len; c++) tokens.push((((c % 2) == 0) ? start : oppositeGender(start)));
    return tokens;
}

function buildGenderRowFromPools(len, start, maleLeft, femaleLeft, unknownLeft) {
    var expected = buildGenderRowTemplate(len, start),
        tokens = [], c,
        prevKnown = '',
        stats = { horizontalGood: 0, horizontalBad: 0, rowMatched: 0, rowMismatched: 0, usedUnknown: 0, verticalGood: 0, verticalBad: 0 },
        usedMale = 0, usedFemale = 0, usedUnknown = 0;

    for (c = 0; c < expected.length; c++) {
        var wanted = expected[c], token = '';
        if (wanted == 'M' && maleLeft > 0) { token = 'M'; maleLeft--; usedMale++; }
        else if (wanted == 'F' && femaleLeft > 0) { token = 'F'; femaleLeft--; usedFemale++; }
        else if (unknownLeft > 0) { token = 'U'; unknownLeft--; usedUnknown++; stats.usedUnknown++; }
        else if (wanted == 'M' && femaleLeft > 0) { token = 'F'; femaleLeft--; usedFemale++; }
        else if (wanted == 'F' && maleLeft > 0) { token = 'M'; maleLeft--; usedMale++; }
        else break;

        tokens.push(token);

        if (token == wanted) stats.rowMatched++;
        else if (token != 'U') stats.rowMismatched++;

        if (token != 'U') {
            if (prevKnown) {
                if (prevKnown != token) stats.horizontalGood++;
                else stats.horizontalBad++;
            }
            prevKnown = token;
        } else {
            prevKnown = '';
        }
    }

    return { tokens: tokens, usedMale: usedMale, usedFemale: usedFemale, usedUnknown: usedUnknown, stats: stats };
}

function mergeGenderStats(a, b) {
    return {
        horizontalGood: a.horizontalGood + b.horizontalGood,
        horizontalBad: a.horizontalBad + b.horizontalBad,
        rowMatched: a.rowMatched + b.rowMatched,
        rowMismatched: a.rowMismatched + b.rowMismatched,
        usedUnknown: a.usedUnknown + b.usedUnknown,
        verticalGood: a.verticalGood + b.verticalGood,
        verticalBad: a.verticalBad + b.verticalBad
    };
}

function oppositeGender(sex) {
    return sex == 'M' ? 'F' : 'M';
}

function getPlanMinorityCenterPenalty(plan) {
    var penalty = 0, positions = {};
    for (var i = 0; plan.placements && i < plan.placements.length; i++) positions[String(plan.placements[i].layerId)] = plan.placements[i].targetCenterX;
    for (var r = 0; r < plan.rows.length; r++) penalty += minorityCenterPenalty(plan.rows[r].items, plan.placements ? positions : null, plan.commonScale);
    return penalty;
}

function getGenderCheckerboardStats(plan) {
    var result = evaluateGenderRowsForStats(plan && plan.rows ? plan.rows : []),
        known = result.known,
        matched = result.matched,
        mismatched = result.mismatched,
        unknown = result.unknown,
        verticalKnown = result.verticalKnown,
        verticalGood = result.verticalGood;
    return {
        known: known,
        matched: matched,
        mismatched: mismatched,
        unknown: unknown,
        verticalKnown: verticalKnown,
        verticalGood: verticalGood,
        symmetryPenalty: getPlanGenderSymmetryPenalty(plan),
        minorityCenterPenalty: getPlanMinorityCenterPenalty(plan),
        horizontalGood: result.horizontalGood,
        horizontalBad: result.horizontalBad,
        rowStarts: result.rowStarts,
        score: known ? matched / known : 1,
        verticalScore: verticalKnown ? verticalGood / verticalKnown : 1
    };
}

function evaluateGenderRowsForStats(rows) {
    var memo = {}, distribution = [], r;
    for (r = 0; r < rows.length; r++) distribution.push((rows[r].items || []).length);

    function rowStats(rowItems, start) {
        var expected = buildGenderRowTemplate(rowItems.length, start),
            matched = 0, mismatched = 0, unknown = 0,
            horizontalGood = 0, horizontalBad = 0,
            prevKnown = '', c;
        for (c = 0; c < rowItems.length; c++) {
            var sex = rowItems[c].gender || 'U';
            if (sex == 'U') { unknown++; prevKnown = ''; continue; }
            if (sex == expected[c]) matched++; else mismatched++;
            if (prevKnown) {
                if (prevKnown != sex) horizontalGood++; else horizontalBad++;
            }
            prevKnown = sex;
        }
        return { matched: matched, mismatched: mismatched, unknown: unknown, horizontalGood: horizontalGood, horizontalBad: horizontalBad };
    }

    function better(a, b) {
        if (!a) return false;
        if (!b) return true;
        if (a.matched > b.matched) return true;
        if (a.matched < b.matched) return false;
        if (a.horizontalBad < b.horizontalBad) return true;
        if (a.horizontalBad > b.horizontalBad) return false;
        if (a.verticalGood > b.verticalGood) return true;
        if (a.verticalGood < b.verticalGood) return false;
        if (a.mismatched < b.mismatched) return true;
        if (a.mismatched > b.mismatched) return false;
        return false;
    }

    function rec(rowIndex, prevStart) {
        var key = rowIndex + '|' + prevStart;
        if (memo[key] !== undefined) return memo[key];
        if (rowIndex >= rows.length) {
            return memo[key] = { matched: 0, mismatched: 0, unknown: 0, verticalGood: 0, verticalKnown: 0, horizontalBad: 0, rowStarts: [] };
        }

        var starts = ['M', 'F'], best = null, s;
        for (s = 0; s < starts.length; s++) {
            var start = starts[s],
                rs = rowStats(rows[rowIndex].items || [], start),
                next = rec(rowIndex + 1, start),
                overlap = rowIndex > 0 ? Math.min(distribution[rowIndex - 1], distribution[rowIndex]) : 0,
                verticalGood = next.verticalGood,
                verticalKnown = next.verticalKnown,
                candidate;
            if (prevStart && overlap > 0) {
                verticalKnown += overlap;
                if (start != prevStart) verticalGood += overlap;
            }
            candidate = {
                matched: rs.matched + next.matched,
                mismatched: rs.mismatched + next.mismatched,
                unknown: rs.unknown + next.unknown,
                verticalGood: verticalGood,
                verticalKnown: verticalKnown,
                horizontalBad: rs.horizontalBad + next.horizontalBad,
                rowStarts: [start].concat(next.rowStarts)
            };
            if (better(candidate, best)) best = candidate;
        }
        memo[key] = best;
        return best;
    }

    var result = rec(0, '');
    result.horizontalGood = 0;
    result.verticalKnown = 0;
    result.verticalGood = 0;
    for (r = 0; r < rows.length; r++) {
        var current = rows[r].items || [], previous = r > 0 ? (rows[r - 1].items || []) : [];
        result.horizontalGood += rowStats(current, result.rowStarts[r]).horizontalGood;
        for (var c = 0; c < Math.min(current.length, previous.length); c++) {
            var a = current[c].gender, b = previous[c].gender;
            if ((a == 'M' || a == 'F') && (b == 'M' || b == 'F')) {
                result.verticalKnown++;
                if (a != b) result.verticalGood++;
            }
        }
    }
    result.known = result.matched + result.mismatched;
    return result;
}

function isBetterGenderPlan(candidate, current) {
    if (cfg.rowRhythm != 'auto') {
        var shapeOrder = compareVerticalRowScores(getVerticalRowScore(candidate.distribution, cfg.rowRhythm), getVerticalRowScore(current.distribution, cfg.rowRhythm));
        if (shapeOrder) return shapeOrder < 0;
    }
    var a = candidate.genderCheckerboard || getGenderCheckerboardStats(candidate),
        b = current.genderCheckerboard || getGenderCheckerboardStats(current),
        eps = 0.000001;
    var ah = a.horizontalGood - a.horizontalBad, bh = b.horizontalGood - b.horizontalBad;
    if (a.horizontalBad < b.horizontalBad) return true;
    if (a.horizontalBad > b.horizontalBad) return false;
    if (ah > bh) return true;
    if (ah < bh) return false;
    if (a.symmetryPenalty != b.symmetryPenalty) return a.symmetryPenalty < b.symmetryPenalty;
    if (a.minorityCenterPenalty < b.minorityCenterPenalty - eps) return true;
    if (a.minorityCenterPenalty > b.minorityCenterPenalty + eps) return false;
    if (a.score > b.score + eps) return true;
    if (a.score < b.score - eps) return false;
    if (a.verticalScore > b.verticalScore + eps) return true;
    if (a.verticalScore < b.verticalScore - eps) return false;
    if (candidate.commonScale > current.commonScale + 1e-10) return true;
    if (candidate.commonScale < current.commonScale - 1e-10) return false;
    return candidate.rhythmPenalty < current.rhythmPenalty - eps;
}

function getItemOrderSignature(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) out.push(items[i].id);
    return out.join(',');
}

function arraysEqual(a, b) {
    if (!a || !b || a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
    return true;
}

function buildLayoutPlan(items, geometry) {
    return refineVerticalLayout(buildGeometricLayoutPlan(items, geometry), geometry);
}

function buildGeometricLayoutPlan(items, geometry) {
    if (lockedLayoutActive()) return buildLockedLayoutPlan(items, geometry);
    var medianHeight = getMedianHeight(items),
        baseGapX = medianHeight * cfg.gapX / 100,
        baseGapY = medianHeight * cfg.gapY / 100;

    // Rectangular selections keep the original fast deterministic solver.
    // One-contour shapes with one interval per band use the fast band solver.
    // Disconnected areas, holes and parallel intervals use the multi-zone DP.
    if (geometry.multiZone) {
        var accelerated = tryPythonZoneLayout(items, geometry, baseGapX, baseGapY);
        if (accelerated) return accelerated;
        progress(32, 'Distributing across zones...')
        var multi = buildMultiZoneLayoutFast(items, geometry, baseGapX, baseGapY);
        if (!multi) throw new Error(str.t('Не удалось распределить слои по отдельным площадкам выделения.', 'Could not distribute layers across the separate selection zones.'))
        multi.autoRows = cfg.autoRows
        if (cfg.pythonPacking && !alphabetOrderActive()) multi.packingFallbackReason = packingFallbackReason;
        return multi
    }

    if (!geometry.isRectangle) {
        progress(32, 'Calculating selection shape...')
        var shaped = buildShapedLayoutFast(items, geometry, baseGapX, baseGapY);
        if (!shaped) throw new Error(str.t('Не удалось подобрать раскладку для формы выделения.', 'Could not find a layout for the selection shape.'))
        shaped.autoRows = cfg.autoRows
        return shaped
    }

    var minRows = cfg.autoRows ? 1 : Math.max(1, Math.min(cfg.rows, items.length)),
        maxRows = cfg.autoRows ? items.length : minRows,
        candidates = maxRows - minRows + 1,
        best = null,
        tested = 0;

    for (var rowsCount = minRows; rowsCount <= maxRows; rowsCount++) {
        progress(32 + 23 * (tested / Math.max(1, candidates)), 'Checked ' + tested + '/' + candidates + '; ' + rowsCount + ' rows')

        var distribution = getBalancedDistribution(items.length, rowsCount),
            candidate = buildRectangularLayoutCandidate(items, geometry, distribution, baseGapX, baseGapY);

        if (!best || isBetterLayout(candidate, best)) best = candidate
        tested++
    }

    progress(55, 'Choosing best layout...')

    if (!best)
        throw new Error(str.t('Не удалось подобрать подходящее количество рядов.', 'Could not find a suitable number of rows.'))

    best.autoRows = cfg.autoRows
    best.testedRows = tested
    return best
}

function buildRectangularLayoutCandidate(items, geometry, distribution, baseGapX, baseGapY) {
    var rowSpecs = [],
        index = 0,
        maxMinRowWidth = 0,
        minLayoutHeight = 0,
        r;

    for (r = 0; r < distribution.length; r++) {
        var count = distribution[r], spec = measureLayoutRow(items.slice(index, index + count));
        index += count;
        var minRowWidth = spec.contentWidth + Math.max(0, count - 1) * baseGapX;
        if (minRowWidth > maxMinRowWidth) maxMinRowWidth = minRowWidth;
        minLayoutHeight += spec.rowHeight;
        spec.interval = { left: geometry.bounds.left, right: geometry.bounds.right };
        rowSpecs.push(spec);
    }

    if (rowSpecs.length > 1) minLayoutHeight += baseGapY * (rowSpecs.length - 1);

    var scaleX = geometry.bounds.width / maxMinRowWidth,
        scaleY = geometry.bounds.height / minLayoutHeight,
        commonScale = Math.min(scaleX, scaleY, cfg.noEnlarge ? 1 : Infinity);

    if (!isFinite(commonScale) || commonScale <= 0) return null;

    var rowIndices = [];
    for (r = 0; r < rowSpecs.length; r++) rowIndices.push(r);

    var vertical = resolveVerticalLayout(rowSpecs, [{
        type: 'container',
        rowIndices: rowIndices,
        top: geometry.bounds.top,
        bottom: geometry.bounds.bottom
    }], commonScale, baseGapY);
    if (!vertical) return null;

    return finalizeLayoutRows(rowSpecs, commonScale, baseGapX, baseGapY, vertical.gapY, {
        scaleX: scaleX,
        scaleY: scaleY,
        fitDifference: Math.abs(scaleX - scaleY),
        layoutHeight: vertical.layoutHeight
    });
}

function resolveVerticalLayout(rowSpecs, groups, commonScale, baseGapY) {
    var minFinalGapY = baseGapY * commonScale,
        maxFinalGapY = minFinalGapY * cfg.maxGapMultiplier,
        gapMin = minFinalGapY,
        gapMax = maxFinalGapY,
        hasAdjacentRows = false,
        g;

    for (g = 0; g < groups.length; g++) {
        var group = groups[g],
            indices = group.rowIndices || [];

        if (!indices.length) continue;
        if (indices.length <= 1) continue;

        hasAdjacentRows = true;
        var limits = group.type == 'ranges' ?
            getRangeVerticalGapBounds(rowSpecs, indices, commonScale) :
            getContainerVerticalGapBounds(rowSpecs, indices, commonScale, group.top, group.bottom);

        if (!limits) return null;
        if (limits.min > gapMin) gapMin = limits.min;
        if (limits.max < gapMax) gapMax = limits.max;
    }

    var actualGapY = 0;
    if (hasAdjacentRows) {
        if (gapMax < gapMin - FIT_EPS) return null;
        if (gapMax < gapMin) gapMax = gapMin;
        actualGapY = gapMax;
    }

    for (g = 0; g < groups.length; g++) {
        group = groups[g];
        indices = group.rowIndices || [];
        if (!indices.length) continue;

        var placed = group.type == 'ranges' ?
            placeRangeVerticalGroup(rowSpecs, indices, commonScale, actualGapY, group.top, group.bottom) :
            placeContainerVerticalGroup(rowSpecs, indices, commonScale, actualGapY, group.top, group.bottom);
        if (!placed) return null;
    }

    var minTop = 1e100,
        maxBottom = -1e100;
    for (var r = 0; r < rowSpecs.length; r++) {
        if (!isFinite(rowSpecs[r].top)) return null;
        var bottom = rowSpecs[r].top + rowSpecs[r].rowHeight * commonScale;
        if (rowSpecs[r].top < minTop) minTop = rowSpecs[r].top;
        if (bottom > maxBottom) maxBottom = bottom;
    }

    return {
        gapY: actualGapY,
        minFinalGapY: minFinalGapY,
        maxFinalGapY: maxFinalGapY,
        layoutHeight: Math.max(0, maxBottom - minTop)
    };
}

function getContainerVerticalGapBounds(rowSpecs, indices, commonScale, top, bottom) {
    var available = bottom - top,
        rowsHeight = 0;
    for (var i = 0; i < indices.length; i++)
        rowsHeight += rowSpecs[indices[i]].rowHeight * commonScale;

    if (rowsHeight > available + FIT_EPS) return null;
    if (indices.length <= 1) return { min: 0, max: 1e100 };
    return { min: 0, max: (available - rowsHeight) / (indices.length - 1) };
}

function getRangeVerticalGapBounds(rowSpecs, indices, commonScale) {
    if (indices.length <= 1) return { min: 0, max: 1e100 };

    var cumulative = [0],
        i, j,
        gapMin = -1e100,
        gapMax = 1e100;

    for (i = 1; i < indices.length; i++)
        cumulative[i] = cumulative[i - 1] + rowSpecs[indices[i - 1]].rowHeight * commonScale;

    for (i = 0; i < indices.length; i++) {
        var rowI = rowSpecs[indices[i]],
            li = rowI.allowedTopMin - cumulative[i];
        if (!isFinite(rowI.allowedTopMin) || !isFinite(rowI.allowedTopMax)) return null;

        for (j = 0; j < indices.length; j++) {
            if (i == j) continue;
            var rowJ = rowSpecs[indices[j]],
                uj = rowJ.allowedTopMax - cumulative[j],
                denom = j - i,
                limit = (uj - li) / denom;

            if (denom > 0) {
                if (limit < gapMax) gapMax = limit;
            } else {
                if (limit > gapMin) gapMin = limit;
            }
        }
    }

    return { min: gapMin, max: gapMax };
}

function placeContainerVerticalGroup(rowSpecs, indices, commonScale, gapY, top, bottom) {
    var rowsHeight = 0,
        i;
    for (i = 0; i < indices.length; i++)
        rowsHeight += rowSpecs[indices[i]].rowHeight * commonScale;

    var layoutHeight = rowsHeight + gapY * Math.max(0, indices.length - 1),
        available = bottom - top;
    if (layoutHeight > available + FIT_EPS) return false;

    var y = top + (available - layoutHeight) / 2;
    for (i = 0; i < indices.length; i++) {
        var spec = rowSpecs[indices[i]];
        spec.top = y;
        y += spec.rowHeight * commonScale + gapY;
    }
    return true;
}

function placeRangeVerticalGroup(rowSpecs, indices, commonScale, gapY, top, bottom) {
    if (indices.length == 1) {
        var single = rowSpecs[indices[0]];
        single.top = single.allowedTopMin + (single.allowedTopMax - single.allowedTopMin) / 2;
        return true;
    }

    var cumulative = [0],
        startMin = -1e100,
        startMax = 1e100,
        i;

    for (i = 1; i < indices.length; i++)
        cumulative[i] = cumulative[i - 1] + rowSpecs[indices[i - 1]].rowHeight * commonScale;

    for (i = 0; i < indices.length; i++) {
        var spec = rowSpecs[indices[i]],
            lo = spec.allowedTopMin - cumulative[i] - i * gapY,
            hi = spec.allowedTopMax - cumulative[i] - i * gapY;
        if (lo > startMin) startMin = lo;
        if (hi < startMax) startMax = hi;
    }

    if (startMax < startMin - FIT_EPS) return false;
    if (startMax < startMin) startMax = startMin;

    var totalHeight = cumulative[indices.length - 1] +
            rowSpecs[indices[indices.length - 1]].rowHeight * commonScale + gapY * (indices.length - 1),
        desiredStart = top != undefined && bottom != undefined ?
            top + ((bottom - top) - totalHeight) / 2 : startMin,
        startTop = Math.max(startMin, Math.min(startMax, desiredStart));

    for (i = 0; i < indices.length; i++)
        rowSpecs[indices[i]].top = startTop + cumulative[i] + i * gapY;

    return true;
}


function finalizeLayoutRows(rowSpecs, commonScale, baseGapX, baseGapY, actualGapY, metadata, fixedGapPolicy) {
    if (!rowSpecs || !rowSpecs.length) return null;

    if (lockedLayoutActive()) {
        if (Math.abs(commonScale - lockedRuntimeScale()) > 1e-9) throw new Error(str.t('Изменился масштаб, зафиксированный в экшене.', 'The scale locked in the action has changed.'));
        fixedGapPolicy = lockedGapPolicy(rowSpecs, actionLayoutProfile);
        if (!fixedGapPolicy) return null;
    }
    var gapPolicy = fixedGapPolicy || resolveHorizontalGapPolicy(rowSpecs, commonScale, baseGapX);
    if (!gapPolicy) return null;

    var blockWidths = {}, rowWidths = [];
    for (var bi = 0; bi < rowSpecs.length; bi++) {
        var bs = rowSpecs[bi], bn = bs.items.length,
            bw = bs.contentWidth * commonScale + getHorizontalGapForRow(gapPolicy, bn, bi) * Math.max(0, bn - 1),
            bk = horizontalBlockKey(bs);
        rowWidths[bi] = bw;
        if (blockWidths[bk] == undefined || bw > blockWidths[bk]) blockWidths[bk] = bw;
    }
    var rows = [],
        placements = [],
        distribution = [],
        maxFinalRowWidth = 0,
        minTop = 1e100,
        maxBottom = -1e100;

    for (var r = 0; r < rowSpecs.length; r++) {
        var spec = rowSpecs[r],
            count = spec.items.length,
            rowGapX = getHorizontalGapForRow(gapPolicy, count, r),
            finalRowWidth = rowWidths[r],
            finalRowHeight = spec.rowHeight * commonScale,
            x = alignRowLeft(spec.interval, finalRowWidth, count, blockWidths[horizontalBlockKey(spec)]);

        if (x == null) return null;

        var row = {
            rowIndex: r,
            items: spec.items,
            contentWidth: spec.contentWidth,
            rowHeight: spec.rowHeight,
            minRowWidth: spec.contentWidth + Math.max(0, count - 1) * baseGapX,
            gapX: rowGapX,
            rowWidth: finalRowWidth,
            y: spec.top,
            availableInterval: { left: spec.interval.left, right: spec.interval.right }
        };
        if (spec.zoneIndex != undefined) row.zoneIndex = spec.zoneIndex;
        if (spec.componentIndex != undefined) row.componentIndex = spec.componentIndex;
        rows.push(row);
        distribution.push(count);

        if (finalRowWidth > maxFinalRowWidth) maxFinalRowWidth = finalRowWidth;
        if (spec.top < minTop) minTop = spec.top;
        if (spec.top + finalRowHeight > maxBottom) maxBottom = spec.top + finalRowHeight;

        for (var i = 0; i < spec.items.length; i++) {
            var item = spec.items[i],
                itemWidth = item.width * commonScale,
                itemHeight = item.height * commonScale,
                placement = {
                    layerId: item.id,
                    name: item.name,
                    sourceCenterX: item.centerX,
                    sourceCenterY: item.centerY,
                    targetCenterX: x + itemWidth / 2,
                    targetCenterY: spec.top + itemHeight / 2,
                    scale: commonScale,
                    width: itemWidth,
                    height: itemHeight,
                    left: x,
                    top: spec.top,
                    right: x + itemWidth,
                    bottom: spec.top + itemHeight
                };

            if (spec.zoneIndex != undefined) placement.zoneIndex = spec.zoneIndex;
            if (spec.componentIndex != undefined) placement.componentIndex = spec.componentIndex;
            placements.push(placement);
            x += itemWidth + rowGapX;
        }
    }

    metadata = metadata || {};
    var plan = {
        commonScale: commonScale,
        rows: rows,
        distribution: distribution,
        placements: placements,
        baseGapX: baseGapX,
        baseGapY: baseGapY,
        minFinalGapX: gapPolicy.minFinalGapX,
        minFinalGapY: baseGapY * commonScale,
        actualGapXMin: gapPolicy.actualGapXMin,
        actualGapXMax: gapPolicy.actualGapXMax,
        actualGapY: actualGapY,
        actualGapYMin: actualGapY,
        actualGapYMax: actualGapY,
        maxGapMultiplier: cfg.maxGapMultiplier,
        horizontalAlign: cfg.horizontalAlign,
        rowRhythm: cfg.rowRhythm,
        rhythmPenalty: metadata.rhythmPenalty != undefined ? metadata.rhythmPenalty : getRowRhythmPenalty(distribution, cfg.rowRhythm),
        layoutWidth: maxFinalRowWidth,
        layoutHeight: metadata.layoutHeight != undefined ? metadata.layoutHeight : Math.max(0, maxBottom - minTop),
        scaleX: metadata.scaleX != undefined ? metadata.scaleX : commonScale,
        scaleY: metadata.scaleY != undefined ? metadata.scaleY : commonScale,
        fitDifference: metadata.fitDifference != undefined ? metadata.fitDifference : 0,
        uniformGaps: cfg.horizontalAlign != 'justify',
        perRowJustifyGaps: cfg.horizontalAlign == 'justify'
    };

    copyLayoutMetadata(plan, metadata);
    return plan;
}

function resolveHorizontalGapPolicy(rowSpecs, commonScale, baseGapX) {
    var minFinalGapX = baseGapX * commonScale,
        maxFinalGapX = minFinalGapX * cfg.maxGapMultiplier,
        maxUniformGapX = 1e100,
        byRow = {},
        hasGap = false,
        actualGapX = 0,
        actualGapXMin = null,
        actualGapXMax = null;

    for (var r = 0; r < rowSpecs.length; r++) {
        var spec = rowSpecs[r],
            count = spec.items.length;
        if (count <= 1) continue;

        var intervalWidth = spec.interval.right - spec.interval.left,
            scaledContentWidth = spec.contentWidth * commonScale,
            gapLimit = (intervalWidth - scaledContentWidth) / (count - 1);

        if (gapLimit < minFinalGapX - FIT_EPS) return null;

        if (cfg.horizontalAlign == 'justify') {
            // Justify is intentionally per physical row: every row independently
            // reaches both edges of its own available interval.
            var rowGap = Math.max(minFinalGapX, gapLimit);
            byRow[String(r)] = rowGap;
            if (actualGapXMin == null || rowGap < actualGapXMin) actualGapXMin = rowGap;
            if (actualGapXMax == null || rowGap > actualGapXMax) actualGapXMax = rowGap;
        } else if (gapLimit < maxUniformGapX) {
            // Left / Center / Right always share one global X gap.
            maxUniformGapX = gapLimit;
        }
        hasGap = true;
    }

    if (hasGap && cfg.horizontalAlign != 'justify') {
        var horizontalCap = Math.min(maxFinalGapX, maxUniformGapX);
        if (horizontalCap < minFinalGapX - FIT_EPS) return null;
        actualGapX = Math.max(minFinalGapX, horizontalCap);
        actualGapXMin = actualGapXMax = actualGapX;
    }

    if (actualGapXMin == null) actualGapXMin = 0;
    if (actualGapXMax == null) actualGapXMax = 0;

    return {
        minFinalGapX: minFinalGapX,
        actualGapX: actualGapX,
        byRow: byRow,
        actualGapXMin: actualGapXMin,
        actualGapXMax: actualGapXMax
    };
}

function getHorizontalGapForRow(policy, count, rowIndex) {
    if (count <= 1) return 0;
    if (cfg.horizontalAlign == 'justify') {
        var gap = policy.byRow ? Number(policy.byRow[String(rowIndex)]) : NaN;
        return isFinite(gap) && gap >= 0 ? gap : policy.minFinalGapX;
    }
    return policy.actualGapX;
}

function horizontalBlockKey(spec) {
    // Never center across distinct zones or across different safe spans of a cut-out.
    return String(spec.componentIndex == undefined ? '' : spec.componentIndex) + '|' +
        String(spec.zoneIndex == undefined ? '' : spec.zoneIndex) + '|' + spec.interval.left + '|' + spec.interval.right;
}

function alignRowLeft(interval, rowWidth, count, blockWidth) {
    var intervalWidth = interval.right - interval.left,
        freeX = intervalWidth - rowWidth;
    if (freeX < -FIT_EPS) return null;

    // Gap policy already used the largest common legal gap. Any slack left
    // around the widest row cannot be filled without changing scale/gaps.
    var blockSlack = Math.max(0, intervalWidth - (blockWidth == undefined ? rowWidth : blockWidth)),
        inset = blockSlack / 2;
    switch (cfg.horizontalAlign) {
        case 'left': return interval.left + inset;
        case 'right': return interval.right - inset - rowWidth;
        case 'justify':
            // With 2+ photos Justify is a hard invariant: the row reaches both edges.
            // A one-photo row has no inter-photo gap to stretch and is centered.
            if (count <= 1 || lockedLayoutActive()) return interval.left + freeX / 2;
            return Math.abs(freeX) <= FIT_EPS ? interval.left : null;
        default:
            return interval.left + freeX / 2;
    }
}

function copyLayoutMetadata(target, source) {
    copyDefinedPlanMetadata(target, source, [
        'shapedSelection', 'multiZoneSelection', 'zoneCount', 'usedZoneCount',
        'usedComponentCount', 'solverPasses', 'testedRows', 'pythonPacking', 'packingBudgetExhausted', 'packingFallbackReason', 'lockedMetrics', 'pythonComposition', 'verticalReferenceScale', 'compositionReferenceScale', 'compositionScaleLoss', 'compositionEvaluated', 'compositionColorCost'
    ]);
}

function copyDefinedPlanMetadata(target, source, keys) {
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (source[key] != undefined) target[key] = source[key];
    }
}

function getMedianDimension(items, key) {
    var values = [];
    for (var i = 0; i < items.length; i++) values.push(items[i][key]);
    values.sort(function (a, b) { return a - b; });
    var m = Math.floor(values.length / 2);
    return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

function makeComponentSignature(count) {
    var s = '';
    for (var i = 0; i < count; i++) s += '0';
    return s;
}

function markComponentSignature(signature, index) {
    if (index == undefined || index < 0 || index >= signature.length || signature.charAt(index) == '1') return signature;
    return signature.substring(0, index) + '1' + signature.substring(index + 1);
}

function compositionSearchRequested(items) {
    if (!cfg.pythonPacking || alphabetOrderActive() || lockedLayoutActive()) return false;
    var palettes = 0;
    for (var i = 0; i < items.length; i++) {
        if (normalizeColorMode(cfg.colorMode) != 'off' && items[i].colorPalette) palettes++;
        if ((cfg.alternateGender && (items[i].gender == 'M' || items[i].gender == 'F')) ||
            (cfg.considerHeadTurn && items[i].headTurnValid)) return true;
    }
    return palettes >= 2;
}

function getCompositionRowQuality(plan) {
    var groups = {}, counts = [], singles = 0, excess = 0, imbalance = 0, r, key;
    for (r = 0; r < plan.rows.length; r++) {
        var row = plan.rows[r], count = row.items.length;
        key = row.zoneIndex != undefined ? String(row.zoneIndex) : 'all';
        if (!groups[key]) groups[key] = [];
        groups[key].push(count); counts.push(count);
    }
    for (key in groups) if (groups.hasOwnProperty(key)) {
        var local = groups[key], total = 0, squares = 0, lo = 1e100, hi = 0;
        if (local.length <= 1) continue;
        for (r = 0; r < local.length; r++) {
            count = local[r]; total += count; squares += count * count;
            if (count == 1) singles++;
            lo = Math.min(lo, count); hi = Math.max(hi, count);
        }
        excess += Math.max(0, hi - lo - 2);
        imbalance += squares - total * total / local.length;
    }
    if (cfg.rowRhythm != 'auto') return [singles, excess].concat(getVerticalRowScore(counts, cfg.rowRhythm));
    return [singles, excess, imbalance, getRowRhythmPenalty(counts, cfg.rowRhythm)];
}

function compareCompositionRows(a, b) {
    var qa = getCompositionRowQuality(a), qb = getCompositionRowQuality(b);
    for (var i = 0; i < qa.length; i++) {
        if (qa[i] < qb[i] - 1e-8) return -1;
        if (qa[i] > qb[i] + 1e-8) return 1;
    }
    return 0;
}

function optimizeCompositionAssignment(plan, geometry, useGender, useHead, useColor) {
    if (!plan.pythonComposition) return optimizeSemanticAssignment(plan, geometry, useGender, useHead);
    if (useColor == undefined) useColor = normalizeColorMode(cfg.colorMode) != 'off';
    var candidates = [plan], best = null, bestScore = null, bestColor = 0, distances = {},
        reference = plan.compositionReferenceScale;
    if (plan.compositionGeometryBaseline) candidates.push(plan.compositionGeometryBaseline);
    if (plan.compositionJSXBaseline) candidates.push(plan.compositionJSXBaseline);
    for (var i = 0; i < candidates.length; i++) reference = Math.max(reference, candidates[i].commonScale, candidates[i].verticalReferenceScale || 0);
    for (i = 0; i < candidates.length; i++) {
        if (candidates[i].commonScale < reference * (1 - COMPOSITION_MAX_SCALE_LOSS) - 1e-9) continue;
        setLayoutProgressRange(i / candidates.length, 1 / candidates.length);
        var candidate = useGender || useHead ? optimizeSemanticAssignment(candidates[i], geometry, useGender, useHead) : candidates[i],
            score = getSemanticAssignmentScore(candidate, geometry, useGender, useHead), colorCost = 0;
        if (useColor) {
            var colored = optimizeColorAssignment(candidate, geometry, useGender, useHead, cfg.colorMode),
                coloredScore = getSemanticAssignmentScore(colored, geometry, useGender, useHead);
            // Joint search has strict priorities: colour cannot spend a better
            // gender or pose score. Keep the original if legacy colour refinement
            // used its bounded pose concession.
            if (!betterSemanticAssignment(score, coloredScore, useHead)) {
                candidate = colored; score = coloredScore;
            }
            colorCost = colorAssignmentCost(candidate, cfg.colorMode, distances);
        }
        var sameSemantics = best && !betterSemanticAssignment(score, bestScore, useHead) && !betterSemanticAssignment(bestScore, score, useHead);
        var rowOrder = best ? compareCompositionRows(candidate, best) : -1;
        if (!best || rowOrder < 0 || (rowOrder == 0 && (betterSemanticAssignment(score, bestScore, useHead) || (sameSemantics &&
            (colorCost < bestColor - 1e-8 || (Math.abs(colorCost - bestColor) <= 1e-8 && candidate.commonScale > best.commonScale + 1e-9)))))) {
            best = candidate; bestScore = score; bestColor = colorCost;
        }
    }
    if (!best) throw new Error(str.t('Нет допустимой композиции в пределах потери масштаба.', 'No valid composition within the scale-loss limit.'));
    validateLayoutPlan(best, geometry);
    best.pythonComposition = true;
    best.compositionReferenceScale = reference;
    best.compositionScaleLoss = Math.max(0, 1 - best.commonScale / reference);
    best.compositionEvaluated = plan.compositionEvaluated;
    if (useColor) best.compositionColorCost = bestColor;
    return best;
}

function tryPythonZoneLayout(items, geometry, baseGapX, baseGapY, seedPlan) {
    if (alphabetOrderActive() || !cfg.pythonPacking || packingDisabledForRun || lockedLayoutActive()) return null;
    var init = pythonApi.tryInit();
    if (!init || !init.ok) {
        packingDisabledForRun = true;
        packingFallbackReason = init && init.message ? init.message : str.t('Python недоступен.', 'Python is unavailable.');
        return null;
    }
    try {
        var zones, composition = compositionSearchRequested(items), data = [], zoneData = [], i;
        if (geometry.isRectangle) zones = [{ left: geometry.bounds.left, top: geometry.bounds.top,
            right: geometry.bounds.right, bottom: geometry.bounds.bottom, componentIndex: 0 }];
        else {
            if (!geometry.multiZone) buildStableLayoutZones(geometry.bands, geometry.components, GEOMETRY_EPS);
            zones = flattenComponentZones(geometry.components);
        }
        for (i = 0; i < items.length; i++) {
            var item = items[i], entry = { id: item.id, width: item.width, height: item.height, priority: getItemPriority(item) };
            if (composition) {
                entry.gender = item.gender || 'U';
                entry.headTurnValid = !!item.headTurnValid; entry.headTurn = item.headTurnValid ? item.headTurn : 0;
                entry.headLeanValid = !!item.headLeanValid; entry.headLean = item.headLeanValid ? item.headLean : 0;
                entry.headLeanWeight = item.headLeanValid ? item.headLeanWeight : 0;
                if (normalizeColorMode(cfg.colorMode) != 'off') entry.colorPalette = item.colorPalette || null;
            }
            data.push(entry);
        }
        for (i = 0; i < zones.length; i++) zoneData.push({ left: zones[i].left, top: zones[i].top,
            right: zones[i].right, bottom: zones[i].bottom, componentIndex: zones[i].componentIndex });
        progress(32, composition ? 'Python: searching whole-sheet composition...' : 'Python: searching zone packing...');
        beginPythonProgressWait(1, composition ? 14000 : 8000);
        var payload = { items: data, zones: zoneData,
            baseGapX: baseGapX, baseGapY: baseGapY, maxGapMultiplier: cfg.maxGapMultiplier,
            horizontalAlign: cfg.horizontalAlign, rowRhythm: cfg.rowRhythm,
            rows: cfg.autoRows ? 0 : Math.max(1, Math.min(cfg.rows, items.length)), noEnlarge: !!cfg.noEnlarge };
        if (composition) {
            payload.useGender = !!cfg.alternateGender; payload.useHead = !!cfg.considerHeadTurn;
            payload.colorMode = normalizeColorMode(cfg.colorMode);
            if (seedPlan && geometry.isRectangle) {
                payload.seedRows = [];
                for (i = 0; i < seedPlan.rows.length; i++) {
                    var ids = [];
                    for (var c = 0; c < seedPlan.rows[i].items.length; c++) ids.push(seedPlan.rows[i].items[c].id);
                    payload.seedRows.push({ zoneIndex: 0, ids: ids });
                }
            }
        }
        var answer = pythonApi.sendPayload(composition ? 'layout_composition' : 'layout_zones', payload, { longRequest: true }),
            plan = decodePythonZoneLayout(answer, items, geometry, zones, baseGapX, baseGapY);
        if (composition) {
            if (answer.compositionSearch !== true || typeof answer.referenceScale != 'number' || !isFinite(answer.referenceScale) ||
                answer.referenceScale < plan.commonScale - 1e-9 ||
                plan.commonScale < answer.referenceScale * (1 - COMPOSITION_MAX_SCALE_LOSS) - 1e-9)
                throw new Error(str.t('Python нарушил предел потери масштаба.', 'Python violated the scale-loss limit.'));
            plan.pythonComposition = true;
            plan.compositionReferenceScale = answer.referenceScale;
            plan.compositionEvaluated = answer.compositionEvaluated;
            plan.compositionGeometryBaseline = decodePythonZoneLayout(answer.geometryBaseline, items, geometry, zones, baseGapX, baseGapY);
            if (seedPlan) {
                // A decomposed shape may fit less tightly than the original JSX
                // band solver. Always keep the original valid geometry eligible.
                plan.compositionJSXBaseline = seedPlan;
                plan.compositionReferenceScale = Math.max(plan.compositionReferenceScale, seedPlan.commonScale, seedPlan.verticalReferenceScale || 0);
            }
        }
        progress(55, 'Python: layout validated.');
        return plan;
    } catch (e) {
        if (e.number == 8007) throw e;
        packingDisabledForRun = true;
        packingFallbackReason = e.message ? e.message : String(e);
        return null;
    } finally { endPythonProgressWait(); }
}

function decodePythonZoneLayout(answer, items, geometry, zones, baseGapX, baseGapY) {
    function numeric(v) { return typeof v == 'number' && isFinite(v); }
    if (!answer || answer.status != 'ok' || !numeric(answer.commonScale) || answer.commonScale <= 0 ||
        !numeric(answer.gapY) || answer.gapY < 0 || !answer.rows || !answer.rows.length || answer.rows.length > items.length ||
        !answer.placements || answer.placements.length != items.length)
        throw new Error(str.t('Python не вернул допустимую раскладку.', 'Python did not return a valid layout.'));
    var byId = {}, used = {}, usedZones = {}, usedComponents = {}, specs = [], r, i;
    for (i = 0; i < items.length; i++) byId[String(items[i].id)] = items[i];
    for (r = 0; r < answer.rows.length; r++) {
        var row = answer.rows[r], zi = row.zoneIndex;
        if (!numeric(zi) || zi != Math.floor(zi) || zi < 0 || zi >= zones.length ||
            !row.ids || !row.ids.length || row.ids.length > items.length || !numeric(row.top))
            throw new Error(str.t('Некорректный ряд Python.', 'Invalid row returned by Python.'));
        if (r && (zi < answer.rows[r - 1].zoneIndex ||
            (zi == answer.rows[r - 1].zoneIndex && row.top < answer.rows[r - 1].top)))
            throw new Error(str.t('Python изменил порядок чтения зон или рядов.', 'Python changed the zone or row reading order.'));
        var zone = zones[zi], rowItems = [], width = 0, height = 0;
        for (i = 0; i < row.ids.length; i++) {
            var id = String(row.ids[i]), item = byId[id];
            if (!item || used[id]) throw new Error(str.t('Python изменил состав выбранных слоёв.', 'Python changed the selected layer set.'));
            used[id] = true; rowItems.push(item); width += item.width; height = Math.max(height, item.height);
        }
        if (row.top < zone.top - 1e-6 || row.top + height * answer.commonScale > zone.bottom + 1e-6)
            throw new Error(str.t('Ряд Python выходит за границу площадки.', 'A Python row extends outside its zone.'));
        usedZones[String(zi)] = true; usedComponents[String(zone.componentIndex)] = true;
        specs.push({ items: rowItems, contentWidth: width, rowHeight: height, top: row.top,
            interval: { left: zone.left, right: zone.right }, zoneIndex: zi, componentIndex: zone.componentIndex });
    }
    for (i = 0; i < items.length; i++) if (!used[String(items[i].id)]) throw new Error(str.t('Python пропустил слой.', 'Python omitted a layer.'));
    var zoneCount = 0, componentCount = 0;
    for (var zk in usedZones) if (usedZones.hasOwnProperty(zk)) zoneCount++;
    for (var ck in usedComponents) if (usedComponents.hasOwnProperty(ck)) componentCount++;
    if (items.length >= geometry.componentCount && componentCount < geometry.componentCount)
        throw new Error(str.t('Python пропустил отдельную область выделения.', 'Python omitted a separate selection area.'));
    if (!cfg.autoRows && specs.length != Math.max(1, Math.min(cfg.rows, items.length)))
        throw new Error(str.t('Python изменил заданное количество рядов.', 'Python changed the requested number of rows.'));
    var grouped = {};
    for (r = 0; r < specs.length; r++) {
        var sk = String(specs[r].zoneIndex);
        if (!grouped[sk]) grouped[sk] = [];
        grouped[sk].push(specs[r]);
    }
    var hasAdjacent = false, minY = baseGapY * answer.commonScale;
    for (sk in grouped) if (grouped.hasOwnProperty(sk)) {
        var group = grouped[sk];
        if (group.length > 1) hasAdjacent = true;
        for (i = 1; i < group.length; i++) {
            var actual = group[i].top - group[i - 1].top - group[i - 1].rowHeight * answer.commonScale;
            if (Math.abs(actual - answer.gapY) > .001) throw new Error(str.t('Неравномерный интервал Python.', 'Python returned uneven gaps.'));
        }
    }
    if (hasAdjacent && (answer.gapY < minY - 1e-6 || answer.gapY > minY * cfg.maxGapMultiplier + 1e-6))
        throw new Error(str.t('Python нарушил заданный интервал.', 'Python violated the requested gap.'));
    var plan = finalizeLayoutRows(specs, answer.commonScale, baseGapX, baseGapY, answer.gapY, {
        shapedSelection: !geometry.isRectangle, multiZoneSelection: !!geometry.multiZone, zoneCount: zones.length,
        usedZoneCount: zoneCount, usedComponentCount: componentCount, layoutHeight: geometry.bounds.height,
        solverPasses: numeric(answer.tested) ? answer.tested : 0 });
    if (!plan) throw new Error(str.t('Python нарушил горизонтальную политику раскладки.', 'Python violated the horizontal layout policy.'));
    var returned = {};
    for (i = 0; i < answer.placements.length; i++) {
        var p = answer.placements[i], key = String(p.id);
        if (returned[key] || !numeric(p.centerX) || !numeric(p.centerY) || !numeric(p.scale))
            throw new Error(str.t('Некорректные координаты Python.', 'Invalid coordinates returned by Python.'));
        returned[key] = p;
    }
    for (i = 0; i < plan.placements.length; i++) {
        var expected = plan.placements[i], actualP = returned[String(expected.layerId)];
        if (!actualP || Math.abs(expected.targetCenterX - actualP.centerX) > .001 ||
            Math.abs(expected.targetCenterY - actualP.centerY) > .001 || Math.abs(plan.commonScale - actualP.scale) > 1e-9)
            throw new Error(str.t('Координаты Python не согласованы с размерами слоёв.', 'Python coordinates do not match the layer sizes.'));
    }
    plan.autoRows = cfg.autoRows;
    plan.pythonPacking = true;
    plan.packingBudgetExhausted = answer.budgetExhausted === true;
    validateLayoutPlan(plan, geometry);
    return plan;
}

function balanceZoneRows(specs, indices, zone, scale, baseGapX, baseGapY, profile) {
    var items = [], r, i;
    for (r = 0; r < indices.length; r++) items = items.concat(specs[indices[r]].items);
    var n = items.length, rows = indices.length;
    if (rows <= 1 || n <= rows) return;
    var metrics = buildFastShapeSegmentCache(items), limitW = (zone.right - zone.left) / scale,
        limitH = (zone.bottom - zone.top) / scale - baseGapY * (rows - 1),
        center = (rows - 1) / 2 - 0.1, states = { '0': [{ height: 0, score: [0, 0, 0, 0], counts: [] }] };
    if (!profile) profile = getRowRhythmProfile(rows, cfg.rowRhythm);
    function compare(a, b) {
        for (var k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 1e-8) return a[k] < b[k] ? -1 : 1;
        return 0;
    }
    // Keep the Pareto frontier of required height and additive balance score.
    // A shorter but uneven split must not hide a slightly taller feasible one.
    function add(frontier, candidate) {
        for (var k = 0; k < frontier.length; k++) if (frontier[k].height <= candidate.height + 1e-9 && compare(frontier[k].score, candidate.score) <= 0) return;
        for (k = frontier.length - 1; k >= 0; k--) if (candidate.height <= frontier[k].height + 1e-9 && compare(candidate.score, frontier[k].score) <= 0) frontier.splice(k, 1);
        frontier.push(candidate);
    }
    for (r = 0; r < rows; r++) {
        progress(currentProgressValue, 'Balancing row fill...');
        var next = {};
        for (var consumedKey in states) if (states.hasOwnProperty(consumedKey)) {
            var consumed = Number(consumedKey), frontier = states[consumedKey], maximum = n - consumed - (rows - r - 1);
            for (var count = 1; count <= maximum; count++) {
                var m = metrics.segments[consumed][count];
                if (m.contentWidth + (count - 1) * baseGapX > limitW + 1e-9) break;
                var end = consumed + count;
                if (r == rows - 1 && end != n) continue;
                for (i = 0; i < frontier.length; i++) {
                    var old = frontier[i], height = old.height + m.rowHeight;
                    if (height > limitH + 1e-9) continue;
                    if (!next[String(end)]) next[String(end)] = [];
                    add(next[String(end)], { height: height, counts: old.counts.concat([count]),
                        score: [old.score[0] + (count == 1 ? 1 : 0), old.score[1] + count * count,
                            old.score[2] - count * profile[r],
                            old.score[3] + count * (r - center) * (r - center)] });
                }
            }
        }
        states = next;
    }
    var finals = states[String(n)], best = null;
    if (!finals) return;
    for (i = 0; i < finals.length; i++) if (!best || compare(finals[i].score, best.score) < 0) best = finals[i];
    var start = 0;
    for (r = 0; r < rows; r++) {
        var spec = specs[indices[r]], length = best.counts[r], dimension = metrics.segments[start][length];
        spec.items = items.slice(start, start + length);
        spec.contentWidth = dimension.contentWidth; spec.rowHeight = dimension.rowHeight;
        start += length;
    }
}

function buildMultiZoneLayoutFast(items, geometry, baseGapX, baseGapY) {
    var zones = flattenComponentZones(geometry.components),
        cache = buildFastShapeSegmentCache(items),
        maxIntervalWidth = getMaximumIntervalWidth(geometry),
        maxZoneHeight = 0,
        maxItemWidth = 0,
        maxItemHeight = 0,
        i;

    if (!zones || !zones.length) return null;

    for (i = 0; i < zones.length; i++)
        if (zones[i].height > maxZoneHeight) maxZoneHeight = zones[i].height;

    for (i = 0; i < items.length; i++) {
        if (items[i].width > maxItemWidth) maxItemWidth = items[i].width;
        if (items[i].height > maxItemHeight) maxItemHeight = items[i].height;
    }

    var scaleX = maxIntervalWidth / maxItemWidth,
        scaleY = maxZoneHeight / maxItemHeight,
        high = Math.min(scaleX, scaleY, cfg.noEnlarge ? 1 : Infinity),
        low = 0,
        iterations = 14,
        desiredRows = cfg.autoRows ? 0 : Math.max(1, Math.min(cfg.rows, items.length)),
        bestAllocation = null,
        componentCount = geometry.componentCount || 1;

    if (!isFinite(high) || high <= 0) return null;

    if (cfg.noEnlarge && findMultiZoneAllocation(items, zones, 1, baseGapX, baseGapY, cache, desiredRows, componentCount)) { low = 1; iterations = 0; }

    for (var pass = 0; pass < iterations; pass++) {
        var scale = (low + high) / 2;
        progress(32 + 22 * (pass / iterations), 'Checked ' + pass + '/' + iterations + '; scale ' + round2(scale * 100) + '%');

        var allocation = findMultiZoneAllocation(items, zones, scale, baseGapX, baseGapY, cache,
            desiredRows, componentCount);
        if (allocation) {
            low = scale;
            bestAllocation = allocation;
        } else {
            high = scale;
        }
    }

    if (!(low > 0)) return null;

    bestAllocation = findMultiZoneAllocation(items, zones, low, baseGapX, baseGapY, cache,
        desiredRows, componentCount);
    if (!bestAllocation) return null;

    var commonScale = low,
        rowSpecs = [],
        verticalGroups = [];

    for (var a = 0; a < bestAllocation.assignments.length; a++) {
        var assignment = bestAllocation.assignments[a];
        if (!assignment || !assignment.rows || !assignment.rows.length) continue;

        var zone = zones[assignment.zoneIndex],
            itemIndex = assignment.start,
            rowIndices = [];

        for (var rr = 0; rr < assignment.rows.length; rr++) {
            var rowSpec = assignment.rows[rr],
                rowCount = rowSpec.count,
                specIndex = rowSpecs.length;

            rowSpecs.push({
                items: items.slice(itemIndex, itemIndex + rowCount),
                contentWidth: rowSpec.contentWidth,
                rowHeight: rowSpec.rowHeight,
                interval: { left: zone.left, right: zone.right },
                zoneIndex: assignment.zoneIndex,
                componentIndex: zone.componentIndex
            });
            rowIndices.push(specIndex);
            itemIndex += rowCount;
        }

        verticalGroups.push({
            type: 'container',
            rowIndices: rowIndices,
            top: zone.top,
            bottom: zone.bottom,
            zoneIndex: assignment.zoneIndex,
            componentIndex: zone.componentIndex
        });
    }

    for (var vg = 0; vg < verticalGroups.length; vg++) {
        var group = verticalGroups[vg];
        balanceZoneRows(rowSpecs, group.rowIndices, zones[group.zoneIndex], commonScale, baseGapX, baseGapY,
            getRowRhythmProfile(rowSpecs.length, cfg.rowRhythm).slice(group.rowIndices[0], group.rowIndices[0] + group.rowIndices.length));
    }
    var vertical = resolveVerticalLayout(rowSpecs, verticalGroups, commonScale, baseGapY);
    if (!vertical) return null;

    progress(55, 'Choosing best zone allocation...');

    return finalizeLayoutRows(rowSpecs, commonScale, baseGapX, baseGapY, vertical.gapY, {
        scaleX: scaleX,
        scaleY: scaleY,
        fitDifference: Math.abs(scaleX - scaleY),
        layoutHeight: geometry.bounds.height,
        shapedSelection: true,
        multiZoneSelection: true,
        zoneCount: geometry.zoneCount,
        usedZoneCount: bestAllocation.usedZones,
        usedComponentCount: bestAllocation.usedComponentCount,
        solverPasses: iterations,
        testedRows: cfg.autoRows ? 0 : 1
    });
}

function findMultiZoneAllocation(items, zones, scale, baseGapX, baseGapY, cache, desiredRows,
    componentCount) {

    var n = items.length,
        minGapX = baseGapX * scale,
        minGapY = baseGapY * scale,
        requireAllComponents = componentCount > 1 && n >= componentCount,
        emptySignature = makeComponentSignature(componentCount),
        packingCache = {},
        states = [{
            itemIndex: 0,
            rowCount: 0,
            penalty: 0,
            usedZones: 0,
            usedComponentCount: 0,
            componentSignature: emptySignature,
            distribution: [],
            rhythmPenalty: 0,
            assignments: []
        }];

    for (var z = 0; z < zones.length; z++) {
        var zone = zones[z],
            next = {};

        for (var si = 0; si < states.length; si++) {
            var state = states[si],
                maxItems = n - state.itemIndex;

            if (requireAllComponents && maxItems < componentCount - state.usedComponentCount) continue;

            // Capacity is based on the real contiguous photos that remain at this
            // exact scale. No median-size or area approximation is used here.
            var capacities = [],
                totalCapacity = 0;
            for (var rz = z; rz < zones.length; rz++) {
                var futureInfo = getZonePackingInfo(state.itemIndex, maxItems, zones[rz], scale,
                    minGapX, minGapY, cache, packingCache);
                capacities[rz] = futureInfo.capacity;
                totalCapacity += futureInfo.capacity;
            }

            var currentCapacity = capacities[z] || 0,
                target = totalCapacity > 0 ? maxItems * currentCapacity / totalCapacity : 0;

            addMultiZoneState(next, {
                itemIndex: state.itemIndex,
                rowCount: state.rowCount,
                penalty: state.penalty + zoneAllocationPenalty(0, target),
                usedZones: state.usedZones,
                usedComponentCount: state.usedComponentCount,
                componentSignature: state.componentSignature,
                distribution: state.distribution,
                rhythmPenalty: state.rhythmPenalty,
                assignments: state.assignments.concat([null])
            }, desiredRows, requireAllComponents);

            if (!maxItems || currentCapacity <= 0) continue;

            var info = getZonePackingInfo(state.itemIndex, maxItems, zone, scale,
                    minGapX, minGapY, cache, packingCache),
                options = info.options;

            for (var oi = 0; oi < options.length; oi++) {
                var option = options[oi],
                    totalRows = state.rowCount + option.rows.length;

                if (desiredRows && totalRows > desiredRows) continue;

                var itemsAfter = n - (state.itemIndex + option.count),
                    zonesAfter = zones.length - z - 1;
                if (itemsAfter > 0 && zonesAfter <= 0) continue;

                var signature = markComponentSignature(state.componentSignature, zone.componentIndex),
                    firstUse = signature != state.componentSignature,
                    newUsedComponentCount = state.usedComponentCount + (firstUse ? 1 : 0);

                if (requireAllComponents && itemsAfter < componentCount - newUsedComponentCount) continue;

                var optionDistribution = getPackingRowsDistribution(option.rows),
                    combinedDistribution = state.distribution.concat(optionDistribution);

                addMultiZoneState(next, {
                    itemIndex: state.itemIndex + option.count,
                    rowCount: totalRows,
                    penalty: state.penalty + zoneAllocationPenalty(option.count, target),
                    usedZones: state.usedZones + 1,
                    usedComponentCount: newUsedComponentCount,
                    componentSignature: signature,
                    distribution: combinedDistribution,
                    rhythmPenalty: getRowRhythmPenalty(combinedDistribution, cfg.rowRhythm),
                    assignments: state.assignments.concat([{
                        zoneIndex: z,
                        start: state.itemIndex,
                        count: option.count,
                        rows: option.rows
                    }])
                }, desiredRows, requireAllComponents);
            }
        }

        states = multiZoneStateValues(next);
        if (!states.length) return null;
    }

    var best = null;
    for (var i = 0; i < states.length; i++) {
        var finalState = states[i];
        if (finalState.itemIndex != n) continue;
        if (desiredRows && finalState.rowCount != desiredRows) continue;
        if (requireAllComponents && finalState.usedComponentCount < componentCount) continue;

        var sameAllocationPenalty = best && Math.abs(finalState.penalty - best.penalty) <= 0.000001,
            finalRhythm = finalState.rhythmPenalty != undefined ? finalState.rhythmPenalty : getRowRhythmPenalty(finalState.distribution || [], cfg.rowRhythm),
            bestRhythm = best ? (best.rhythmPenalty != undefined ? best.rhythmPenalty : getRowRhythmPenalty(best.distribution || [], cfg.rowRhythm)) : 1e100;

        if (!best || finalState.penalty < best.penalty - 0.000001 ||
            (sameAllocationPenalty && cfg.rowRhythm != 'auto' && finalRhythm < bestRhythm - 0.000001) ||
            (sameAllocationPenalty && (cfg.rowRhythm == 'auto' || Math.abs(finalRhythm - bestRhythm) <= 0.000001) && finalState.usedComponentCount > best.usedComponentCount) ||
            (sameAllocationPenalty && (cfg.rowRhythm == 'auto' || Math.abs(finalRhythm - bestRhythm) <= 0.000001) && finalState.usedComponentCount == best.usedComponentCount && finalState.usedZones > best.usedZones) ||
            (sameAllocationPenalty && (cfg.rowRhythm == 'auto' || Math.abs(finalRhythm - bestRhythm) <= 0.000001) && finalState.usedComponentCount == best.usedComponentCount && finalState.usedZones == best.usedZones && finalState.rowCount < best.rowCount))
            best = finalState;
    }

    return best;
}

function getZonePackingInfo(start, maxItems, zone, scale, minGapX, minGapY, segmentCache, packingCache) {
    var key = zone.zoneIndex + ':' + start + ':' + maxItems,
        cached = packingCache[key];
    if (cached) return cached;

    var options = buildZonePackingOptions(start, maxItems, zone, scale, minGapX, minGapY, segmentCache),
        capacity = 0;
    for (var i = 0; i < options.length; i++)
        if (options[i].count > capacity) capacity = options[i].count;

    cached = { options: options, capacity: capacity };
    packingCache[key] = cached;
    return cached;
}

function buildZonePackingOptions(start, maxItems, zone, scale, minGapX, minGapY, cache) {
    var dp = [],
        options = [],
        consumed, rowsCount, count;

    dp[0] = []
    dp[0][0] = { height: 0, rows: [] }

    for (consumed = 0; consumed < maxItems; consumed++) {
        if (!dp[consumed]) continue;

        for (rowsCount = 0; rowsCount < dp[consumed].length; rowsCount++) {
            var state = dp[consumed][rowsCount];
            if (!state) continue;

            for (count = 1; consumed + count <= maxItems; count++) {
                var metrics = cache.segments[start + consumed][count],
                    rowGapX = minGapX,
                    rowWidth = metrics.contentWidth * scale + Math.max(0, count - 1) * rowGapX;

                // Capacity is checked at the minimum allowed gap. In Justify the
                // final gap is recomputed later so the accepted row reaches both edges.
                if (rowWidth > zone.width + 1e-9) break;

                var rowHeight = metrics.rowHeight * scale,
                    newHeight = state.height + (rowsCount ? minGapY : 0) + rowHeight;
                if (newHeight > zone.height + 1e-9) continue;

                var nextConsumed = consumed + count,
                    nextRows = rowsCount + 1,
                    rowSpec = { count: count, contentWidth: metrics.contentWidth, rowHeight: metrics.rowHeight },
                    candidate = { height: newHeight, rows: state.rows.concat([rowSpec]) };

                if (!dp[nextConsumed]) dp[nextConsumed] = []
                var oldCandidate = dp[nextConsumed][nextRows],
                    candidateRhythm = getRowRhythmPenalty(getPackingRowsDistribution(candidate.rows), cfg.rowRhythm),
                    oldCandidateRhythm = oldCandidate ? getRowRhythmPenalty(getPackingRowsDistribution(oldCandidate.rows), cfg.rowRhythm) : 1e100;
                if (!oldCandidate || candidate.height < oldCandidate.height - FIT_EPS ||
                    (cfg.rowRhythm != 'auto' && Math.abs(candidate.height - oldCandidate.height) <= FIT_EPS && candidateRhythm < oldCandidateRhythm - 0.000001))
                    dp[nextConsumed][nextRows] = candidate
            }
        }
    }

    for (consumed = 1; consumed <= maxItems; consumed++) {
        if (!dp[consumed]) continue;
        for (rowsCount = 1; rowsCount < dp[consumed].length; rowsCount++) {
            var packed = dp[consumed][rowsCount];
            if (packed) options.push({ count: consumed, rows: packed.rows, height: packed.height })
        }
    }

    // Larger allocations first usually reach a complete document state sooner.
    options.sort(function (a, b) {
        if (a.count != b.count) return b.count - a.count
        return a.rows.length - b.rows.length
    })
    return options
}

function addMultiZoneState(map, state, desiredRows, preserveComponentSignature) {
    if (desiredRows && state.rowCount > desiredRows) return;

    var preserveRowCount = desiredRows || cfg.rowRhythm != 'auto',
        key = state.itemIndex + ':' + (preserveRowCount ? state.rowCount : 0) +
            (preserveComponentSignature ? ':' + state.componentSignature : ''),
        old = map[key],
        samePenalty = old && Math.abs(state.penalty - old.penalty) <= 0.000001,
        stateRhythm = state.rhythmPenalty != undefined ? state.rhythmPenalty : getRowRhythmPenalty(state.distribution || [], cfg.rowRhythm),
        oldRhythm = old ? (old.rhythmPenalty != undefined ? old.rhythmPenalty : getRowRhythmPenalty(old.distribution || [], cfg.rowRhythm)) : 1e100;

    if (!old || state.penalty < old.penalty - 0.000001 ||
        (samePenalty && cfg.rowRhythm != 'auto' && stateRhythm < oldRhythm - 0.000001) ||
        (samePenalty && (cfg.rowRhythm == 'auto' || Math.abs(stateRhythm - oldRhythm) <= 0.000001) && state.usedComponentCount > old.usedComponentCount) ||
        (samePenalty && (cfg.rowRhythm == 'auto' || Math.abs(stateRhythm - oldRhythm) <= 0.000001) && state.usedComponentCount == old.usedComponentCount && state.usedZones > old.usedZones) ||
        (samePenalty && (cfg.rowRhythm == 'auto' || Math.abs(stateRhythm - oldRhythm) <= 0.000001) && state.usedComponentCount == old.usedComponentCount && state.usedZones == old.usedZones && state.rowCount < old.rowCount))
        map[key] = state;
}

function multiZoneStateValues(map) {
    var out = [];
    for (var key in map) if (map.hasOwnProperty(key)) out.push(map[key])
    return out
}

function zoneAllocationPenalty(count, target) {
    var d = count - target,
        norm = Math.max(1, target);
    return d * d / norm
}

function buildShapedLayoutFast(items, geometry, baseGapX, baseGapY) {
    var cache = buildFastShapeSegmentCache(items),
        maxIntervalWidth = getMaximumIntervalWidth(geometry),
        maxItemWidth = 0,
        maxItemHeight = 0,
        i;

    for (i = 0; i < items.length; i++) {
        if (items[i].width > maxItemWidth) maxItemWidth = items[i].width;
        if (items[i].height > maxItemHeight) maxItemHeight = items[i].height;
    }

    var scaleX = maxIntervalWidth / maxItemWidth,
        scaleY = geometry.bounds.height / maxItemHeight,
        high = Math.min(scaleX, scaleY, cfg.noEnlarge ? 1 : Infinity),
        low = 0,
        iterations = 14,
        desiredRows = cfg.autoRows ? 0 : Math.max(1, Math.min(cfg.rows, items.length)),
        bestPath = null;

    if (!isFinite(high) || high <= 0) return null;

    if (cfg.noEnlarge && findShapedPlacementFast(items, geometry, 1, baseGapX, baseGapY, cache, desiredRows)) { low = 1; iterations = 0; }

    for (var pass = 0; pass < iterations; pass++) {
        var scale = (low + high) / 2;
        progress(32 + 22 * (pass / iterations), 'Checked ' + pass + '/' + iterations + '; scale ' + round2(scale * 100) + '%');

        var path = findShapedPlacementFast(items, geometry, scale, baseGapX, baseGapY, cache, desiredRows);
        if (path) {
            low = scale;
            bestPath = path;
        } else {
            high = scale;
        }
    }

    if (!(low > 0)) return null;

    bestPath = findShapedPlacementFast(items, geometry, low, baseGapX, baseGapY, cache, desiredRows);
    if (!bestPath || !bestPath.length) return null;

    var commonScale = low,
        rowSpecs = [],
        rowIndices = [];

    for (var r = 0; r < bestPath.length; r++) {
        var slot = bestPath[r];
        rowSpecs.push({
            items: items.slice(slot.start, slot.start + slot.count),
            contentWidth: slot.contentWidth,
            rowHeight: slot.rowHeight,
            allowedTopMin: slot.allowedTopMin,
            allowedTopMax: slot.allowedTopMax,
            interval: { left: slot.interval.left, right: slot.interval.right }
        });
        rowIndices.push(r);
    }

    var vertical = resolveVerticalLayout(rowSpecs, [{
        type: 'ranges',
        rowIndices: rowIndices,
        top: geometry.bounds.top,
        bottom: geometry.bounds.bottom
    }], commonScale, baseGapY);
    if (!vertical) return null;

    progress(55, 'Choosing best layout...');

    return finalizeLayoutRows(rowSpecs, commonScale, baseGapX, baseGapY, vertical.gapY, {
        scaleX: scaleX,
        scaleY: scaleY,
        fitDifference: Math.abs(scaleX - scaleY),
        layoutHeight: vertical.layoutHeight,
        shapedSelection: true,
        solverPasses: iterations,
        testedRows: cfg.autoRows ? 0 : 1
    });
}

function buildFastShapeSegmentCache(items) {
    var n = items.length,
        segments = [],
        start, count;

    for (start = 0; start < n; start++) {
        segments[start] = []
        var width = 0,
            height = 0;

        for (count = 1; start + count <= n; count++) {
            var item = items[start + count - 1];
            width += item.width
            if (item.height > height) height = item.height
            segments[start][count] = { contentWidth: width, rowHeight: height }
        }
    }

    return { segments: segments }
}

function findShapedPlacementFast(items, geometry, scale, baseGapX, baseGapY, cache, desiredRows) {
    var n = items.length,
        minGapY = baseGapY * scale,
        maxIntervalWidth = getMaximumIntervalWidth(geometry),
        statesByEnd = [],
        rangeCache = {},
        start, count;

    for (start = 0; start < n; start++) {
        var previous = start == 0 ? null : statesByEnd[start - 1];
        if (start > 0 && (!previous || !previous.length)) continue;

        for (count = 1; start + count <= n; count++) {
            var metrics = cache.segments[start][count],
                requiredWidth = (metrics.contentWidth + Math.max(0, count - 1) * baseGapX) * scale,
                height = metrics.rowHeight * scale;

            if (requiredWidth > maxIntervalWidth + FIT_EPS) break;
            if (height > geometry.bounds.height + FIT_EPS) continue;

            var end = start + count - 1,
                key = start + ':' + count,
                ranges = rangeCache[key];

            if (ranges == undefined) {
                ranges = getFastRowTopRanges(geometry, height, requiredWidth)
                rangeCache[key] = ranges
            }
            if (!ranges.length) continue;

            if (!statesByEnd[end]) statesByEnd[end] = []

            for (var rr = 0; rr < ranges.length; rr++) {
                var range = ranges[rr];

                if (start == 0) {
                    if (desiredRows && desiredRows < 1) continue;
                    if (desiredRows) {
                        var itemsAfterFirst = n - count,
                            rowsAfterFirst = desiredRows - 1;
                        if (rowsAfterFirst < 0 || itemsAfterFirst < rowsAfterFirst || (rowsAfterFirst == 0 && itemsAfterFirst != 0)) continue;
                    }

                    addFastShapeState(statesByEnd[end], {
                        start: start,
                        count: count,
                        contentWidth: metrics.contentWidth,
                        rowHeight: metrics.rowHeight,
                        height: height,
                        topMin: range.topMin,
                        topMax: range.topMax,
                        bottomMin: range.topMin + height,
                        bottomMax: range.topMax + height,
                        allowedTopMin: range.topMin,
                        allowedTopMax: range.topMax,
                        interval: range.interval,
                        rowCount: 1,
                        distribution: [count],
                        rhythmPenalty: getRowRhythmPenalty([count], cfg.rowRhythm),
                        prev: null
                    }, desiredRows)
                    continue;
                }

                for (var pp = 0; pp < previous.length; pp++) {
                    var prev = previous[pp],
                        rowCount = prev.rowCount + 1;

                    if (desiredRows && rowCount > desiredRows) continue;

                    var itemsAfter = n - (start + count),
                        rowsAfter = desiredRows ? desiredRows - rowCount : 0;

                    if (desiredRows && (rowsAfter < 0 || itemsAfter < rowsAfter || (rowsAfter == 0 && itemsAfter != 0))) continue;

                    // Feasibility is checked with one exact minimum Gap Y for
                    // every row. This guarantees that the selected path always
                    // has a document-wide uniform vertical rhythm. After the
                    // scale is fixed we may enlarge that one common gap.
                    var topMin = Math.max(range.topMin, prev.bottomMin + minGapY),
                        topMax = Math.min(range.topMax, prev.bottomMax + minGapY);

                    if (topMax < topMin - FIT_EPS) continue;
                    if (topMax < topMin) topMax = topMin

                    addFastShapeState(statesByEnd[end], {
                        start: start,
                        count: count,
                        contentWidth: metrics.contentWidth,
                        rowHeight: metrics.rowHeight,
                        height: height,
                        topMin: topMin,
                        topMax: topMax,
                        bottomMin: topMin + height,
                        bottomMax: topMax + height,
                        allowedTopMin: range.topMin,
                        allowedTopMax: range.topMax,
                        interval: range.interval,
                        rowCount: rowCount,
                        distribution: prev.distribution.concat([count]),
                        rhythmPenalty: getRowRhythmPenalty(prev.distribution.concat([count]), cfg.rowRhythm),
                        prev: prev
                    }, desiredRows)
                }
            }
        }
    }

    var finals = statesByEnd[n - 1];
    if (!finals || !finals.length) return null

    var best = null;
    for (var i = 0; i < finals.length; i++) {
        var state = finals[i];
        if (desiredRows && state.rowCount != desiredRows) continue;

        var stateRhythm = state.rhythmPenalty != undefined ? state.rhythmPenalty : getRowRhythmPenalty(state.distribution || [], cfg.rowRhythm),
            bestRhythm = best ? (best.rhythmPenalty != undefined ? best.rhythmPenalty : getRowRhythmPenalty(best.distribution || [], cfg.rowRhythm)) : 1e100;

        if (!best || state.rowCount < best.rowCount ||
            (state.rowCount == best.rowCount && cfg.rowRhythm != 'auto' && stateRhythm < bestRhythm - 0.000001) ||
            (state.rowCount == best.rowCount && (cfg.rowRhythm == 'auto' || Math.abs(stateRhythm - bestRhythm) <= 0.000001) &&
                state.bottomMax - state.bottomMin > best.bottomMax - best.bottomMin + FIT_EPS))
            best = state
    }

    if (!best) return null

    var path = [];
    while (best) {
        path.push(best)
        best = best.prev
    }
    path.reverse()
    return path
}

function addFastShapeState(list, state, desiredRows) {
    // For the future only the reachable bottom interval and row count matter.
    // If another state covering the same prefix has an equal/better row count
    // and fully contains this interval, this state can never unlock anything
    // new and is discarded. This keeps the DP compact in ExtendScript.
    for (var i = list.length - 1; i >= 0; i--) {
        var old = list[i],
            oldDominates = old.bottomMin <= state.bottomMin + FIT_EPS && old.bottomMax >= state.bottomMax - FIT_EPS,
            newDominates = state.bottomMin <= old.bottomMin + FIT_EPS && state.bottomMax >= old.bottomMax - FIT_EPS;

        var rhythmActive = cfg.rowRhythm != 'auto',
            oldRhythm = old.rhythmPenalty != undefined ? old.rhythmPenalty : 0,
            newRhythm = state.rhythmPenalty != undefined ? state.rhythmPenalty : 0,
            oldRhythmNoWorse = !rhythmActive || oldRhythm <= newRhythm + 0.000001,
            newRhythmNoWorse = !rhythmActive || newRhythm <= oldRhythm + 0.000001;

        if (desiredRows) {
            if (old.rowCount != state.rowCount) continue;
            if (oldDominates && oldRhythmNoWorse) return;
            if (newDominates && newRhythmNoWorse) list.splice(i, 1)
        } else {
            if (old.rowCount <= state.rowCount && oldDominates && oldRhythmNoWorse) return;
            if (state.rowCount <= old.rowCount && newDominates && newRhythmNoWorse) list.splice(i, 1)
        }
    }
    list.push(state)
}

function getFastRowTopRanges(geometry, rowHeight, requiredWidth) {
    var low = geometry.bounds.top,
        high = geometry.bounds.bottom - rowHeight,
        events = [],
        ranges = [],
        i;

    if (high < low - FIT_EPS) return ranges
    if (high < low) high = low

    pushUniqueNumber(events, low, 0.001)
    pushUniqueNumber(events, high, 0.001)

    for (i = 0; i < geometry.yBreaks.length; i++) {
        var y = geometry.yBreaks[i],
            a = y,
            b = y - rowHeight;

        if (a > low + 0.001 && a < high - 0.001) pushUniqueNumber(events, a, 0.001)
        if (b > low + 0.001 && b < high - 0.001) pushUniqueNumber(events, b, 0.001)
    }

    events.sort(function (a, b) { return a - b })

    if (events.length == 1) {
        var onlyIntervals = getIntervalsForVerticalSpan(geometry, low, low + rowHeight),
            only = chooseRowInterval(onlyIntervals, requiredWidth);
        if (only) ranges.push({ topMin: low, topMax: low, interval: only })
        return ranges
    }

    for (i = 0; i < events.length - 1; i++) {
        var from = events[i],
            to = events[i + 1];
        if (to < from + 0.000001) continue;

        var probe = from + (to - from) / 2,
            intervals = getIntervalsForVerticalSpan(geometry, probe, probe + rowHeight),
            interval = chooseRowInterval(intervals, requiredWidth);

        if (!interval) continue;

        var last = ranges.length ? ranges[ranges.length - 1] : null;
        if (last && Math.abs(last.topMax - from) <= 0.002 &&
            Math.abs(last.interval.left - interval.left) <= GEOMETRY_EPS &&
            Math.abs(last.interval.right - interval.right) <= GEOMETRY_EPS) {
            last.topMax = to
        } else {
            ranges.push({
                topMin: from,
                topMax: to,
                interval: { left: interval.left, right: interval.right, width: interval.right - interval.left }
            })
        }
    }

    return ranges
}

function getMaximumIntervalWidth(geometry) {
    var maxWidth = 0;
    for (var i = 0; i < geometry.bands.length; i++) {
        for (var j = 0; j < geometry.bands[i].intervals.length; j++) {
            var width = geometry.bands[i].intervals[j].right - geometry.bands[i].intervals[j].left;
            if (width > maxWidth) maxWidth = width
        }
    }
    return maxWidth
}

function chooseRowInterval(intervals, requiredWidth) {
    var best = null;
    for (var i = 0; i < intervals.length; i++) {
        var width = intervals[i].right - intervals[i].left;
        if (width + FIT_EPS < requiredWidth) continue;
        if (!best || width > best.width + FIT_EPS ||
            (Math.abs(width - best.width) <= FIT_EPS && intervals[i].left < best.left)) {
            best = { left: intervals[i].left, right: intervals[i].right, width: width }
        }
    }
    return best
}

function isBetterLayout(candidate, current) {
    if (!candidate) return false
    if (!current) return true

    var scaleEps = 1e-10;
    if (candidate.commonScale > current.commonScale + scaleEps) return true
    if (candidate.commonScale < current.commonScale - scaleEps) return false

    // At the same scale, honor the selected vertical row rhythm before
    // secondary geometric tie-breakers. Rhythm never wins by shrinking scale.
    if (cfg.rowRhythm != 'auto') {
        var candidateRhythm = candidate.rhythmPenalty != undefined ? candidate.rhythmPenalty : getRowRhythmPenalty(candidate.distribution, cfg.rowRhythm),
            currentRhythm = current.rhythmPenalty != undefined ? current.rhythmPenalty : getRowRhythmPenalty(current.distribution, cfg.rowRhythm);
        if (candidateRhythm < currentRhythm - 0.000001) return true
        if (candidateRhythm > currentRhythm + 0.000001) return false
    }

    // If two variants have effectively the same scale, prefer the one where
    // width and height constraints are balanced more closely. This avoids a
    // needlessly long/thin layout when it gives no size advantage.
    if (candidate.fitDifference < current.fitDifference - scaleEps) return true
    if (candidate.fitDifference > current.fitDifference + scaleEps) return false

    // Final deterministic tie-breaker: fewer rows.
    return candidate.rows.length < current.rows.length
}

function compareVerticalRowScores(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var av = a[i] || 0, bv = b[i] || 0;
        if (av < bv - 1e-8) return -1;
        if (av > bv + 1e-8) return 1;
    }
    return 0;
}

function getVerticalRowScore(counts, mode) {
    var n = counts.length, total = 0, squares = 0, lo = 1e100, hi = 0, singles = 0,
        violations = 0, severity = 0, mirror = [], tie = 0, i;
    for (i = 0; i < n; i++) {
        var value = counts[i]; total += value; squares += value * value;
        lo = Math.min(lo, value); hi = Math.max(hi, value);
        if (value == 1 && n > 1) singles++;
    }
    for (i = 0; i < Math.floor(n / 2); i++) mirror.push(Math.abs(counts[i] - counts[n - 1 - i]));
    while (mirror.length < Math.floor(total / 2)) mirror.push(0);
    var variance = n ? squares - total * total / n : 0, excess = Math.max(0, hi - lo - 2);
    if (mode == 'auto' || n <= 1) return [singles, excess, variance].concat(mirror);
    var profile = getRowRhythmProfile(n, mode), middle = (n - 1) / 2;
    for (i = 1; i < n; i++) {
        var delta = counts[i] - counts[i - 1], wrong = 0;
        if (mode == 'alternateWide' || mode == 'alternateNarrow') {
            var wantsMore = (i % 2 == 0) == (mode == 'alternateWide');
            wrong = Math.max(0, 1 - (wantsMore ? delta : -delta));
        } else {
            var toward = Math.abs(i - middle) < Math.abs(i - 1 - middle),
                away = Math.abs(i - middle) > Math.abs(i - 1 - middle),
                wantsIncrease = mode == 'centerWide' ? toward : away;
            if (toward || away) wrong = Math.max(0, wantsIncrease ? -delta : delta);
        }
        if (wrong > 0) { violations++; severity += wrong; }
    }
    for (i = 0; i < n; i++) tie -= counts[i] * profile[i];
    return [excess, singles, violations, severity].concat(mirror, [variance, tie]);
}

function improveVerticalCounts(counts, mode, feasible, tick) {
    if (mode == 'auto' || counts.length <= 1) return counts.slice(0);
    var best = counts.slice(0), score = getVerticalRowScore(best, mode), n = counts.length;
    for (var pass = 0; pass < Math.min(12, n * 2); pass++) {
        if (tick) tick();
        var next = best, nextScore = score;
        for (var a = 0; a < n; a++) if (best[a] > 1) for (var b = 0; b < n; b++) {
            if (a == b) continue;
            var trial = best.slice(0); trial[a]--; trial[b]++;
            var quality = getVerticalRowScore(trial, mode);
            if (compareVerticalRowScores(quality, nextScore) < 0 && (!feasible || feasible(trial))) {
                next = trial; nextScore = quality;
            }
        }
        if (next == best) break;
        best = next; score = nextScore;
    }
    return best;
}

function reflowVerticalRows(plan, geometry, itemRows, scale) {
    if (plan.lockedMetrics) return rebuildAssignedLayout(plan, geometry, itemRows, true);
    if (!priorityOrderValid(itemRows)) return null;
    var specs = [], groups = [], byZone = {}, r;
    for (r = 0; r < itemRows.length; r++) {
        var old = plan.rows[r], spec = assignedRowSpec(itemRows[r], old);
        if (!geometry.isRectangle && !geometry.multiZone &&
            !setClosestRowRange(spec, geometry, scale,
                (spec.contentWidth + plan.baseGapX * (itemRows[r].length - 1)) * scale, old.y)) return null;
        specs.push(spec);
        var key = geometry.multiZone ? String(old.zoneIndex) : 'all';
        if (!byZone[key]) byZone[key] = [];
        byZone[key].push(r);
    }
    var zones = geometry.multiZone ? flattenComponentZones(geometry.components) : null;
    for (var key in byZone) if (byZone.hasOwnProperty(key)) {
        var zone = zones ? zones[Number(key)] : geometry.bounds;
        groups.push({ type: !geometry.isRectangle && !geometry.multiZone ? 'ranges' : 'container',
            rowIndices: byZone[key], top: zone.top, bottom: zone.bottom });
    }
    var vertical = resolveVerticalLayout(specs, groups, scale, plan.baseGapY);
    if (!vertical) return null;
    var metadata = {};
    copyLayoutMetadata(metadata, plan);
    copyDefinedPlanMetadata(metadata, plan, ['scaleX', 'scaleY', 'fitDifference']);
    return finalizeLayoutRows(specs, scale, plan.baseGapX, plan.baseGapY, vertical.gapY, metadata);
}

function refineVerticalLayout(plan, geometry) {
    if (!plan || cfg.rowRhythm == 'auto' || plan.pythonPacking || plan.rows.length <= 1) return plan;
    var initial = plan.distribution, reference = plan.commonScale, fixed = !!plan.lockedMetrics,
        minimum = fixed ? reference : reference * (1 - (typeof COMPOSITION_MAX_SCALE_LOSS != 'undefined' ? COMPOSITION_MAX_SCALE_LOSS : .01)),
        seed = {}, rows = plan.rows, groups = {}, i;
    for (var property in plan) if (plan.hasOwnProperty(property)) seed[property] = plan[property];
    seed.commonScale = minimum;
    for (i = 0; i < rows.length; i++) {
        var key = rows[i].zoneIndex != undefined ? String(rows[i].zoneIndex) : 'all';
        if (!groups[key]) groups[key] = { indices: [], items: [] };
        groups[key].indices.push(i); groups[key].items = groups[key].items.concat(rows[i].items);
    }
    function rebuild(counts, scale) {
        var assigned = [], k, r;
        for (k in groups) if (groups.hasOwnProperty(k)) {
            var group = groups[k], offset = 0, sum = 0;
            for (r = 0; r < group.indices.length; r++) sum += counts[group.indices[r]];
            if (sum != group.items.length) return null;
            for (r = 0; r < group.indices.length; r++) {
                var index = group.indices[r]; assigned[index] = group.items.slice(offset, offset + counts[index]); offset += counts[index];
            }
        }
        seed.commonScale = scale;
        return reflowVerticalRows(seed, geometry, assigned, scale);
    }
    var total = 0;
    for (i = 0; i < initial.length; i++) total += initial[i];
    var preferred = getPreferredRowDistribution(total, initial.length, cfg.rowRhythm), start = initial;
    if (compareVerticalRowScores(getVerticalRowScore(preferred, cfg.rowRhythm), getVerticalRowScore(initial, cfg.rowRhythm)) < 0 && rebuild(preferred, minimum)) start = preferred;
    var bestPlan = null,
        result = improveVerticalCounts(start, cfg.rowRhythm, function (counts) {
            var candidate = rebuild(counts, minimum);
            if (!candidate) return false;
            bestPlan = candidate; return true;
        }, function () { progress(currentProgressValue, 'Refining vertical row shape...'); });
    if (compareVerticalRowScores(getVerticalRowScore(result, cfg.rowRhythm), getVerticalRowScore(initial, cfg.rowRhythm)) >= 0) return plan;
    bestPlan = rebuild(result, minimum);
    if (!bestPlan) return plan;
    var high = reference, low = minimum, exact = rebuild(result, high);
    if (exact) bestPlan = exact;
    else if (!fixed) for (i = 0; i < 18; i++) {
        var scale = (low + high) / 2, candidate = rebuild(result, scale);
        if (candidate) { bestPlan = candidate; low = scale; } else high = scale;
    }
    bestPlan.verticalReferenceScale = reference;
    validateLayoutPlan(bestPlan, geometry);
    return bestPlan;
}

function getPreferredRowDistribution(count, rows, mode) {
    if (mode == 'auto') return getBalancedDistribution(count, rows);

    var base = Math.floor(count / rows),
        extra = count % rows,
        output = [],
        ranked = [],
        profile = getRowRhythmProfile(rows, mode),
        i;

    for (i = 0; i < rows; i++) {
        output[i] = base;
        ranked.push({ index: i, score: profile[i] });
    }
    if (!extra) return improveVerticalCounts(output, mode);

    ranked.sort(function (a, b) {
        if (Math.abs(a.score - b.score) > 0.000001) return b.score - a.score;
        // Deterministic tie-breaker: reading order. Symmetric modes normally
        // select both members of a pair when the arithmetic allows it.
        return a.index - b.index;
    });

    for (i = 0; i < extra && i < ranked.length; i++) output[ranked[i].index]++;
    return improveVerticalCounts(output, mode);
}

function getRowRhythmProfile(rows, mode) {
    var out = [], i;
    if (rows <= 0) return out;
    if (mode == 'auto' || rows == 1) {
        for (i = 0; i < rows; i++) out[i] = 0;
        return out;
    }

    if (mode == 'alternateWide' || mode == 'alternateNarrow') {
        var wideOnEven = mode == 'alternateWide', bias = 1 / (4 * rows * rows);
        // Resolve unavoidable remainder ties in reading order: fill preferred
        // long rows from the top, and put extra items in short rows from below.
        for (i = 0; i < rows; i++) out[i] = ((i % 2 == 0) == wideOnEven) ? 1 - i * bias : i * bias;
        return out;
    }

    var center = (rows - 1) / 2,
        minDistance = rows % 2 ? 0 : 0.5,
        maxDistance = Math.max(center, rows - 1 - center),
        span = maxDistance - minDistance;

    for (i = 0; i < rows; i++) {
        var distance = Math.abs(i - center),
            centerScore = span > 0 ? 1 - (distance - minDistance) / span : 1;
        centerScore = Math.max(0, Math.min(1, centerScore));
        out[i] = mode == 'edgesWide' ? 1 - centerScore : centerScore;
    }
    return out;
}

function getRowRhythmPenalty(distribution, mode) {
    if (mode == 'auto' || !distribution || distribution.length <= 1) return 0;

    var minValue = 1e100,
        maxValue = -1e100,
        i;
    for (i = 0; i < distribution.length; i++) {
        var value = Number(distribution[i]);
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
    }
    if (!(maxValue > minValue)) return 0;

    var profile = getRowRhythmProfile(distribution.length, mode),
        span = maxValue - minValue,
        penalty = 0;
    for (i = 0; i < distribution.length; i++) {
        var normalized = (distribution[i] - minValue) / span,
            d = normalized - profile[i];
        penalty += d * d;
    }
    return penalty / distribution.length;
}

function getPackingRowsDistribution(rows) {
    var out = [];
    if (!rows) return out;
    for (var i = 0; i < rows.length; i++) out.push(rows[i].count);
    return out;
}

function getBalancedDistribution(count, rows) {
    var base = Math.floor(count / rows),
        extra = count % rows,
        output = [],
        i;

    for (i = 0; i < rows; i++) output[i] = base
    if (!extra) return output

    var extraRows = getSymmetricExtraRows(rows, extra);
    for (i = 0; i < extraRows.length; i++) output[extraRows[i]]++

    return output
}

function getSymmetricExtraRows(rows, extra) {
    var selected = [],
        center = (rows - 1) / 2,
        i;

    if (rows % 2 && extra % 2) {
        selected.push(Math.floor(center))
        extra--
    }

    var pairs = [];
    for (i = 0; i < Math.floor(rows / 2); i++) {
        pairs.push({
            left: i,
            right: rows - 1 - i,
            distance: Math.abs(i - center)
        })
    }

    // When the remainder is even, start near the center. When it is odd and the
    // center is already occupied, spread the next pair towards the outside.
    pairs.sort(function (a, b) {
        if (selected.length) return a.distance < b.distance ? 1 : -1
        return a.distance > b.distance ? 1 : -1
    })

    for (i = 0; i < pairs.length && extra >= 2; i++) {
        selected.push(pairs[i].left)
        selected.push(pairs[i].right)
        extra -= 2
    }

    // This branch is mainly for an even number of rows.
    if (extra == 1) {
        var best = -1,
            bestDistance = 1e20;
        for (i = 0; i < rows; i++) {
            if (arrayContains(selected, i)) continue;
            var d = Math.abs(i - center);
            if (d < bestDistance) {
                bestDistance = d
                best = i
            }
        }
        if (best >= 0) selected.push(best)
    }

    selected.sort(function (a, b) { return a - b })
    return selected
}

function getMedianHeight(items) {
    return getMedianDimension(items, 'height');
}

function validateLayoutPlan(plan, geometry) {
    if (plan && plan.rows) {
        var priorityRows = [];
        for (var pr = 0; pr < plan.rows.length; pr++) priorityRows.push(plan.rows[pr].items);
        if (!priorityOrderValid(priorityRows)) throw new Error(str.t('Нарушен порядок приоритетов цветовых меток.', 'Layer label priority order was violated.'));
    }
    if (cfg.noEnlarge && plan && plan.commonScale > 1 + 1e-12)
        throw new Error(str.t('Нарушен запрет увеличения слоёв.', 'Layer enlargement is disabled.'));
    if (!plan || !plan.placements || !plan.placements.length)
        throw new Error(str.t('План раскладки пуст.', 'The layout plan is empty.'))

    if (plan.placements.length != sourceState.layerIds.length)
        throw new Error(str.t('Количество рассчитанных позиций не совпадает с количеством выбранных слоёв.', 'The number of calculated positions does not match the number of selected layers.'))

    if (!isFinite(plan.commonScale) || plan.commonScale <= 0)
        throw new Error(str.t('Некорректный общий масштаб.', 'Invalid common scale.'))

    if (plan.lockedMetrics && lockedLayoutActive()) {
        var previousRows = {};
        for (var r = 0; r < plan.rows.length; r++) {
            var row = plan.rows[r], zoneKey = String(row.zoneIndex == undefined ? 0 : row.zoneIndex), previous = previousRows[zoneKey];
            if (previous && Math.abs(row.y - previous.y - previous.rowHeight * plan.commonScale - actionLayoutProfile.gapY) > 1e-7)
                throw new Error(str.t('Изменился Y-интервал экшена.', 'The action Y gap has changed.'));
            previousRows[zoneKey] = row;
            if (row.items.length > 1 && Math.abs(row.gapX - actionLayoutProfile.gapX) > 1e-7)
                throw new Error(str.t('Изменился X-интервал экшена.', 'The action X gap has changed.'));
        }
        if (Math.abs(getMedianDimension(plan.placements, 'height') - actionLayoutProfile.height) > 1e-7)
            throw new Error(str.t('Изменилась опорная высота экшена.', 'The action reference height has changed.'));
    }
    var eps = 0.05, seenIds = {}, sourceIds = {};
    for (var si = 0; si < sourceState.layerIds.length; si++) sourceIds[String(sourceState.layerIds[si])] = true;
    for (var i = 0; i < plan.placements.length; i++) {
        var p = plan.placements[i], idKey = String(p.layerId);
        if (seenIds[idKey] || !sourceIds[idKey])
            throw new Error(str.t('План содержит повторный или посторонний слой "', 'The plan contains a duplicate or foreign layer "') + p.name + str.t('".', '".'));
        seenIds[idKey] = true;
        if (!isFinite(p.left) || !isFinite(p.top) || !isFinite(p.right) || !isFinite(p.bottom) ||
            p.right <= p.left || p.bottom <= p.top)
            throw new Error(str.t('Некорректные границы слоя "', 'Invalid bounds for layer "') + p.name + str.t('".', '".'));

        if (!isFinite(p.targetCenterX) || !isFinite(p.targetCenterY) || !isFinite(p.scale))
            throw new Error(str.t('Некорректные координаты слоя "', 'Invalid coordinates for layer "') + p.name + str.t('".', '".'))

        if (Math.abs(p.scale - plan.commonScale) > 1e-10)
            throw new Error(str.t('Нарушен единый масштаб раскладки.', 'The common layout scale was violated.'))

        if (p.left < geometry.bounds.left - eps || p.top < geometry.bounds.top - eps ||
            p.right > geometry.bounds.right + eps || p.bottom > geometry.bounds.bottom + eps)
            throw new Error(str.t('Слой "', 'Layer "') + p.name + str.t('" выходит за внешние границы выделения.', '" extends outside the outer selection bounds.'))

        if (!geometry.isRectangle) {
            var allowed = getIntervalsForVerticalSpan(geometry, p.top, p.bottom),
                inside = false;
            for (var k = 0; k < allowed.length; k++) {
                if (p.left >= allowed[k].left - eps && p.right <= allowed[k].right + eps) {
                    inside = true
                    break;
                }
            }
            if (!inside) throw new Error(str.t('Слой "', 'Layer "') + p.name + str.t('" частично выходит за форму выделения.', '" extends partially outside the selection shape.'))
        }
    }

    for (i = 0; i < plan.placements.length; i++) {
        for (var j = i + 1; j < plan.placements.length; j++) {
            if (rectanglesOverlap(plan.placements[i], plan.placements[j], eps))
                throw new Error(str.t('Обнаружено пересечение слоёв "', 'Overlap detected between layers "') + plan.placements[i].name + str.t('" и "', '" and "') + plan.placements[j].name + str.t('".', '".'))
        }
    }
}

function rectanglesOverlap(a, b, eps) {
    return a.left < b.right - eps && a.right > b.left + eps &&
        a.top < b.bottom - eps && a.bottom > b.top + eps
}

// Photoshop raster bounds can round to whole pixels. This checks native
// results, not just planned coordinates; larger deviations cause history rollback.
function validateAppliedBounds(expected, actual, name) {
    var eps = 1.01, keys = ['left', 'top', 'right', 'bottom'];
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!isFinite(Number(actual[key])) || Math.abs(Number(actual[key]) - expected[key]) > eps)
            throw new Error(str.t('Photoshop не воспроизвёл записанную геометрию объекта "',
                'Photoshop did not reproduce the recorded geometry of object "') + name + str.t('".', '".'));
    }
    if (Math.abs((actual.right - actual.left) - (expected.right - expected.left)) > eps ||
        Math.abs((actual.bottom - actual.top) - (expected.bottom - expected.top)) > eps)
        throw new Error(str.t('Photoshop изменил размер рамки объекта "', 'Photoshop changed the frame size of object "') + name + str.t('".', '".'));
}

function applyLayoutPlan() {
    if (cfg.noEnlarge && layoutPlan && layoutPlan.commonScale > 1 + 1e-12)
        throw new Error(str.t('Увеличение слоёв запрещено.', 'Layer enlargement is disabled.'));
    if (!layoutPlan || !layoutPlan.placements) throw new Error(str.t('Нет рассчитанного LayoutPlan.', 'No calculated LayoutPlan is available.'))

    var scale = layoutPlan.commonScale,
        ids = sourceState && sourceState.layerIds ? sourceState.layerIds.slice(0) : [],
        i;

    if (!isFinite(scale) || scale <= 0) throw new Error(str.t('Некорректный общий масштаб.', 'Invalid common scale.'))
    if (!ids.length) throw new Error(str.t('Не удалось получить исходный набор слоёв для общей трансформации.', 'Could not get the source layer set for the common transform.'))

    runLayoutProgressStage('Scaling layers', function () {
        // For Transform only the selected set matters, not its palette-order
        // representation. Check targetLayersIDs directly: one document query,
        // no per-layer descriptors.
        if (!selectedLayerSetMatches(ids)) {
            lr.selectLayers(ids);
            if (!selectedLayerSetMatches(ids))
                throw new Error(str.t('Photoshop не смог восстановить исходный набор слоёв перед общей трансформацией.', 'Photoshop could not restore the source layer set before the common transform.'));
        }
        if (Math.abs(scale - 1) > 0.0000001) lr.transformSelection(scale * 100);
    });
    runLayoutProgressStage('Positioning photos', function () {
        var total = layoutPlan.placements.length;
        for (i = 0; i < total; i++) {
            var p = layoutPlan.placements[i];
            layoutUnitProgress(i, total, i + '/' + total);
            lr.selectLayers([p.layerId]);
            var boundsProperty = lr.getProperty('boundsNoEffects', p.layerId);
            if (!boundsProperty || !boundsProperty.value)
                throw new Error(str.t('Не удалось получить boundsNoEffects слоя после общей трансформации.', 'Could not get layer boundsNoEffects after the common transform.'));
            var b = lr.descToObject(boundsProperty.value), actualLeft = Number(b.left), actualTop = Number(b.top),
                dX = p.left - actualLeft, dY = p.top - actualTop;
            if (!isFinite(actualLeft) || !isFinite(actualTop) || !isFinite(dX) || !isFinite(dY))
                throw new Error(str.t('Не удалось рассчитать итоговое положение слоя "', 'Could not calculate the final position of layer "') + p.name + str.t('".', '".'));
            if (Math.abs(dX) > 0.0001 || Math.abs(dY) > 0.0001) lr.move(dX, dY);
            if (layoutPlan.lockedMetrics) {
                var applied = lr.getProperty('boundsNoEffects', p.layerId);
                if (!applied || !applied.value) throw new Error(str.t('Не удалось проверить итоговые границы рамки.', 'Could not verify the final frame bounds.'));
                validateAppliedBounds(p, lr.descToObject(applied.value), p.name);
            }
            layoutUnitProgress(i + 1, total, (i + 1) + '/' + total);
        }
    });
    if (cfg.groupRows) runLayoutProgressStage('Grouping rows', function () { groupLayoutRows(layoutPlan.rows); });
}

function groupLayoutRows(rows, preparedMap) {
    for (var r = rows.length - 1; r >= 0; r--) {
        layoutUnitProgress(rows.length - r - 1, rows.length, (rows.length - r - 1) + '/' + rows.length + ' — Row ' + (r + 1));

        var ids = [], seen = {};
        for (var i = 0; i < rows[r].items.length; i++) {
            var itemId = rows[r].items[i].id, entry = preparedMap ? preparedMap[String(itemId)] : null,
                roots = entry ? entry.roots : [itemId];
            for (var q = 0; q < roots.length; q++) if (!seen[String(roots[q])]) {
                seen[String(roots[q])] = true;
                ids.push(roots[q]);
            }
        }
        if (!ids.length) continue;

        lr.selectLayers(ids)
        lr.groupSelectedLayers()
        layoutUnitProgress(rows.length - r, rows.length, (rows.length - r) + '/' + rows.length + ' — Row ' + (r + 1));
    }
}

function restoreLayerSelection(ids, activeId) {
    if (!ids || !ids.length) return;

    var ordered = [], i;
    for (i = 0; i < ids.length; i++) {
        if (ids[i] != activeId) ordered.push(ids[i])
    }
    if (arrayContains(ids, activeId)) ordered.push(activeId)
    lr.selectLayers(ordered.length ? ordered : ids)
}

function shouldCollapseAllGroupsAfterLayout() {
    if (cfg && cfg.groupRows) return true;
    if (!inputPreparation || !inputPreparation.units) return false;
    for (var i = 0; i < inputPreparation.units.length; i++) {
        var roots = inputPreparation.units[i].roots || [];
        for (var r = 0; r < roots.length; r++)
            if (roots[r] && roots[r].section == 'layerSectionStart') return true;
    }
    return false;
}

function collapseAllLayerGroups() {
    try {
        if (typeof app != 'undefined' && typeof app.runMenuItem == 'function')
            app.runMenuItem(s2t('collapseAllGroupsEvent'));
    } catch (e) {}
}

function near(a, b, eps) {
    return Math.abs(a - b) <= eps
}

function samePoint(a, b, eps) {
    return near(a.x, b.x, eps) && near(a.y, b.y, eps)
}

function arrayContains(a, value) {
    for (var i = 0; i < a.length; i++) if (a[i] == value) return true
    return false
}

function round2(v) {
    return Math.round(v * 100) / 100
}


function OptionalPythonFeatures(api, failureLimit) {
    var state = {};

    function resetState() {
        state = {
            initialized: false,
            disabled: false,
            reason: '',
            message: '',
            failureLimit: Math.max(1, Number(failureLimit) || 3),
            consecutiveFailures: 0,
            totalFailures: 0,
            photoFailures: 0
        };
    }

    resetState();

    this.resetForRun = function () {
        resetState();
    };

    this.getState = function () {
        return {
            initialized: state.initialized,
            disabled: state.disabled,
            reason: state.reason,
            message: state.message,
            failureLimit: state.failureLimit,
            consecutiveFailures: state.consecutiveFailures,
            totalFailures: state.totalFailures,
            photoFailures: state.photoFailures
        };
    };

    this.isDisabled = function () {
        return state.disabled;
    };

    this.ensureReady = function () {
        if (state.disabled) return false;
        if (state.initialized) return true;

        var result = api.tryInit();
        if (!result || !result.ok) {
            state.disabled = true;
            state.reason = result && result.reason ? result.reason : 'python_unavailable';
            state.message = result && result.message ? result.message : str.t('Python-функции недоступны.', 'Python features are unavailable.');
            return false;
        }

        state.initialized = true;
        state.reason = '';
        state.message = '';
        return true;
    };

    this.recordFailure = function (reason, message) {
        if (state.disabled) return;
        state.consecutiveFailures++;
        state.totalFailures++;
        state.reason = reason || 'python_error';
        state.message = message || str.t('Ошибка дополнительного Python-анализа.', 'Optional Python analysis error.');

        if (state.consecutiveFailures >= state.failureLimit) {
            state.disabled = true;
            state.reason = 'circuit_breaker';
            state.message = str.t('Python-анализ отключён до конца запуска после ', 'Python analysis was disabled for the rest of this run after ') + state.failureLimit +
                str.t(' последовательных ошибок. Последняя: ', ' consecutive errors. Last error: ') + state.message;
        }
    };

    this.recordSuccess = function () {
        state.consecutiveFailures = 0;
        state.reason = '';
        state.message = '';
    };

    this.recordPhotoFailure = function (reason, message) {
        state.photoFailures++;
        this.recordFailure(reason, message);
    };

    this.call = function (type, payload, options) {
        options = options || {};
        if (!this.ensureReady()) {
            return { ok: false, skipped: true, disabled: true, reason: state.reason, message: state.message };
        }

        try {
            var value = api.sendPayload(type, payload, { longRequest: !!options.photo || (type == 'gender_names' || type == 'alphabet_names') });

            // A valid result, including an explicit low-confidence/unknown result,
            // proves that the optional method is functioning and breaks the streak.
            if (!options.deferSuccess) this.recordSuccess();
            return { ok: true, value: value, disabled: false };
        } catch (e) {
            if (e.number && e.number == 8007) throw e;
            var message = e && e.message ? e.message : String(e);
            if (options.photo) this.recordPhotoFailure('python_error', message);
            else this.recordFailure('python_error', message);
            return { ok: false, error: e, disabled: state.disabled, reason: state.reason, message: state.message };
        }
    };
}


// ExtendScript has no guaranteed native JSON.parse. Parse data without executing
// input text; reject truncated replies, expressions and non-finite numbers.
function parseJSONData(text) {
    var input = String(text), pos = 0, size = input.length;
    function fail() { throw new Error('Invalid JSON data'); }
    function space() { while (pos < size && /[\x20\t\r\n]/.test(input.charAt(pos))) pos++; }
    function stringValue() {
        var result = '', ch, escaped, hex,
            escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        pos++;
        while (pos < size) {
            ch = input.charAt(pos++);
            if (ch == '"') return result;
            if (ch.charCodeAt(0) < 32) fail();
            if (ch != '\\') { result += ch; continue; }
            escaped = input.charAt(pos++);
            if (escaped == 'u') {
                hex = input.substr(pos, 4);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
                result += String.fromCharCode(parseInt(hex, 16)); pos += 4;
            } else {
                if (!escapes.hasOwnProperty(escaped)) fail();
                result += escapes[escaped];
            }
        }
        fail();
    }
    function value(depth) {
        if (depth > 64) fail();
        space();
        var ch = input.charAt(pos), result, key, match, number;
        if (ch == '"') return stringValue();
        if (ch == '[' || ch == '{') {
            var array = ch == '[', close = array ? ']' : '}';
            result = array ? [] : {}; pos++; space();
            if (input.charAt(pos) == close) { pos++; return result; }
            while (pos < size) {
                space();
                if (array) result.push(value(depth + 1));
                else {
                    if (input.charAt(pos) != '"') fail();
                    key = stringValue(); space();
                    // Protocol objects never need prototype or method keys.
                    if (key == '__proto__' || key == 'constructor' || key == 'prototype' || key == 'hasOwnProperty') fail();
                    if (result.hasOwnProperty(key) || input.charAt(pos++) != ':') fail();
                    result[key] = value(depth + 1);
                }
                space(); ch = input.charAt(pos++);
                if (ch == close) return result;
                if (ch != ',') fail();
            }
            fail();
        }
        if (input.substr(pos, 4) == 'true') { pos += 4; return true; }
        if (input.substr(pos, 5) == 'false') { pos += 5; return false; }
        if (input.substr(pos, 4) == 'null') { pos += 4; return null; }
        match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(pos));
        if (!match) fail();
        pos += match[0].length; number = Number(match[0]);
        if (!isFinite(number)) fail();
        return number;
    }
    var result = value(0);
    space();
    if (pos != size) fail();
    return result;
}

function AutoLayoutApi(apiHost, portSend, portListen, apiFile) {
    var sequence = 0,
        session = (new Date()).getTime() + '-' + Math.floor(Math.random() * 1000000),
        serverID = 'auto-layout/' + ver,
        initializationResult = null;

    function runtimeFiles() {
        var local = $.getenv('LOCALAPPDATA');
        if (!local) throw new Error(str.t('LOCALAPPDATA недоступен.', 'LOCALAPPDATA is unavailable.'));
        var root = local + '/JazzyScripts/AutoLayoutRuntime';
        return {
            root: root,
            python: new File(root + '/venv/Scripts/pythonw.exe'),
            launcher: new File(root + '/launcher.vbs'),
            marker: new File(root + '/runtime_version.txt')
        };
    }

    function ready() {
        var r = runtimeFiles();
        if (!r.python.exists || !r.launcher.exists || !r.marker.exists) return false;
        var models = ['face.onnx', 'gender.onnx'];
        for (var i = 0; i < models.length; i++)
            if (!(new File(r.root + '/venv/models/' + models[i])).exists) return false;
        return true;
    }

    function isHandshake(result) {
        return result && result.type == 'answer' && result.message == serverID && result.server_id == serverID;
    }

    function isAutoLayoutServer(result) {
        return result && typeof result.server_id == 'string' && result.server_id.indexOf('auto-layout/') == 0;
    }

    function serverIsListening() {
        var socket = new Socket(),
            opened = false;
        try {
            socket.timeout = 1;
            opened = socket.open(apiHost + ':' + portSend, 'UTF-8');
            if (!opened) return false;
            // Heartbeat is intentionally fire-and-forget and needs no response
            // listener, so probing the port does not generate server errors.
            socket.writeln(objectToJSON({ type: 'heartbeat', target_id: '__shutdown_probe__' }));
            return true;
        } catch (e) {
            return false;
        } finally {
            try { socket.close(); } catch (e2) { }
        }
    }

    function waitServerStop(delay) {
        var start = (new Date()).getTime();
        while ((new Date()).getTime() - start < delay) {
            if (!serverIsListening()) return true;
            if (pulseLayoutProgress() === false) throwCancelled();
            $.sleep(100);
        }
        return !serverIsListening();
    }

    function forceStopConfirmedServer() {
        // A previous server may not stop cooperatively. Only call this after a
        // successful handshake has proved that the listener is an Auto Layout
        // server. The helper kills the process owning our dedicated TCP port.
        var token = (new Date()).getTime() + '_' + Math.floor(Math.random() * 1000000),
            batName = 'AutoLayout_stop_' + token + '.bat',
            vbsName = 'AutoLayout_stop_' + token + '.vbs',
            bat = new File(Folder.temp + '/' + batName),
            vbs = new File(Folder.temp + '/' + vbsName);

        try {
            bat.encoding = 'ASCII';
            if (!bat.open('w')) return false;
            bat.writeln('@echo off');
            bat.writeln('for /f "tokens=2,5" %%A in (\'netstat -ano -p tcp\') do if "%%A"=="127.0.0.1:' + portSend + '" taskkill /PID %%B /F >nul 2>&1');
            bat.writeln('exit /b 0');
            bat.close();

            vbs.encoding = 'ASCII';
            if (!vbs.open('w')) return false;
            vbs.writeln('Option Explicit');
            vbs.writeln('Dim sh, p');
            vbs.writeln('Set sh = CreateObject("WScript.Shell")');
            vbs.writeln('p = sh.ExpandEnvironmentStrings("%TEMP%") & "\\' + batName + '"');
            vbs.writeln('sh.Run Chr(34) & p & Chr(34), 0, True');
            vbs.close();

            if (!vbs.execute()) return false;
            return waitServerStop(5000);
        } catch (e) {
            if (e.number == 8007) throw e;
            return false;
        } finally {
            try { if (bat.opened) bat.close(); } catch (e1) { }
            try { if (vbs.opened) vbs.close(); } catch (e2) { }
            try { if (bat.exists) bat.remove(); } catch (e3) { }
            try { if (vbs.exists) vbs.remove(); } catch (e4) { }
        }
    }

    function stopIncompatibleServer(result) {
        if (!isAutoLayoutServer(result)) return false;

        if (layoutProgressRun && layoutProgressRun.active) { layoutProgressRun.detail = 'Closing previous Python version'; pulseLayoutProgress(true); }
        else app.changeProgressText('Closing previous Python version...');

        // Try cooperative shutdown first, then replace the confirmed old server.
        controlRequest('shutdown', '', true);
        if (waitServerStop(2500)) return true;
        return forceStopConfirmedServer();
    }

    function localAvailability() {
        try {
            var module = findPythonModule(apiFile);
            if (!module) return { available: false, reason: 'module_missing', message: str.t('модуль ', 'module ') + apiFile + str.t('.pyw не найден', '.pyw was not found') };
            if (!ready()) return { available: false, reason: 'runtime_missing', message: str.t('runtime не установлен или модели отсутствуют; запустите install_runtime.bat', 'runtime is not installed or models are missing; run install_runtime.bat') };
            return { available: true, reason: '', message: '' };
        } catch (e) {
            return { available: false, reason: 'runtime_unavailable', message: e && e.message ? e.message : String(e) };
        }
    }

    this.getHeadTurnAvailability = function (baseAvailability) {
        if (!baseAvailability.available) return baseAvailability;
        var r = runtimeFiles();
        if (!(new File(r.root + '/venv/models/face_landmarker.task')).exists)
            return { available: false, message: str.t('Для поворота головы обновите runtime через install_runtime.bat.', 'Update the runtime with install_runtime.bat to enable head-turn analysis.') };
        try {
            if (!r.marker.open('r')) throw new Error('Runtime marker unavailable');
            var revision = Number(r.marker.read());
            r.marker.close();
            if (!(revision >= 2)) return { available: false, message: str.t('Для поворота головы обновите runtime через install_runtime.bat.', 'Update the runtime with install_runtime.bat to enable head-turn analysis.') };
        } catch (e) {
            try { r.marker.close(); } catch (ignored) { }
            return { available: false, message: str.t('Для поворота головы обновите runtime через install_runtime.bat.', 'Update the runtime with install_runtime.bat to enable head-turn analysis.') };
        }
        if (!(new File(r.root + '/venv/models/pose_landmarker_full.task')).exists)
            return { available: true, message: str.t('Пока учитывается только голова. Для корпуса обновите runtime через install_runtime.bat.', 'Only the head is currently considered. Update the runtime with install_runtime.bat to enable body orientation.') };
        return { available: true, message: '' };
    };

    this.getAvailability = function () {
        // The server itself is optional. A stopped server is not an error when the
        // local runtime is installed: it will be launched only if a Python feature
        // is actually requested.
        try {
            var result = sendMessage({ type: 'handshake', message: '' }, 300);
            if (isHandshake(result)) return { available: true, reason: '', message: '' };
            if (result && !isAutoLayoutServer(result))
                return { available: false, reason: 'port_busy', message: str.t('порт Python занят другим приложением', 'the Python port is in use by another application') };
        } catch (e) { }
        return localAvailability();
    };

    this.tryInit = function () {
        if (initializationResult) return initializationResult;
        initializationResult = startOrConnect();
        return initializationResult;
    };

    function startOrConnect() {
        try {
            var result = sendMessage({ type: 'handshake', message: '' }, 1000);
            if (isHandshake(result)) return { ok: true };

            var local = localAvailability();
            if (result) {
                if (!isAutoLayoutServer(result))
                    return { ok: false, reason: 'port_busy', message: str.t('Порт Auto layout занят другим приложением или неизвестным сервером.', 'The Auto Layout port is in use by another application or an unknown server.') };
                if (!local.available)
                    return { ok: false, reason: local.reason, message: local.message };
                if (!stopIncompatibleServer(result))
                    return { ok: false, reason: 'old_server_stop_failed', message: str.t('Не удалось автоматически закрыть Python-сервер предыдущей версии Auto layout.', 'Could not automatically stop the Python server from the previous Auto Layout version.') };
            }

            if (!local.available)
                return { ok: false, reason: local.reason, message: local.message };

            var module = findPythonModule(apiFile),
                r = runtimeFiles();
            $.setenv('AUTO_LAYOUT_SERVER', module.fsName);
            if (!r.launcher.execute())
                return { ok: false, reason: 'launcher_failed', message: str.t('Не удалось запустить приватный Python launcher.', 'Could not start the private Python launcher.') };

            var start = (new Date()).getTime();
            if (layoutProgressRun && layoutProgressRun.active) { layoutProgressRun.detail = 'Starting Python module'; pulseLayoutProgress(true); }
            else app.changeProgressText('Starting Python module...');
            while ((new Date()).getTime() - start < INIT_DELAY) {
                if (pulseLayoutProgress() === false) throwCancelled();
                result = sendMessage({ type: 'handshake', message: '' }, 1000);
                if (isHandshake(result)) return { ok: true };
                if (result)
                    return { ok: false, reason: 'unexpected_server', message: str.t('Неожиданный ответ Python-сервера Auto layout.', 'Unexpected response from the Auto Layout Python server.') };
                $.sleep(150);
            }
            return { ok: false, reason: 'startup_timeout', message: str.t('Не удалось запустить Python-сервер Auto layout. Подробности: ', 'Could not start the Auto Layout Python server. Details: ') + r.root + '/server.log' };
        } catch (e) {
            if (e.number && e.number == 8007) throw e;
            return { ok: false, reason: 'startup_error', message: e && e.message ? e.message : String(e) };
        }
    }

    function findPythonModule(name) {
        var folder = new File($.fileName).parent,
            paths = [folder.fsName + '/lib/' + name + '.pyw', folder.fsName + '/' + name + '.pyw'];
        for (var i = 0; i < paths.length; i++) {
            var f = new File(paths[i]);
            if (f.exists) return f;
        }
        return null;
    }

    this.cleanup = function (path) {
        return sendMessage({ type: 'cleanup', message: path }, 1500);
    };

    this.sendPayload = function (type, payload, options) {
        options = options || {};
        if (options.longRequest === true) beginPythonProgressWait();
        try {
            var result = sendMessage({ type: type, message: payload, long_request: options.longRequest === true }, ANALYSIS_DELAY);
            if (!result) throw new Error(str.t('Превышено время ожидания ответа Python.', 'Python response timeout.'));
            if (result.server_id != serverID) throw new Error(str.t('Ответ получен от несовместимого Python-сервера.', 'Response received from an incompatible Python server.'));
            if (result.type == 'cancelled') throwCancelled();
            if (result.type == 'error') throw new Error(String(result.message));
            return result.type == 'answer' ? result.message : null;
        } finally { if (options.longRequest === true) endPythonProgressWait(); }
    };

    function controlRequest(type, targetID, waitReply) {
        var socket = new Socket();
        try {
            socket.timeout = waitReply ? 6 : 1;
            if (!socket.open(apiHost + ':' + portSend, 'UTF-8')) return false;
            socket.writeln(objectToJSON({ type: type, target_id: targetID }));
            if (!waitReply) return true;
            var result = parseJSONData(socket.readln());
            return result && result.stopped === true;
        } catch (e) { return false; }
        finally { try { socket.close(); } catch (e2) { } }
    }

    function sendMessage(o, delay) {
        o.request_id = session + '-' + (++sequence);
        var listener = new Socket(),
            sender = new Socket(),
            longRequest = o.long_request === true,
            sent = false,
            received = false;
        if (!listener.listen(portListen, 'UTF-8')) throw new Error(str.t('Порт ответа ', 'Response port ') + portListen + str.t(' занят.', ' is busy.'));
        try {
            sender.timeout = 1;
            try {
                if (!sender.open(apiHost + ':' + portSend, 'UTF-8')) return null;
                sent = true;
                if (sender.writeln(objectToJSON(o)) === false)
                    throw new Error(str.t('Не удалось передать запрос Python.', 'Could not send the Python request.'));
            } catch (connectionError) {
                if (connectionError.number == 8007) throw connectionError;
                // A server that is still starting can refuse or reset a probe.
                // Keep polling until the startup deadline, not just one attempt.
                if (o.type == 'handshake') return null;
                throw connectionError;
            }
            sender.close();

            var start = (new Date()).getTime(),
                lastPulse = start,
                lastHeartbeat = start;
            while ((new Date()).getTime() - start < delay) {
                var now = (new Date()).getTime();
                if (longRequest && now - lastPulse >= 100) {
                    lastPulse = now;
                    if (pulseLayoutProgress() === false) throwCancelled();
                }
                if (longRequest && now - lastHeartbeat >= 1000) {
                    lastHeartbeat = now;
                    controlRequest('heartbeat', o.request_id, false);
                }

                var answer = listener.poll();
                if (answer) {
                    var parsed = null;
                    try { answer.timeout = 5; parsed = parseJSONData(answer.readln()); }
                    catch (parseError) { }
                    finally { answer.close(); }
                    if (parsed && parsed.request_id == o.request_id) {
                        received = true;
                        return parsed;
                    }
                }
                $.sleep(5);
            }
            return null;
        } catch (e) {
            if (e.number == 8007) isCancelled = true;
            throw e;
        } finally {
            try { sender.close(); } catch (e3) { }
            listener.close();
            if (longRequest && sent && !received) controlRequest('cancel', o.request_id, true);
        }
    }

    function objectToJSON(o) {
        function quote(value) {
            return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                .replace(/[\x00-\x1f\u2028\u2029]/g, function (ch) {
                    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
                }) + '"';
        }
        if (o === null || o === undefined) return 'null';
        if (typeof o == 'string') return quote(o);
        if (typeof o == 'number') {
            if (!isFinite(o)) throw new Error('Non-finite JSON number');
            return String(o);
        }
        if (typeof o == 'boolean') return String(o);
        var parts = [], i, key;
        if (o instanceof Array) {
            for (i = 0; i < o.length; i++) parts.push(objectToJSON(o[i]));
            return '[' + parts.join(',') + ']';
        }
        for (key in o) if (o.hasOwnProperty(key)) parts.push(quote(key) + ':' + objectToJSON(o[key]));
        return '{' + parts.join(',') + '}';
    }
}

function AM(target, order) {
    var s2t = stringIDToTypeID,
        t2s = typeIDToStringID,
        AR = ActionReference,
        AD = ActionDescriptor;

    target = target ? s2t(target) : null;

    this.getProperty = function (property, id, idxMode, descMode) {
        property = s2t(property);
        var r = new AR;
        r.putProperty(s2t('property'), property);
        id != undefined ? (idxMode ? r.putIndex(target, id) : r.putIdentifier(target, id)) :
            r.putEnumerated(target, s2t('ordinal'), order ? s2t(order) : s2t('targetEnum'));
        try { return descMode ? executeActionGet(r) : getDescValue(executeActionGet(r), property); } catch (e) { return false; }
    };

    this.getDescriptor = function (id, idxMode) {
        var r = new AR;
        idxMode ? r.putIndex(target, id) : r.putIdentifier(target, id);
        try { return executeActionGet(r); } catch (e) { return false; }
    };

    this.setLayerName = function (name) {
        var r = new AR, d = new AD, value = new AD;
        r.putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        d.putReference(s2t('null'), r);
        value.putString(s2t('name'), name);
        d.putObject(s2t('to'), s2t('layer'), value);
        executeAction(s2t('set'), d, DialogModes.NO);
    };

    this.descToObject = function (d) {
        var o = {};
        for (var i = 0; i < d.count; i++) {
            var k = d.getKey(i);
            o[t2s(k)] = getDescValue(d, k);
        }
        return o;
    };

    this.convertToObject = function (obj, key) {
        var d = new AD;
        switch (obj.typename) {
            case 'ActionList': d.putList(s2t(key), obj); break;
            case 'ActionDescriptor': d = obj; break;
        }
        var desc = new AD;
        desc.putObject(s2t('object'), s2t('json'), d);
        return parseJSONData(executeAction(s2t('convertJSONdescriptor'), desc).getString(s2t('json')))[key];
    };

    this.makePathFromSelection = function (tolerance) {
        var r = new AR,
            d = new AD,
            r1 = new AR;
        r.putClass(s2t('path'));
        d.putReference(s2t('null'), r);
        r1.putProperty(s2t('selectionClass'), s2t('selection'));
        d.putReference(s2t('from'), r1);
        d.putUnitDouble(s2t('tolerance'), s2t('pixelsUnit'), tolerance);
        executeAction(s2t('make'), d, DialogModes.NO);
    };

    this.deleteWorkPath = function () {
        var r = new AR,
            d = new AD;
        r.putProperty(s2t('path'), s2t('workPath'));
        d.putReference(s2t('null'), r);
        executeAction(s2t('delete'), d, DialogModes.NO);
    };

    this.hasProperty = function (property, id, idxMode) {
        property = s2t(property);
        var r = new AR;
        r.putProperty(s2t('property'), property);
        id != undefined ? (idxMode ? r.putIndex(target, id) : r.putIdentifier(target, id)) :
            r.putEnumerated(target, s2t('ordinal'), s2t('targetEnum'));
        try { return executeActionGet(r).hasKey(property); } catch (e) { return false; }
    };

    this.rasterize = function () {
        var r = new AR, d = new AD;
        r.putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        d.putReference(s2t('target'), r);
        executeAction(s2t('rasterizeLayer'), d, DialogModes.NO);
    };

    this.convertToSmartObject = function () {
        executeAction(s2t('newPlacedLayer'), undefined, DialogModes.NO);
    };

    this.editSmartObject = function () {
        executeAction(s2t('placedLayerEditContents'), undefined, DialogModes.NO);
    };

    this.flatten = function () {
        executeAction(s2t('flattenImage'), undefined, DialogModes.NO);
    };

    this.convertToRGB = function () {
        var d = new AD;
        d.putClass(s2t('to'), s2t('RGBColorMode'));
        executeAction(s2t('convertMode'), d, DialogModes.NO);
    };

    this.setScale = function (scale) {
        var d = new AD;
        d.putUnitDouble(s2t('width'), s2t('percentUnit'), scale * 100);
        d.putBoolean(s2t('scaleStyles'), true);
        d.putBoolean(s2t('constrainProportions'), true);
        d.putEnumerated(s2t('interpolation'), s2t('interpolationType'), s2t('nearestNeighbor'));
        executeAction(s2t('imageSize'), d, DialogModes.NO);
    };

    this.saveACopy = function (file) {
        var d1 = new AD,
            d = new AD;
        d1.putInteger(s2t('extendedQuality'), 6);
        d1.putEnumerated(s2t('matteColor'), s2t('matteColor'), s2t('none'));
        d.putObject(s2t('as'), s2t('JPEG'), d1);
        d.putPath(s2t('in'), file);
        d.putBoolean(s2t('copy'), true);
        executeAction(s2t('save'), d, DialogModes.NO);
    };

    this.close = function (save) {
        var d = new AD;
        d.putEnumerated(s2t('saving'), s2t('yesNo'), save === true ? s2t('yes') : s2t('no'));
        executeAction(s2t('close'), d, DialogModes.NO);
    };

    this.selectPreviousHistoryState = function () {
        var r = new AR,
            d = new AD;
        r.putEnumerated(s2t('historyState'), s2t('ordinal'), s2t('previous'));
        d.putReference(s2t('null'), r);
        executeAction(s2t('select'), d, DialogModes.NO);
    };

    this.selectLayers = function (ids) {
        var r = new AR,
            d = new AD;
        for (var a = 0; a < ids.length; a++) r.putIdentifier(s2t('layer'), ids[a]);
        d.putReference(s2t('target'), r);
        d.putBoolean(s2t('makeVisible'), false);
        executeAction(s2t('select'), d, DialogModes.NO);
    };

    this.move = function (dX, dY) {
        var r = new AR,
            d = new AD,
            d1 = new AD;
        r.putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        d.putReference(s2t('null'), r);
        d1.putUnitDouble(s2t('horizontal'), s2t('pixelsUnit'), dX);
        d1.putUnitDouble(s2t('vertical'), s2t('pixelsUnit'), dY);
        d.putObject(s2t('to'), s2t('offset'), d1);
        executeAction(s2t('move'), d, DialogModes.NO);
    };

    this.groupSelectedLayers = function (name) {
        var r = new AR,
            d = new AD,
            r1 = new AR;
        r.putClass(s2t('layerSection'));
        d.putReference(s2t('null'), r);
        r1.putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
        d.putReference(s2t('from'), r1);

        if (name != undefined) {
            var d1 = new AD;
            d1.putString(s2t('name'), name);
            d.putObject(s2t('using'), s2t('layerSection'), d1);
        }
        executeAction(s2t('make'), d, DialogModes.NO);
    };

    this.transformSelection = function (scale, offsetX, offsetY) {
        var d = new AD,
            d1 = new AD;
        offsetX = isFinite(Number(offsetX)) ? Number(offsetX) : 0;
        offsetY = isFinite(Number(offsetY)) ? Number(offsetY) : 0;
        d.putEnumerated(s2t('freeTransformCenterState'), s2t('quadCenterState'), s2t('QCSAverage'));
        d1.putUnitDouble(s2t('horizontal'), s2t('pixelsUnit'), offsetX);
        d1.putUnitDouble(s2t('vertical'), s2t('pixelsUnit'), offsetY);
        d.putObject(s2t('offset'), s2t('offset'), d1);
        d.putUnitDouble(s2t('width'), s2t('percentUnit'), scale);
        d.putUnitDouble(s2t('height'), s2t('percentUnit'), scale);
        d.putBoolean(s2t('linked'), true);
        d.putEnumerated(s2t('interfaceIconFrameDimmed'), s2t('interpolationType'), s2t('bicubic'));
        executeAction(s2t('transform'), d, DialogModes.NO);
    };

    function getDescValue(d, p) {
        switch (d.getType(p)) {
            case DescValueType.OBJECTTYPE: return { type: t2s(d.getObjectType(p)), value: d.getObjectValue(p) };
            case DescValueType.LISTTYPE: return d.getList(p);
            case DescValueType.REFERENCETYPE: return d.getReference(p);
            case DescValueType.BOOLEANTYPE: return d.getBoolean(p);
            case DescValueType.STRINGTYPE: return d.getString(p);
            case DescValueType.INTEGERTYPE: return d.getInteger(p);
            case DescValueType.LARGEINTEGERTYPE: return d.getLargeInteger(p);
            case DescValueType.DOUBLETYPE: return d.getDouble(p);
            case DescValueType.ALIASTYPE: return d.getPath(p);
            case DescValueType.CLASSTYPE: return d.getClass(p);
            case DescValueType.UNITDOUBLE: return d.getUnitDoubleValue(p);
            case DescValueType.ENUMERATEDTYPE: return { type: t2s(d.getEnumerationType(p)), value: t2s(d.getEnumerationValue(p)) };
            default: break;
        }
    }
}
