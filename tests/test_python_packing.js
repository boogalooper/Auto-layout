const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),cp=require('child_process');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:32,progress(){},cfg:{autoRows:true,rows:4,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3,pythonPacking:false},packingDisabledForRun:false,packingFallbackReason:''};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function main()')),ctx);
function contour(l,t,r,b){return {points:[{x:l,y:t},{x:r,y:t},{x:r,y:b},{x:l,y:b}]};}
function shape(contours){let bounds=ctx.getContoursBounds(contours),bands=ctx.buildSelectionBandsFromContours(contours,.75),components=ctx.buildConnectedSelectionComponents(bands,.75),topology=ctx.analyzeSelectionTopology(components,bands,.75),zones=ctx.buildStableLayoutZones(bands,components,.75);return {bounds,contours,bands,components,yBreaks:ctx.getBandBreaks(bands),isRectangle:false,multiZone:true,componentCount:components.length,zoneCount:zones.length,...topology};}
let fixtures=[];
for(let k=0;k<36;k++){
 const geometry=k%3==0?shape([contour(0,0,400,800),contour(650,100,1300,650)]):k%3==1?shape([contour(0,0,1000,800),contour(350,250,650,550)]):shape([contour(0,0,1000,300),contour(0,300,400,800)]);
 const items=Array.from({length:12},(_,i)=>({id:i+1,name:'child'+i,order:i,gender:i%2?'M':'F',headTurnValid:true,headTurn:(i%3-1)*30,colorPalette:[{lab:[i%2?20:90,0,0],weight:1}],width:75+(i*13+k*5)%45,height:110+(i*23+k*7)%45,centerX:50,centerY:70}));
 ctx.cfg.horizontalAlign=['left','center','right','justify'][k%4];ctx.cfg.autoRows=k<8;ctx.cfg.rowRhythm=k%2?'centerWide':'auto';ctx.sourceState={layerIds:items.map(x=>x.id)};
 const median=ctx.getMedianHeight(items),zones=ctx.flattenComponentZones(geometry.components),payload={items:items.map(x=>({id:x.id,width:x.width,height:x.height})),zones,baseGapX:median*.06,baseGapY:median*.06,maxGapMultiplier:3,horizontalAlign:ctx.cfg.horizontalAlign,rowRhythm:ctx.cfg.rowRhythm,rows:ctx.cfg.autoRows?0:4};
 const fallback=ctx.buildLayoutPlan(items,geometry);fixtures.push({geometry,items,zones,payload,fallback,cfg:{...ctx.cfg}});
}
const result=cp.spawnSync('python3',[path.join(__dirname,'test_zone_solver.py'),'--solve'],{input:JSON.stringify(fixtures.map(f=>f.payload)),encoding:'utf8',maxBuffer:2e6});assert.equal(result.status,0,result.stderr);let answers=JSON.parse(result.stdout),areaGains=[];
for(let k=0;k<fixtures.length;k++){
 let f=fixtures[k];Object.assign(ctx.cfg,f.cfg);ctx.sourceState={layerIds:f.items.map(x=>x.id)};
 let q=ctx.decodePythonZoneLayout(answers[k],f.items,f.geometry,f.zones,f.payload.baseGapX,f.payload.baseGapY);assert(q.pythonPacking);assert(q.commonScale+1e-8>=f.fallback.commonScale);areaGains.push((Math.pow(q.commonScale/f.fallback.commonScale,2)-1)*100);ctx.validateLayoutPlan(q,f.geometry);
 q=ctx.optimizeSemanticAssignment(q,f.geometry,true,true);q=ctx.optimizeColorAssignment(q,f.geometry,true,true,'contrast');ctx.validateLayoutPlan(q,f.geometry);assert(q.pythonPacking);
}
let f=fixtures[0];Object.assign(ctx.cfg,f.cfg,{pythonPacking:true});ctx.sourceState={layerIds:f.items.map(x=>x.id)};
let calls=0;ctx.pythonApi={tryInit:()=>({ok:true}),sendPayload(type,payload,options){calls++;assert.equal(type,'layout_zones');assert(options.longRequest);return vm.runInContext('('+JSON.stringify(answers[0])+')',ctx);}};
let q=ctx.buildLayoutPlan(f.items,f.geometry);assert(q.pythonPacking);assert.equal(calls,1);ctx.buildGenderAwareLayoutPlan(f.items,f.geometry);assert.equal(calls,2,'gender must call packing only once per build');
for(let corrupt of [a=>a.placements[0].centerX+=100,a=>a.rows[0].ids[0]=999,a=>a.commonScale=-1,a=>a.gapY=1e9,a=>a.rows[0].top=-200]){let a=structuredClone(answers[0]);corrupt(a);assert.throws(()=>ctx.decodePythonZoneLayout(a,f.items,f.geometry,f.zones,f.payload.baseGapX,f.payload.baseGapY));}
ctx.packingDisabledForRun=false;ctx.pythonApi.sendPayload=()=>({status:'fallback'});q=ctx.buildLayoutPlan(f.items,f.geometry);assert(!q.pythonPacking);assert(q.packingFallbackReason);assert.equal(q.commonScale,f.fallback.commonScale);
ctx.packingDisabledForRun=false;ctx.pythonApi.tryInit=()=>({ok:false,message:'unavailable'});q=ctx.buildLayoutPlan(f.items,f.geometry);assert(!q.pythonPacking);assert.equal(q.commonScale,f.fallback.commonScale);
ctx.packingDisabledForRun=false;ctx.pythonApi.tryInit=()=>({ok:true});ctx.pythonApi.sendPayload=()=>{let e=new Error('cancel');e.number=8007;throw e;};assert.throws(()=>ctx.buildLayoutPlan(f.items,f.geometry),e=>e.number==8007);assert(!ctx.packingDisabledForRun);
console.log('PASS: 36 genuine Python→JSX plans, split/L/hole selections, all alignments/fixed rows; scale at least JSX baseline, M/F/pose/color, coordinate validation, unavailable/invalid fallbacks and ESC');

console.log('Python vs unchanged JSX: '+areaGains.filter(x=>x>1e-5).length+'/36 strictly greater occupied photo area; min '+Math.min(...areaGains).toFixed(4)+'%, max '+Math.max(...areaGains).toFixed(4)+'%');
// Real Python geometry and pure JSX geometry use the identical new symmetry policy.
{
 const geometry=shape([contour(0,0,650,150),contour(800,0,1450,150)]);
 const children=Array.from('MMMMMMMMFFFF',(gender,i)=>({id:i+1,order:i,name:'symmetry'+i,gender,width:100,height:140,headTurnValid:false,colorPalette:[{lab:[i%3?90:10,0,0],weight:1}]}));
 Object.assign(ctx.cfg,{autoRows:false,rows:2,pythonPacking:false,horizontalAlign:'center',rowRhythm:'auto'});ctx.sourceState={layerIds:children.map(x=>x.id)};
 const zones=ctx.flattenComponentZones(geometry.components),payload={items:children.map(x=>({id:x.id,width:x.width,height:x.height})),zones,baseGapX:8.4,baseGapY:8.4,maxGapMultiplier:3,horizontalAlign:'center',rowRhythm:'auto',rows:2};
 const result=cp.spawnSync('python3',[path.join(__dirname,'test_zone_solver.py'),'--solve'],{input:JSON.stringify([payload]),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const pythonPlan=ctx.decodePythonZoneLayout(JSON.parse(result.stdout)[0],children,geometry,zones,8.4,8.4),jsxPlan=ctx.buildLayoutPlan(children,geometry);
 for(let original of [pythonPlan,jsxPlan]){
  assert.deepEqual(Array.from(original.distribution),[6,6]);
  let ordered=ctx.optimizeSemanticAssignment(original,geometry,true,false);
  assert.equal(ordered.genderCheckerboard.horizontalBad,2);assert.equal(ordered.genderCheckerboard.symmetryPenalty,0);
  for(let row of ordered.rows)assert.equal(row.items.map(x=>x.gender).join(''),'MFMMFM');
  for(let mode of ['harmonious','contrast']){
   let colored=ctx.optimizeColorAssignment(ordered,geometry,true,false,mode);ctx.validateLayoutPlan(colored,geometry);
   assert.equal(colored.genderCheckerboard.symmetryPenalty,0);assert.equal(colored.commonScale,original.commonScale);
   assert.equal(!!colored.pythonPacking,!!original.pythonPacking);
  }
 }
 console.log('PASS: real Python and JSX two-island packing -> MFMMFM in each row; both colour modes preserve symmetry and scale');
}
