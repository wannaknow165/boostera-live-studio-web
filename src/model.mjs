const text=(v,n=160)=>typeof v==='string'?v.slice(0,n):'';
const id=v=>typeof v==='string'&&/^\d{1,30}$/.test(v)?v:'';
const list=v=>Array.isArray(v)?v.filter(x=>x&&typeof x==='object'):[];
const first=(...v)=>v.find(x=>typeof x==='string'&&x)||'';
const safeUrl=v=>{try{const u=new URL(v);return u.protocol==='https:'?u.href:'';}catch{return '';}};
export function normalizeCandidates(batches,snapshot,linked=[]){
  const rows=new Map();
  for(const batch of Object.values(batches||{})){
    if(!batch||typeof batch!=='object'||batch.ticket?.epoch!==snapshot.session?.epoch||!batch.accepted)continue;
    for(const entry of list(batch.entries)){
      const t=entry.target||{},owner=entry.room?.owner||{},uid=id(t.uid),roomId=id(t.roomId);
      if(!uid||!roomId)continue;
      const old=rows.get(uid),source=text(batch.ticket?.query?.section,40);
      rows.set(uid,{uid,roomId,name:text(first(t.nickname,owner.nickname,old?.name)),
        handle:text(first(t.displayId,owner.display_id,old?.handle)),
        avatar:safeUrl(first(t.avatarUrls?.[0],owner.avatar_thumb?.url_list?.[0],old?.avatar)),
        sources:[...new Set([...(old?.sources||[]),source].filter(Boolean))]});
    }
  }
  for(const [uid,user]of Object.entries(snapshot.users||{})){
    if(!id(uid)||uid===snapshot.session?.selfUid||!user||typeof user!=='object')continue;
    const member=linked.find(x=>first(x.uid,x.userId,x.userInfo?.uid,x.userInfo?.userId)===uid);
    const row=rows.get(uid)||{uid,roomId:id(user.roomId),sources:[]},info=member?.userInfo||member?.user||member||{};
    rows.set(uid,{...row,name:text(first(row.name,info.nickname,info.nickName)),
      handle:text(first(row.handle,info.displayId,info.display_id)),
      avatar:safeUrl(first(row.avatar,info.avatarThumb?.urlList?.[0],info.avatar_thumb?.url_list?.[0])),
      linked:user.linked===true,invited:user.invited===true,applied:user.applied===true,
      inviteAvailable:user.availableActions?.invite===true,directAvailable:user.availableActions?.direct===true});
  }
  return[...rows.values()].slice(0,300);
}
export function normalizeSnapshot(s={},options={}){
  const {providerReady,panel,battleStatus,linked,batches,now=Date.now()}=options,session=s.session;
  return{connected:true,observedAt:now,health:text(s.health),live:Boolean(id(session?.roomId)),
    providerReady:providerReady===true,panelReady:panel?.status==='ready',
    session:session?{selfUid:id(session.selfUid),roomId:id(session.roomId),epoch:text(session.epoch)}:null,
    battleStatus:text(battleStatus,40)||'SELECT_MODE',
    battle:s.battle?{id:id(s.battle.battleId),status:text(s.battle.status,40),incoming:Boolean(s.battle.incoming),
      participantUids:(s.battle.participantUids||[]).map(id).filter(Boolean)}:null,
    candidates:normalizeCandidates(batches,s,list(linked)),
    operations:list(s.operations).slice(-20).map(op=>({id:text(op.operationId),kind:text(op.kind,40),
      action:text(op.action,40),phase:text(op.phase,40),step:text(op.step,40),outcome:text(op.outcome,40),
      targetUid:id(op.targetUid),createdAt:Number(op.createdAt)||0,updatedAt:Number(op.updatedAt)||0,
      error:op.error?{code:text(op.error.code),message:text(op.error.message,250)}:null})),
    coverage:{friends:Object.values(batches||{}).some(b=>b?.accepted&&b?.ticket?.epoch===session?.epoch&&b?.ticket?.query?.section==='followed_list'),
      suggested:Object.values(batches||{}).some(b=>b?.accepted&&b?.ticket?.epoch===session?.epoch&&['recommend_list','league_recommend_list'].includes(b?.ticket?.query?.section)),
      truncated:Boolean(batches?.__truncated||Object.values(batches||{}).some(b=>b?.entries?.some?.(v=>typeof v==='string')))},
    actions:{mode:'observe',invite:false,accept:false,reject:false,reason:'NATIVE_CALLER_REQUIRED'}};
}
export function summarizeChanges(previous,next){
  const events=[];
  if(!previous?.connected&&next.connected)events.push({type:'connection',title:'LIVE Studio מחובר',detail:'הנתונים מתקבלים מהתוכנה במחשב.'});
  if(previous?.connected&&!next.connected)events.push({type:'error',title:'החיבור לסטודיו נותק',detail:'הפאנל מנסה להתחבר מחדש.'});
  if(next.connected&&next.live!==Boolean(previous?.live))events.push({type:'live',title:next.live?'השידור פעיל':'אין שידור פעיל',detail:''});
  for(const op of next.operations||[]){
    const old=previous?.operations?.find(x=>x.id===op.id);
    if(old&&old.phase===op.phase&&old.step===op.step&&old.outcome===op.outcome)continue;
    if(!previous?.connected&&op.outcome!=='pending')continue;
    const k=op.kind?.includes('battle')?'באטל':'Co-host';
    const title=op.outcome==='succeeded'?k+': החיבור הצליח':op.outcome==='failed'?k+': הפעולה לא הושלמה':op.step==='awaiting_peer'?k+': ממתינים לאישור':k+': בקשה נשלחה';
    events.push({type:op.outcome==='failed'?'error':'invite',title,detail:op.error?.message||(op.targetUid?'משתתף '+op.targetUid.slice(-6):'')});
  }
  if(next.battle?.id&&(next.battle.id!==previous?.battle?.id||next.battle.status!==previous?.battle?.status))
    events.push({type:'battle',title:next.battle.status==='open'?'באטל פעיל':next.battle.status==='ended'?'הבאטל הסתיים':'בקשת באטל בהמתנה',detail:'מזהה '+next.battle.id});
  const oldLinked=new Set(previous?.candidates?.filter(x=>x.linked).map(x=>x.uid));
  for(const p of next.candidates||[])if(p.linked&&!oldLinked.has(p.uid))events.push({type:'invite',title:'משתתף התחבר',detail:p.name||'משתתף '+p.uid.slice(-6)});
  return events;
}
