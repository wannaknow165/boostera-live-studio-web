import {EventEmitter} from 'node:events';
const str=(v,max=100)=>v==null?'':String(v).slice(0,max);
const number=v=>Number.isFinite(Number(v))?Number(v):0;
const person=u=>({id:str(u?.id??u?.userId),handle:str(u?.displayId??u?.uniqueId),name:str(u?.nickName??u?.nickname??u?.displayId??u?.uniqueId)});
export class LiveEvents extends EventEmitter{
  constructor({factory,signApiKey='',onAutomation=async()=>{}}={}){
    super();this.factory=factory;this.signApiKey=signApiKey;this.onAutomation=onAutomation;
    this.client=null;this.generation=0;this.seen=new Map();this.listeners=new Set();
    this.state={status:'disconnected',handle:'',roomId:null,viewers:0,likes:0,gifts:0,diamonds:0,battle:null,participants:[],supporters:[],events:[],lastEventAt:null,error:null};
  }
  snapshot(){return structuredClone(this.state);}
  publish(){const state=this.snapshot();this.emit('state',state);return state;}
  log(type,data){const ev={type,at:Date.now(),...data};this.state.events.unshift(ev);this.state.events=this.state.events.slice(0,60);this.state.lastEventAt=ev.at;return ev;}
  async connect(handle){
    if(!/^@?[a-zA-Z0-9_.]{2,32}$/.test(handle||''))throw Object.assign(new Error('INVALID_TIKTOK_HANDLE'),{status:400});
    await this.disconnect();const generation=++this.generation;this.state={...this.state,status:'connecting',handle:handle.replace(/^@/,''),roomId:null,error:null,battle:null,participants:[],supporters:[],gifts:0,diamonds:0,viewers:0,likes:0,events:[]};this.seen.clear();this.publish();
    try{
      const options={processInitialData:false,enableExtendedGiftInfo:true,...(this.signApiKey?{signApiKey:this.signApiKey}:{})};
      if(this.factory)this.client=await this.factory(this.state.handle,options);
      else{const mod=await import('tiktok-live-connector');const Connection=mod.TikTokLiveConnection||mod.WebcastPushConnection;if(!Connection)throw Error('CONNECTOR_NOT_INSTALLED');this.client=new Connection(this.state.handle,options);}
      const client=this.client;
      for(const event of ['gift','chat','like','roomUser','member','follow','share','linkMicBattle','linkMicArmies','linkMicBattleItemCard','linkMicBattlePunishFinish','linkMicMethod','linkMessage','linkLayer']){
        client.on(event,data=>{if(generation===this.generation)try{this.ingest(event,data);}catch{this.state.error='UNRECOGNIZED_EVENT_PAYLOAD';this.publish();}});
      }
      client.on('error',()=>{if(generation===this.generation){this.state.error='TIKTOK_CONNECTION_ERROR';this.publish();}});
      client.on('disconnected',()=>{if(generation===this.generation){this.state.status='disconnected';this.publish();}});
      client.on('streamEnd',()=>{if(generation===this.generation){this.state.status='ended';this.publish();}});
      const connected=await client.connect();
      if(generation!==this.generation){await client.disconnect();return this.snapshot();}
      this.state.status='connected';this.state.roomId=str(connected?.roomId||client.roomId);this.state.error=null;return this.publish();
    }catch(error){if(generation===this.generation){this.state.status='error';this.state.error=/not live|offline/i.test(error.message)?'CREATOR_OFFLINE':error.code==='ERR_MODULE_NOT_FOUND'?'CONNECTOR_NOT_INSTALLED':'CONNECTION_FAILED_OR_SIGNING_REQUIRED';this.publish();}return this.snapshot();}
  }
  async disconnect(){++this.generation;const client=this.client;this.client=null;if(client)try{await client.disconnect();}catch{}this.state.status='disconnected';return this.publish();}
  ingest(type,data={}){
    const messageId=str(data.common?.msgId||data.msgId);
    const key=messageId?type+':'+messageId:null;
    if(key&&this.seen.has(key))return false;
    if(key)this.seen.set(key,Date.now());
    for(const[k,t]of this.seen)if(Date.now()-t>600000||this.seen.size>3000)this.seen.delete(k);
    const who=person(data.user);
    if(type==='gift'){
      const gift=data.gift||data.extendedGiftInfo||{};
      if(number(gift.type??data.giftType)===1&&data.repeatEnd!==true&&number(data.repeatEnd)!==1)return false;
      const group=str(data.groupId),giftId=str(data.giftId??gift.id);
      const groupKey=group?'streak:'+group+':'+who.id+':'+giftId:null;if(groupKey&&this.seen.has(groupKey))return false;if(groupKey)this.seen.set(groupKey,Date.now());
      const count=Math.max(1,Math.min(100000,number(data.repeatCount)||1)),diamonds=Math.max(0,number(gift.diamondCount??data.diamondCount))*count;
      const name=str(gift.name??data.giftName)||giftId;
      this.state.gifts+=count;this.state.diamonds+=diamonds;
      const id=who.id||who.handle;let supporter=this.state.supporters.find(p=>p.id===id);if(!supporter){supporter={...who,id,diamonds:0,gifts:0};this.state.supporters.push(supporter);}supporter.diamonds+=diamonds;supporter.gifts+=count;this.state.supporters.sort((a,b)=>b.diamonds-a.diamonds);this.state.supporters=this.state.supporters.slice(0,100);
      this.log(type,{user:who,name,count,diamonds});
      void Promise.resolve(this.onAutomation({type:'gift',user:this.state.handle,supporter:who.handle||who.name,gift:name,count,source:'tiktok',eventId:messageId||groupKey})).catch(()=>{});
    }else if(type==='roomUser'){this.state.viewers=number(data.viewerCount??data.total??data.userCount);this.log(type,{viewers:this.state.viewers});}
    else if(type==='like'){this.state.likes=number(data.totalLikeCount??data.total)||this.state.likes+number(data.likeCount);this.log(type,{user:who,count:number(data.likeCount)});}
    else if(type==='chat')this.log(type,{user:who,text:str(data.content??data.comment,300)});
    else if(type==='linkMicBattle'){
      const id=str(data.battleId),old=this.state.battle;
      const settings=data.battleSettings||{},start=number(settings.startTime),end=number(settings.endTime);
      const anchors=Array.isArray(data.anchorsInfo)?data.anchorsInfo:[];
      this.state.participants=anchors.map(a=>person(a.value?.user||a.user||a)).filter(p=>p.id||p.handle).slice(0,12);
      this.state.battle={id,action:str(data.action),startTime:start,endTime:end,duration:number(settings.duration),scores:old?.id===id?old.scores:[],observedAt:Date.now()};
      this.log(type,{battleId:id,action:str(data.action)});
      if(id&&old?.id!==id&&start>0&&Math.abs(Date.now()/1000-start)<90&&(end===0||end>Date.now()/1000))void Promise.resolve(this.onAutomation({type:'battle_start',user:this.state.handle,source:'tiktok',battleId:id})).catch(()=>{});
    }else if(type==='linkMicArmies'){
      const id=str(data.battleId),entries=Array.isArray(data.armies)?data.armies:Object.entries(data.armies||{}).map(([key,value])=>({key,value}));
      const scores=entries.map(a=>{const v=a.value||a;return{id:str(a.key??v.hostUserId??v.userId),score:number(v.score??v.totalScore??v.points??v.battlePoints),contributors:(Array.isArray(v.users)?v.users:Array.isArray(v.contributors)?v.contributors:[]).slice(0,10).map(u=>({...person(u.user||u),score:number(u.score??u.points)}))};});
      this.state.battle={...(this.state.battle?.id===id?this.state.battle:{}),id,scores,observedAt:Date.now()};this.log(type,{battleId:id,scores});
    }else if(type==='linkMicBattleItemCard'){
      const mult=number(data.useCriticalStrikeCard?.multiplier??data.useCriticalStrikeCard?.effectConfig?.multiplier);
      this.log(type,{battleId:str(data.battleId),messageType:str(data.msgType),multiplier:[2,3,5].includes(mult)?mult:null});
      if([2,3,5].includes(mult))void Promise.resolve(this.onAutomation({type:'gift_x'+mult,user:this.state.handle,source:'tiktok',battleId:str(data.battleId)})).catch(()=>{});
    }else this.log(type,{user:who,battleId:str(data.battleId),messageType:str(data.msgType)});
    this.publish();return true;
  }
}
