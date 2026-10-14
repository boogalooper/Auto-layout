const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:55,progress(){},cfg:{autoRows:false,rows:2,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};
vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
const g={isRectangle:true,multiZone:false,bounds:{left:0,top:0,right:1000,bottom:800,width:1000,height:800}};
function items(levels){return levels.map((level,i)=>({id:i+1,name:'child'+i,order:i,gender:i%2?'F':'M',headTurnValid:false,colorPalette:[{lab:[level,0,0],weight:1}],width:100,height:140,centerX:50,centerY:70}));}
function seed(it,counts){ctx.sourceState={layerIds:it.map(x=>x.id)};return ctx.buildRectangularLayoutCandidate(it,g,counts,8.4,8.4);}
for(let mode of ['harmonious','contrast']){
 let it=items(mode=='harmonious'?[10,90,10,90,10,90]:[10,10,10,90,90,90]),p=seed(it,[6]),q=ctx.optimizeColorAssignment(p,g,false,false,mode);
 assert(q.colorOrdering.finalCost<q.colorOrdering.initialCost);ctx.validateLayoutPlan(q,g);
 assert.equal(q.commonScale,p.commonScale);assert.equal(q.actualGapY,p.actualGapY);assert.deepEqual(q.rows.flatMap(r=>r.items.map(i=>i.id)).sort(),it.map(i=>i.id).sort());
 assert(!p.colorOrdering);
}
for(let mode of ['harmonious','contrast']){
 let it=items([10,90,90,10,10,90,90,10]),p=seed(it,[4,4]);p=ctx.optimizeSemanticAssignment(p,g,true,false);
 let before=ctx.getSemanticAssignmentScore(p,g,true,false),q=ctx.optimizeColorAssignment(p,g,true,false,mode),after=ctx.getSemanticAssignmentScore(q,g,true,false);
 assert.deepEqual(after,before);ctx.validateLayoutPlan(q,g);
 for(let r=0;r<p.rows.length;r++)assert.deepEqual(q.rows[r].items.map(i=>i.gender),p.rows[r].items.map(i=>i.gender));
}
let it=items([10,90,10,90,10,90]);it.forEach((x,i)=>{x.headTurnValid=true;x.headTurn=[70,45,10,-10,-45,-70][i];});let p=seed(it,[6]);p=ctx.optimizeSemanticAssignment(p,g,false,true);let q=ctx.optimizeColorAssignment(p,g,false,true,'contrast');assert(ctx.getSemanticAssignmentScore(q,g,false,true).head<=ctx.getSemanticAssignmentScore(p,g,false,true).head+1e-9);
let red={lab:[50,60,30],weight:.9},blue={lab:[35,20,-60],weight:.1};assert(ctx.paletteDistance([red,blue],[{...red,weight:.1},{...blue,weight:.9}])>0);assert(ctx.paletteDistance([red,blue],[red,blue])<1e-6);
assert(ctx.classifyColorOutcome({analysis_status:'ok',palette:[{lab:[200,0,0],weight:1}]}).failure);assert(!ctx.classifyColorOutcome({analysis_status:'uncertain'}).failure);
it=items([10,90]);it.forEach(x=>x.colorPalette=null);p=seed(it,[2]);q=ctx.optimizeColorAssignment(p,g,false,false,'harmonious');assert.equal(q.colorOrdering.finalCost,0);
console.log('PASS: both color objectives improve, weighted palette proportions, fixed geometry, immutable seed, unchanged M/F and pose priorities, unknown colors and invalid responses');
let previews=0,requests=[],failColor=false;
ctx.activeDocument={activeHistoryState:{},suspendHistory(){}};ctx.app={activeDocument:ctx.activeDocument};ctx.doc={getProperty:()=>1};ctx.createGenderPreview=()=>{previews++;return 'mock.jpg';};ctx.removePreview=()=>true;
ctx.pythonApi={tryInit:()=>({ok:true}),sendPayload(type,payload){requests.push({type,payload});return vm.runInContext('('+JSON.stringify(type=='gender_names'?[]:{id:payload.id,gender:{sex:'F',source:'image',confidence:.8,analysis_status:'ok'},head_turn:{analysis_status:'ok',turn:30},color:failColor?{analysis_status:'technical_failure',reason:'color_exception'}:{analysis_status:'ok',palette:[{lab:[50,0,0],weight:1}]}})+')',ctx);}};
for(let name of ['pythonFeatures','headTurnFeatures','colorFeatures'])ctx[name]=new ctx.OptionalPythonFeatures(ctx.pythonApi,3);
ctx.cfg.alternateGender=true;ctx.cfg.considerHeadTurn=true;ctx.cfg.colorMode='harmonious';it=items([0,0,0,0,0]);let result=ctx.analyzeSemantics(it);assert.equal(previews,5);assert.equal(requests.filter(r=>r.type=='analyze_image').length,5);assert.equal(result.color.known,5);assert(!result.color.fallbackToGeometry);
previews=0;requests=[];failColor=true;it=items([0,0,0,0,0]);result=ctx.analyzeSemantics(it);assert.equal(previews,5);assert(result.color.fallbackToGeometry);assert(!result.gender.fallbackToGeometry);assert(!result.headTurn.fallbackToGeometry);assert.equal(requests.filter(r=>r.type=='analyze_image'&&r.payload.color).length,3);
ctx.cfg.alternateGender=false;ctx.cfg.considerHeadTurn=false;failColor=false;previews=0;requests=[];result=ctx.analyzeSemantics(items([0,0]));assert.equal(previews,2);assert.equal(result.color.known,2);assert(requests.every(r=>r.payload.color&&!r.payload.gender&&!r.payload.head_turn));
console.log('PASS: shared previews for three features, independent color circuit breaker, color-only mode');
function contour(l,t,r,b){return {points:[{x:l,y:t},{x:r,y:t},{x:r,y:b},{x:l,y:b}]};}
function shape(contours){let bounds=ctx.getContoursBounds(contours),bands=ctx.buildSelectionBandsFromContours(contours,.75),components=ctx.buildConnectedSelectionComponents(bands,.75),topology=ctx.analyzeSelectionTopology(components,bands,.75),zones=ctx.buildStableLayoutZones(bands,components,.75);return {bounds,contours,bands,components,yBreaks:ctx.getBandBreaks(bands),isRectangle:false,multiZone:true,componentCount:components.length,zoneCount:zones.length,...topology};}
ctx.cfg.autoRows=true;
let shapes=[shape([contour(0,0,400,800),contour(900,0,1300,800)]),shape([contour(0,0,1200,800),contour(450,250,750,550)])];
for(let t=0;t<12;t++){
 it=items([10,90,30,70,10,90,30,70,10,90,30,70]);it.forEach((x,i)=>{x.width=80+(i*7+t*3)%35;x.height=120+(i*11+t)%25;x.headTurnValid=true;x.headTurn=(i%3-1)*30;});ctx.sourceState={layerIds:it.map(x=>x.id)};
 let geometry=shapes[t%2];p=ctx.buildLayoutPlan(it,geometry);p=ctx.optimizeSemanticAssignment(p,geometry,true,true);p.headTurnSummary={known:12};let signature=JSON.stringify(p);q=ctx.optimizeColorAssignment(p,geometry,true,true,t%2?'contrast':'harmonious');ctx.validateLayoutPlan(q,geometry);
 assert.equal(JSON.stringify(p),signature);assert.equal(q.commonScale,p.commonScale);assert.equal(q.actualGapY,p.actualGapY);assert.deepEqual(q.headTurnSummary,p.headTurnSummary);assert(ctx.colorPoseCompatible(q,p,geometry));assert.equal(q.genderCheckerboard.horizontalBad,p.genderCheckerboard.horizontalBad);
}
console.log('PASS: 12 variable-size disconnected/holed layouts with M/F and pose enabled; containment, metadata and immutability');
assert(ctx.paletteTone([{lab:[88,0,0],weight:.6},{lab:[20,5,10],weight:.4}]).lightness>75);assert(ctx.paletteTone([{lab:[15,0,0],weight:.45},{lab:[45,10,20],weight:.3},{lab:[60,10,20],weight:.25}]).lightness<25);
console.log('PASS: dominant garment tone prevails over secondary dark/light portrait colours');
// New modes use the same whole-sheet neighbour graph with opposite objectives.
for(let mode of ['harmonious','contrast']) {
 it=items([10,10,10,90,90,90]);p=seed(it,[3,3]);q=ctx.optimizeColorAssignment(p,g,false,false,mode);
 assert(q.colorOrdering.finalCost<=q.colorOrdering.initialCost+1e-8);ctx.validateLayoutPlan(q,g);
 if(mode==='contrast'){
  assert(q.colorOrdering.moved>0);
  assert(q.rows[0].items.some(x=>!p.rows[0].items.some(y=>y.id===x.id)),'must exchange photos across rows');
 }
}
assert(ctx.paletteTone([{lab:[50,70,0],weight:.5},{lab:[50,-70,0],weight:.5}]).chroma>60);
console.log('PASS: new whole-sheet colour objectives and exchanges across rows');
// Near-equivalent poses must no longer freeze colour. Strong inward turns stay inward.
it=items([10,10,90,90,10,10]);it.forEach((x,i)=>{x.gender='MFMMFM'[i];x.headTurnValid=true;x.headTurn=[30,26,22,-22,-26,-30][i];});
p=seed(it,[6]);q=ctx.optimizeColorAssignment(p,g,true,true,'contrast');
assert(q.colorOrdering.moved>0,'nearby poses must permit useful colour exchanges');
assert(q.colorOrdering.finalCost<q.colorOrdering.initialCost);
assert(ctx.colorPoseCompatible(q,p,g));assert(ctx.colorSemanticsCompatible(q.semanticAssignment,ctx.getSemanticAssignmentScore(p,g,true,true)));
assert.equal(q.rows[0].items.map(x=>x.gender).join(''),'MFMMFM');
let swapped={...p,rows:[{...p.rows[0],items:[...p.rows[0].items].reverse()}]};
assert(!ctx.colorPoseCompatible(swapped,p,g),'large/opposite turns are not interchangeable');
const split=shape([contour(0,0,600,160),contour(800,0,1400,160)]);
ctx.cfg.autoRows=false;ctx.cfg.rows=2;
for(let mode of ['harmonious','contrast']){
 it=items(mode==='harmonious'?[10,90,10,90,10,90]:[10,10,10,90,90,90]);ctx.sourceState={layerIds:it.map(x=>x.id)};
 p=ctx.buildLayoutPlan(it,split);assert.equal(p.rows.length,2);
 q=ctx.optimizeColorAssignment(p,split,false,false,mode);ctx.validateLayoutPlan(q,split);
 assert(q.colorOrdering.finalCost<q.colorOrdering.initialCost,mode);
 assert(q.rows[0].items.some(x=>!p.rows[0].items.some(y=>x.id===y.id)),mode+' must exchange across islands');
 assert.equal(q.commonScale,p.commonScale);
}
console.log('PASS: useful colour exchanges with nearby poses, strong-turn protection, symmetry preserved; both modes exchange across disconnected selection islands');
// Large sheets must consider every photo, not stop after one 80-slot sample.
it=items(Array.from({length:96},(_,i)=>i));p=seed(it,[24,24,24,24]);
const rebuild=ctx.rebuildAssignedLayout,seen=new Set();
ctx.rebuildAssignedLayout=(base,geometry,rows)=>{
 rows.forEach((row,r)=>row.forEach((item,c)=>{if(item.id!==base.rows[r].items[c].id)seen.add(item.id);}));return null;
};
q=ctx.optimizeColorAssignment(p,g,false,false,'contrast');ctx.rebuildAssignedLayout=rebuild;
assert.equal(seen.size,96);assert.equal(q.colorOrdering.moved,0);
console.log('PASS: all 96 selected photos participate in the bounded global colour search');
