const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
let previous=0,closed=0,assigned=[],failPrevious=false,failAnchor=false,current=1;
const anchor={},ctx={progress(){},cfg:{alternateGender:false,considerHeadTurn:true,colorMode:'off'},FIT_EPS:.02,GEOMETRY_EPS:.75,
 lr:{selectLayers(){}},app:{},doc:{getProperty:()=>current,close(){closed++;current=1;},selectPreviousHistoryState(){previous++;if(failPrevious)throw Error('previous failed');}},activeDocument:{suspendHistory(){}}};
Object.defineProperty(ctx.activeDocument,'activeHistoryState',{get:()=>anchor,set(value){assigned.push(value);if(failAnchor)throw Error('anchor failed');}});ctx.app.activeDocument=ctx.activeDocument;
vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
ctx.restoreAnalysisHistory(1,anchor,true);assert.equal(previous,1);assert.equal(assigned.length,0);
failPrevious=true;ctx.restoreAnalysisHistory(1,anchor,true);assert.equal(assigned.length,1);
current=2;ctx.restoreAnalysisHistory(1,anchor,false);assert.equal(closed,1);assert.equal(current,1);
failAnchor=true;assert.throws(()=>ctx.restoreAnalysisHistory(1,anchor,true),e=>e.autoLayoutRestoreFailure);
assert.throws(()=>ctx.createGenderPreview({id:1,name:'child'},1,anchor),e=>e.autoLayoutRestoreFailure);
// The analysis circuit breaker must never swallow failed history restoration.
failAnchor=false;let previews=0,requests=0;
ctx.pythonApi={tryInit:()=>({ok:true}),sendPayload(){requests++;}};
for(let k of ['pythonFeatures','headTurnFeatures','colorFeatures'])ctx[k]=new ctx.OptionalPythonFeatures(ctx.pythonApi,3);
ctx.createGenderPreview=()=>{previews++;let e=Error('rollback failed');e.autoLayoutRestoreFailure=true;throw e;};
assert.throws(()=>ctx.analyzeSemantics([{id:1,name:'one'},{id:2,name:'two'}]),e=>e.autoLayoutRestoreFailure);
assert.equal(previews,1);assert.equal(requests,0);assert.equal(assigned.at(-1),anchor);
// Disabled gender must not incur checkerboard calculations during pose/color search.
ctx.getGenderCheckerboardStats=()=>{throw Error('unexpected gender evaluation');};
assert.equal(ctx.getSemanticAssignmentScore({placements:[],rows:[]},{bounds:{left:0,right:100,width:100}},false,false).horizontalBad,0);
console.log('PASS: previous-state restoration, anchor fallback, nested-document close, fail-closed preview/analysis and skipped disabled gender calculations');
