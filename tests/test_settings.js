const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../Photoshop-files/Auto-layout-v0.10.9.jsx'),'utf8');
let saved=null,controls=[];
class Descriptor{constructor(){this.data={};}get count(){return Object.keys(this.data).length;}getKey(i){return Object.keys(this.data)[i];}getType(k){return this.data[k].type;}getString(k){return new String(this.data[k].value);}getDouble(k){return this.data[k].value;}getBoolean(k){return this.data[k].value;}getInteger(k){return this.data[k].value;}putString(k,v){assert.equal(typeof v,'string');this.data[k]={type:2,value:v};}putDouble(k,v){this.data[k]={type:3,value:v};}putBoolean(k,v){this.data[k]={type:1,value:v};}}
class Control{constructor(type,labels){this.type=type;this.items=[];this.children=[];this.enabled=true;controls.push(this);if(Array.isArray(labels))for(let text of labels)this.add('item',text);}add(type,b,c){if(type=='item'){let item={text:b,index:new Number(this.items.length)};this.items.push(item);return item;}let control=new Control(type,c);this.children.push(control);return control;}remove(control){this.children=this.children.filter(c=>c!==control);}set selection(value){assert(typeof value!='string','string assignment to ScriptUI selection');this.selected=typeof value=='number'?this.items[value]:value;}get selection(){return this.selected;}close(value){this.result=value;}}
const ctx={ver:'0.10.9',UUID:'persistent-uuid',ActionDescriptor:Descriptor,DescValueType:{BOOLEANTYPE:1,STRINGTYPE:2,DOUBLETYPE:3,INTEGERTYPE:4},Window:function(type){return new Control(type);},app:{stringIDToTypeID:s=>s,typeIDToStringID:s=>new String(s),getCustomOptions(id){assert.equal(id,ctx.UUID);if(!saved)throw Error('absent');return saved;},putCustomOptions(id,d,persistent){assert.equal(id,ctx.UUID);assert(persistent);saved=d;}},pythonApi:{getAvailability:()=>({available:true}),getHeadTurnAvailability:()=>({available:true,message:''})}};
vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function main()')),ctx);
function dialog(){controls=[];let dlg=ctx.dialog(),dropdown=controls.find(c=>c.items.some(i=>i.text==='Согласованные цвета')),ok=controls.find(c=>c.text=='Разложить слои');return {dlg,dropdown,ok};}
const modes=['off','harmonious','contrast'];
for(let mode of modes){
 ctx.cfg=new ctx.Config();ctx.cfg.colorMode=new String(mode);ctx.cfg.putScriptSettings();assert.equal(saved.getString('colorMode').valueOf(),mode);
 ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();assert.equal(ctx.cfg.colorMode,mode);assert.equal(typeof ctx.cfg.colorMode,'string');let d=dialog(),index=modes.indexOf(mode);assert.equal(d.dropdown.selection.text,ctx.colorModeLabel(mode));
 // Native index is deliberately wrong/one-based. Selection text is authoritative.
 for(let indexType of [n=>n,n=>n+1,n=>String(n+1),n=>new Number(n+1),n=>n+100]){
  d.dropdown.selection=d.dropdown.items[index];d.dropdown.selection.index=indexType(index);d.dropdown.onChange.call({});assert.equal(ctx.cfg.colorMode,mode);
  d.ok.onClick();ctx.cfg.putScriptSettings();ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();assert.equal(ctx.cfg.colorMode,mode);d=dialog();assert.equal(d.dropdown.selection.text,ctx.colorModeLabel(mode));
 }
}
// Specifically selecting the second visible item must never become the third.
ctx.cfg=new ctx.Config();let d=dialog();d.dropdown.selection=d.dropdown.items[1];d.dropdown.selection.index=2;d.ok.onClick();ctx.cfg.putScriptSettings();ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();assert.equal(ctx.cfg.colorMode,'harmonious');d=dialog();assert.equal(d.dropdown.selection,d.dropdown.items[1]);
// OK captures a choice even with omitted onChange; contrast now is last item.
ctx.cfg=new ctx.Config();d=dialog();d.dropdown.selection=d.dropdown.items[2];assert.equal(ctx.cfg.colorMode,'off');d.ok.onClick();assert.equal(d.dlg.result,1);ctx.cfg.putScriptSettings();ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();assert.equal(ctx.cfg.colorMode,'contrast');
ctx.pythonApi.getAvailability=()=>({available:false,message:'missing'});ctx.cfg.colorMode='harmonious';d=dialog();assert(!d.dropdown.enabled);assert.equal(d.dropdown.selection.text,ctx.colorModeLabel('harmonious'));d.ok.onClick();ctx.cfg.putScriptSettings();ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();assert.equal(ctx.cfg.colorMode,'harmonious');ctx.pythonApi.getAvailability=()=>({available:true});d=dialog();assert.equal(d.dropdown.selection.text,ctx.colorModeLabel('harmonious'));
for(let v of ['harmonious',1,'1',new Number(1)])assert.equal(ctx.normalizeColorMode(v),'harmonious');for(let v of [2,'2',new Number(2)])assert.equal(ctx.normalizeColorMode(v),'contrast');for(let v of [null,undefined,'bad',-1,NaN])assert.equal(ctx.normalizeColorMode(v),'off');
console.log('PASS: all three modes round trip by label/token; wrong/one-based/string/boxed index cannot shift selection; second item stays second, missed onChange/OK, unavailable runtime and legacy migration');

// Healthy runtime does not reserve an invisible 68px status row.
ctx.pythonApi.getAvailability=()=>({available:true});ctx.cfg=new ctx.Config();d=dialog();
let additional=controls.find(control=>control.text=='Дополнительно');
assert(!additional.children.some(control=>control.visible===false));
console.log('PASS: no hidden status control reserves space below healthy Python settings');

for(let old of ['lightToDark','darkToLight','vividToMuted','mutedToVivid']) assert.equal(ctx.normalizeColorMode(old),'harmonious');

// Obsolete report settings must not return through preferences or action payloads.
saved.putBoolean('showReport',true);ctx.cfg=new ctx.Config();ctx.cfg.getScriptSettings();
assert(!Object.prototype.hasOwnProperty.call(ctx.cfg,'showReport'));
ctx.cfg.putScriptSettings();assert(!Object.prototype.hasOwnProperty.call(saved.data,'showReport'));
console.log('PASS: retired report flag is neither restored nor saved');
