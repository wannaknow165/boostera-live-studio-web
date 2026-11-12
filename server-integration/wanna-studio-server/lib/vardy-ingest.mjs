// Vardyverse cloud ingest: pushes the TikTok LIVE events that LiveEvents (lib/mobile-live-events.mjs) receives from
// tiktok-live-connector to the Vardyverse API.
//   POST {VARDY_BASE_URL}/api/public/live/ingest · header x-vardy-service-key
//   body  { creator_handle, room_id, events:[{ type, ts, dedupe_key, payload }] } · at most 200 events per call
//   reply { accepted, duplicate, rejected:[…] }
// Opt-in from env (see vardyIngestFromEnv): VARDY_INGEST=1 · VARDY_BASE_URL · VARDY_SERVICE_KEY · VARDY_CREATOR_HANDLE.
// Without VARDY_SERVICE_KEY it is a DRY-RUN: nothing leaves the machine, every batch it would send goes to
// runtime/vardy-dryrun.jsonl and the log shows counts only (never user data).
// Batching: a 1 s flush timer. While the API is unreachable (network error, 5xx, 429, 401/403/404) the batches wait in
// runtime/vardy-spool.jsonl (the last 2,000 events) and are replayed in order as soon as a call succeeds. 429 backs off
// 60 s (or Retry-After when longer); other failures back off 2 s doubling up to 60 s. 413 halves the batch size; 422 (and
// any other 4xx) drops that batch, since retrying the same events cannot help.
// Event mapping (payload keys are snake_case; user = { id, handle, name }):
//   gift          only the final message of a streak (repeatEnd true/1); a non-streakable gift (type ≠ 1) always counts,
//                 whatever its repeatEnd says, as in LiveEvents.ingest;
//                 diamonds = diamondCount × repeatCount; dedupe_key gift:<transactionId|orderId|logId|msgId> or
//                 gift:<userId>:<giftId>:<timestamp>
//   like          one event per user per 5 s window: { user, count, total_like_count, window_ms }
//   member        viewer joined · chat { user, text } · follow / share { user }
//   viewers       from roomUser: { viewer_count, top_viewers:[{ user, coins, rank }] }
//   battle        from linkMicBattle (phase 'status': action, start/end, participants, results) and linkMicArmies
//                 (phase 'scores': per-host score + top contributors); from managedBattle (the Tik.Tools provider's
//                 projection of battle/battleArmies, lib/tiktools-events.mjs) as phase 'managed': status, times, scores
//   session_start / session_end   connect / disconnect of the LiveEvents connection
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './env.mjs';

export const DEFAULT_BASE_URL='https://vardy-verse-connect.lovable.app';
export const MAX_BATCH=200,SPOOL_MAX=2000,FLUSH_MS=1000,LIKE_WINDOW_MS=5000,RATE_LIMIT_BACKOFF_MS=60000,MAX_BACKOFF_MS=60000;
export const EVENT_TYPES=['gift','like','member','chat','follow','share','viewers','battle','session_start','session_end'];
const BATTLE_ACTIONS={1:'invite',2:'reject',3:'cancel',4:'open',5:'finish',6:'cut_short',7:'accept',8:'quit_apply',9:'decline_quit',10:'decline_off_quit',11:'leave_linkmic'};

const str=(v,max=100)=>v==null?'':String(v).slice(0,max);
const number=v=>Number.isFinite(Number(v))?Number(v):0;
const person=u=>({id:str(u?.id??u?.idStr??u?.userId??u?.userIdStr),handle:str(u?.displayId??u?.uniqueId),name:str(u?.nickName??u?.nickname??u?.displayId??u?.uniqueId)});
const msgId=d=>str(d?.common?.msgId||d?.msgId);
const toMs=v=>{const n=number(v);return n<=0?0:n<1e11?Math.round(n*1000):Math.round(n);};
const iso=ms=>new Date(ms).toISOString();
// the message's own time when the connector carries one (stable across a redelivery), otherwise the time we got it
const eventTime=(d,now)=>{for(const v of[d?.timestamp,d?.common?.createTime,d?.createTime]){const ms=toMs(v);if(ms&&Math.abs(ms-now)<86400000)return ms;}return now;};
const event=(type,ts,key,payload)=>({type,ts:iso(ts),dedupe_key:str(key,200),payload});
const list=(...candidates)=>candidates.find(Array.isArray)||[];

// connector event → 0..n Vardyverse events (pure). Likes are not mapped here: LikeWindows aggregates them.
export function mapEvent(type,data={},{now=Date.now()}={}){
  data=data||{};
  const ts=eventTime(data,now),id=msgId(data),who=person(data.user),self=who.id||who.handle||'anon';
  const own=prefix=>prefix+':'+(id||self+':'+ts);
  if(type==='gift'){
    const gift=data.gift||data.extendedGiftInfo||{};
    const streakable=number(gift.type??data.giftType??gift.gift_type)===1,ended=data.repeatEnd===true||number(data.repeatEnd)===1;
    if(streakable&&!ended)return[]; // streak still running: its last message carries the total (same rule as LiveEvents.ingest)
    const giftId=str(data.giftId??gift.id),count=Math.max(1,Math.min(100000,number(data.repeatCount)||1)),each=Math.max(0,number(gift.diamondCount??data.diamondCount));
    const tx=str(data.transactionId||data.orderId||data.logId||id);
    return[event('gift',ts,'gift:'+(tx||self+':'+giftId+':'+ts),{gift_id:giftId,gift_name:str(gift.name??data.giftName)||giftId,diamond_count:each,repeat_count:count,diamonds:each*count,user:who,msg_id:id||null})];
  }
  if(type==='chat')return[event('chat',ts,own('chat'),{user:who,text:str(data.content??data.comment,500)})];
  if(type==='member')return[event('member',ts,own('member'),{user:who,action:number(data.action)||null,member_count:number(data.memberCount)||null})];
  if(type==='follow'||type==='share')return[event(type,ts,own(type),{user:who})];
  if(type==='social'){const key=String(data.common?.displayText?.key??data.displayType??'').toLowerCase();const kind=key.includes('follow')?'follow':key.includes('share')?'share':null;return kind?[event(kind,ts,own(kind),{user:who})]:[];}
  if(type==='roomUser'){
    const top=list(data.topViewers,data.ranks,data.ranksList).slice(0,10).map((v,i)=>({user:person(v?.user||v),coins:number(v?.coinCount??v?.score),rank:number(v?.rank)||i+1})).filter(v=>v.user.id||v.user.handle);
    return[event('viewers',ts,'viewers:'+(id||ts),{viewer_count:Math.max(0,number(data.viewerCount??data.total??data.userCount??data.totalUser)),top_viewers:top})];
  }
  if(type==='linkMicBattle'){
    const battleId=str(data.battleId),settings=data.battleSettings||{},start=toMs(settings.startTimeMs??settings.startTime),end=toMs(settings.endTimeMs??settings.endTime),action=number(data.action);
    const anchors=Array.isArray(data.anchorsInfo)?data.anchorsInfo:Object.values(data.anchorsInfo||{});
    const participants=anchors.map(a=>person(a?.value?.user||a?.user||a)).filter(p=>p.id||p.handle).slice(0,12);
    const results=Object.entries(data.battleResult||{}).map(([key,v])=>({id:str(v?.userId||key),result:number(v?.result),score:number(v?.score)}));
    return[event('battle',ts,`battle:${battleId}:`+(id||'status:'+ts),{battle_id:battleId,phase:'status',action,action_name:BATTLE_ACTIONS[action]||null,start_time:start?iso(start):null,end_time:end?iso(end):null,duration:number(settings.duration)||null,participants,results})];
  }
  if(type==='linkMicArmies'){
    const battleId=str(data.battleId),entries=Array.isArray(data.armies)?data.armies:Object.entries(data.armies||{}).map(([key,value])=>({key,value}));
    const scores=entries.map(a=>{const v=a?.value||a||{};return{id:str(a?.key??v.anchorIdStr??v.hostUserId??v.userId),score:number(v.hostscore??v.score??v.totalScore??v.points??v.battlePoints),contributors:list(v.userArmies,v.users,v.contributors).slice(0,10).map(u=>({...person(u?.user||u),score:number(u?.score??u?.points)}))};});
    return[event('battle',ts,`battle:${battleId}:`+(id||'scores:'+ts),{battle_id:battleId,phase:'scores',reason:number(data.triggerReason)||null,total_diamonds:number(data.totalDiamondCount)||null,scores})];
  }
  if(type==='managedBattle'){ // Tik.Tools provider: battle/battleArmies already projected by managedBattle()
    const b=data.battle||{};if(!b.id)return[];
    const scores=(Array.isArray(b.scores)?b.scores:[]).map(s=>({id:str(s?.id),score:number(s?.score),members:(Array.isArray(s?.members)?s.members:[]).slice(0,20).map(m=>str(m)),contributors:(Array.isArray(s?.contributors)?s.contributors:[]).slice(0,10).map(c=>({id:str(c?.id),handle:str(c?.handle),name:str(c?.name),score:number(c?.score)}))}));
    return[event('battle',ts,`battle:${b.id}:`+(id||'managed:'+(toMs(b.serverTsMs)||ts)),{battle_id:str(b.id),phase:'managed',status:str(b.status),start_time:toMs(b.startTimeMs)?iso(toMs(b.startTimeMs)):null,end_time:toMs(b.endTimeMs)?iso(toMs(b.endTimeMs)):null,duration:number(b.duration)||null,scores})];
  }
  return[];
}

// likes: one event per user per window (5 s). add() returns windows that closed because a newer like opened the next one,
// drain(now) returns every window that is old enough (force = all of them). Items are { room, ev }.
export class LikeWindows{
  constructor(windowMs=LIKE_WINDOW_MS){this.windowMs=windowMs;this.open=new Map();}
  get size(){return this.open.size;}
  add(data,now,room=''){
    data=data||{};const who=person(data.user),key=who.id||who.handle||'anon',count=Math.max(0,number(data.likeCount??data.count)),total=Math.max(0,number(data.totalLikeCount??data.total));
    const out=[];let w=this.open.get(key);
    if(w&&now-w.start>=this.windowMs){out.push(this.close(key));w=null;}
    if(!w){w={start:now,user:who,count:0,total:0,room};this.open.set(key,w);}
    w.count+=count;if(total)w.total=total;
    return out.filter(Boolean);
  }
  close(key){const w=this.open.get(key);this.open.delete(key);if(!w||!w.count)return null;return{room:w.room,ev:event('like',w.start,'like:'+(w.user.id||w.user.handle||'anon')+':'+w.start,{user:w.user,count:w.count,total_like_count:w.total||null,window_ms:this.windowMs})};}
  drain(now,force=false){const out=[];for(const[key,w]of[...this.open])if(force||now-w.start>=this.windowMs){const item=this.close(key);if(item)out.push(item);}return out;}
}

// null unless VARDY_INGEST=1 — then an ingest built from VARDY_BASE_URL / VARDY_SERVICE_KEY / VARDY_CREATOR_HANDLE
export function vardyIngestFromEnv(env={},overrides={}){
  const flag=String(env.VARDY_INGEST??'').trim().toLowerCase();
  if(flag!=='1'&&flag!=='true')return null;
  return createVardyIngest({baseUrl:String(env.VARDY_BASE_URL||'').trim()||DEFAULT_BASE_URL,serviceKey:String(env.VARDY_SERVICE_KEY??'').trim(),creatorHandle:String(env.VARDY_CREATOR_HANDLE??'').trim(),...overrides});
}

export function createVardyIngest({baseUrl=DEFAULT_BASE_URL,serviceKey='',creatorHandle='',fetchImpl,log,runtimeDir,now=()=>Date.now(),timers=globalThis,flushMs=FLUSH_MS,maxBatch=MAX_BATCH,spoolMax=SPOOL_MAX,likeWindowMs=LIKE_WINDOW_MS,requestTimeoutMs=10000}={}){
  const base=String(baseUrl||'').trim().replace(/\/+$/,'');
  if(!/^https?:\/\/[^/\s]+/i.test(base))throw Object.assign(Error('VARDY_BASE_URL_INVALID'),{status:400});
  const url=base+'/api/public/live/ingest',dryRun=!serviceKey;
  const dir=runtimeDir||path.join(ROOT,'runtime'),spoolFile=path.join(dir,'vardy-spool.jsonl'),dryRunFile=path.join(dir,'vardy-dryrun.jsonl');
  const out=typeof log==='function'?log:(...a)=>console.log(...a);
  const doFetch=typeof fetchImpl==='function'?fetchImpl:(...a)=>globalThis.fetch(...a);
  const likes=new LikeWindows(likeWindowMs);
  const counters={queued:0,calls:0,sent:0,accepted:0,duplicate:0,rejected:0,spooled:0,dropped:0,failures:0,dryRunBatches:0,mapErrors:0,lastStatus:null,lastError:null};
  const session={active:false,roomId:'',handle:'',startedAt:0};
  const limitMax=Math.max(1,Math.min(MAX_BATCH,maxBatch));
  let queue=[],spool=[],timer=null,inflight=null,retryAt=0,backoffMs=0,limit=limitMax,closed=false,lastLog='',lastLogAt=0;

  function note(message,always=false){const t=now();if(!always&&message===lastLog&&t-lastLogAt<60000)return;lastLog=message;lastLogAt=t;out('[vardy] '+message);}
  const summary=events=>{const counts={};for(const e of events)counts[e.type]=(counts[e.type]||0)+1;return Object.entries(counts).map(([t,n])=>t+' '+n).join(', ');};
  function loadSpool(){
    try{
      if(!fs.existsSync(spoolFile))return[];
      const items=[];
      for(const line of fs.readFileSync(spoolFile,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{const r=JSON.parse(line);if(r&&EVENT_TYPES.includes(r.type)&&r.dedupe_key)items.push({room:str(r.room_id),ev:{type:r.type,ts:str(r.ts,40),dedupe_key:str(r.dedupe_key,200),payload:r.payload??{}}});}catch{}}
      if(items.length)note(`spool: ${items.length} events waiting from an earlier run`);
      return items.slice(-spoolMax);
    }catch(e){note('spool read failed: '+(e.code||e.message));return[];}
  }
  function persistSpool(){try{fs.mkdirSync(dir,{recursive:true});const tmp=spoolFile+'.tmp';fs.writeFileSync(tmp,spool.map(i=>JSON.stringify({room_id:i.room,...i.ev})+'\n').join(''));fs.renameSync(tmp,spoolFile);}catch(e){note('spool write failed: '+(e.code||e.message));}}
  function writeDryRun(body){try{fs.mkdirSync(dir,{recursive:true});try{if(fs.statSync(dryRunFile).size>25e6)fs.renameSync(dryRunFile,dryRunFile+'.1');}catch{}fs.appendFileSync(dryRunFile,JSON.stringify({at:iso(now()),url,...body})+'\n');}catch(e){note('dry-run write failed: '+(e.code||e.message));}}
  function toSpool(items,front=false){if(!items.length)return;if(front)spool.unshift(...items);else spool.push(...items);if(spool.length>spoolMax){counters.dropped+=spool.length-spoolMax;spool.splice(0,spool.length-spoolMax);}counters.spooled+=items.length;persistSpool();}
  function schedule(ms){if(closed||timer)return;timer=timers.setTimeout(()=>{timer=null;void run();},Math.max(0,ms));if(typeof timer?.unref==='function')timer.unref();}
  function reschedule(ms){if(timer){timers.clearTimeout(timer);timer=null;}schedule(ms);}
  // the queue holds at most spoolMax events in memory; older ones move to the spool file in chunks
  function push(room,ev){queue.push({room,ev});counters.queued++;if(queue.length>spoolMax)toSpool(queue.splice(0,Math.max(limitMax,queue.length-spoolMax)));schedule(flushMs);}
  // one batch = up to `limit` events of one room: spooled (older) events first, then the live queue
  function take(){const items=[];let room=null,fromSpool=0;for(const source of[spool,queue]){while(source.length&&items.length<limit&&(room===null||source[0].room===room)){room=source[0].room;items.push(source.shift());if(source===spool)fromSpool++;}if(items.length>=limit)break;}return items.length?{room,items,fromSpool}:null;}
  function giveBack(batch){toSpool(batch.items,batch.fromSpool>0);}
  function failed(batch,status,why,wait){counters.failures++;counters.lastError=why;backoffMs=wait||Math.min(MAX_BACKOFF_MS,backoffMs?backoffMs*2:2000);retryAt=now()+backoffMs;giveBack(batch);note(`${status||'network'} ${why}: ${batch.items.length} events kept in the spool (${spool.length} waiting), retry in ${Math.round(backoffMs/1000)} s`);}
  async function parse(res){try{const text=await res.text();return text?JSON.parse(text):{};}catch{return{};}}
  async function send(batch){
    const {items,room,fromSpool}=batch,events=items.map(i=>i.ev),body={creator_handle:creatorHandle||session.handle||'',room_id:room,events};
    if(dryRun){counters.dryRunBatches++;counters.sent+=events.length;writeDryRun(body);if(fromSpool)persistSpool();note(`dry-run batch #${counters.dryRunBatches}: ${events.length} events (${summary(events)}) not sent, see runtime/vardy-dryrun.jsonl`,true);return;}
    let res;counters.calls++;
    try{res=await doFetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-vardy-service-key':serviceKey},body:JSON.stringify(body),signal:AbortSignal.timeout(requestTimeoutMs)});}
    catch(e){return failed(batch,0,'unreachable ('+str(e?.cause?.code||e?.code||e?.name||'error',60)+')');}
    counters.lastStatus=res.status;
    if(res.ok){
      const reply=await parse(res),accepted=number(reply.accepted),duplicate=number(reply.duplicate),rejected=Array.isArray(reply.rejected)?reply.rejected.length:number(reply.rejected);
      counters.sent+=events.length;counters.accepted+=accepted;counters.duplicate+=duplicate;counters.rejected+=rejected;
      if(fromSpool)persistSpool();
      if(backoffMs||rejected)note(`sent ${events.length} events: accepted ${accepted}, duplicate ${duplicate}, rejected ${rejected}`+(backoffMs?' (recovered, '+spool.length+' still spooled)':''),true);
      retryAt=0;backoffMs=0;return;
    }
    if(res.status===413){ // too big for the API: halve the batch size (kept for the life of the process) or drop a lone giant event
      if(items.length>1){limit=Math.max(1,Math.floor(items.length/2));giveBack(batch);note(`413 payload too large: batch size lowered to ${limit}`);}
      else{counters.dropped++;counters.rejected++;if(fromSpool)persistSpool();note('413 payload too large: one event dropped');}
      return;
    }
    if(res.status===429){const ra=Number(res.headers?.get?.('retry-after'));return failed(batch,429,'rate limited',Math.max(RATE_LIMIT_BACKOFF_MS,Number.isFinite(ra)&&ra>0?ra*1000:0));}
    if(res.status===401||res.status===403)return failed(batch,res.status,'service key rejected (check VARDY_SERVICE_KEY)',RATE_LIMIT_BACKOFF_MS);
    if(res.status===404)return failed(batch,404,'ingest endpoint not found (check VARDY_BASE_URL)',RATE_LIMIT_BACKOFF_MS);
    if(res.status>=500)return failed(batch,res.status,'server error');
    const reply=await parse(res),listed=Array.isArray(reply.rejected)?reply.rejected.length:0; // 422 or another 4xx: this batch is bad, retrying cannot help
    counters.rejected+=events.length;counters.dropped+=events.length;if(fromSpool)persistSpool();
    note(`${res.status} batch rejected: ${events.length} events dropped (${listed} listed by the API)`,true);
  }
  async function flush(){
    for(const w of likes.drain(now()))push(w.room,w.ev);
    try{while(now()>=retryAt){const batch=take();if(!batch)break;await send(batch);}}catch(e){counters.lastError='flush: '+str(e?.message,120);}
    if(!closed&&(queue.length||spool.length||likes.size))schedule(now()<retryAt?retryAt-now():flushMs);
    return counters.calls;
  }
  function run(){if(!inflight)inflight=flush().finally(()=>{inflight=null;});return inflight;}
  const idle=()=>inflight||Promise.resolve();
  function handle(type,data){
    if(closed)return 0;
    try{
      if(type==='like'){for(const w of likes.add(data,now(),session.roomId))push(w.room,w.ev);schedule(flushMs);return 0;}
      const events=mapEvent(type,data,{now:now()});for(const ev of events)push(session.roomId,ev);return events.length;
    }catch(e){counters.mapErrors++;counters.lastError='map: '+str(e?.message,120);return 0;}
  }
  function sessionStart({roomId='',handle=''}={}){
    if(closed)return false;if(session.active)sessionEnd({reason:'reconnect'});
    const t=now();Object.assign(session,{active:true,roomId:str(roomId),handle:str(handle).replace(/^@/,''),startedAt:t});
    for(const q of queue)if(!q.room)q.room=session.roomId; // events that arrived while the room id was still unknown
    push(session.roomId,event('session_start',t,`session_start:${session.roomId}:${t}`,{handle:session.handle,room_id:session.roomId,started_at:iso(t)}));
    return true;
  }
  function sessionEnd({reason='disconnect'}={}){
    if(closed||!session.active)return false;
    const t=now();for(const w of likes.drain(t,true))push(w.room,w.ev);
    push(session.roomId,event('session_end',t,`session_end:${session.roomId}:${t}`,{handle:session.handle,room_id:session.roomId,reason:str(reason,40),ended_at:iso(t),duration_ms:Math.max(0,t-session.startedAt)}));
    session.active=false;reschedule(0);return true;
  }
  async function close(){
    if(closed)return;
    if(session.active)sessionEnd({reason:'shutdown'});
    for(const w of likes.drain(now(),true))push(w.room,w.ev);
    if(timer){timers.clearTimeout(timer);timer=null;}
    await run();closed=true;
    if(timer){timers.clearTimeout(timer);timer=null;}
    if(queue.length)toSpool(queue.splice(0)); // whatever could not be sent survives for the next run
  }
  const stats=()=>({...counters,pending:queue.length,spool:spool.length,dryRun,url,batchLimit:limit,backoffUntil:retryAt||null,session:{...session}});
  spool=loadSpool();if(spool.length)schedule(flushMs);
  return{handle,sessionStart,sessionEnd,flush:run,idle,close,stats,dryRun,url,files:{spool:spoolFile,dryRun:dryRunFile}};
}
