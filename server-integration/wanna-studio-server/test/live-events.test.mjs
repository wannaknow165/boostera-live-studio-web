import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {LiveEvents} from '../lib/mobile-live-events.mjs';
test('gift streak is counted exactly once at final event',()=>{
 const automations=[],events=new LiveEvents({onAutomation:e=>automations.push(e)});
 const gift={user:{id:'9007199254740993123',displayId:'customer'},giftId:'1',groupId:'streak',gift:{type:1,name:'Rose',diamondCount:1},repeatCount:4};
 assert.equal(events.ingest('gift',gift),false);assert.equal(events.state.gifts,0);
 assert.equal(events.ingest('gift',{...gift,repeatEnd:1}),true);
 assert.equal(events.ingest('gift',{...gift,repeatEnd:1}),false);
 assert.equal(events.state.gifts,4);assert.equal(events.state.diamonds,4);assert.equal(events.state.supporters[0].id,'9007199254740993123');
 assert.equal(automations.length,1);assert.equal(automations[0].source,'tiktok');assert.equal(automations[0].count,4);
});
test('battle messages keep IDs and reset previous scores on another battle',()=>{
 const fired=[],events=new LiveEvents({onAutomation:e=>fired.push(e)});const now=Math.floor(Date.now()/1000);
 events.ingest('linkMicBattle',{battleId:'90071992547409931234',action:1,battleSettings:{startTime:now,endTime:now+240},anchorsInfo:[{value:{user:{id:'123',displayId:'creator'}}}]});
 events.ingest('linkMicArmies',{battleId:'90071992547409931234',armies:[{key:'123',value:{points:'50'}}]});
 assert.equal(events.state.battle.scores[0].score,50);assert.equal(events.state.battle.id,'90071992547409931234');assert.equal(fired.length,1);
 events.ingest('linkMicBattle',{battleId:'second',action:99});assert.deepEqual(events.state.battle.scores,[]);assert.equal(fired.length,1);
});
test('public connection lifecycle is driven by actual connector success',async()=>{
 class Fake extends EventEmitter{async connect(){return{roomId:'room123'};}async disconnect(){this.emit('disconnected');}}
 let client;const events=new LiveEvents({factory:()=>client=new Fake()});const connected=await events.connect('@wanna');assert.equal(connected.status,'connected');assert.equal(connected.roomId,'room123');
 client.emit('chat',{content:'hello',user:{displayId:'viewer'}});assert.equal(events.state.events[0].text,'hello');await events.disconnect();assert.equal(events.state.status,'disconnected');
 await assert.rejects(()=>events.connect('https://evil.example'),/INVALID_TIKTOK_HANDLE/);
});
test('failed TikTok signing never reports connected',async()=>{
 const events=new LiveEvents({factory:()=>({on(){},connect(){throw Error('signing unavailable');},disconnect(){}})});const state=await events.connect('wanna');assert.equal(state.status,'error');assert.equal(state.error,'CONNECTION_FAILED_OR_SIGNING_REQUIRED');
});
