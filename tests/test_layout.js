const fs=require('fs'),vm=require('vm'),assert=require('assert');
const path=require('path').join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx');
const src=fs.readFileSync(path,'utf8');
const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:32,progress(){},cfg:{autoRows:true,rows:4,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};
vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
function items(m,f,u){return Array.from({length:m+f+u},(_,i)=>({id:i+1,name:'layer'+i,gender:i<m?'M':i<m+f?'F':'U',width:100,height:140,centerX:50,centerY:70,order:i}));}
function plan(ts,ds){let i=0;return {rows:ds.map(n=>({items:ts.slice(i,i+=n).map(gender=>({gender}))}))};}
function stats(ts,ds){return ctx.getGenderCheckerboardStats(plan(ts,ds));}
let tested=0;
for(const d of [[3,3,3],[3,4,4,3],[4,3,3,4],[4,4],[5,3],[1,1,1],[7,8,8,7]]){let N=d.reduce((a,b)=>a+b,0);for(let m=0;m<=N;m++)for(let u=0;u<=N-m;u++){let f=N-m-u,arr=items(m,f,u),out=ctx.reorderItemsForGenderCheckerboard(arr,d),before=ctx.solveGenderRowTemplates(d,m,f,u).rows.flatMap(r=>r.tokens),after=out.map(x=>x.gender),a=stats(after,d),b=stats(before,d);assert.equal(out.length,N);assert.equal(new Set(out.map(x=>x.id)).size,N);for(let sex of ['M','F','U'])assert.equal(after.filter(x=>x==sex).length,arr.filter(x=>x.gender==sex).length);assert(a.horizontalGood-a.horizontalBad>=b.horizontalGood-b.horizontalBad);assert.equal(a.known,m+f);assert(Number.isFinite(a.score));assert(a.verticalGood<=a.verticalKnown);tested++;}}
let d=[4,3,3,4],out=ctx.reorderItemsForGenderCheckerboard(items(2,12,0),d),a=stats(out.map(x=>x.gender),d);assert.equal(a.horizontalGood-a.horizontalBad,-2);
let balanced=stats(ctx.reorderItemsForGenderCheckerboard(items(8,8,0),[4,4,4,4]).map(x=>x.gender),[4,4,4,4]);assert.equal(balanced.horizontalBad,0);assert.equal(balanced.verticalScore,1);
// Actual vertical pairs must ignore U, regardless of chosen row templates.
let actual=stats(['M','U','F','M'],[2,2]);assert.equal(actual.verticalKnown,1);assert.equal(actual.verticalGood,1);
for(const bad of [{}, {sex:'M',confidence:2,analysis_status:'ok'}, {sex:'X',confidence:.9,analysis_status:'ok'}])assert(ctx.classifyPhotoAnalysisOutcome(bad).failure);
assert(!ctx.classifyPhotoAnalysisOutcome({sex:'U',confidence:.6,analysis_status:'uncertain'}).failure);
let responses=[null,null,{sex:'U',confidence:.6,analysis_status:'uncertain'},null,null,null];let api={tryInit:()=>({ok:true}),sendPayload:()=>responses.shift()},feat=new ctx.OptionalPythonFeatures(api,3);
for(let i=0;i<6;i++){feat.call('gender_image',{}, {photo:true,classify:ctx.classifyPhotoAnalysisOutcome});if(i==2)assert.equal(feat.getState().consecutiveFailures,0);}assert(feat.isDisabled());assert.equal(feat.getState().totalFailures,5);
let disabled=new ctx.OptionalPythonFeatures({tryInit:()=>({ok:false})},3);assert(!disabled.ensureReady());
// Geometry-only candidates, alignment/rhythm/fixed rows plus validation.
let geometry={isRectangle:true,multiZone:false,bounds:{left:0,top:0,right:1200,bottom:800,width:1200,height:800}};
for(let align of ['left','center','right','justify'])for(let rhythm of ['auto','centerWide','edgesWide','alternateWide','alternateNarrow'])for(let auto of [true,false]){ctx.cfg.horizontalAlign=align;ctx.cfg.rowRhythm=rhythm;ctx.cfg.autoRows=auto;let arr=items(7,7,0);ctx.sourceState={layerIds:arr.map(x=>x.id)};let p=ctx.buildLayoutPlan(arr,geometry);ctx.validateLayoutPlan(p,geometry);assert.equal(p.placements.length,14);}
console.log('PASS:',tested,'gender combinations; 40 geometry scenarios; fallbacks, invalid replies and actual statistics');
// Stress ordinary larger class, no Photoshop involved.
console.time('100 children');ctx.reorderItemsForGenderCheckerboard(items(5,90,5),[20,20,20,20,20]);console.timeEnd('100 children');
new vm.Script(src.replace(/^\uFEFF?#target photoshop\s*/,''));
function contour(l,t,r,b){return {points:[{x:l,y:t},{x:r,y:t},{x:r,y:b},{x:l,y:b}]};}
function makeGeometry(contours){let eps=.75,bounds=ctx.getContoursBounds(contours),bands=ctx.buildSelectionBandsFromContours(contours,eps),components=ctx.buildConnectedSelectionComponents(bands,eps),topology=ctx.analyzeSelectionTopology(components,bands,eps),multi=contours.length>1||bands.some(b=>b.intervals.length>1);let zones=multi?ctx.buildStableLayoutZones(bands,components,eps):[];return {bounds,contours,bands,components,yBreaks:ctx.getBandBreaks(bands),isRectangle:false,multiZone:multi,componentCount:components.length,zoneCount:zones.length,...topology};}
const shapes=[makeGeometry([{points:[{x:0,y:0},{x:1200,y:0},{x:1200,y:350},{x:600,y:350},{x:600,y:800},{x:0,y:800}]}]),makeGeometry([contour(0,0,1200,800),contour(450,250,750,550)]),makeGeometry([contour(0,0,550,800),contour(650,0,1200,800)])];
ctx.cfg.autoRows=true;ctx.cfg.rowRhythm='auto';
for(let g of shapes)for(let align of ['left','center','right','justify']){ctx.cfg.horizontalAlign=align;let arr=items(7,7,0);ctx.sourceState={layerIds:arr.map(x=>x.id)};let p=ctx.buildLayoutPlan(arr,g);try {ctx.validateLayoutPlan(p,g);} catch(e){console.log('shape',shapes.indexOf(g),align, JSON.stringify(p.placements),JSON.stringify(g.bands));throw e;}}
console.log('PASS: 12 L-shape/hole/disconnected geometry scenarios');
// Invalid plans rejected before Photoshop mutations.
ctx.cfg.horizontalAlign='center';let arr=items(2,2,0);ctx.sourceState={layerIds:arr.map(x=>x.id)};let good=ctx.buildLayoutPlan(arr,geometry),bad=JSON.parse(JSON.stringify(good));bad.placements[0].left=NaN;assert.throws(()=>ctx.validateLayoutPlan(bad,geometry));bad=JSON.parse(JSON.stringify(good));bad.placements[0].layerId=bad.placements[1].layerId;assert.throws(()=>ctx.validateLayoutPlan(bad,geometry));
// Optional semantic reorder errors keep an already valid seed; cancellation propagates.
let original=ctx.buildLayoutPlan, count=0;ctx.buildLayoutPlan=function(){if(++count>1)throw new Error('reorder failed');return original.apply(ctx,arguments);};assert(ctx.buildGenderAwareLayoutPlan(arr,geometry));count=0;ctx.buildLayoutPlan=function(){if(++count>1){let e=new Error('cancel');e.number=8007;throw e;}return original.apply(ctx,arguments);};assert.throws(()=>ctx.buildGenderAwareLayoutPlan(arr,geometry),e=>e.number==8007);ctx.buildLayoutPlan=original;
console.log('PASS: invalid plans, semantic fallback and cancellation propagation');
let randSeed=73;function random(){randSeed=(randSeed*1664525+1013904223)>>>0;return randSeed/4294967296;}
for(let k=0;k<36;k++){let g=shapes[k%3],arr=items(4,4,0);for(let item of arr){item.width=70+random()*90;item.height=110+random()*80;}ctx.sourceState={layerIds:arr.map(x=>x.id)};ctx.cfg.horizontalAlign=['left','center','right','justify'][k%4];ctx.cfg.gapX=2+random()*10;ctx.cfg.gapY=2+random()*10;let p=ctx.buildLayoutPlan(arr,g);ctx.validateLayoutPlan(p,g);}
console.log('PASS: 36 mixed-dimension shaped layouts');
