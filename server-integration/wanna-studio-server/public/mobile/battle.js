// TikTok telemetry only: the host/opponent video is viewed on TikTok, not fabricated here.
export function mountBattle(root){
  if(!root)return;
  root.innerHTML='<div class="title-row"><div><p class="eyebrow">TIKTOK LIVE BATTLE</p><h2>הבאטל שלך</h2></div><strong data-clock>—</strong></div><form class="battle-connect"><label>חשבון TikTok<input name="handle" dir="ltr" placeholder="@username" pattern="@?[a-zA-Z0-9_.]{2,32}" required></label><button class="button primary">חבר באטל</button><button class="button subtle" type="button" data-disconnect>נתק</button></form><p data-status role="status">ממתין לחיבור ללייב פעיל.</p><div class="battle-scores" data-scores></div><p class="muted" data-detail></p><a class="button subtle" data-watch target="_blank" rel="noopener noreferrer" hidden>פתח את תמונת הבאטל ב־TikTok</a>';
  const get=s=>root.querySelector(s),form=get('form');let snapshot=null,busy=false,closed=false;
  const labels={connecting:'מתחבר ל־TikTok…',connected:'מחובר לקליטת אירועים',disconnected:'מנותק',ended:'הלייב הסתיים',error:'חיבור האירועים נכשל'};
  const errors={CREATOR_OFFLINE:'החשבון אינו בלייב כרגע.',CONNECTION_FAILED_OR_SIGNING_REQUIRED:'לא ניתן לקבל חדר LIVE. בדוק שהחשבון בלייב ואת חיבור קליטת האירועים.',TIKTOK_CONNECTION_ERROR:'חיבור האירועים נותק.',CONNECTOR_NOT_INSTALLED:'ספריית החיבור אינה מותקנת.'};
  function render(s){snapshot=s;const b=s.battle,live=s.status==='connected',expired=b?.endTimeMs&&Date.now()>b.endTimeMs,ended=b?.status==='ended'||expired;
    get('[data-status]').textContent=errors[s.error]||labels[s.status]||s.status;
    get('[data-detail]').textContent=!live?'ממתין לחיבור מאומת. נתוני באטל ישנים אינם מוצגים.':!b?'מחובר ללייב; עדיין לא התקבל אירוע באטל.':(ended?'הבאטל הסתיים':b.status==='active'?'באטל פעיל':b.status==='pending'?'הזמנת באטל — טרם התחיל':'התקבלו נתוני באטל')+' · '+b.id;
    get('[data-clock]').textContent=live&&b?.endTimeMs&&!ended?Math.max(0,Math.ceil((b.endTimeMs-Date.now())/1000))+' שניות':ended&&live?'הסתיים':'—';
    get('[data-scores]').replaceChildren();
    if(live&&b){const participants=s.participants||[],scores=b.scores||[],ids=[...new Set([...participants.map(p=>p.id),...scores.map(p=>p.id)])];for(const id of ids){const p=participants.find(p=>p.id===id),score=scores.find(p=>p.id===id),card=document.createElement('div'),name=document.createElement('span'),points=document.createElement('strong');name.textContent=p?.name||p?.handle||id;points.textContent=score?.score??'—';card.append(name,points);get('[data-scores]').append(card);}}
    const handle=/^[a-zA-Z0-9_.]{2,32}$/.test(s.handle||'')?s.handle:null;get('[data-watch]').hidden=!handle;if(handle){get('[data-watch]').href='https://www.tiktok.com/@'+handle+'/live';if(!form.elements.handle.value)form.elements.handle.value=handle;}
  }
  async function request(route,body){const r=await fetch('/api/workspace/tiktok'+route,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('REQUEST_FAILED');return r.json();}
  async function refresh(){if(busy||closed||document.hidden)return;busy=true;try{render(await request(''));}catch{get('[data-status]').textContent='אין חיבור לשרת.';get('[data-scores]').replaceChildren();get('[data-clock]').textContent='—';snapshot=null;}finally{busy=false;}}
  form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;form.querySelector('button').disabled=true;get('[data-status]').textContent='מתחבר ל־TikTok…';try{render(await request('/connect',{handle:form.elements.handle.value.trim()}));}catch{get('[data-status]').textContent='לא ניתן להתחבר כרגע.';}finally{busy=false;form.querySelector('button').disabled=false;}};
  get('[data-disconnect]').onclick=async()=>{try{render(await request('/disconnect',{}));}catch{get('[data-status]').textContent='לא התקבל אישור ניתוק.';}};
  void refresh();const timer=setInterval(refresh,2000),clock=setInterval(()=>{if(snapshot)render(snapshot);},1000);
  return()=>{closed=true;clearInterval(timer);clearInterval(clock);};
}
