import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BattleController} from '../src/battles.mjs';

function setup(){
  const snapshot={health:'ready',session:{epoch:'room-epoch',roomId:'123'},battle:{battleId:'456',status:'pending'}};
  const native={ready:true,identity:'invitation-456',scopes:[{role:'invitee',battleId:'456'}],buttons:[{action:'match.accept',enabled:true}]};
  let clicks=0;
  const ui={inspect:async()=>structuredClone(native),act:async()=>{clicks++;}};
  const service={state:async()=>structuredClone(snapshot)};
  const controller=new BattleController({service,ui});
  return{controller,snapshot,native,ui,service,get clicks(){return clicks;}};
}
async function request(t){const s=await t.controller.state();return{action:'match.accept',epoch:s.epoch,revision:s.revision,requestId:crypto.randomUUID()};}

test('acceptance invokes the native action once and does not claim a connected battle',async()=>{
  const t=setup(),body=await request(t);
  const [a,b]=await Promise.all([t.controller.execute(body),t.controller.execute(body)]);
  assert.equal(t.clicks,1);assert.deepEqual(a,b);assert.equal(a.outcome,'awaiting_studio');assert.equal(a.dispatched,true);
});
test('replacement invitation invalidates the viewed action before any click',async()=>{
  const t=setup(),body=await request(t);t.native.identity='invitation-999';
  await assert.rejects(t.controller.execute(body),{code:'BATTLE_CHANGED'});assert.equal(t.clicks,0);
});
test('fresh HTTP request IDs still cannot repeat an unchanged native action',async()=>{
  const t=setup(),body=await request(t);await t.controller.execute(body);
  await t.controller.execute({...body,requestId:crypto.randomUUID()});assert.equal(t.clicks,1);
});

test('returning to the same native screen in a later round permits a new action but not duplicate retries',async()=>{
  const t=setup();t.snapshot.battle=null;t.native.identity='mode-screen';t.native.buttons=[{action:'cohostMode.getStarted',enabled:true}];
  const request=async()=>({...await t.controller.state(),action:'cohostMode.getStarted',requestId:crypto.randomUUID()});
  const first=await request();await t.controller.execute(first);assert.equal(t.clicks,1);
  t.native.identity='start-screen';await t.controller.state();t.native.identity='mode-screen';
  const second=await request();assert.notEqual(second.revision,first.revision);await t.controller.execute(second);assert.equal(t.clicks,2);
  await t.controller.execute({...second,requestId:crypto.randomUUID()});assert.equal(t.clicks,2);
  // A battle transition also distinguishes rounds if the same controls stay rendered.
  t.snapshot.battle={battleId:'999',status:'open'};await t.controller.state();t.snapshot.battle=null;
  const third=await request();assert.notEqual(third.revision,second.revision);await t.controller.execute(third);assert.equal(t.clicks,3);
});
test('room change and bridge health loss prevent accepting a stale invitation',async()=>{
  for(const mutate of [t=>{t.snapshot.session.epoch='different-room';},t=>{t.snapshot.health='offline';}]){
    const t=setup(),body=await request(t);mutate(t);
    await assert.rejects(t.controller.execute(body));assert.equal(t.clicks,0);
  }
});
test('native disabled state and unsupported service names cannot be dispatched',async()=>{
  const t=setup();t.native.buttons[0].enabled=false;const body=await request(t);
  await assert.rejects(t.controller.execute(body),{code:'BATTLE_ACTION_UNAVAILABLE'});
  assert.throws(()=>t.controller.execute({...body,action:'acceptIncomingDirectBattle',requestId:crypto.randomUUID()}),{code:'INVALID_BATTLE_REQUEST'});
  assert.equal(t.clicks,0);
});
test('lost native response is unknown and retry does not send a second acceptance',async()=>{
  const t=setup();let attempts=0;t.ui.act=async()=>{attempts++;throw new Error('NATIVE_UI_TIMEOUT');};
  const body=await request(t),first=await t.controller.execute(body),again=await t.controller.execute(body);
  assert.equal(first.outcome,'unknown');assert.equal(first.dispatched,null);assert.deepEqual(first,again);assert.equal(attempts,1);
});
test('same request ID cannot be reused for a different battle action',async()=>{
  const t=setup(),body=await request(t);await t.controller.execute(body);
  assert.throws(()=>t.controller.execute({...body,action:'match.decline'}),{code:'REQUEST_ID_CONFLICT'});
});
test('room transition during native inspection clears all controls',async()=>{
  const t=setup();let count=0;t.service.state=async()=>({...t.snapshot,session:{...t.snapshot.session,epoch:++count===1?'old':'new'}});
  const state=await t.controller.state();assert.equal(state.available,false);assert.deepEqual(state.actions,[]);assert.equal(state.error,'SESSION_CHANGED');
});
