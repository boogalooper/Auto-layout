const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const ctx={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:55,progress(){},cfg:{autoRows:false,rows:2,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};
vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
for(let length=3;length<=17;length++)for(let minor=1;minor*2<length-1;minor++)for(let sex of ['M','F']){
 let row={tokens:Array.from({length},(_,i)=>i<minor?sex:sex=='M'?'F':'M')};ctx.centerMinorityGenderRows([row]);
 let at=row.tokens.flatMap((t,i)=>t==sex?[i]:[]),center=(length-1)/2;assert.equal(row.tokens.slice(1).filter((t,i)=>t===row.tokens[i]).length,length-2*minor-1);
 if(length%2 || minor%2===0)assert.equal(ctx.genderRowSymmetryPenalty(row.tokens),0);assert(Math.abs(at.reduce((a,b)=>a+b,0)/minor-center)<=.5);assert(at[0]>0&&at.at(-1)<length-1);
}
const g={isRectangle:true,multiZone:false,bounds:{left:0,top:0,right:1000,bottom:800,width:1000,height:800}};
let turns=[70,20,-70,70,0,-10,-70],items=turns.map((turn,i)=>({id:i+1,name:i==1?'Konstantin':i==4?'Daniil':'child'+i,order:i,gender:'M',headTurnValid:true,headTurn:turn,width:100,height:i==4?142:140,centerX:50,centerY:70}));
ctx.sourceState={layerIds:items.map(x=>x.id)};let seed=ctx.buildRectangularLayoutCandidate(items,g,[3,4],8.4,8.4),q=ctx.optimizeSemanticAssignment(seed,g,true,true);ctx.validateLayoutPlan(q,g);assert.equal(q.rows[0].items[1].name,'Daniil');assert(q.headTurnOrdering.finalCost<q.headTurnOrdering.initialCost);assert.equal(q.commonScale,seed.commonScale);assert.equal(q.actualGapY,seed.actualGapY);assert.notEqual(q.rows[0].rowHeight,seed.rows[0].rowHeight);
// Row counts and alternation prevail; a balanced even row may choose either start.
items=[70,50,-30,-70,70,10,-20,-70].map((turn,i)=>({id:i+1,name:'child'+i,order:i,gender:i%2?'F':'M',headTurnValid:true,headTurn:turn,width:100,height:140,centerX:50,centerY:70}));ctx.sourceState={layerIds:items.map(x=>x.id)};seed=ctx.buildRectangularLayoutCandidate(items,g,[4,4],8.4,8.4);q=ctx.optimizeSemanticAssignment(seed,g,true,true);ctx.validateLayoutPlan(q,g);let stats=ctx.getGenderCheckerboardStats(q);assert.equal(stats.horizontalBad,0);for(let row of q.rows){assert.equal(row.items.filter(x=>x.gender=='M').length,2);assert.equal(row.items.filter(x=>x.gender=='F').length,2);}
// Gender-only centralization works without any body/head feature.
items=Array.from({length:5},(_,i)=>({id:i+1,name:'child'+i,order:i,gender:i==0?'M':'F',headTurnValid:false,width:100,height:140,centerX:50,centerY:70}));ctx.sourceState={layerIds:items.map(x=>x.id)};seed=ctx.buildRectangularLayoutCandidate(items,g,[5],8.4,8.4);q=ctx.optimizeSemanticAssignment(seed,g,true,false);ctx.validateLayoutPlan(q,g);assert.equal(q.rows[0].items[2].gender,'M');
console.log('PASS: symmetric minority patterns with minimum repeats, Daniil/Konstantin unequal-height cross-row swap, joint gender/head patterns, gender-only mode');
// All faces have zero yaw, but their independent lean should point inward.
items=[-10,10,0].map((lean,i)=>({id:i+1,name:'lean'+i,order:i,gender:'M',headTurnValid:true,headTurn:0,headLeanValid:true,headLean:lean,headLeanWeight:1,width:100,height:140,centerX:50,centerY:70}));ctx.sourceState={layerIds:items.map(x=>x.id)};seed=ctx.buildRectangularLayoutCandidate(items,g,[3],8.4,8.4);q=ctx.optimizeSemanticAssignment(seed,g,false,true);assert.deepEqual(q.rows[0].items.map(x=>x.headLean),[10,0,-10]);ctx.validateLayoutPlan(q,g);
for(let item of items)item.headLeanWeight=0;seed=ctx.buildRectangularLayoutCandidate(items,g,[3],8.4,8.4);q=ctx.optimizeSemanticAssignment(seed,g,false,true);assert.deepEqual(q.rows[0].items.map(x=>x.id),seed.rows[0].items.map(x=>x.id));
console.log('PASS: independent inward lean, pitch-damped lean contributes no direction when weight is zero');
