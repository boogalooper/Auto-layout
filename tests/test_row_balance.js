const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:50,progress(){},cfg:{autoRows:true,rows:4,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
function children(n){return Array.from({length:n},(_,i)=>({id:i+1,width:100,height:140}));}
function rebalance(items,counts,width=425.2,height=585.2){let index=0,specs=counts.map(count=>({items:items.slice(index,index+=count)}));ctx.balanceZoneRows(specs,counts.map((_,i)=>i),{left:0,right:width,top:0,bottom:height},1,8.4,8.4);return specs.map(s=>s.items.length);}
assert.deepEqual(rebalance(children(13),[1,4,4,4]),[3,4,3,3]);assert.deepEqual(rebalance(children(13),[3,4,4,2]),[3,4,3,3]);assert.deepEqual(rebalance(children(3),[1,1,1],100,450),[1,1,1]);
function score(counts){let center=(counts.length-1)/2-.1;return [counts.filter(c=>c==1).length,counts.reduce((s,c)=>s+c*c,0),counts.reduce((s,c,i)=>s+c*(i-center)**2,0)];}
function cmp(a,b){for(let i=0;i<3;i++)if(Math.abs(a[i]-b[i])>1e-8)return a[i]-b[i];return 0;}
function compositions(n,r){if(r==1)return [[n]];let result=[];for(let c=1;c<=n-r+1;c++)for(let rest of compositions(n-c,r-1))result.push([c,...rest]);return result;}
let checked=0;
for(let n=4;n<=12;n++)for(let r=2;r<=Math.min(n,5);r++)for(let k=0;k<3;k++){
 let items=children(n);items.forEach((x,i)=>{x.width=70+(i*17+k*3)%50;x.height=100+(i*29+k*11)%70;});let width=310+k*50,height=500+k*70;
 let feasible=compositions(n,r).filter(cs=>{let index=0,totalH=8.4*(r-1);for(let c of cs){let row=items.slice(index,index+=c);if(row.reduce((s,x)=>s+x.width,0)+8.4*(c-1)>width+1e-9)return false;totalH+=Math.max(...row.map(x=>x.height));}return totalH<=height+1e-9;});
 if(!feasible.length)continue;let winner=feasible.reduce((a,b)=>cmp(score(a),score(b))<=0?a:b),out=rebalance(items,feasible[0],width,height);assert(cmp(score(out),score(winner))==0,JSON.stringify({n,r,k,out,winner}));checked++;
}
console.log('PASS: 1/4/4/4 and 3/4/4/2 → 3/4/3/3; physically narrow singleton rows retained; '+checked+' mixed-size cases vs independent exhaustive partition oracle');
function contour(l,t,r,b){return {points:[{x:l,y:t},{x:r,y:t},{x:r,y:b},{x:l,y:b}]};}
let contours=[contour(0,0,425.2,585.2),contour(600,0,1025.2,585.2)],bounds=ctx.getContoursBounds(contours),bands=ctx.buildSelectionBandsFromContours(contours,.75),components=ctx.buildConnectedSelectionComponents(bands,.75),topology=ctx.analyzeSelectionTopology(components,bands,.75),zones=ctx.buildStableLayoutZones(bands,components,.75),geometry={bounds,contours,bands,components,yBreaks:ctx.getBandBreaks(bands),isRectangle:false,multiZone:true,componentCount:2,zoneCount:zones.length,...topology};
let items=children(26);items.forEach((x,i)=>{x.name='child'+i;x.order=i;x.centerX=50;x.centerY=70;});ctx.cfg.autoRows=false;ctx.cfg.rows=8;ctx.sourceState={layerIds:items.map(x=>x.id)};let q=ctx.buildLayoutPlan(items,geometry);ctx.validateLayoutPlan(q,geometry);
for(let z=0;z<2;z++)assert.deepEqual(q.rows.filter(r=>r.zoneIndex==z).map(r=>r.items.length),[3,4,3,3]);
// Original solver uses 14 binary probes and this case's exact capacity ceiling is scale=1.
let low=0,high=Math.min(425.2/100,585.2/140);for(let i=0;i<14;i++){let mid=(low+high)/2;if(mid<=1)low=mid;else high=mid;}assert.equal(q.commonScale,low);
console.log('PASS: complete JSX two-zone layout, 26 children/8 rows → two 3/4/3/3 groups at unchanged original scale');
