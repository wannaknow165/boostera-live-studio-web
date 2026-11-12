import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {LiveEvents} from '../lib/mobile-live-events.mjs';
test('chat survives busy likes, is bounded and resets on a new account',async()=>{
 class Fake extends EventEmitter{async connect(){return{roomId:'12345'};}async disconnect(){}}
 const events=new LiveEvents({factory:()=>new Fake()});await events.connect('first');
 for(let i=0;i<110;i++)events.ingest('chat',{common:{msgId:String(i)},comment:'message '+i,user:{uniqueId:'viewer'}});
 for(let i=0;i<100;i++)events.ingest('like',{likeCount:1});
 assert.equal(events.state.chat.length,100);assert.equal(events.state.chat[0].text,'message 109');assert.equal(events.state.events.some(e=>e.type==='chat'),false);
 await events.connect('second');assert.equal(events.state.chat.length,0);assert.equal(events.state.lastEventAt,null);await events.disconnect();
});
test('disconnect during asynchronous connector construction cannot revive an old account',async()=>{
 let release,disconnected=false;const events=new LiveEvents({factory:()=>new Promise(r=>release=r)});
 const pending=events.connect('first');await new Promise(r=>setImmediate(r));await events.disconnect();
 release({async disconnect(){disconnected=true;},connect(){throw Error('must not connect');}});
 await pending;assert.equal(events.state.status,'disconnected');assert.equal(events.client,null);assert.equal(disconnected,true);
});
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
 events.ingest('linkMicBattle',{battleId:'90071992547409931234',action:4,battleSettings:{startTimeMs:String(now*1000),endTimeMs:String((now+240)*1000),status:1},anchorsInfo:[{value:{user:{id:'123',displayId:'creator'}}}]});
 events.ingest('linkMicArmies',{battleId:'90071992547409931234',armies:[{key:'123',value:{points:'50'}}]});
 assert.equal(events.state.battle.scores[0].score,'50');assert.equal(events.state.battle.id,'90071992547409931234');assert.equal(fired.length,1);
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
test('v3 battle score, contributor and millisecond lifecycle fields reach the snapshot exactly',()=>{
 const fired=[],events=new LiveEvents({onAutomation:e=>fired.push(e)}),now=Date.now(),id='9007199254740993999';
 const settings={battleId:id,startTimeMs:String(now),endTimeMs:String(now+240000),duration:240,status:1};
 events.ingest('linkMicBattle',{battleId:id,action:4,battleSettings:settings,anchorsInfo:[{key:'11',value:{user:{userId:'11',displayId:'host',nickName:'Host'}}},{key:'22',value:{user:{userId:'22',displayId:'opponent',nickName:'Opponent'}}}]});
 events.ingest('linkMicArmies',{battleId:id,battleSettings:settings,triggerReason:1,armies:{'11':{hostscore:'9007199254740993001',userArmies:[{userIdStr:'333',score:'500',nickname:'Supporter'}]},'22':{hostscore:'450',userArmies:[]}}});
 assert.equal(events.state.battle.status,'active');assert.equal(events.state.battle.startTimeMs,now);assert.equal(events.state.battle.scores[0].score,'9007199254740993001');assert.equal(events.state.battle.scores[0].contributors[0].id,'333');assert.equal(events.state.participants[1].name,'Opponent');assert.equal(fired.length,1);
 events.ingest('linkMicBattle',{battleId:id,action:5,battleSettings:{...settings,status:2},battleResult:{'11':{userId:'11',score:'9007199254740993002'},'22':{userId:'22',score:'460'}}});
 assert.equal(events.state.battle.status,'ended');assert.equal(events.state.participants.length,2);assert.equal(events.state.battle.scores[1].score,'460');
 events.ingest('linkMicArmies',{battleId:id,triggerReason:4,armies:{'11':{hostscore:'9007199254740993002'}}});assert.equal(events.state.battle.status,'ended');
 events.ingest('linkMicArmies',{battleId:'new-round',triggerReason:1,armies:{'44':{hostscore:'1'}}});assert.equal(events.state.participants.length,0);assert.equal(events.state.battle.scores.length,1);
});
test('an invitation is not a started battle and BATTLE_END ends score-only rounds',()=>{
 const fired=[],events=new LiveEvents({onAutomation:e=>fired.push(e)}),battleId='round';
 events.ingest('linkMicBattle',{battleId,action:1,battleSettings:{startTimeMs:String(Date.now()),duration:240,status:0}});assert.equal(events.state.battle.status,'pending');assert.equal(fired.length,0);
 events.ingest('linkMicArmies',{battleId,triggerReason:2,armies:{'1':{hostscore:'15'}}});assert.equal(events.state.battle.status,'ended');
});
