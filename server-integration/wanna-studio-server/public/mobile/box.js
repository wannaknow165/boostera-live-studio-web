const $=id=>document.getElementById(id);
let checking=false,opening=false,accountGeneration=0;
async function refresh(){
  try{
    const r=await fetch('/api/mobile/session',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
    if($('status'))$('status').textContent='גייטוויי '+s.version+' · שרת האפקטים '+(s.effectsServer?'מחובר':'לא זמין');
    if($('detail'))$('detail').textContent='המצלמה, האפקטים וחשבון TikTok מנוהלים מאותו פאנל. Studio פועל בתוך הבוקס שלך.';
    if($('pair'))$('pair').hidden=!s.local;
    if($('box-session-status'))$('box-session-status').textContent='מחובר לבוקס שלך';
    if($('box-logout'))$('box-logout').hidden=false;
  }catch{if($('status'))$('status').textContent='אין חיבור לבוקס. יש להתחבר מחדש או לצמד את הטלפון.';if($('box-session-status'))$('box-session-status').textContent='יש לפתוח את קישור החיבור הפרטי לבוקס';if($('box-logout'))$('box-logout').hidden=true;}
}
function clearQr(){
  $('account-qr').hidden=true;$('account-qr').removeAttribute('src');
  $('account-approve').hidden=true;$('account-approve').removeAttribute('href');
}
function renderAccount(s){
  clearQr();$('account-name').hidden=true;$('account-refresh').hidden=s.phase!=='expired';
  const messages={connected:'חשבון TikTok מחובר ל־Studio',qr:'ממתין לאישור החיבור ב־TikTok',scanned:'הקוד נסרק. יש לאשר את הכניסה ב־TikTok.',expired:'תוקף הקוד הסתיים. אפשר ליצור QR חדש.',loading:'מכין קוד חיבור חדש…',unavailable:'הבוקס מחובר. Studio עדיין בהכנה לחיבור החשבון.'};
  $('account-status').textContent=messages[s.phase]||messages.unavailable;
  if(s.phase==='connected'){
    $('account-name').textContent=(s.account.name?s.account.name+' · ':'')+'@'+s.account.handle;
    $('account-name').hidden=false;
    $('account-help').textContent='ההתחברות נשמרת בפרופיל Studio של הבוקס הזה. אם TikTok יבקש כניסה מחדש, הקוד יופיע כאן שוב.';
  }else if(s.phase==='qr'&&typeof s.image==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(s.image)){
    $('account-qr').src=s.image;$('account-qr').hidden=false;
    let link;
    try{const u=new URL(s.approvalUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='tiktok.com'||u.hostname.endsWith('.tiktok.com')))link=u.href;}catch{}
    if(link){$('account-approve').href=link;$('account-approve').hidden=false;}
    $('account-help').textContent=link?'פתח את קישור האישור המקורי של TikTok ואשר את הכניסה לחשבון הרצוי. אפשר גם לסרוק את ה־QR דרך TikTok.':'סרוק את הקוד דרך TikTok ואשר את הכניסה לחשבון הרצוי. קישור אישור לטלפון עדיין אינו זמין מ־Studio.';
  }else $('account-help').textContent='החיבור הראשוני דורש אישור שלך ב־TikTok. אין צורך לפתוח את Studio בטלפון.';
}
async function checkAccount(){
  if(checking||opening||$('studio-account').hidden)return;checking=true;$('account-check').disabled=true;
  const generation=accountGeneration;
  try{const r=await fetch('/api/mobile/studio/account',{cache:'no-store',signal:AbortSignal.timeout(7000)});if(r.status===503){if(generation===accountGeneration&&!document.hidden)renderAccount({phase:'unavailable'});return;}if(!r.ok)throw Error();const s=await r.json();if(generation===accountGeneration&&!document.hidden)renderAccount(s);}
  catch{clearQr();$('account-name').hidden=true;$('account-refresh').hidden=true;$('account-status').textContent='לא ניתן לבדוק את החיבור ל־Studio כרגע. אפשר לנסות שוב.';}
  finally{checking=false;$('account-check').disabled=false;}
}
$('connect-studio').addEventListener('click',()=>{
  $('studio-account').hidden=false;$('connect-studio').setAttribute('aria-expanded','true');void checkAccount();
});
if($('connect-studio-top'))$('connect-studio-top').addEventListener('click',()=>{
  $('studio-account').hidden=false;$('connect-studio').setAttribute('aria-expanded','true');
  $('connect-studio').closest('section').scrollIntoView({behavior:'smooth',block:'start'});void checkAccount();
});
if($('box-logout'))$('box-logout').addEventListener('click',async()=>{
  try{const r=await fetch('/api/mobile/logout',{method:'POST'});if(!r.ok)throw Error();accountGeneration++;clearQr();$('account-name').hidden=true;$('studio-account').hidden=true;$('connect-studio').setAttribute('aria-expanded','false');await refresh();}
  catch{if($('box-session-status'))$('box-session-status').textContent='היציאה לא הושלמה. נסה שוב.';}
});
$('account-check').addEventListener('click',checkAccount);
$('account-refresh').addEventListener('click',async()=>{
  if(opening||checking)return;opening=true;clearQr();$('account-refresh').disabled=true;
  try{const r=await fetch('/api/mobile/studio/account/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(7000)});if(!r.ok)throw Error();renderAccount(await r.json());}
  catch{$('account-status').textContent='לא ניתן לרענן את הקוד כרגע. נסה בדיקת חיבור.';}
  finally{opening=false;$('account-refresh').disabled=false;}
});
document.addEventListener('visibilitychange',()=>{accountGeneration++;if(document.hidden)clearQr();else void checkAccount();});
async function initialConnection(){
  const fragment=new URLSearchParams(location.hash.slice(1)),code=fragment.get('pair');
  if(code!==null){
    fragment.delete('pair');history.replaceState(history.state,'',location.pathname+location.search+(fragment.toString()?'#'+fragment:''));
    try{
      const r=await fetch('/api/mobile/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,label:'הטלפון שלי'})});
      if(!r.ok)throw Error();
      $('studio-account').hidden=false;$('connect-studio').setAttribute('aria-expanded','true');
      $('connect-studio').closest('section').scrollIntoView({block:'start'});
      await checkAccount();
    }catch{if($('box-session-status'))$('box-session-status').textContent='קישור החיבור פג תוקף או כבר נוצל. נדרש קישור חדש.';return;}
  }
  await refresh();
}
void initialConnection();setInterval(()=>{if(!document.hidden){void refresh();void checkAccount();}},5000);
