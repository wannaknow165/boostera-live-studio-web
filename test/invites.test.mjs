import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {InviteController} from '../src/invites.mjs';
import {NativeUi} from '../src/native-ui.mjs';
const requestId='11111111-1111-4111-8111-111111111111';
function fixture({observeMs=0,onClick,nativeObserved=false}={}){
  let snapshot={health:'ready',session:{epoch:'fresh',selfUid:'111',roomId:'222'},users:{'333':{roomId:'444',availableActions:{invite:true}}},operations:[]},clicks=0,prepares=0;
  const service={async state(){return structuredClone(snapshot);}};
  const ui={async prepare(uid){prepares++;return{ready:true,uid};},async clickInvite(uid){clicks++;if(onClick)onClick(snapshot,uid);else snapshot.operations.push({operationId:'new-operation',kind:'manual_cohost',action:'invite',targetUid:uid,createdAt:10000,step:'awaiting_peer',outcome:'pending'});}};
  const controller=new InviteController({service,ui,now:()=>10000,observeMs,pause:async()=>{},getState:()=>({session:{epoch:'fresh'},candidates:[{uid:'333',name:'Creator',sources:['followed_list'],nativeObserved,inviteAvailable:nativeObserved}]})});
  return{controller,get snapshot(){return snapshot;},set snapshot(v){snapshot=v;},get clicks(){return clicks;},get prepares(){return prepares;}};
}
test('preparation identifies the target without sending any invitation',async()=>{
  const f=fixture(),draft=await f.controller.prepare({uid:'333',epoch:'fresh'});
  assert.equal(draft.name,'Creator');assert.match(draft.draftToken,/^[a-f0-9]{48}$/);assert.equal(f.clicks,0);assert.equal(f.prepares,1);
});
test('one confirmed request clicks once and reports pending rather than accepted',async()=>{
  const f=fixture(),draft=await f.controller.prepare({uid:'333',epoch:'fresh'});
  const result=await f.controller.send({...draft,requestId});
  assert.equal(f.clicks,1);assert.equal(result.submitted,true);assert.equal(result.outcome,'pending');assert.equal(result.operationId,'new-operation');
});
test('duplicate HTTP request IDs reuse the same send and receipt',async()=>{
  const f=fixture(),draft=await f.controller.prepare({uid:'333',epoch:'fresh'}),body={...draft,requestId};
  const a=f.controller.send(body),b=f.controller.send(body);assert.equal(a,b);
  const results=await Promise.all([a,b]);assert.equal(f.clicks,1);assert.deepEqual(results[0],results[1]);
});
test('a changed LIVE session cannot dispatch a previously confirmed target',async()=>{
  const f=fixture(),draft=await f.controller.prepare({uid:'333',epoch:'fresh'});f.snapshot.session.epoch='next';
  await assert.rejects(f.controller.send({...draft,requestId}),/SESSION_CHANGED/);assert.equal(f.clicks,0);
});
test('disabled, self and unknown creators are rejected before UI preparation',async()=>{
  const f=fixture();f.snapshot.users['333'].availableActions.invite=false;
  await assert.rejects(f.controller.prepare({uid:'333',epoch:'fresh'}),/TARGET_UNAVAILABLE/);
  await assert.rejects(f.controller.prepare({uid:'111',epoch:'fresh'}),/SELF_INVITE_NOT_ALLOWED/);
  await assert.rejects(f.controller.prepare({uid:'999',epoch:'fresh'}),/TARGET_UNAVAILABLE/);
  assert.equal(f.prepares,0);assert.equal(f.clicks,0);
});

test('a real rendered candidate can be prepared before it enters snapshot users, with explicit current-session permission',async()=>{
  const f=fixture({nativeObserved:true});delete f.snapshot.users['333'];
  await assert.rejects(f.controller.prepare({uid:'333',epoch:'fresh'}),/TARGET_UNAVAILABLE/);
  f.snapshot.availability={manual_cohost:{allowed:true}};
  const draft=await f.controller.prepare({uid:'333',epoch:'fresh'});assert.equal(f.prepares,1);assert.equal(f.clicks,0);
  f.snapshot.availability.manual_cohost.allowed=false;
  await assert.rejects(f.controller.send({...draft,requestId}),/TARGET_UNAVAILABLE/);assert.equal(f.clicks,0);
});
test('no observed operation produces an unknown receipt, never false success',async()=>{
  const f=fixture({onClick(){}}),draft=await f.controller.prepare({uid:'333',epoch:'fresh'});
  const result=await f.controller.send({...draft,requestId});assert.equal(result.submitted,null);assert.equal(result.outcome,'unknown');assert.equal(f.clicks,1);
  await assert.rejects(f.controller.prepare({uid:'333',epoch:'fresh'}),/INVITE_BUSY/);
});
test('send requires a nonexpired preparation token and request identity',async()=>{
  const f=fixture();assert.throws(()=>f.controller.send({uid:'333',epoch:'fresh',draftToken:'missing',requestId}),/CONFIRMATION_EXPIRED/);
  await assert.rejects(f.controller.prepare({uid:'333"]',epoch:'fresh'}),/INVALID_TARGET/);assert.equal(f.clicks,0);
});
test('a rejected native operation is reported as failed with the server reason',async()=>{
  const f=fixture({onClick(s,uid){s.operations.push({operationId:'rejected',kind:'manual_cohost',action:'invite',targetUid:uid,createdAt:10000,outcome:'failed',error:{code:'REQUEST_REJECTED',message:'Not available'}});}});
  const draft=await f.controller.prepare({uid:'333',epoch:'fresh'}),receipt=await f.controller.send({...draft,requestId});
  assert.equal(receipt.outcome,'failed');assert.equal(receipt.error.message,'Not available');
});
function nativeFixture({disabled=false,duplicate=false,loading=false,clickable=true,search=false}={}){
  let clicks=0;
  const card={getAttribute:key=>key==='data-cohost-clickable'?(clickable?'1':'0'):null};
  const button={disabled,hasAttribute:key=>key==='data-loading'&&loading,getAttribute:()=>null,closest:()=>card,getClientRects:()=>[{}],scrollIntoView(){},click(){clicks++;}};
  const document={visibilityState:'hidden',querySelector:selector=>search&&selector.includes('role="tab"')?null:{},querySelectorAll(selector){return selector.includes('333')?(duplicate?[button,button]:[button]):[];}};
  class Socket extends EventTarget{
    constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(data){const req=JSON.parse(data);const value=vm.runInNewContext(req.params.expression,{document,getComputedStyle:()=>({visibility:'visible'})});queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:req.id,result:{result:{value}}})})));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  const ui=new NativeUi({Socket,fetcher:async()=>({json:async()=>[{type:'page',url:'file:///C:/Program%20Files/TikTok%20LIVE%20Studio/1.39.6/resources/app//html/popupMulti/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/test'}]})});
  return{ui,get clicks(){return clicks;}};
}
test('native adapter clicks only one exact enabled UID-tagged Invite button',async()=>{
  const f=nativeFixture();assert.equal((await f.ui.clickInvite('333')).clicked,true);assert.equal(f.clicks,1);
});
test('native adapter refuses disabled, loading, non-clickable or ambiguous UI buttons',async()=>{
  for(const options of [{disabled:true},{duplicate:true},{loading:true},{clickable:false}]){const f=nativeFixture(options);await assert.rejects(f.ui.clickInvite('333'),/NATIVE_INVITE_DISABLED|AMBIGUOUS_NATIVE_TARGET/);assert.equal(f.clicks,0);}
});
test('native search results work without friend tabs and loading never dispatches twice',async()=>{
  const f=nativeFixture({search:true});assert.equal((await f.ui.clickInvite('333')).clicked,true);assert.equal(f.clicks,1);
  const busy=nativeFixture({search:true,loading:true});await assert.rejects(busy.ui.clickInvite('333'),/NATIVE_INVITE_DISABLED/);assert.equal(busy.clicks,0);
});
test('native adapter rejects a debugger endpoint outside the local app',async()=>{
  const ui=new NativeUi({fetcher:async()=>({json:async()=>[{type:'page',url:'file:///C:/Program%20Files/TikTok%20LIVE%20Studio/1.39.6/resources/app/html/popupMulti/index.html',webSocketDebuggerUrl:'ws://evil.example:9222/test'}]})});
  await assert.rejects(ui.connect(),/INVALID_NATIVE_ENDPOINT/);
});
