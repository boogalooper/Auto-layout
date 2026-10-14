const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
function create(){
 let events=[],segments=[],cancel=null,time=0,ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:0,layoutProgressRun:null,layoutProgressWork:null,layoutProgressResult:undefined,isCancelled:false,packingDisabledForRun:false,packingFallbackReason:'',layoutPlan:null,sourceState:null,selectionGeometry:null,cfg:{alternateGender:false,considerHeadTurn:false,colorMode:'off',groupRows:false},$: {sleep(){}},alert(message){throw Error(message);}};
 ctx.Date=class { getTime(){return time;} };
 ctx.app={changeProgressText(text){events.push({kind:'text',text});},updateProgress(done,total){events.push({kind:'update',done,total});return true;},doProgressSegmentTask(weight,start,total,expression){let segment={name:ctx.layoutProgressRun.name,index:start,total,sum:0};segments.push(segment);events.push({kind:'segment',segment});vm.runInContext(expression,ctx);assert(segment.sum<=1+1e-8);return true;},doProgressTask(delta,expression){let segment=segments.at(-1);if(segment)segment.sum+=(1-segment.sum)*delta;events.push({kind:'pulse',delta,done:ctx.layoutProgressRun?.done,name:ctx.layoutProgressRun?.name});if(cancel&&cancel(ctx))return false;vm.runInContext(expression,ctx);return true;}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function throwCancelled()')),ctx);
 return {ctx,events,segments,setCancel(fn){cancel=fn;},advanceTime(ms){time+=ms;}};
}
let t=create(),c=t.ctx;c.layoutProgressRun={index:0,total:2,active:false};
c.runLayoutProgressStage('Анализ фото',()=>{c.layoutUnitProgress(2,5,'2/5');c.beginPythonProgressWait(.2,1000);for(let i=0;i<5;i++)c.pulseLayoutProgress();assert.equal(c.layoutProgressRun.done,.4);for(let i=0;i<50;i++){t.advanceTime(250);c.pulseLayoutProgress();}assert(c.layoutProgressRun.done>.4&&c.layoutProgressRun.done<.6);assert(Math.abs(t.segments[0].sum-c.layoutProgressRun.done)<1e-8);c.endPythonProgressWait();c.layoutUnitProgress(3,5,'3/5');assert.equal(c.layoutProgressRun.done,.6);c.layoutUnitProgress(5,5,'5/5');});
assert.equal(t.segments[0].sum,1);assert(t.events.some(e=>e.text?.includes('ожидание Python')));assert(!c.layoutProgressRun.active);
c.runLayoutProgressStage('Слои',()=>{assert.equal(c.layoutProgressRun.done,0);c.progress(19,'1/2');assert.equal(c.layoutProgressRun.done,.5);c.progress(8,'пересчёт');assert.equal(c.layoutProgressRun.done,.5);c.progress(30,'2/2');},8,30);assert.equal(t.segments[1].sum,1);
// Actual main + Apply keep one Transform and Move per layer inside one History.
for(let semantic of [false,true])for(let grouped of [false,true])for(let locked of [false,true]){
 t=create();c=t.ctx;c.cfg.alternateGender=semantic;c.cfg.groupRows=grouped;c.cfg.lockForAction=locked;c.actionLayoutProfile=null;
 let original={},cleanup=0,historyCalls=0,moves=0,transforms=0,selected=[1,2,3];
 let items=[1,2,3].map(id=>({id,name:'child'+id,order:id,width:10,height:20,centerX:5,centerY:10}));
 c.activeDocument={activeHistoryState:original,suspendHistory(name,expression){historyCalls++;vm.runInContext(expression,c);}};
 c.app.activeDocument=c.activeDocument;
 c.apl={getProperty:()=>1};c.buildInputPreparation=()=>null;c.collectDocumentState=()=>({layerIds:[1,2,3],originalLayerIds:[1,2,3],activeLayerId:1,originalActiveLayerId:1});c.collectSelectionGeometry=()=>({isRectangle:true});
 c.collectLayoutItems=()=>{for(let i=0;i<3;i++)c.progress(8+22*(i+1)/3,(i+1)+'/3');return items;};
 c.analyzeSemantics=()=>{c.progress(32,'3/3');return {gender:{fallbackToGeometry:true},headTurn:null,color:null};};c.refreshLayoutLayerReferences=()=>{};c.restoreLayerSelection=(ids)=>{selected=Array.from(ids);};
 c.cfg.maxGapMultiplier=3;c.cfg.horizontalAlign='center';c.cfg.rowRhythm='auto';
 c.buildLayoutPlan=()=>{c.progress(55,'Расчёт завершён');return c.finalizeLayoutRows([{items,contentWidth:30,rowHeight:20,top:50,interval:{left:100,right:180}}],2,5,2,0,{});};
 c.validateLayoutPlan=()=>{};c.validateSourceLayersBeforeApply=()=>{};c.cleanupPreviews=()=>cleanup++;c.getSelectedLayerIds=()=>selected;
 c.lr={selectLayers(ids){selected=Array.from(ids);},transformSelection(scale){assert.equal(scale,200);transforms++;},getProperty(){return {value:{left:0,top:0}};},descToObject:x=>x,move(){moves++;c.activeDocument.activeHistoryState='changed';},groupSelectedLayers(){}};
 c.main();assert.equal(cleanup,1);assert.equal(historyCalls,2);assert.equal(transforms,1);assert.equal(moves,3);assert.deepEqual(selected,[1,2,3]);assert.equal(c.layoutProgressRun.index,c.layoutProgressRun.total);assert.equal(t.segments.length,7+(grouped?1:0)+(semantic?2:0));assert(c.runSucceeded);if(locked){assert.equal(c.actionLayoutProfile.scale,2);assert.equal(c.actionLayoutProfile.gapX,10);assert.equal(c.actionLayoutProfile.gapY,4);assert(c.layoutPlan.lockedMetrics);}
 let position=t.events.filter(e=>e.kind=='pulse'&&e.name=='Позиционирование фотографий');assert(position.some(e=>Math.abs(e.done-1/3)<1e-8));assert(position.some(e=>Math.abs(e.done-2/3)<1e-8));
 // Cancel after the first real Move: rollback all changes, no further moves.
 moves=0;transforms=0;cleanup=0;historyCalls=0;c.activeDocument.activeHistoryState=original;
 t.setCancel(ctx=>ctx.layoutProgressRun.name=='Позиционирование фотографий'&&ctx.layoutProgressRun.done>=1/3);c.main();assert(c.isCancelled);assert.equal(moves,1);assert.equal(c.activeDocument.activeHistoryState,original);assert.equal(cleanup,1);assert.deepEqual(selected,[1,2,3]);assert(!c.layoutProgressRun.active);
}
console.log('PASS: native segments/counts, time-based capped Python waiting with real completion, reset/monotonic stage progress, optional stage counts, actual Apply one Transform/3 Moves/one History, ESC rollback and cleanup');
// Cancellation must report an unsuccessful rollback, rather than silently hiding it.
const rollbackAnchor=c.activeDocument.activeHistoryState, alerts=[];let changedHistory=rollbackAnchor;
Object.defineProperty(c.activeDocument,'activeHistoryState',{get(){return changedHistory;},set(value){if(value===rollbackAnchor)throw Error('history denied');changedHistory=value;}});
c.alert=message=>alerts.push(message);c.main();assert(!c.runSucceeded);assert(alerts.some(message=>message.includes('Не удалось отменить изменения документа')));
console.log('PASS: failed main rollback is visible even during ESC cancellation');
