const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
const c={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:55,progress(){},cfg:{autoRows:false,rows:1,rowRhythm:'auto',horizontalAlign:'center',gapX:6,gapY:6,maxGapMultiplier:3}};
vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function main()')),c);
function score(t){return [t.slice(1).filter((v,i)=>v===t[i]).length,c.genderRowSymmetryPenalty(t),c.minorityCenterPenalty(t)];}
function less(a,b){for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]<b[i];}return false;}
let cases=0;
for(let n=2;n<=12;n++)for(let m=1;m<n;m++){
 if(Math.abs(2*m-n)<=1)continue;
 let best=null;
 for(let mask=0;mask<2**n;mask++){
  let t=Array.from({length:n},(_,i)=>mask&(1<<i)?'M':'F');if(t.filter(x=>x==='M').length!==m)continue;
  let s=score(t);if(!best||less(s,best))best=s;
 }
 let t=c.symmetricKnownGenderTokens(m,n-m);assert.deepEqual(score(t),best,JSON.stringify({n,m,t}));cases++;
}
assert.equal(c.solveKnownGenderAllocation([6],4,2).rows[0].tokens.join(''),'MFMMFM');
assert.equal(c.solveKnownGenderAllocation([6],2,4).rows[0].tokens.join(''),'FMFFMF');
const g={isRectangle:true,bounds:{left:0,top:0,right:1200,bottom:700,width:1200,height:700}};
for(let genders of ['MFMFMM','FMFMFF','MMMFMMMM','MFMUMMM'])for(let head of [false,true]){
 let items=Array.from(genders,(gender,i)=>({id:i+1,order:i,gender,width:100,height:140,headTurnValid:head,headTurn:(i-(genders.length-1)/2)*-8}));c.sourceState={layerIds:items.map(x=>x.id)};
 let p=c.buildRectangularLayoutCandidate(items,g,[items.length],8.4,8.4),q=c.optimizeSemanticAssignment(p,g,true,head);
 c.validateLayoutPlan(q,g);assert.equal(q.commonScale,p.commonScale);
 if(genders==='MFMFMM')assert.equal(q.rows[0].items.map(x=>x.gender).join(''),'MFMMFM');
 if(genders==='FMFMFF')assert.equal(q.rows[0].items.map(x=>x.gender).join(''),'FMFFMF');
 assert(q.semanticAssignment.symmetry<=c.getSemanticAssignmentScore(p,g,true,head).symmetry);
}
console.log('PASS:',cases,'count combinations checked against exhaustive row permutations; final semantic optimizer preserves symmetry with/without pose, unknowns and scale');
