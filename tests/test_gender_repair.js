const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:55,progress(){},cfg:{autoRows:false,rows:2,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function main()')),ctx);
const g={isRectangle:true,multiZone:false,bounds:{left:0,top:0,right:1000,bottom:1000,width:1000,height:1000}};
function items(m,f,valid){return Array.from({length:m+f},(_,i)=>({id:i+1,name:'child'+i,order:i,gender:i<m?'M':'F',headTurnValid:valid,headTurn:0,width:100,height:140,centerX:50,centerY:70}));}
function oracle(distribution,m){let dp=new Map([[0,0]]);for(let len of distribution){let next=new Map();for(let [used,cost] of dp)for(let k=0;k<=len;k++){let n=used+k;if(n>m)continue;let bad=Math.max(0,Math.abs(2*k-len)-1);next.set(n,Math.min(next.get(n)??Infinity,cost+bad));}dp=next;}return dp.get(m);}
let count=0;
for(let d of [[4],[2,2],[3,3],[4,3,3,4],[3,4,4,3],[5,6,5,5]])for(let m=0;m<=d.reduce((a,b)=>a+b);m++){
 let N=d.reduce((a,b)=>a+b),arr=items(m,N-m,false),ordered=ctx.reorderItemsForGenderCheckerboard(arr,d),offset=0,rows=d.map(n=>({items:ordered.slice(offset,offset+=n)})),stats=ctx.getGenderCheckerboardStats({rows});assert.equal(stats.horizontalBad,oracle(d,m),JSON.stringify({d,m}));count++;
}
for(let valid of [false,true])for(let head of [false,true]){
 let arr=items(2,2,valid);ctx.sourceState={layerIds:arr.map(x=>x.id)};let seed=ctx.buildRectangularLayoutCandidate(arr,g,[2,2],8.4,8.4),q=ctx.optimizeSemanticAssignment(seed,g,true,head);ctx.validateLayoutPlan(q,g);assert.equal(ctx.getGenderCheckerboardStats(q).horizontalBad,0);assert.equal(q.rows[0].items.filter(x=>x.gender=='M').length,1);assert.equal(q.rows[1].items.filter(x=>x.gender=='M').length,1);
 seed=ctx.buildRectangularLayoutCandidate(arr,g,[4],8.4,8.4);q=ctx.optimizeSemanticAssignment(seed,g,true,head);assert.equal(ctx.getGenderCheckerboardStats(q).horizontalBad,0);
}
// Realistic 21-child counts: minimal unavoidable repetition is one, not two.
let arr=items(13,8,false),ordered=ctx.reorderItemsForGenderCheckerboard(arr,[5,6,5,5]),offset=0;assert.equal(ctx.getGenderCheckerboardStats({rows:[5,6,5,5].map(n=>({items:ordered.slice(offset,offset+=n)}))}).horizontalBad,1);
console.log('PASS:',count,'global quota cases vs independent minimum-repeat oracle; MM/DD between rows and MMDD within row repaired with/without pose; 21-child imbalance');
