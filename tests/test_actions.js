const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
assert(src.includes('<eventid>4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a</eventid>'));assert(src.includes('/inAction [(action settings) /boolean]'));
class D{constructor(){this.data={};}get count(){return Object.keys(this.data).length;}hasKey(k){return k in this.data;}getKey(i){return Object.keys(this.data)[i];}getType(k){return this.data[k].type;}getString(k){return new String(this.data[k].value);}getDouble(k){return this.data[k].value;}getInteger(k){return this.data[k].value;}getBoolean(k){return this.data[k].value;}putString(k,v){this.data[k]={type:2,value:v};}putDouble(k,v){this.data[k]={type:3,value:v};}putBoolean(k,v){this.data[k]={type:1,value:v};}}
let prefs=new D(),reports=0,dialogs=0,jobs=0,cancel=false;
const c={UUID:'4f33f0a7-2e8f-4b6d-9ec0-61d98a44f99a',FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:32,progress(){},layoutProgressRun:null,actionLayoutProfile:null,actionPlayback:false,runSucceeded:false,isCancelled:false,ActionDescriptor:D,DescValueType:{BOOLEANTYPE:1,STRINGTYPE:2,DOUBLETYPE:3,INTEGERTYPE:4},DialogModes:{ALL:1,NO:2},app:{playbackParameters:new D(),playbackDisplayDialogs:2,stringIDToTypeID:s=>s,typeIDToStringID:s=>s,getCustomOptions:()=>prefs,putCustomOptions(id,d){prefs=d;},doProgress(name,code){vm.runInContext(code,c);}}};
vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function main()')),c);c.cfg=new c.Config();c.cfg.autoRows=true;c.cfg.horizontalAlign='center';
function children(n){return Array.from({length:n},(_,i)=>({id:i+1,name:'child'+i,order:i,gender:i%2?'F':'M',headTurnValid:true,headTurn:(i%3-1)*20,colorPalette:[{lab:[i%2?20:90,0,0],weight:1}],width:100,height:140,centerX:50,centerY:70}));}
function contour(l,t,r,b){return {points:[{x:l,y:t},{x:r,y:t},{x:r,y:b},{x:l,y:b}]};}
function shape(contours){let bounds=c.getContoursBounds(contours),bands=c.buildSelectionBandsFromContours(contours,.75),components=c.buildConnectedSelectionComponents(bands,.75),topology=c.analyzeSelectionTopology(components,bands,.75),zones=c.buildStableLayoutZones(bands,components,.75);return {bounds,contours,bands,components,yBreaks:c.getBandBreaks(bands),isRectangle:false,multiZone:true,componentCount:components.length,zoneCount:zones.length,...topology};}
const rect={isRectangle:true,multiZone:false,bounds:{left:0,top:0,right:1000,bottom:800,width:1000,height:800}},split=shape([contour(0,0,425.2,585.2),contour(600,0,1025.2,585.2)]),hole=shape([contour(0,0,1000,800),contour(400,200,600,450)]);
let fixture;
for(let g of [rect,split,hole])for(let align of ['center','justify']){
 c.cfg.lockForAction=false;c.cfg.horizontalAlign=align;c.actionLayoutProfile=null;let n=g==split?26:20,it=children(n);c.sourceState={layerIds:it.map(x=>x.id)};let p=c.buildLayoutPlan(it,g);
 c.cfg.lockForAction=true;c.actionLayoutProfile=c.profileFromLayout(p);p=c.freezeLayoutMetrics(p,g);c.validateLayoutPlan(p,g);let profile={...c.actionLayoutProfile};assert.equal(p.commonScale,profile.scale);for(let row of p.rows)if(row.items.length>1)assert.equal(row.gapX,profile.gapX);
 c.cfg.putScriptSettings(false);assert(!prefs.hasKey('lockedScale'),'actual metrics must not leak into global preferences');c.cfg.putScriptSettings(true);let recorded=c.app.playbackParameters;assert(c.hasLayoutActionParameters(recorded));assert.equal(recorded.getDouble('lockedScale'),profile.scale);
 c.cfg=new c.Config();c.cfg.getScriptSettings(true);c.actionLayoutProfile=c.readLockedActionProfile(recorded);
 for(let count of [Math.max(4,n-8),n-3,n]){
  it=children(count);c.sourceState={layerIds:it.map(x=>x.id)};let q=c.buildLayoutPlan(it,g);c.validateLayoutPlan(q,g);assert.equal(q.commonScale,profile.scale);assert.equal(q.actualGapY,profile.gapY);for(let row of q.rows)if(row.items.length>1)assert.equal(row.gapX,profile.gapX);
  q=c.optimizeSemanticAssignment(q,g,true,true);q=c.optimizeColorAssignment(q,g,true,true,'darkToLight');c.validateLayoutPlan(q,g);assert.equal(q.commonScale,profile.scale);assert.equal(q.actualGapY,profile.gapY);for(let row of q.rows)if(row.items.length>1)assert.equal(row.gapX,profile.gapX);
 }
 it=children(100);c.sourceState={layerIds:it.map(x=>x.id)};assert.throws(()=>c.buildLayoutPlan(it,g),/не помещаются/);
 fixture={plan:p,profile,recorded};
}
// Dispatcher: action playback ignores global preferences, edit mode changes no document.
c.dialog=editing=>({show(){dialogs++;assert.equal(editing,c.actionPlayback&&c.app.playbackDisplayDialogs==1);return cancel?2:1;}});c.showReport=()=>reports++;
c.main=()=>{jobs++;c.runSucceeded=true;c.layoutPlan=fixture.plan;c.selectionGeometry=rect;if(c.cfg.lockForAction&&!c.actionLayoutProfile)c.actionLayoutProfile=fixture.profile;};
c.app.playbackParameters=fixture.recorded;c.app.playbackDisplayDialogs=2;c.cfg=new c.Config();c.runAutoLayoutEntry();assert.equal(jobs,1);assert.equal(dialogs,0);assert.equal(reports,0);assert(c.cfg.lockForAction);
c.app.playbackDisplayDialogs=1;c.cfg=new c.Config();c.runAutoLayoutEntry();assert.equal(jobs,1);assert.equal(dialogs,1);
let missing=new D();missing.putBoolean('inAction',true);missing.putBoolean('lockForAction',true);c.app.playbackParameters=missing;c.app.playbackDisplayDialogs=2;c.cfg=new c.Config();assert.throws(()=>c.runAutoLayoutEntry(),/нет корректного/);assert.equal(jobs,1);
c.app.playbackParameters=new D();c.cfg=new c.Config();c.runAutoLayoutEntry();assert.equal(dialogs,2);assert.equal(jobs,2);assert.equal(reports,0);assert(c.hasLayoutActionParameters(c.app.playbackParameters));
c.app.playbackParameters=new D();cancel=true;c.cfg=new c.Config();c.runAutoLayoutEntry();assert(c.isCancelled);assert.equal(jobs,2);
console.log('PASS: Photoshop action resource/marker, config vs action descriptors, actual frozen scale/uniform gaps across counts/rect/split/hole/justify, semantic preservation, overflow fails, silent playback/edit/cancel/missing profile lifecycle');

c.app.playbackParameters=new D();cancel=false;c.isCancelled=false;c.cfg=new c.Config();c.main=()=>{jobs++;c.runSucceeded=false;};c.runAutoLayoutEntry();assert(c.isCancelled);assert.equal(c.app.playbackParameters.count,0,'failed recording must not publish stale metrics');
console.log('PASS: failed recording cannot write an action profile');
