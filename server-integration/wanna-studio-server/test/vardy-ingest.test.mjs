import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createVardyIngest,vardyIngestFromEnv,mapEvent,LikeWindows,DEFAULT_BASE_URL} from '../lib/vardy-ingest.mjs';
import {LiveEvents} from '../lib/mobile-live-events.mjs';
import {managedBattle} from '../lib/tiktools-events.mjs';

const T0=1762000000000; // fixed "now" for the fake clock
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'vardy-test-'));
const lines=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
// fake clock: the ingest gets now()/timers from here, so 1 s flushes and 60 s back-offs are exact and instant
function clock(start=T0){
  let t=start,seq=0;const pending=[];let idle=()=>Promise.resolve();
  const timers={setTimeout(fn,ms){const h={id:++seq,at:t+Math.max(0,Number(ms)||0),fn,unref(){return h;},ref(){return h;}};pending.push(h);return h;},clearTimeout(h){const i=pending.indexOf(h);if(i>=0)pending.splice(i,1);}};
  const settle=async()=>{await idle();for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));await idle();};
  async function advance(ms){const end=t+ms;for(;;){pending.sort((a,b)=>a.at-b.at||a.id-b.id);const next=pending[0];if(!next||next.at>end)break;t=next.at;pending.shift();next.fn();await settle();}t=end;await settle();}
  return{now:()=>t,timers,advance,settle,watch(ingest){idle=ingest.idle;},get pending(){return pending.length;}};
}
// mocked fetch: records every call; reply(body, n) returns a Response or an Error to throw
function fakeApi(reply=body=>Response.json({accepted:body.events.length,duplicate:0,rejected:[]})){
  const calls=[];
  const fetchImpl=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,headers:options.headers,body});const r=await reply(body,calls.length);if(r instanceof Error)throw r;return r;};
  return{calls,fetchImpl};
}
function make(c,api,dir,logs,extra={}){const ingest=createVardyIngest({baseUrl:'https://vardy.test',serviceKey:'test-key',fetchImpl:api.fetchImpl,log:l=>logs.push(l),runtimeDir:dir,now:c.now,timers:c.timers,...extra});c.watch(ingest);return ingest;}

test('mapper: a gift is sent only at the end of its streak, with diamonds x count and a stable dedupe key',()=>{
 const base={user:{id:'7000000000000000001',displayId:'fan_one',nickname:'Fan'},giftId:'5655',repeatCount:3,gift:{id:'5655',name:'Rose',diamondCount:1,type:1},common:{msgId:'msg-1',createTime:String(T0-500)}};
 assert.deepEqual(mapEvent('gift',{...base,repeatEnd:false},{now:T0}),[]);
 assert.deepEqual(mapEvent('gift',{...base,repeatEnd:0},{now:T0}),[]);
 assert.deepEqual(mapEvent('gift',{...base},{now:T0}),[]); // streakable gift without a streak-end marker: not final
 const [ended]=mapEvent('gift',{...base,repeatEnd:true,orderId:'order-77'},{now:T0});
 assert.equal(ended.type,'gift');assert.equal(ended.dedupe_key,'gift:order-77');assert.equal(ended.ts,new Date(T0-500).toISOString());
 assert.deepEqual(ended.payload,{gift_id:'5655',gift_name:'Rose',diamond_count:1,repeat_count:3,diamonds:3,user:{id:'7000000000000000001',handle:'fan_one',name:'Fan'},msg_id:'msg-1'});
 const [v3]=mapEvent('gift',{...base,repeatEnd:1},{now:T0});assert.equal(v3.dedupe_key,'gift:msg-1'); // numeric repeatEnd (proto v3); msgId is the transaction id
 const [composite]=mapEvent('gift',{...base,repeatEnd:true,common:{}},{now:T0});assert.equal(composite.dedupe_key,`gift:7000000000000000001:5655:${T0}`);
 const [single]=mapEvent('gift',{...base,gift:{...base.gift,type:2,diamondCount:500},repeatCount:1,repeatEnd:0},{now:T0});assert.equal(single.payload.diamonds,500); // non-streakable gift: its only message counts
 // Tik.Tools emits every gift with a boolean repeatEnd (lib/tiktools-connection.mjs): a one-shot gift (type 0) arrives as repeatEnd:false and still counts, as in LiveEvents.ingest
 const oneShot=mapEvent('gift',{...base,gift:{...base.gift,type:0,diamondCount:29999},giftType:0,repeatCount:1,repeatEnd:false},{now:T0});
 assert.equal(oneShot.length,1);assert.equal(oneShot[0].payload.diamonds,29999);assert.equal(oneShot[0].dedupe_key,'gift:msg-1');
 const live=new LiveEvents();live.ingest('gift',{...base,gift:{...base.gift,type:0,diamondCount:29999},giftType:0,repeatCount:1,repeatEnd:false});
 assert.equal(live.state.gifts,1);assert.equal(live.state.diamonds,29999); // the two counters agree
});

test('mapper: viewers, battle, member, follow/share and chat keep the contract shape',()=>{
 const check=(type,data,expect)=>{const out=mapEvent(type,data,{now:T0});assert.equal(out.length,1,type);const ev=out[0];assert.equal(ev.type,expect);assert.match(ev.ts,/^\d{4}-\d{2}-\d{2}T/);assert.ok(ev.dedupe_key.startsWith(expect+':'),ev.dedupe_key);return ev;};
 const viewers=check('roomUser',{total:'1234',ranks:[{user:{id:'1',displayId:'top1'},score:'900',rank:'1'}],common:{msgId:'ru-1'}},'viewers');
 assert.equal(viewers.payload.viewer_count,1234);assert.deepEqual(viewers.payload.top_viewers,[{user:{id:'1',handle:'top1',name:'top1'},coins:900,rank:1}]);assert.equal(viewers.dedupe_key,'viewers:ru-1');
 const battle=check('linkMicBattle',{battleId:'b1',action:4,battleSettings:{startTimeMs:String(T0),endTimeMs:String(T0+300000),duration:300},anchorsInfo:[{key:'1',value:{user:{userId:'1',nickname:'Host A'}}},{key:'2',value:{user:{userId:'2',nickname:'Host B'}}}],common:{msgId:'lb-1'}},'battle');
 assert.equal(battle.payload.phase,'status');assert.equal(battle.payload.action_name,'open');assert.deepEqual(battle.payload.participants.map(p=>p.name),['Host A','Host B']);assert.equal(battle.payload.start_time,new Date(T0).toISOString());assert.equal(battle.payload.duration,300);
 const scores=check('linkMicArmies',{battleId:'b1',armies:{'1':{hostscore:'150',userArmies:[{userId:'9',nickname:'Giver',score:'150'}]},'2':{hostscore:'20',userArmies:[]}},triggerReason:1},'battle');
 assert.equal(scores.payload.phase,'scores');assert.deepEqual(scores.payload.scores.map(s=>[s.id,s.score]),[['1',150],['2',20]]);assert.equal(scores.payload.scores[0].contributors[0].name,'Giver');
 const legacy=check('linkMicArmies',{battleId:'b2',armies:[{key:'123',value:{points:'50'}}]},'battle');assert.equal(legacy.payload.scores[0].score,50);
 // Tik.Tools provider: battle/battleArmies arrive already projected as managedBattle (lib/tiktools-events.mjs)
 const projected=managedBattle({battleId:'0',matchId:'match',sessionId:'round',status:4,secsRemaining:10,serverTsMs:T0,durationSec:300,hosts:[{hostUserId:'1',isTeam:true,teamTotalScore:100,members:[{userId:'12345678',score:100}],contributors:[{userId:'87654321',score:60,nickname:'MVP'}]}]},'battleArmies');
 const managed=check('managedBattle',{battle:projected,common:{msgId:'mb-1'}},'battle');
 assert.equal(managed.dedupe_key,'battle:match:round:mb-1');assert.equal(managed.payload.phase,'managed');assert.equal(managed.payload.battle_id,'match:round');assert.equal(managed.payload.status,'active');
 assert.equal(managed.payload.end_time,new Date(T0+10000).toISOString());assert.equal(managed.payload.start_time,new Date(T0+10000-300000).toISOString());assert.equal(managed.payload.duration,300);
 assert.deepEqual(managed.payload.scores,[{id:'team:1',score:100,members:['12345678'],contributors:[{id:'87654321',handle:'',name:'MVP',score:60}]}]);
 const noMsg=check('managedBattle',{battle:projected},'battle');assert.equal(noMsg.dedupe_key,`battle:match:round:managed:${T0}`); // no msgId: the provider's own timestamp
 assert.deepEqual(mapEvent('managedBattle',{battle:null},{now:T0}),[]);assert.deepEqual(mapEvent('managedBattle',{},{now:T0}),[]);
 const events=new LiveEvents();events.ingest('managedBattle',{battle:projected});assert.equal(events.state.battle.status,'active'); // LiveEvents and the mapper agree the battle exists
 assert.equal(check('member',{user:{id:'3',displayId:'newbie'},action:1,common:{msgId:'m-1'}},'member').dedupe_key,'member:m-1');
 check('follow',{user:{id:'4',displayId:'newfan'},common:{msgId:'s-1'}},'follow');
 check('share',{user:{id:'4',displayId:'newfan'},common:{msgId:'s-2'}},'share');
 assert.equal(check('social',{user:{id:'4'},common:{msgId:'s-3',displayText:{key:'pm_mt_guidance_share'}}},'share').dedupe_key,'share:s-3');
 const chat=check('chat',{user:{id:'5',displayId:'talker'},content:'hello',common:{msgId:'c-1'}},'chat');assert.equal(chat.payload.text,'hello');assert.equal(chat.dedupe_key,'chat:c-1');
 assert.equal(check('chat',{user:{id:'5'},comment:'legacy'},'chat').dedupe_key,`chat:5:${T0}`); // no msgId: user + receipt time
 assert.deepEqual(mapEvent('like',{user:{id:'1'},count:3},{now:T0}),[]); // likes are aggregated by LikeWindows, never mapped one by one
 assert.deepEqual(mapEvent('linkMicMethod',{},{now:T0}),[]);
 assert.deepEqual(mapEvent('chat',null,{now:T0})[0].payload.user,{id:'',handle:'',name:''}); // a broken payload never throws
});

test('likes are aggregated per user per 5 s window',()=>{
 const likes=new LikeWindows(5000);
 assert.deepEqual(likes.add({user:{id:'a',displayId:'ann'},count:3,total:'10'},T0,'room1'),[]);
 assert.deepEqual(likes.add({user:{id:'a',displayId:'ann'},count:2,total:'12'},T0+1000,'room1'),[]);
 assert.deepEqual(likes.add({user:{id:'b',displayId:'bob'},likeCount:1},T0+2000,'room1'),[]);
 assert.deepEqual(likes.drain(T0+4999),[]);
 const closed=likes.drain(T0+5000);assert.equal(closed.length,1);assert.equal(closed[0].room,'room1');
 assert.equal(closed[0].ev.type,'like');assert.equal(closed[0].ev.dedupe_key,'like:a:'+T0);assert.equal(closed[0].ev.ts,new Date(T0).toISOString());
 assert.deepEqual(closed[0].ev.payload,{user:{id:'a',handle:'ann',name:'ann'},count:5,total_like_count:12,window_ms:5000});
 const rolled=likes.add({user:{id:'b'},count:4},T0+7000,'room1');assert.equal(rolled.length,1);assert.equal(rolled[0].ev.payload.count,1); // b's first window closes when its next one opens
 assert.equal(likes.size,1);assert.equal(likes.drain(T0+7000,true)[0].ev.payload.count,4);assert.equal(likes.size,0);
});

test('batcher: flushes after 1 s, at most 200 events per call, and counts accepted/duplicate/rejected',async()=>{
 const dir=tmp(),c=clock(),logs=[],api=fakeApi(body=>Response.json({accepted:body.events.length-1,duplicate:1,rejected:[]}));
 try{
  const ingest=make(c,api,dir,logs,{baseUrl:'https://vardy.test/',creatorHandle:'creator'});
  ingest.sessionStart({roomId:'room1',handle:'other'});
  for(let i=0;i<449;i++)ingest.handle('chat',{user:{id:'u'+i,displayId:'viewer'+i},content:'hi '+i,common:{msgId:'c'+i}});
  await c.advance(999);assert.equal(api.calls.length,0);
  await c.advance(1);assert.equal(api.calls.length,3);
  assert.deepEqual(api.calls.map(k=>k.body.events.length),[200,200,50]);
  assert.equal(api.calls[0].url,'https://vardy.test/api/public/live/ingest');assert.equal(api.calls[0].headers['x-vardy-service-key'],'test-key');assert.equal(api.calls[0].headers['content-type'],'application/json');
  assert.equal(api.calls[0].body.creator_handle,'creator');assert.equal(api.calls[0].body.room_id,'room1');
  assert.deepEqual(Object.keys(api.calls[0].body),['creator_handle','room_id','events']);
  assert.equal(api.calls[0].body.events[0].type,'session_start');assert.equal(api.calls[0].body.events[1].dedupe_key,'chat:c0');assert.equal(api.calls[2].body.events[49].dedupe_key,'chat:c448');
  for(const call of api.calls)for(const ev of call.body.events)assert.deepEqual(Object.keys(ev),['type','ts','dedupe_key','payload']);
  const s=ingest.stats();assert.equal(s.calls,3);assert.equal(s.sent,450);assert.equal(s.accepted,447);assert.equal(s.duplicate,3);assert.equal(s.rejected,0);assert.equal(s.pending,0);assert.equal(s.spool,0);assert.equal(s.failures,0);
  assert.equal(fs.existsSync(path.join(dir,'vardy-spool.jsonl')),false);assert.equal(fs.existsSync(path.join(dir,'vardy-dryrun.jsonl')),false);
  await ingest.close();assert.equal(c.pending,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('429 backs off 60 s, keeps the batch in the spool file and replays it first on recovery',async()=>{
 const dir=tmp(),c=clock(),logs=[];let mode='limit';
 const api=fakeApi(body=>mode==='limit'?new Response('slow down',{status:429,headers:{'retry-after':'5'}}):Response.json({accepted:body.events.length,duplicate:0,rejected:[]}));
 try{
  const ingest=make(c,api,dir,logs);
  ingest.sessionStart({roomId:'room1',handle:'creator'});
  ingest.handle('chat',{user:{id:'1',displayId:'first'},content:'one',common:{msgId:'c1'}});
  await c.advance(1000);assert.equal(api.calls.length,1);
  const spoolFile=path.join(dir,'vardy-spool.jsonl'),spooled=lines(spoolFile);
  assert.deepEqual(spooled.map(l=>l.type),['session_start','chat']);assert.equal(spooled[0].room_id,'room1');assert.equal(spooled[1].dedupe_key,'chat:c1');
  assert.equal(ingest.stats().backoffUntil,c.now()+60000);assert.equal(ingest.stats().spool,2);
  ingest.handle('chat',{user:{id:'2',displayId:'second'},content:'two',common:{msgId:'c2'}});
  await c.advance(59000);assert.equal(api.calls.length,1); // still backing off: nothing was sent
  mode='ok';await c.advance(1000);
  assert.equal(api.calls.length,2);assert.deepEqual(api.calls[1].body.events.map(e=>e.dedupe_key),['session_start:room1:'+T0,'chat:c1','chat:c2']);
  assert.deepEqual(lines(spoolFile),[]);const s=ingest.stats();assert.equal(s.spool,0);assert.equal(s.pending,0);assert.equal(s.failures,1);assert.equal(s.accepted,3);assert.equal(s.backoffUntil,null);
  assert.ok(logs.some(l=>/^\[vardy\] 429 rate limited.*retry in 60 s$/.test(l)),logs.join('\n'));assert.ok(logs.some(l=>/recovered/.test(l)));
  assert.ok(!logs.some(l=>/first|second/.test(l)),'log lines carry counts only');
  await ingest.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('unreachable API: events spool to disk (last 2,000) and a fresh instance replays them in order',async()=>{
 const dir=tmp(),c=clock(),logs=[];
 const down=fakeApi(()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}}));
 const spoolFile=path.join(dir,'vardy-spool.jsonl');
 try{
  const first=make(c,down,dir,logs);
  first.sessionStart({roomId:'room1',handle:'creator'});
  for(let i=0;i<2100;i++)first.handle('chat',{user:{id:'u'+(i%7),displayId:'v'+(i%7)},content:'m'+i,common:{msgId:'c'+i}});
  await c.advance(1000);
  assert.equal(down.calls.length,1);assert.equal(down.calls[0].body.events.length,200);
  let s=first.stats();assert.equal(s.failures,1);assert.equal(s.spool,200);assert.equal(s.pending,1901);assert.equal(s.backoffUntil,c.now()+2000);
  assert.equal(lines(spoolFile).length,200);assert.equal(lines(spoolFile)[0].type,'session_start');
  assert.ok(logs.some(l=>/unreachable \(ECONNREFUSED\)/.test(l)),logs.join('\n'));
  await first.close(); // shutdown while down: everything pending is spooled, the oldest beyond 2,000 are dropped
  s=first.stats();assert.equal(s.pending,0);assert.equal(s.spool,2000);assert.equal(s.dropped,102);
  const saved=lines(spoolFile);assert.equal(saved.length,2000);assert.equal(saved[0].dedupe_key,'chat:c101');assert.equal(saved[1999].type,'session_end');
  const up=fakeApi(),c2=clock(T0+600000);
  const second=make(c2,up,dir,logs);
  assert.equal(second.stats().spool,2000);
  await c2.advance(1000);
  assert.equal(up.calls.length,10);assert.deepEqual(up.calls.map(k=>k.body.events.length),Array(10).fill(200));
  assert.equal(up.calls[0].body.events[0].dedupe_key,'chat:c101');assert.equal(up.calls[9].body.events[199].type,'session_end');assert.equal(up.calls[0].body.room_id,'room1');
  assert.deepEqual(lines(spoolFile),[]);assert.equal(second.stats().spool,0);assert.equal(second.stats().accepted,2000);
  assert.ok(logs.some(l=>/spool: 2000 events waiting from an earlier run/.test(l)));
  await second.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('dry-run without a service key: no HTTP, batches land in vardy-dryrun.jsonl and the log shows counts only',async()=>{
 const dir=tmp(),c=clock(),logs=[],api=fakeApi();
 try{
  const ingest=vardyIngestFromEnv({VARDY_INGEST:'1',VARDY_CREATOR_HANDLE:'creator'},{fetchImpl:api.fetchImpl,log:l=>logs.push(l),runtimeDir:dir,now:c.now,timers:c.timers});c.watch(ingest);
  assert.equal(ingest.dryRun,true);assert.equal(ingest.url,DEFAULT_BASE_URL+'/api/public/live/ingest');
  ingest.sessionStart({roomId:'room1',handle:'creator'});
  ingest.handle('gift',{user:{id:'1',displayId:'secret_handle'},giftId:'1',repeatCount:2,repeatEnd:true,gift:{name:'Rose',diamondCount:1,type:1},common:{msgId:'g1'}});
  ingest.handle('like',{user:{id:'1',displayId:'secret_handle'},count:5});
  await c.advance(1000);
  assert.equal(api.calls.length,0);
  const file=path.join(dir,'vardy-dryrun.jsonl');let batches=lines(file);
  assert.equal(batches.length,1);assert.deepEqual(batches[0].events.map(e=>e.type),['session_start','gift']);assert.equal(batches[0].creator_handle,'creator');assert.equal(batches[0].room_id,'room1');assert.equal(batches[0].url,ingest.url);
  await c.advance(5000); // the like window closes and goes out as its own batch
  batches=lines(file);assert.equal(batches.length,2);assert.equal(batches[1].events[0].type,'like');assert.equal(batches[1].events[0].payload.count,5);
  assert.ok(logs.some(l=>/dry-run batch #1: 2 events \(session_start 1, gift 1\)/.test(l)),logs.join('\n'));
  assert.ok(!logs.some(l=>l.includes('secret_handle')),'no user data in the log');
  const s=ingest.stats();assert.equal(s.dryRunBatches,2);assert.equal(s.sent,3);assert.equal(s.calls,0);
  assert.equal(vardyIngestFromEnv({}),null);assert.equal(vardyIngestFromEnv({VARDY_INGEST:'0',VARDY_SERVICE_KEY:'x'}),null);
  const live=vardyIngestFromEnv({VARDY_INGEST:'1',VARDY_BASE_URL:'https://example.test/',VARDY_SERVICE_KEY:' k '},{runtimeDir:dir,log:()=>{}});assert.equal(live.dryRun,false);assert.equal(live.url,'https://example.test/api/public/live/ingest');await live.close();
  assert.throws(()=>vardyIngestFromEnv({VARDY_INGEST:'1',VARDY_BASE_URL:'ftp://nope'},{runtimeDir:dir}),/VARDY_BASE_URL_INVALID/);
  await ingest.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('413 halves the batch until it fits; 422 drops the batch instead of retrying; 401 waits 60 s',async()=>{
 const dir=tmp(),c=clock(),logs=[];let big=0,auth=false;
 const api=fakeApi(body=>auth?new Response('',{status:401}):body.events.length>60?(big++,new Response('',{status:413})):body.events.some(e=>e.payload.text==='poison')?Response.json({error:'invalid',rejected:[{dedupe_key:'x',reason:'bad'}]},{status:422}):Response.json({accepted:body.events.length,duplicate:0,rejected:[]}));
 try{
  const ingest=make(c,api,dir,logs);
  ingest.sessionStart({roomId:'room1',handle:'creator'});
  for(let i=0;i<199;i++)ingest.handle('chat',{user:{id:'u'},content:'m'+i,common:{msgId:'c'+i}});
  await c.advance(1000);
  assert.equal(big,2);assert.deepEqual(api.calls.map(k=>k.body.events.length),[200,100,50,50,50,50]); // 200 → 413 → 100 → 413 → 50 ok
  assert.deepEqual(api.calls[2].body.events.map(e=>e.dedupe_key).slice(0,2),['session_start:room1:'+T0,'chat:c0']); // order survives the halving
  let s=ingest.stats();assert.equal(s.sent,200);assert.equal(s.batchLimit,50);assert.equal(s.spool,0);assert.equal(s.pending,0);
  ingest.handle('chat',{user:{id:'u'},content:'poison',common:{msgId:'p1'}});
  await c.advance(1000);
  s=ingest.stats();assert.equal(api.calls.length,7);assert.equal(s.dropped,1);assert.equal(s.rejected,1);assert.equal(s.pending,0);assert.equal(s.spool,0);assert.equal(s.backoffUntil,null);
  await c.advance(5000);assert.equal(api.calls.length,7); // not retried
  assert.ok(logs.some(l=>/422 batch rejected: 1 events dropped \(1 listed by the API\)/.test(l)),logs.join('\n'));
  auth=true;ingest.handle('chat',{user:{id:'u'},content:'later',common:{msgId:'l1'}});
  await c.advance(1000);assert.equal(api.calls.length,8);s=ingest.stats();assert.equal(s.spool,1);assert.equal(s.backoffUntil,c.now()+60000);
  assert.ok(logs.some(l=>/401 service key rejected/.test(l)));
  await c.advance(30000);assert.equal(api.calls.length,8);
  await ingest.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('LiveEvents: no ingest without VARDY_INGEST=1; with one it forwards session start, deduped events and the end',async()=>{
 const dir=tmp(),c=clock(),api=fakeApi();
 class Fake extends EventEmitter{async connect(){return{roomId:'room42'};}async disconnect(){this.emit('disconnected');}}
 try{
  assert.equal(new LiveEvents({}).vardy,null);assert.equal(new LiveEvents({env:{VARDY_INGEST:'0'}}).vardy,null);assert.equal(new LiveEvents().vardy,null);
  const vardy=createVardyIngest({baseUrl:'https://vardy.test',serviceKey:'test-key',fetchImpl:api.fetchImpl,log:()=>{},runtimeDir:dir,now:c.now,timers:c.timers});c.watch(vardy);
  let client;const events=new LiveEvents({factory:()=>client=new Fake(),vardy});
  assert.equal((await events.connect('@wanna')).status,'connected');
  client.emit('chat',{content:'hello',user:{id:'1',displayId:'viewer'},common:{msgId:'c1'}});
  client.emit('chat',{content:'hello',user:{id:'1',displayId:'viewer'},common:{msgId:'c1'}}); // duplicate msgId: LiveEvents drops it before the hook
  client.emit('gift',{user:{id:'2',displayId:'fan'},giftId:'1',groupId:'g1',gift:{type:1,name:'Rose',diamondCount:1},repeatCount:3,repeatEnd:0,common:{msgId:'g1'}}); // streak still running
  client.emit('gift',{user:{id:'2',displayId:'fan'},giftId:'1',groupId:'g1',gift:{type:1,name:'Rose',diamondCount:1},repeatCount:5,repeatEnd:1,common:{msgId:'g2'}});
  client.emit('like',{user:{id:'3',displayId:'liker'},count:2,total:'40'});
  client.emit('roomUser',{total:'12',ranks:[],common:{msgId:'r1'}});
  assert.equal(events.state.gifts,5);assert.equal(events.state.viewers,12);
  await events.disconnect();assert.equal(events.state.status,'disconnected');
  await c.advance(1000);
  assert.equal(api.calls.length,1);
  assert.deepEqual(api.calls[0].body.events.map(e=>e.type),['session_start','chat','gift','viewers','like','session_end']);
  assert.equal(api.calls[0].body.room_id,'room42');assert.equal(api.calls[0].body.creator_handle,'wanna');
  assert.equal(api.calls[0].body.events[2].payload.diamonds,5);assert.equal(api.calls[0].body.events[4].payload.count,2);assert.equal(api.calls[0].body.events[5].payload.reason,'disconnect');
  await vardy.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
