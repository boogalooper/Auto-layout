const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const c={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:55,progress(){},cfg:{autoRows:false,rows:2,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};
vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function main()')),c);
const g={isRectangle:true,bounds:{left:0,top:0,right:1200,bottom:800,width:1200,height:800}};
let items=Array.from('FMFMFMMM MFFF'.replace(/ /g,''),(gender,i)=>({id:i+1,order:i,name:'child'+i,gender,genderSource:'name',width:100,height:140,headTurnValid:true,headTurn:(i%6-2.5)*-20,colorPalette:[{lab:[i%2?90:10,i%3*30,0],weight:1}]}));
c.sourceState={layerIds:items.map(i=>i.id)};let p=c.buildRectangularLayoutCandidate(items,g,[6,6],8.4,8.4);
let repaired=c.optimizeSemanticAssignment(p,g,true,true);assert.equal(c.getGenderCheckerboardStats(repaired).horizontalBad,0);
for(let mode of ['lightToDark','darkToLight','vividToMuted','mutedToVivid','contrast']){
 let q=c.optimizeColorAssignment(repaired,g,true,true,mode);assert.equal(c.getGenderCheckerboardStats(q).horizontalBad,0);assert(c.getSemanticAssignmentScore(q,g,true,true).vertical>=c.getSemanticAssignmentScore(repaired,g,true,true).vertical);
}
// Old direction profiles consistently migrate to harmonious neighbourhoods.
for(let mode of ['lightToDark','darkToLight','vividToMuted','mutedToVivid']) assert.equal(c.normalizeColorMode(mode),'harmonious');
c.pythonFeatures={getState:()=>({disabled:true})};let summary=c.finalizeGenderSummary(items,true);assert(!summary.fallbackToGeometry);
c.colorFeatures={getState:()=>({disabled:true})};assert(!c.finalizeColorSummary(items,true).fallbackToGeometry);
// Temporary path history restores selection and existing Work Path on success and exception.
let original={selection:'exact pixels',path:'existing Work Path'},state=original,historyCount=0;
c.activeDocument={get activeHistoryState(){return state;},set activeHistoryState(value){state=value;},suspendHistory(name,expression){historyCount++;vm.runInContext(expression,c);}};c.app={activeDocument:c.activeDocument};
c.collectSelectionGeometry=()=>{state={selection:'changed',path:'temporary'};return g;};assert.equal(c.collectSelectionGeometryWithHistory(),g);assert.equal(state,original);assert.equal(historyCount,1);
c.collectSelectionGeometry=()=>{state={path:'temporary'};throw Error('path cancelled');};assert.throws(()=>c.collectSelectionGeometryWithHistory());assert.equal(state,original);
assert(!src.includes('.currentHistoryState'));
let text='';c.app.changeProgressText=value=>text=value;c.layoutProgressRun={index:3,name:'Анализ фотографий',detail:'Фото 26/26',waiting:false,done:.9};c.renderLayoutProgress();assert(text.length<60);assert(!text.includes('Екатерина'));
console.log('PASS: screenshot M/M/M/F/F/F repair with pose+all color modes, opposite near-equal tone directions, retained partial analysis, selection/Work Path history success/cancel and short progress');

c.layoutProgressRun.waiting=true;c.renderLayoutProgress();assert(!text.includes('~'));assert(text.includes('ожидание Python'));
console.log('PASS: Python wait percentage has no tilde');
