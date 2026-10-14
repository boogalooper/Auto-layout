const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const c={FIT_EPS:.02,GEOMETRY_EPS:.75,OPTIONAL_PYTHON_EMPTY_LIMIT:3,packingDisabledForRun:false,packingFallbackReason:'',currentProgressValue:30,progress(){},cfg:{alternateGender:true,considerHeadTurn:true,colorMode:'lightToDark'},activeDocument:{activeHistoryState:{},suspendHistory(){}},doc:{getProperty:()=>1}};
vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function main()')),c);c.app={activeDocument:c.activeDocument};c.createGenderPreview=()=> 'mock.jpg';c.removePreview=()=>true;
let requests=0;c.pythonApi={tryInit:()=>({ok:true}),sendPayload(type,payload){if(type=='gender_names')return vm.runInContext('[]',c);requests++;let found=payload.id==6;return vm.runInContext('('+JSON.stringify({id:payload.id,gender:{sex:found?'F':'U',source:found?'image':'unknown',confidence:found?.9:0,reason:found?'face_classifier':'face_not_found',analysis_status:found?'ok':'not_applicable'},head_turn:found?{analysis_status:'ok',turn:25,reason:'head_pose'}:{analysis_status:'not_applicable',reason:'face_not_found'},color:found?{analysis_status:'ok',palette:[{lab:[70,0,0],weight:1}]}:{analysis_status:'uncertain',reason:'face_not_found',palette:[]}})+')',c);}};
for(let key of ['pythonFeatures','headTurnFeatures','colorFeatures'])c[key]=new c.OptionalPythonFeatures(c.pythonApi,3);
let items=Array.from({length:6},(_,i)=>({id:i+1,name:'frame '+(i+1)}));let result=c.analyzeSemantics(items);assert.equal(requests,3);assert.equal(items[5].gender,'U');assert(!items[5].headTurnValid);assert(!items[5].colorPalette);assert.equal(result.gender.unknown,6);
assert(c.semanticImageAnalysisDisabledForRun);assert.equal(c.semanticImageEmptyStreak,3);assert(c.packingDisabledForRun);assert(/последовательных/.test(c.semanticImageFallbackReason));
for(let key of ['pythonFeatures','headTurnFeatures','colorFeatures']){assert(!c[key].isDisabled());assert.equal(c[key].getState().photoFailures,0);}
console.log('PASS: three consecutive valid-but-empty photo analyses stop further Python image analysis and Python packing');

requests=0;c.packingDisabledForRun=false;c.packingFallbackReason='';
c.pythonApi={tryInit:()=>({ok:true}),sendPayload(type,payload){
  if(type=='gender_names')return vm.runInContext('('+JSON.stringify([{id:1,sex:'M',source:'name',confidence:1,reason:'dictionary',analysis_status:'ok'}])+')',c);
  requests++;return vm.runInContext('('+JSON.stringify({id:payload.id,gender:{sex:'U',source:'unknown',confidence:0,reason:'face_not_found',analysis_status:'not_applicable'},head_turn:{analysis_status:'not_applicable',reason:'face_not_found'},color:{analysis_status:'uncertain',reason:'face_not_found',palette:[]}})+')',c);
}};
for(let key of ['pythonFeatures','headTurnFeatures','colorFeatures'])c[key]=new c.OptionalPythonFeatures(c.pythonApi,3);
items=Array.from({length:5},(_,i)=>({id:i+1,name:'frame '+(i+1)}));result=c.analyzeSemantics(items);
assert.equal(requests,3);assert.equal(items[0].gender,'M');assert.equal(items[0].genderSource,'name');assert.equal(result.gender.male,1);assert(!result.gender.fallbackToGeometry);assert(c.packingDisabledForRun);
console.log('PASS: a gender already resolved from the layer name survives the no-photo-data fallback; subsequent placement can use it in JSX');
