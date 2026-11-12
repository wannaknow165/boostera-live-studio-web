'use strict';
const $=id=>document.getElementById(id);
const local=location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname)&&location.port==='47831';
let inviteDraft=null,inviteBusy=false;
let battleControl=null,battleBusy=false,battleLoading=false,battleReceipt=null;
let state={connected:false,candidates:[],operations:[],events:[]},tab='all',busy=false,toastTimer,requestVersion=0;
const set=(id,text)=>{$(id).textContent=text;};
const time=value=>new Date(value).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function toast(message){set('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},5000);}
function showHelp(){$('help-dialog').showModal();}
for(const id of ['help','side-help','setup-action'])$(id).addEventListener('click',showHelp);
$('close-help').addEventListener('click',()=>$('help-dialog').close());
$('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
if(local)$('download').hidden=true;
async function focusStudio(){
  if(!local){showHelp();return;}
  try{const r=await fetch('/api/focus-studio',{method:'POST'}),result=await r.json();toast(result.ok?'עברנו ל־LIVE Studio. פעולות ההזמנה מתבצעות שם.':'פתח את LIVE Studio משורת המשימות.');}catch{toast('המעבר לסטודיו לא זמין כרגע.');}
}
$('focus').addEventListener('click',focusStudio);
$('refresh').addEventListener('click',async()=>{
  if(!local){showHelp();return;}
  $('refresh').disabled=true;
  try{await fetch('/api/refresh',{method:'POST'});await update();toast('הנתונים רועננו. רשימות חדשות נטענות מתוך Co-host בסטודיו.');}catch{toast('לא ניתן לרענן כרגע.');}
  finally{$('refresh').disabled=false;}
});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
  tab=button.dataset.tab;document.querySelectorAll('[data-tab]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});renderCandidates();
}));
$('search').addEventListener('input',renderCandidates);
function avatar(person,large=false){
  const el=document.createElement('div');el.className='avatar'+(large?' large':'');
  el.textContent=(person.name||person.handle||'B').trim().slice(0,1).toUpperCase();
  if(person.avatar){const img=document.createElement('img');img.alt='';img.src=person.avatar;img.referrerPolicy='no-referrer';img.addEventListener('error',()=>{img.remove();el.textContent=(person.name||'B').slice(0,1);},{once:true});el.replaceChildren(img);}
  return el;
}
function renderStage(){
  const stage=$('stage');stage.replaceChildren();
  const self=document.createElement('div');self.className='stage-person self';
  self.append(avatar({name:state.self?.name||'B'},true));
  const name=document.createElement('strong');name.textContent=state.self?.name||'החשבון שלך';self.append(name);
  const label=document.createElement('span');label.textContent=state.live?'בשידור עכשיו':state.connected?'מוכן בסטודיו':'ממתין לסטודיו';self.append(label);
  stage.append(self);
  const linked=(state.candidates||[]).filter(p=>p.linked);
  const people=linked.length?linked.slice(0,3):[null];
  for(const person of people){
    const vs=document.createElement('div');vs.className='versus';vs.textContent=state.battle?.status==='open'?'VS':'×';stage.append(vs);
    const card=document.createElement('div');card.className='stage-person'+(!person?' empty':'');
    if(person){card.append(avatar(person,true));const name=document.createElement('strong');name.textContent=person.name||'משתתף '+person.uid.slice(-6);card.append(name);const tag=document.createElement('span');tag.textContent='מחובר ב־Co-host';card.append(tag);}
    else{const a=document.createElement('div');a.className='avatar large';a.textContent='+';card.append(a);const n=document.createElement('strong');n.textContent='המקום הבא בלייב';const note=document.createElement('span');note.textContent='משתתף יופיע כאן אחרי חיבור';card.append(n,note);}
    stage.append(card);
  }
}
function renderCandidates(){
  const container=$('candidate-list'),needle=$('search').value.trim().toLocaleLowerCase('he');
  let people=(state.candidates||[]).filter(p=>{
    if(tab==='friends'&&!p.sources?.includes('followed_list'))return false;
    if(tab==='suggested'&&!p.sources?.some(s=>['recommend_list','league_recommend_list','may_know_list','game_list'].includes(s)))return false;
    if(tab==='linked'&&!p.linked)return false;
    return !needle||[p.name,p.handle,p.uid].join(' ').toLocaleLowerCase('he').includes(needle);
  }).sort((a,b)=>Number(b.linked)-Number(a.linked)||Number(b.invited)-Number(a.invited)||String(a.name||a.uid).localeCompare(String(b.name||b.uid),'he'));
  set('candidate-count',String(people.length));container.replaceChildren();
  if(!people.length){
    const empty=document.createElement('div');empty.className='empty-state';
    const icon=document.createElement('div');icon.className='empty-icon';icon.textContent='↔';
    const title=document.createElement('h3');title.textContent=needle?'לא נמצאו יוצרים בחיפוש':tab==='linked'?'עדיין אין משתתפים מחוברים':'הרשימה הזו עדיין לא נטענה';
    const p=document.createElement('p');p.textContent=needle?'נסה שם, כינוי או מזהה אחר.':'פתח את הרשימה בפאנל Co-host בסטודיו. הנתונים יופיעו כאן אוטומטית.';
    empty.append(icon,title,p);container.append(empty);return;
  }
  for(const person of people){
    const row=document.createElement('article');row.className='candidate';row.append(avatar(person));
    const info=document.createElement('div');info.className='person-info';
    const name=document.createElement('strong');name.textContent=person.name||'משתתף '+person.uid.slice(-6);
    const handle=document.createElement('small');handle.textContent=person.handle?'@'+person.handle:'ID '+person.uid;info.append(name,handle);row.append(info);
    const status=document.createElement('span');status.className='person-state'+(person.invited?' pending':'');
    status.textContent=person.linked?'מחובר':person.invited?'ממתין לאישור':person.applied?'בקשה פתוחה':person.inviteAvailable?'זמין להזמנה':'לא זמין להזמנה';row.append(status);
    const action=document.createElement('button');
    const canInvite=state.actions?.invite&&person.inviteAvailable&&!person.linked&&!person.invited;
    action.className='native-button'+(canInvite?' send-invite':'');
    action.textContent=person.linked?'מחובר':person.invited?'ממתין לאישור':canInvite?'שלח הזמנה':'ביצוע בסטודיו ↗';
    action.disabled=Boolean(inviteBusy||person.linked||person.invited);
    action.title=canInvite?'שליחת הזמנת Co-host מהחשבון שלך':'פעולה זו אינה זמינה כרגע מהפאנל';
    action.addEventListener('click',()=>canInvite?beginInvite(person):focusStudio());row.append(action);container.append(row);
  }
}
function renderEvents(){
  if(!state.events?.length)return;
  const container=$('events');container.replaceChildren();
  for(const event of [...state.events].reverse().slice(0,50)){
    const row=document.createElement('article');row.className='event '+event.type;
    const symbol=document.createElement('div');symbol.className='event-symbol';symbol.textContent=event.type==='error'?'!':event.type==='battle'?'⚑':'✓';
    const content=document.createElement('div');content.className='event-text';
    const title=document.createElement('strong');title.textContent=event.title;
    const detail=document.createElement('p');detail.textContent=event.detail;
    const stamp=document.createElement('time');stamp.dateTime=new Date(event.at).toISOString();stamp.textContent=time(event.at);
    content.append(title,detail,stamp);row.append(symbol,content);container.append(row);
  }
}
function render(){
  const connected=state.connected,live=connected&&state.live,linked=(state.candidates||[]).filter(p=>p.linked).length;
  const waiting=(state.operations||[]).filter(op=>op.outcome==='pending');
  $('connection-pill').className='pill'+(connected?'':' muted');
  $('connection-pill').replaceChildren();const dot=document.createElement('i');$('connection-pill').append(dot,document.createTextNode(connected?'הסטודיו מחובר':local?'ממתין לסטודיו':'פאנל מקומי'));
  set('live-label',live?'LIVE עכשיו':connected?'מוכן לשידור':'ממתין לחיבור');
  $('live-label').closest('.stat').classList.toggle('live-stat',Boolean(live));
  set('live-detail',live?'שידור פעיל ב־TikTok':connected?'אין שידור פעיל כרגע':'המחבר מנסה להתחבר');
  set('linked-count',connected?String(linked+(live?1:0)):'—');set('pending-count',connected?String(waiting.length+(state.battle?.incoming?1:0)):'—');
  const b=state.battle;
  set('battle-label',!connected?'—':b?.status==='open'?'באטל פעיל':b?.status==='pending'?'ממתין לאישור':b?.status==='ended'?'הסתיים':state.battleStatus==='PREPARING'?'בהכנה':'אין באטל פעיל');
  set('battle-detail',b?.id?'ID '+b.id:connected?'ממתין לבאטל הבא':'ממתין לנתונים מהסטודיו');
  set('pending-detail',waiting.length?'ממתינים לתגובה מהצד השני':'Co-host ובאטל');
  $('stage-pill').className='pill'+(live?' live':' muted');$('stage-pill').replaceChildren();const d=document.createElement('i');$('stage-pill').append(d,document.createTextNode(live?'LIVE':connected?'STANDBY':'OFFLINE'));
  set('room-code',state.session?.roomId?'ROOM '+state.session.roomId:'—');
  set('stage-footer-text',live?'המשתתפים מסונכרנים עם הסטודיו':connected?'הסטודיו מחובר. אפשר להתחיל שידור.':'תמונת המצב מתקבלת מ־LIVE Studio');
  for(const [name,ok]of [['check-bridge',connected],['check-panel',state.panelReady],['check-battle',state.providerReady]]){
    set(name,ok?'מחובר':'ממתין');$(name).classList.toggle('ok',Boolean(ok));
  }
  set('updated',state.observedAt?'עודכן '+time(state.observedAt):state.lastObservedAt?'עדכון אחרון '+time(state.lastObservedAt):'טרם התקבל עדכון');
  $('setup-banner').hidden=Boolean(connected);
  set('setup-title',local?'ממתינים ל־LIVE Studio':'הפאנל החי פועל במחשב שלך');
  set('setup-copy',local?'פתח את הסטודיו עם אפשרות החיבור והשאר אותו פועל. הפאנל יתחבר אוטומטית.':'פתח את המחבר במחשב שבו LIVE Studio מותקן. אפשר להוריד אותו מכאן.');
  set('list-hint',state.coverage?.truncated?'מוצגת רשימה חלקית כפי שסופקה על ידי הסטודיו.':'הרשימות משקפות את מה שנטען ב־Friends וב־Suggested creators בתוך Co-host.');
  renderStage();renderCandidates();renderEvents();
}
async function update(){
  if(!local||busy)return;busy=true;const version=++requestVersion;
  try{
    const response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(4500)});
    if(!response.ok)throw new Error('CONNECTION_ERROR');
    const next=await response.json();if(version===requestVersion)state=next;
  }catch{state={...state,connected:false,live:false,candidates:[],operations:[],battle:null,lastObservedAt:state.observedAt,observedAt:null};}
  finally{busy=false;render();}
}

const inviteErrors={
  SESSION_CHANGED:'השידור השתנה. רענן את הרשימה ובחר שוב.',
  STUDIO_NOT_READY:'הסטודיו עדיין לא מוכן לשליחת הזמנות.',
  TARGET_UNAVAILABLE:'היוצר הזה אינו זמין כרגע להזמנה.',
  INVITATION_ALREADY_PENDING:'כבר ממתינה הזמנה ליוצר הזה.',
  INVITE_BUSY:'בקשה קודמת עדיין בטיפול. המתן לפני ניסיון נוסף.',
  CONFIRMATION_EXPIRED:'האישור פג. בחר שוב את היוצר לפני שליחה.',
  REFRESH_CANDIDATES:'רענן את רשימת היוצרים ונסה שוב.',
  OPEN_COHOST_PANEL:'פתח את פאנל Co-host בסטודיו והשאר אותו פתוח.',
  TARGET_NOT_IN_NATIVE_LIST:'היוצר לא נמצא כרגע ברשימה שבסטודיו. פתח את הרשימה המתאימה ובחר שוב.',
  NATIVE_INVITE_DISABLED:'הסטודיו אינו מאפשר כרגע להזמין את היוצר הזה.',
  AMBIGUOUS_NATIVE_TARGET:'לא זוהה כפתור הזמנה יחיד ליוצר. לא נשלחה הזמנה.',
};
async function inviteRequest(route,body){
  const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'INVITE_FAILED');return result;
}
function closeInvite(){if(!inviteBusy){inviteDraft=null;$('invite-dialog').close();}}
$('close-invite').addEventListener('click',closeInvite);
$('cancel-invite').addEventListener('click',closeInvite);
$('invite-dialog').addEventListener('cancel',event=>{if(inviteBusy)event.preventDefault();else inviteDraft=null;});
async function beginInvite(person){
  if(inviteBusy||!state.session?.epoch)return;
  inviteBusy=true;renderCandidates();toast('בודק שהיוצר עדיין זמין להזמנה…');
  try{
    inviteDraft=await inviteRequest('/api/invites/prepare',{uid:person.uid,epoch:state.session.epoch});
    set('invite-name',inviteDraft.name);set('invite-handle',inviteDraft.handle?'@'+inviteDraft.handle:'ID '+inviteDraft.uid);
    $('confirm-invite').disabled=false;set('confirm-invite','שלח הזמנה');$('invite-dialog').showModal();$('toast').hidden=true;
  }catch(error){toast(inviteErrors[error.message]||'לא ניתן להכין את ההזמנה כרגע. לא נשלחה הזמנה.');}
  finally{inviteBusy=false;renderCandidates();}
}
$('confirm-invite').addEventListener('click',async()=>{
  if(inviteBusy||!inviteDraft)return;
  const draft=inviteDraft;inviteDraft=null;inviteBusy=true;$('confirm-invite').disabled=true;set('confirm-invite','שולח…');renderCandidates();
  try{
    const receipt=await inviteRequest('/api/invites/send',{uid:draft.uid,epoch:draft.epoch,draftToken:draft.draftToken,requestId:crypto.randomUUID()});
    if(receipt.submitted===true&&receipt.outcome==='failed')toast('הסטודיו דחה את ההזמנה: '+(receipt.error?.message||'היוצר אינו זמין.'));
    else if(receipt.submitted===true&&receipt.outcome==='succeeded')toast('ההזמנה אושרה והיוצר התחבר.');
    else if(receipt.submitted===true)toast('ההזמנה נקלטה בסטודיו. ממתינים לאישור היוצר.');
    else toast('לא התקבל אישור שליחה. בדוק בסטודיו לפני ניסיון נוסף.');
  }catch(error){toast(inviteErrors[error.message]||'תוצאת השליחה לא ידועה. בדוק בסטודיו לפני ניסיון נוסף.');}
  finally{inviteBusy=false;$('invite-dialog').close();renderCandidates();void update();}
});

function renderBattleControls(){
  const connected=state.connected&&battleControl?.available;
  set('battle-controls-status',connected?'מחובר ל־Match':'ממתין ל־Match');
  const actions=$('battle-controls-actions');actions.replaceChildren();
  const scopes=battleControl?.scopes||[],incoming=scopes.find(s=>s.role==='invitee');
  const waiting=scopes.find(s=>s.role==='inviter');
  let message=!local?'פתח את הפאנל המקומי כדי לשלוט בבאטל.':!connected?'ממתין לחיבור ל־Studio ולשידור פעיל.':incoming?'התקבלה הזמנת באטל. אפשר לקבל או לדחות כאן.':waiting?'הזמנת באטל ממתינה לתשובת הצד השני.':battleControl.actions.length?'בחר את הפעולה הבאה לבאטל.':'חבר יוצר ב־Co-host ופתח את Match בסטודיו. הפקדים הזמינים יופיעו כאן.';
  if(state.battle?.status==='open')message='TikTok מדווח על באטל פעיל.';
  if(battleBusy)message='מעביר את הפעולה ל־Studio…';
  else if(battleReceipt)message=battleReceipt;
  set('battle-controls-message',message);
  if(!connected)return;
  for(const control of battleControl.actions){
    const button=document.createElement('button');button.className='button '+(['match.accept','match.start','cohostMode.getStarted'].includes(control.action)?'mint':'secondary');
    button.dataset.battleAction=control.action;button.textContent=control.label+(control.selected?' ✓':'');
    button.disabled=battleBusy||inviteBusy||!control.enabled||control.selected;
    button.addEventListener('click',()=>performBattleAction(control.action));actions.append(button);
  }
}
async function updateBattleControls(){
  if(!local||battleLoading||battleBusy)return;battleLoading=true;
  try{
    const response=await fetch('/api/battles',{cache:'no-store',signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error();const next=await response.json();
    if(next.revision!==battleControl?.revision)battleReceipt=null;
    battleControl=next;
  }catch{battleControl=null;battleReceipt=null;}
  finally{battleLoading=false;renderBattleControls();}
}
async function performBattleAction(action){
  if(battleBusy||!battleControl?.available)return;
  const observed=battleControl;battleBusy=true;battleReceipt=null;renderBattleControls();
  try{
    const receipt=await inviteRequest('/api/battles/action',{action,revision:observed.revision,epoch:observed.epoch,requestId:crypto.randomUUID()});
    battleReceipt=receipt.dispatched===true?'הפעולה הועברה ל־Studio. ממתינים לעדכון מצב הבאטל.':'לא התקבל אישור לפעולה. בדוק את מצב הבאטל בסטודיו לפני ניסיון נוסף.';
  }catch(error){
    battleReceipt=['BATTLE_CHANGED','SESSION_CHANGED'].includes(error.message)?'ההזמנה או המשתתפים השתנו. המצב מתרענן; בחר שוב.':error.message==='BATTLE_ACTION_UNAVAILABLE'?'הפעולה אינה זמינה עוד בסטודיו.':'לא ניתן לאמת את תוצאת הפעולה. בדוק בסטודיו לפני ניסיון נוסף.';
  }finally{battleBusy=false;renderBattleControls();void update();}
}
render();renderBattleControls();if(local){void update();void updateBattleControls();setInterval(update,1800);setInterval(updateBattleControls,2400);}
