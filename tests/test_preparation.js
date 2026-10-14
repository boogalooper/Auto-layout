const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
function node(id,kind=1,parentId=null,extra={}){return {id,name:'layer'+id,kind,parentId,itemIndex:id,section:kind==7?'layerSectionStart':'layerSectionContent',children:[],links:[],text:'',clipped:false,background:false,locking:{},blendMode:'normal',...extra};}
function tree(nodes){let byId={};nodes.forEach(n=>{byId[n.id]=n;n.children=[];});nodes.forEach(n=>{if(n.parentId!=null)byId[n.parentId].children.push(n);});return {nodes,byId,roots:nodes.filter(n=>n.parentId==null)};}
const c={FIT_EPS:.02,GEOMETRY_EPS:.75,currentProgressValue:0,progress(){},cfg:{}};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function main()')),c);
let data=tree([node(10,7,null),node(8,1,10),node(9,3,10,{text:'Иванов Иван'}),node(30,1,null,{links:[31]}),node(31,3,null,{links:[30],text:'Петров Пётр'})]);
let p=c.planInputPreparation(data,[10,8,30,31]);assert.equal(p.units.length,2);assert.deepEqual(p.units.map(u=>u.name),['Петров Пётр','Иванов Иван']);assert(p.units.every(u=>u.convert));
// Links from inside a selected group include the external partner exactly once.
data=tree([node(10,7),node(8,1,10,{links:[30]}),node(9,3,10,{text:'Анна'}),node(30,1,null,{links:[8]})]);p=c.planInputPreparation(data,[10,30]);assert.equal(p.units.length,1);assert.deepEqual(p.units[0].roots.map(n=>n.id),[30,10]);
// Independent nested selected groups get absorbed by the selected ancestor.
data=tree([node(40,7),node(30,7,40),node(28,3,30,{text:'Мария'}),node(29,1,30)]);p=c.planInputPreparation(data,[28,30,40]);assert.equal(p.units.length,1);assert.deepEqual(p.units[0].roots.map(n=>n.id),[40]);
data=tree([node(10,7),node(8,1,10,{links:[30]}),node(40,7),node(30,1,40,{links:[8]})]);assert.throws(()=>c.planInputPreparation(data,[8]),/родительских/);
data=tree([node(10,1,null,{links:[11],clipped:true}),node(11,3,null,{links:[10],text:'Иван'}),node(9,1)]);assert.throws(()=>c.planInputPreparation(data,[10]),/обтравки/);
data=tree([node(10,7,null,{blendMode:'passThrough'}),node(8,1,10),node(9,2,10)]);assert.throws(()=>c.planInputPreparation(data,[10]),/Коррекция/);data.byId[10].blendMode='normal';assert(c.planInputPreparation(data,[10]));
data=tree([node(4,4)]);assert.equal(c.planInputPreparation(data,[4]).units[0].convert,false);data.byId[4].locking.protectAll=true;assert.throws(()=>c.planInputPreparation(data,[4]),/заблокированный/);
c.lr={getProperty(k,id){if(k=='name')return 'shape';if(k=='layerKind')return 4;if(k=='background')return false;if(k=='layerLocking')return null;if(k=='boundsNoEffects')return {value:{left:10,top:20,right:110,bottom:220}};if(k=='itemIndex')return 7;},descToObject:v=>v};let shapeItems=c.collectLayoutItems([4]);assert.equal(shapeItems.length,1);assert.equal(shapeItems[0].width,100);assert.equal(shapeItems[0].height,200);
// Descriptor traversal: one bulk read per palette index, nesting/background,
// both integer/reference links and textKey content; no DOM layer access.
const records=[node(0,1),{section:'layerSectionEnd'},node(2,1,null,{links:[7]}),{section:'layerSectionEnd'},node(4,3,null,{text:'  Иванов\rИван  '}),node(5,7),node(6,7),node(7,1,null,{links:[2]})];
class D{constructor(n){this.n=n;}hasKey(k){return k=='layerSection'||['layerID','name','layerKind','group','background','linkedLayerIDs'].includes(k)||k=='textKey'&&this.n.kind==3;}getInteger(k){return k=='layerID'?this.n.id:this.n.kind;}getString(k){return this.n.name;}getBoolean(k){return !!this.n[k];}getEnumerationValue(){return this.n.section||'layerSectionContent';}getObjectValue(){return {hasKey:()=>true,getString:()=>this.n.text};}getList(){let a=this.n.links||[];return {count:a.length,getType:i=>i%2?'reference':'integer',getInteger:i=>a[i],getReference:i=>({getIdentifier:()=>a[i]})};}}
c.s2t=x=>x;c.typeIDToStringID=x=>x;c.DescValueType={INTEGERTYPE:'integer',REFERENCETYPE:'reference'};let reads=0;c.doc={getProperty:k=>k=='hasBackgroundLayer'?true:7};c.lr={getDescriptor(i){reads++;return new D(records[i]);}};
let collected=c.collectPreparationLayers();assert.equal(reads,8);assert.equal(collected.byId['4'].parentId,5);assert.equal(collected.byId['5'].parentId,6);assert.equal(collected.byId['2'].parentId,6);assert.equal(collected.byId['4'].text,'Иванов Иван');
console.log('PASS: group/child deduplication, linked closure incl group descendants, text names, standalone shapes stay native, locks, clipping/parent/adjustment guards; bulk AM descriptor traversal and nesting');

data=tree([node(40,7,null,{blendMode:'normal'}),node(30,1,40,{links:[31]}),node(31,2,40,{links:[30]})]);assert.throws(()=>c.planInputPreparation(data,[30]),/Коррекция/);
data=tree([node(40,7,null,{blendMode:'passThrough'}),node(30,1,40,{blendMode:'multiply'})]);assert.throws(()=>c.planInputPreparation(data,[40]),/режим наложения/);
console.log('PASS: isolation requires an ancestor inside the prepared object, not an unselected parent; pass-through blending guard');
