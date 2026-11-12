import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, {WebSocketServer} from 'ws';
import {createTikToolsConnection} from '../lib/tiktools-connection.mjs';
import {LiveEvents} from '../lib/mobile-live-events.mjs';
import {eventProvider} from '../lib/mobile-event-provider.mjs';
import {managedBattle} from '../lib/tiktools-events.mjs';

const KEY='test-only+not-a-credential/=',ROOM='7123456789012345678',USER='controlled_creator';
const user={id:'1234567890123456789',uniqueId:'viewer',nickname:'צופה'};
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected event was not received');}
async function fixture(t,handshake={event:'roomInfo',roomId:ROOM,uniqueId:USER}){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let socket;
  server.on('connection',s=>{socket=s;if(handshake)s.send(JSON.stringify(handshake));});
  class Local extends WebSocket{constructor(address,options){const u=new URL(address);assert.equal(u.origin,'wss://api.tik.tools');assert.equal(u.searchParams.get('apiKey'),KEY);assert.equal(options.followRedirects,false);super('ws://127.0.0.1:'+server.address().port,options);}}
  const connection=createTikToolsConnection(USER,{apiKey:KEY,WebSocketImpl:Local,timeoutMs:200});
  t.after(async()=>{await connection.disconnect();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));});
  return{connection,send:value=>socket.send(JSON.stringify(value))};
}
test('managed socket feeds chat, gifts, social counters and battle telemetry through the real reader',async t=>{
  const f=await fixture(t),live=new LiveEvents({factory:()=>f.connection});t.after(()=>live.disconnect());
  assert.equal((await live.connect(USER)).status,'connected');assert.equal(live.state.roomId,ROOM);
  f.send({event:'chat',data:{user,comment:'שלום <img src=x onerror=alert(1)>',msgId:'one'}});
  f.send({event:'chat',data:{user,comment:'duplicate',msgId:'one'}});
  f.send({event:'gift',data:{user,giftId:5655,giftName:'Rose',giftType:1,repeatEnd:true,repeatCount:3,diamondCount:1,groupId:'group'}});
  f.send({event:'social',data:{user,action:'follow'}});f.send({event:'share',data:{user}});f.send({event:'subscribe',data:{user}});
  f.send({event:'roomUserSeq',data:{viewerCount:25}});
  f.send({event:'battleArmies',data:{battleId:'0',matchId:'match',sessionId:'round1',status:4,serverTsMs:Date.now(),durationSec:300,secsRemaining:180,teams:[{hostUserId:'987654321',score:80,users:[{user,score:60}]}]}});
  await until(()=>live.state.battle);
  assert.equal(live.state.chat.length,1);assert.match(live.state.chat[0].text,/<img/);
  assert.equal(live.state.gifts,3);assert.equal(live.state.events.find(e=>e.type==='gift').name,'Rose');
  assert.equal(live.state.follows,1);assert.equal(live.state.shares,1);assert.equal(live.state.subscribers,1);assert.equal(live.state.viewers,25);
  assert.equal(live.state.battle.status,'active');assert.equal(live.state.battle.id,'match:round1');assert.equal(live.state.battle.scores[0].contributors[0].score,'60');
  assert.ok(!JSON.stringify(live.snapshot()).includes(KEY));
  f.send({event:'streamEnd',data:{uniqueId:USER}});await until(()=>live.state.status==='ended');
});
test('unverified or wrong rooms never connect, and upstream errors do not leak credentials',async t=>{
  const wrong=await fixture(t,{event:'roomInfo',roomId:ROOM,uniqueId:'wrong_account'});
  await assert.rejects(wrong.connection.connect(),{code:'TIKTOOLS_ROOM_MISMATCH'});
  const silent=await fixture(t,null);await assert.rejects(silent.connection.connect(),{code:'TIKTOOLS_TIMEOUT'});
  const f=await fixture(t);let problem;f.connection.on('error',e=>problem=e);await f.connection.connect();
  f.send({event:'error',data:{message:KEY}});await until(()=>problem);
  assert.equal(problem.code,'TIKTOOLS_PROVIDER_REJECTED');assert.ok(!problem.message.includes(KEY));
});
test('battle phase enums, zero countdown, team identities and round resets stay distinct',()=>{
  const input={battleId:'0',matchId:'match',sessionId:'round',status:4,secsRemaining:10,serverTsMs:Date.now(),hosts:[{hostUserId:'1',isTeam:true,teamTotalScore:100,members:[{userId:'12345678',score:100}],contributors:[{userId:'87654321',score:60,nickname:'MVP'}]}]};
  assert.equal(managedBattle(input,'battle').status,'pending');
  const b=managedBattle(input,'battleArmies');assert.equal(b.status,'active');assert.equal(b.scores[0].id,'team:1');assert.deepEqual(b.scores[0].members,['12345678']);
  const events=new LiveEvents();events.ingest('managedBattle',{battle:b});
  events.ingest('managedBattle',{battle:managedBattle({...input,secsRemaining:0},'battleArmies')});assert.equal(events.state.battle.status,'ended');
  events.ingest('managedBattle',{battle:b});assert.equal(events.state.battle.status,'ended');
  events.ingest('managedBattle',{battle:managedBattle({...input,sessionId:'round2'},'battleArmies')});assert.equal(events.state.battle.status,'active');
  assert.equal(managedBattle({status:4},'battleArmies'),null);
});
test('provider settings persist privately; missing key fails before any socket is opened',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'event-provider-'));fs.mkdirSync(path.join(root,'data'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const provider=eventProvider(root);provider.save({provider:'tiktools'});
  await assert.rejects(provider.create(USER,{}),{code:'TIKTOOLS_KEY_REQUIRED'});
  provider.save({provider:'tiktools',apiKey:KEY});assert.equal(eventProvider(root).info().tiktoolsConfigured,true);
  assert.ok(!JSON.stringify(provider.info()).includes(KEY));assert.throws(()=>provider.save({provider:'tiktools',apiKey:'bad\nkey'}),/INVALID_EVENT_PROVIDER/);
});
