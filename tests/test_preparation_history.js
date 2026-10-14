const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
function run(groupRows,cancelStage=null,changedSize=false,semantic=false,mixed=false){
 const originalLayers=[{id:10,kind:7,name:'source group',children:[8,9],left:10,top:10,width:100,height:160},{id:8,kind:1,name:'photo',left:10,top:10,width:100,height:140},{id:9,kind:3,name:'caption',left:10,top:150,width:100,height:20},{id:30,kind:1,name:'photo2',left:150,top:10,width:100,height:140},{id:31,kind:3,name:'caption2',left:150,top:150,width:100,height:20}];
 if(mixed)originalLayers.push({id:99,kind:1,name:'plain photo',left:300,top:10,width:100,height:160});
 let layers=structuredClone(originalLayers),selected=[10,30,31],active=31,nextId=1000,history=null,historyName='',events=[],alerts=[],moves=0,transforms=0,cleanup=0,renames=[];
 const c={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:0,layoutProgressRun:null,layoutProgressWork:null,layoutProgressResult:undefined,isCancelled:false,cfg:{alternateGender:semantic,considerHeadTurn:semantic,colorMode:semantic?'lightToDark':'off',groupRows,lockForAction:true,maxGapMultiplier:3,horizontalAlign:'center',rowRhythm:'auto'},$: {sleep(){}},alert(message){alerts.push(message);}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function throwCancelled()')),c);
 if(mixed)selected.push(99);
 const originalSelected=[...selected];
 const snapshot=()=>({layers:structuredClone(layers),selected:[...selected],active});
 const original=snapshot();history=original;
 function find(id){return layers.find(l=>l.id==id);}function descendants(id){let l=find(id),out=[id];for(let child of l?.children||[])out.push(...descendants(child));return out;}
 c.activeDocument={get activeHistoryState(){return history;},set activeHistoryState(value){layers=structuredClone(value.layers);selected=[...value.selected];active=value.active;history=value;},suspendHistory(name,expression){historyName=name;events.push(name);vm.runInContext(expression,c);history=snapshot();}};
 c.app={activeDocument:c.activeDocument,changeProgressText(){},updateProgress(){return true;},doProgressSegmentTask(w,start,total,expression){vm.runInContext(expression,c);return true;},doProgressTask(delta,expression){if(cancelStage&&c.layoutProgressRun.name==cancelStage&&c.layoutProgressRun.done>=.5)return false;vm.runInContext(expression,c);return true;}};
 c.apl={getProperty:()=>1};c.collectDocumentState=()=>({layerIds:[...originalSelected],originalLayerIds:[...originalSelected],activeLayerId:31,originalActiveLayerId:31});
 const members=(ids)=>ids.map(id=>({...find(id),locking:{},parentId:null,itemIndex:id,links:[],text:id==9?'Иванов Иван':id==31?'Петров Пётр':'',section:id==10?'layerSectionStart':'layerSectionContent'}));
 c.buildInputPreparation=()=>({units:[{roots:members([31,30]),members:members([31,30]),convert:true,name:'Петров Пётр'},{roots:members([10]),members:members([10,8,9]),convert:true,name:'Иванов Иван'}]});
 if(mixed){let build=c.buildInputPreparation;c.buildInputPreparation=()=>{let p=build();p.units.push({roots:members([99]),members:members([99]),convert:false,name:'plain photo'});return p;};}
 c.collectSelectionGeometry=()=>({isRectangle:true,bounds:{left:0,top:0,right:900,bottom:500,width:900,height:500}});
 c.getSelectedLayerIds=()=>[...selected];c.restoreLayerSelection=(ids,id)=>{assert(ids.every(i=>find(i)));selected=[...ids];active=id;};
 c.lr={selectLayers(ids){assert(ids.every(i=>find(i)));selected=[...ids];active=ids[0];},getProperty(key,id=active){const l=find(id);if(!l)return false;if(key=='layerID')return l.id;if(key=='layerKind')return l.kind;if(key=='name')return l.name;if(key=='itemIndex')return layers.indexOf(l)+1;if(key=='background')return false;if(key=='layerLocking')return {value:{}};if(key=='boundsNoEffects')return {value:{left:l.left,top:l.top,right:l.left+l.width,bottom:l.top+l.height}};},descToObject:x=>x,
 groupSelectedLayers(name){assert.equal(name,undefined);let selectedLayers=selected.map(find),id=nextId++;layers.push({id,kind:7,name:'Group '+id,children:[...selected],left:Math.min(...selectedLayers.map(l=>l.left)),top:Math.min(...selectedLayers.map(l=>l.top)),width:Math.max(...selectedLayers.map(l=>l.left+l.width))-Math.min(...selectedLayers.map(l=>l.left)),height:Math.max(...selectedLayers.map(l=>l.top+l.height))-Math.min(...selectedLayers.map(l=>l.top))});selected=[id];active=id;},
 convertToSmartObject(){const l=find(active),ids=descendants(active),id=nextId++,copy={...l,id,kind:5,children:undefined};if(changedSize&&historyName=='Auto layout')copy.width+=5;layers=layers.filter(n=>!ids.includes(n.id));layers.push(copy);active=id;selected=[id];},setLayerName(name){find(active).name=name;renames.push(name);},
 transformSelection(scale){transforms++;selected.forEach(id=>{let l=find(id);l.width*=scale/100;l.height*=scale/100;});},move(x,y){moves++;let l=find(active);l.left+=x;l.top+=y;}};
 c.validateSourceLayersBeforeApply=()=>{assert(c.sourceState.layerIds.every(id=>[1,5].includes(find(id)?.kind)));assert(c.layoutPlan.placements.every(p=>c.sourceState.layerIds.includes(p.layerId)));};
 c.buildLayoutPlan=items=>c.finalizeLayoutRows([{items,contentWidth:100*items.length,rowHeight:160,top:20,interval:{left:0,right:900}}],2,5,5,0,{});
 c.analyzeSemantics=items=>{items.forEach((item,i)=>{item.gender=i%2?'F':'M';item.genderSource='name';item.headTurnValid=true;item.headTurn=i%2?-40:40;item.colorPalette=[{lab:[i%2?90:20,0,0],weight:1}];});return {gender:{fallbackToGeometry:false},headTurn:{fallbackToGeometry:false},color:{fallbackToGeometry:false}};};
 c.cleanupPreviews=()=>cleanup++;
 c.main();
 assert.equal(cleanup,1);
 if(cancelStage||changedSize){assert(!c.runSucceeded);assert.deepEqual(layers,originalLayers);assert.deepEqual(selected,originalSelected);if(changedSize)assert(alerts.some(a=>a.includes('Повторная подготовка')));else assert(c.isCancelled);}
 else {assert(c.runSucceeded,JSON.stringify(alerts));assert.equal(transforms,1);assert.equal(moves,mixed?3:2);assert.equal(renames.length,4);assert.deepEqual(renames,['Петров Пётр','Иванов Иван','Петров Пётр','Иванов Иван']);assert(selected.every(id=>[1,5].includes(find(id).kind)));assert(c.layoutPlan.placements.every(p=>p.layerId>=1003||mixed&&p.layerId==99));assert.equal(c.layoutProgressRun.index,c.layoutProgressRun.total);assert(c.layoutPlan.lockedMetrics);
  // One user Undo returns original groups, linked text/photo layers and selection.
  c.activeDocument.activeHistoryState=original;assert.deepEqual(layers,originalLayers);assert.deepEqual(selected,originalSelected);
 }
 return {events,moves,transforms};
}
run(false);run(true);run(false,null,false,true);run(true,null,false,true);run(false,null,false,true,true);
for(let stage of ['Подготовка объектов для анализа','Подготовка итоговых объектов','Позиционирование фотографий'])run(false,stage);
run(false,null,true);
console.log('PASS: actual main/preparation/final commit, text names, new ID remapping, uniform scale/frozen action profile, unnamed row groups, cancellation in both conversions/Move, size-change rejection and single-operation Undo model');
