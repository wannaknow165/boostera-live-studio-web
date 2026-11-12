import {mountBattle} from '/mobile/battle.js';
import {createAudioMixer} from '/mobile/audio.js';
import {createMobileWorkspace} from '/mobile/render.js';
const $=id=>document.getElementById(id);
let lastSpecialAt=Date.now()-2000,lastClipAt=Date.now()-2000,lastBgAt=Date.now()-2000;
let session=null,catalog=[],effects=[],filter='all',engine=null,enginePromise=null,engineRunning=false,cameraStream=null,micStream=null,facing='user',cameraBusy=false,probe=false,probeBusy=false,recording=null,recordChunks=[],recordStream=null,recordAt=0,recordFile=null,recordUrl=null,deferredInstall=null,eventSource=null,toastTimer,wakeLock=null,overlayFull=false,lastFrameAt=0,frames=0,fpsAt=performance.now(),lastScreenAt=Date.now()-2000,lastOverlayAt=Date.now()-2000,lastLiveAt=Date.now()-2000;
const video=$('camera'),output=$('output'),ctx=output.getContext('2d',{alpha:false}),fxOut=$('fx-output'),overlay=$('overlay');
const mixer=createAudioMixer();
let targetFps=30;
const workspaceUI=createMobileWorkspace({getEngine:()=>engine,initEngine:()=>initEngine(),getCamera:()=>cameraStream,getMic:()=>micStream,createStream:()=>createRecordStream(),output,video,getFacing:()=>facing,toast:message=>toast(message)});
const encode=encodeURIComponent;
const set=(id,value)=>{$(id).textContent=value;};
const secure=window.isSecureContext&&Boolean(navigator.mediaDevices?.getUserMedia);
const isIos=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function toast(message){set('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},5000);}
function safeName(name,fallback){return typeof name==='string'&&!name.includes('???')?name:fallback;}
function safeMedia(url){return typeof url==='string'&&/^\/(media|fx)\//.test(url)?url:null;}
function supportedMime(audio=false){const types=audio?['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg']:['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'];return types.find(t=>window.MediaRecorder?.isTypeSupported?.(t))||'';}
function applyAuth(value){
  session=value;workspaceUI.setAuth(Boolean(value?.authenticated));$('pair-card').hidden=Boolean(value?.authenticated);$('server-state').classList.toggle('ok',Boolean(value?.effectsServer));
  set('server-state',value?.effectsServer?'מחובר לשרת האפקטים':value?.authenticated?'שרת האפקטים לא זמין':'נדרש צימוד');
  $('start-camera-main').disabled=!value?.authenticated;$('camera-toggle').disabled=!value?.authenticated;
  if(value?.authenticated){set('server-details','שרת האפקטים מחובר · '+(value.counts?.effects||0)+' אפקטים חיים');set('device-info','מכשיר: '+value.device.label+'\nחיבור מאובטח: '+(secure?'כן':'לא')+'\nמותקן כאפליקציה: '+((navigator.standalone||matchMedia('(display-mode: standalone)').matches)?'כן':'בדפדפן')+'\nהקלטה: '+(window.MediaRecorder?'נתמכת':'לא זמינה')+'\nקידוד: '+(supportedMime()||'לא זמין'));$('device-info').style.whiteSpace='pre-line';}
}
async function api(path,options={}){
  const response=await fetch(path,{cache:'no-store',...options});
  if(response.status===401){applyAuth(null);stopProbe();throw new Error('PAIRING_REQUIRED');}
  if(!response.ok){let j={};try{j=await response.json();}catch{}throw new Error(j.error||'SERVER_ERROR');}
  return response;
}
async function checkSession(){
  try{const response=await fetch('/api/mobile/session',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(response.status===401){applyAuth(null);return;}if(!response.ok)throw Error();applyAuth(await response.json());}
  catch{set('server-state','אין חיבור לשרת');$('server-state').classList.remove('ok');}
}
$('pair-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;set('pair-error','');
  try{const r=await fetch('/api/mobile/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('pair-code').value.trim(),label:isIos?'iPhone / iPad':/Android/.test(navigator.userAgent)?'Android':'דפדפן'})});const j=await r.json();if(!r.ok)throw Error(j.error);$('pair-code').value='';await checkSession();await loadCatalog();connectEvents();toast('הטלפון מחובר לפאנל שלך.');}
  catch(error){set('pair-error',error.message==='TOO_MANY_ATTEMPTS'?'המתן דקה לפני ניסיון נוסף.':'הקוד שגוי או פג תוקף. צור קוד חדש במסך הצימוד במחשב.');}
  finally{button.disabled=false;}
});
function paintCover(source,target,w,h){
  const sw=source.videoWidth||source.width,sh=source.videoHeight||source.height;if(!sw||!sh)return;
  const scale=Math.max(w/sw,h/sh);target.drawImage(source,(w-sw*scale)/2,(h-sh*scale)/2,sw*scale,sh*scale);
}
function draw(now){
  requestAnimationFrame(draw);if(now-lastFrameAt<1000/targetFps)return;lastFrameAt=now;
  ctx.fillStyle='#09070f';ctx.fillRect(0,0,output.width,output.height);
  if(video.readyState>=2){
    const source=engine?.ready&&engineRunning&&fxOut.width>0&&fxOut.height>0?fxOut:video;
    ctx.save();if(facing==='user'){ctx.translate(output.width,0);ctx.scale(-1,1);}paintCover(source,ctx,output.width,output.height);ctx.restore();frames++;
  }
  if(!overlay.paused&&overlay.readyState>=2){ctx.save();if(overlayFull)paintCover(overlay,ctx,output.width,output.height);else ctx.drawImage(overlay,0,0,output.width,output.height);ctx.restore();}
  mixer.update(engine,overlay);workspaceUI.draw(ctx,now);
  if(now-fpsAt>1000){set('fps',Math.round(frames*1000/(now-fpsAt))+' FPS');frames=0;fpsAt=now;}
  if(recording?.state==='recording'){const seconds=Math.floor((performance.now()-recordAt)/1000);set('record-time',String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'));if(seconds>=180){stopRecording();toast('הקלטת הבדיקה הסתיימה אחרי שלוש דקות.');}}
}
requestAnimationFrame(draw);
async function initEngine(){
  if(engine?.ready)return engine;if(enginePromise)return enginePromise;
  set('tracking-state','טוען מעקב פנים וגוף…');
  enginePromise=(async()=>{
    const {FxEngine}=await import('/fx/fx-engine.js');
    FxEngine.NAMES={sit:'ישיבה',stand:'עמידה',frontal:'מבט למצלמה',face:'פנים',eyes:'עיניים',shoulders:'כתפיים',hands:'ידיים',handL:'יד שמאל',handR:'יד ימין',waist:'מותניים',body:'גוף'};
    engine=new FxEngine(video,fxOut,{log:message=>{if(String(message).includes('ready'))set('tracking-state','מעקב פנים וגוף פעיל');}});
    engine.onReject=check=>toast('כדי להפעיל את האפקט צריך: '+(check.missing||[]).map(m=>FxEngine.NAMES[m]||m).join(', '));
    await engine.init();mixer.attach(engine);workspaceUI.attach(engine);engine.start();engineRunning=true;
    for(const method of ['glove','loadGnome','loadTomato'])try{Promise.resolve(engine[method]?.()).catch(()=>{});}catch{}
    set('tracking-state','מעקב פנים וגוף פעיל');return engine;
  })().catch(error=>{set('tracking-state','המצלמה פעילה · מעקב לא נטען');enginePromise=null;throw error;});
  return enginePromise;
}
async function startCamera(){
  if(cameraBusy)return;if(!secure){toast('המצלמה דורשת פתיחה בקישור HTTPS, ב־Safari או Chrome.');return;}
  cameraBusy=true;
  try{
    const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:720},height:{ideal:1280},frameRate:{ideal:targetFps,max:targetFps}},audio:false});
    cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=next;video.srcObject=next;await video.play();
    if(!micStream)try{micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}catch{toast('המצלמה פעילה ללא מיקרופון. אפשר לאשר הרשאה בהגדרות הדפדפן.');}
    mixer.start(micStream);mixer.attach(engine);$('output-quality').disabled=true;$('camera-placeholder').hidden=true;$('camera-dot').classList.add('on');set('camera-state','מצלמה פעילה');$('camera-toggle').classList.add('active');
    for(const id of ['flip-camera','record','test-video'])$(id).disabled=false;for(const id of ['mic-toggle','test-audio'])$(id).disabled=!micStream;
    if(!window.MediaRecorder||!output.captureStream)$('record').disabled=true;
    $('mic-toggle').classList.toggle('active',Boolean(micStream?.getAudioTracks().some(t=>t.enabled)));
    if(navigator.wakeLock)try{wakeLock=await navigator.wakeLock.request('screen');}catch{}
    void initEngine().catch(()=>toast('המצלמה פועלת. לא ניתן היה לטעון כרגע את מעקב הפנים במכשיר הזה.'));
  }catch(error){toast(error.name==='NotAllowedError'?'יש לאשר גישה למצלמה בדפדפן.':'לא ניתן לפתוח את המצלמה. סגור אפליקציה אחרת שמשתמשת בה ונסה שוב.');}
  finally{cameraBusy=false;}
}
function stopCamera(){
  mixer.stopMic();void workspaceUI.stopBroadcast();engine?.battle?.stop();engine?.gnomeA?.c?.v?.pause();$('output-quality').disabled=false;
  stopProbe();if(recording?.state==='recording')stopRecording();
  cameraStream?.getTracks().forEach(t=>t.stop());micStream?.getTracks().forEach(t=>t.stop());cameraStream=null;micStream=null;video.srcObject=null;
  $('camera-placeholder').hidden=false;$('camera-dot').classList.remove('on');set('camera-state','מצלמה כבויה');$('camera-toggle').classList.remove('active');$('mic-toggle').classList.remove('active');
  for(const id of ['flip-camera','mic-toggle','record','test-video','test-audio'])$(id).disabled=true;
  wakeLock?.release().catch(()=>{});wakeLock=null;
}
$('start-camera-main').onclick=startCamera;$('camera-toggle').onclick=()=>cameraStream?stopCamera():startCamera();
$('flip-camera').onclick=async()=>{if(recording?.state==='recording'){toast('עצור את ההקלטה לפני החלפת מצלמה.');return;}cameraStream?.getVideoTracks().forEach(t=>t.stop());cameraStream=null;video.srcObject=null;facing=facing==='user'?'environment':'user';await startCamera();};
$('mic-toggle').onclick=()=>{if(!micStream)return;const on=!micStream.getAudioTracks()[0]?.enabled;micStream.getAudioTracks().forEach(t=>t.enabled=on);if(!mixer.active){recordStream?.getAudioTracks().forEach(t=>t.enabled=on);workspaceUI.mute(on);}$('mic-toggle').classList.toggle('active',on);toast(on?'המיקרופון פעיל.':'המיקרופון מושתק.');};
async function post(path,value){return(await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();}
async function triggerScreen(type,count,mult){
  if(!cameraStream){toast('הפעל קודם את המצלמה.');return;}
  try{await initEngine();const j=await post('/api/mobile/screen',{type,count,mult,seconds:30});applyStage(j.stage);toast('האפקט הופעל דרך השרת.');}catch{toast('האפקט לא הופעל. בדוק את החיבור לשרת ואת טעינת המעקב.');}
}
document.querySelectorAll('[data-screen]').forEach(b=>b.onclick=()=>triggerScreen(b.dataset.screen,Number(b.dataset.count)||1,Number(b.dataset.mult)||2));
async function playEffect(effect){
  if(!cameraStream){toast('הפעל קודם מצלמה.');return;}
  toast('טוען את האפקט שנבחר…');
  try{
    const fx=await initEngine();
    if(!fx.effects[effect.id])await fx.loadEffect('/fx/effects/'+effect.dir);
    const check=fx.check(effect.id);if(!check.ok){fx.onReject?.(check);return;}
    fx.trigger(effect.id);toast('האפקט פועל על המצלמה שלך.');
  }catch{toast('לא ניתן לטעון את האפקט הזה במכשיר כרגע.');}
}
async function playMedia(row){
  if(!cameraStream){toast('הפעל קודם את המצלמה.');return;}
  const url=safeMedia(row.url);if(!url){toast('אין לאפקט הזה קובץ מוכן להפעלה.');return;}
  if(row.kind==='battle'&&row.battleId){try{const fx=await initEngine();await fx.playBattle(row.battleId);}catch{toast('לא ניתן להפעיל את קליפ הקרב.');}return;}
  if(row.kind==='live'){const effect=effects.find(e=>e.id===row.id.replace(/^live-/,''));if(effect)return playEffect(effect);}
  if(row.kind==='room'){try{const fx=await initEngine();await fx.plateFromUrl(url);toast('הרקע נטען למנוע האפקטים.');}catch{toast('לא ניתן לטעון את הרקע.');}return;}
  overlayFull=['background','template'].includes(row.kind);overlay.src=url;overlay.loop=false;overlay.muted=false;
  try{await overlay.play();toast('המדיה מהספרייה פועלת בתצוגה.');}catch{toast('פורמט הווידאו הזה אינו זמין במכשיר כרגע.');}
}
function stopAll(){workspaceUI.stopRecipe();if(engine){engine.battle?.stop();engine.gnomeA?.c?.v?.pause();engine.gnomeA=null;engine.tomatoes=[];engine.headTomatoes=[];engine.wake=null;}if(engine){engine.active=null;engine.armed=null;engine.stopDouble?.();engine.punches=[];}overlay.pause();overlay.removeAttribute('src');lastScreenAt=Date.now();void post('/api/mobile/screen',{type:'stop'}).catch(()=>{});void post('/api/mobile/stop',{}).catch(()=>{});}
$('stop-effect').onclick=()=>{stopAll();toast('האפקטים נוקו מהתצוגה.');};
function applyStage(stage){
  if(!stage)return;
  if(stage.special?.at>lastSpecialAt){lastSpecialAt=stage.special.at;if(engine?.ready)void engine.playBattle(stage.special.set);}
  if(stage.clip?.at>lastClipAt){lastClipAt=stage.clip.at;const row=catalog.find(r=>r.orderId===stage.clip.id||r.id===stage.clip.id);if(row)void playMedia(row);}
  if(stage.bg?.at>lastBgAt){lastBgAt=stage.bg.at;if(engine?.ready&&safeMedia(stage.bg.url))void engine.plateFromUrl(stage.bg.url);}
  const s=stage.screen;if(s&&s.at>lastScreenAt){lastScreenAt=s.at;if(!engine?.ready)return;if(s.type==='hits')engine.screenHits(s.count||1);if(s.type==='double')engine.startDouble(s.mult||2,s.seconds||30);if(s.type==='wake')engine.wakeUp();if(s.type==='tomato')engine.throwTomato(s.count||1,s.style||stage.tomatoStyle);if(s.type==='stop'){engine.stopDouble?.();engine.active=null;}}
  const o=stage.overlay;if(o&&o.at>lastOverlayAt){lastOverlayAt=o.at;const row=catalog.find(r=>r.overlayId===o.id||r.orderId===o.id||r.battleId===o.id);if(row)void playMedia(row);}
  const l=stage.live;if(l&&l.at>lastLiveAt){lastLiveAt=l.at;const e=effects.find(e=>e.id===l.effect);if(e)void playEffect(e);}
}
function connectEvents(){eventSource?.close();if(!session?.authenticated)return;eventSource=new EventSource('/api/mobile/events');eventSource.onmessage=event=>{try{applyStage(JSON.parse(event.data));}catch{}};}
async function loadCatalog(){
  if(!session?.authenticated)return;
  try{
    const[e,c]=await Promise.all([api('/api/mobile/effects').then(r=>r.json()),api('/api/mobile/catalog').then(r=>r.json())]);effects=Array.isArray(e)?e:[];catalog=Array.isArray(c.rows)?c.rows:[];set('effect-count',effects.length);set('media-count',catalog.length);
    $('effects-list').replaceChildren();
    for(const effect of effects){const b=document.createElement('button');b.className='effect';const icon=document.createElement('div');icon.className='effect-icon';icon.textContent=effect.posture==='stand'?'↟':'✧';const content=document.createElement('div');const title=document.createElement('strong');title.textContent=safeName(effect.title,effect.id);const note=document.createElement('small');note.textContent=(effect.posture==='stand'?'אפקט בעמידה':'אפקט בישיבה')+' · המנוע הקיים שלך';const arrow=document.createElement('span');arrow.className='arrow';arrow.textContent='←';content.append(title,note);b.append(icon,content,arrow);b.onclick=()=>playEffect(effect);$('effects-list').append(b);}
    renderMedia();
  }catch{toast('לא ניתן לטעון כרגע את ספריית האפקטים מהשרת.');}
}
function renderMedia(){
  const search=$('library-search').value.trim().toLocaleLowerCase('he'),container=$('media-list');container.replaceChildren();
  const rows=catalog.filter(r=>(filter==='all'||filter==='front'&&['front','overlay'].includes(r.kind)||filter==='background'&&['background','room'].includes(r.kind)||filter==='battle'&&r.kind==='battle')&&[r.name,r.id].join(' ').toLocaleLowerCase('he').includes(search));
  for(const row of rows){const item=document.createElement('div');item.className='media-item';const badge=document.createElement('div');badge.className='media-thumb';badge.textContent=row.kind==='room'?'▧':row.kind==='live'?'✧':'▶';badge.style.display='flex';badge.style.alignItems='center';badge.style.justifyContent='center';badge.style.color='#b58bff';const content=document.createElement('div'),name=document.createElement('strong'),note=document.createElement('small');name.textContent=safeName(row.name,row.id);note.textContent=({front:'שכבה שקופה',overlay:'אפקט קדמי',battle:'אפקט קרב',background:'סרטון רקע',room:'רקע',live:'אפקט חי',template:'תבנית וידאו'})[row.kind]||row.kind;content.append(name,note);const play=document.createElement('button');play.className='button subtle';play.textContent='הפעל';play.onclick=()=>playMedia(row);item.append(badge,content,play);container.append(item);}
  if(!rows.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='לא נמצאה מדיה בסינון הזה.';container.append(empty);}
}
$('library-search').oninput=renderMedia;document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{filter=b.dataset.kind;document.querySelectorAll('[data-kind]').forEach(x=>x.classList.toggle('selected',x===b));renderMedia();});
$('refresh-library').onclick=loadCatalog;
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-selected',String(x===b));});for(const name of ['effects','library','tests'])$('tab-'+name).hidden=name!==b.dataset.tab;});
function createRecordStream(){
  const stream=output.captureStream(targetFps);const mixed=mixer.track();if(mixed)stream.addTrack(mixed);else for(const track of micStream?.getAudioTracks()||[])stream.addTrack(track.clone());return stream;
}
function stopRecording(){if(recording?.state==='recording')recording.stop();}
$('record').onclick=()=>{
  if(recording?.state==='recording'){stopRecording();return;}if(!cameraStream||!window.MediaRecorder||!output.captureStream)return;
  try{
    recordStream=createRecordStream();const mime=supportedMime();recording=new MediaRecorder(recordStream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:3000000});recordChunks=[];let size=0;recordAt=performance.now();
    recording.ondataavailable=e=>{if(e.data.size){recordChunks.push(e.data);size+=e.data.size;if(size>96*1024*1024)stopRecording();}};
    recording.onstop=()=>{const type=recording.mimeType||recordChunks[0]?.type||'video/webm',blob=new Blob(recordChunks,{type}),ext=type.includes('mp4')?'mp4':'webm';recordFile=new File([blob],'WANNA-FX-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+ext,{type});if(recordUrl)URL.revokeObjectURL(recordUrl);recordUrl=URL.createObjectURL(blob);$('download-recording').href=recordUrl;$('download-recording').download=recordFile.name;$('recording-ready').hidden=false;set('recording-info',(blob.size/1048576).toFixed(1)+' MB · '+ext.toUpperCase()+' · נשמר במכשיר');$('record-badge').hidden=true;$('record').classList.remove('recording');recordStream.getTracks().forEach(t=>t.stop());toast('ההקלטה מוכנה לשמירה או לשיתוף.');};
    recording.onerror=()=>{toast('ההקלטה לא הושלמה במכשיר הזה.');$('record-badge').hidden=true;$('record').classList.remove('recording');recordStream?.getTracks().forEach(t=>t.stop());};
    recording.start(1000);$('record-badge').hidden=false;$('record').classList.add('recording');$('recording-ready').hidden=true;
  }catch{toast('ההקלטה לא זמינה כרגע בדפדפן הזה.');}
};
$('share-recording').onclick=async()=>{if(!recordFile)return;try{if(navigator.canShare?.({files:[recordFile]}))await navigator.share({files:[recordFile],title:'WANNA FX'});else $('download-recording').click();}catch(error){if(error.name!=='AbortError')toast('אפשר להשתמש בכפתור הורדה כדי לשמור את הסרטון.');}};
function stopProbe(){probe=false;$('test-video').textContent='התחל בדיקה';}
$('test-video').onclick=()=>{if(probe){stopProbe();return;}if(!cameraStream)return;probe=true;set('test-video','עצור בדיקה');set('video-test-details','שולח דגימות מהתמונה עם האפקטים לשרת…');void sendProbe();};
async function sendProbe(){
  if(!probe||probeBusy||!cameraStream||document.hidden)return;probeBusy=true;
  try{const blob=await new Promise(r=>output.toBlob(r,'image/jpeg',0.45));if(!blob)throw Error();const started=performance.now();const response=await api('/api/mobile/frame',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob,signal:AbortSignal.timeout(6000)});const ack=await response.json();set('ack-count',ack.sequence);set('ack-latency',Math.round(performance.now()-started));set('ack-bytes',Math.round((session?.stats?.bytes||0)+ack.bytes)/1000);set('video-test-details','השרת אישר קבלת דגימה '+ack.sequence+' · '+new Date(ack.serverTime).toLocaleTimeString('he-IL'));if(session){session.stats||={bytes:0};session.stats.bytes=(session.stats.bytes||0)+ack.bytes;}}
  catch(error){set('video-test-details',error.message==='PAIRING_REQUIRED'?'נדרש צימוד מחדש.':'דגימה לא אושרה. בדוק את חיבור הרשת.');}
  finally{probeBusy=false;}
}
setInterval(()=>{if(probe)void sendProbe();},500);
$('test-server').onclick=async()=>{const started=performance.now();await checkSession();if(session?.effectsServer)set('server-details','השרת ענה תוך '+Math.round(performance.now()-started)+' מילישניות · '+session.counts.effects+' אפקטים חיים.');};
$('test-audio').onclick=async()=>{
  if(!micStream||!window.MediaRecorder)return;const button=$('test-audio');button.disabled=true;
  try{const stream=new MediaStream(micStream.getAudioTracks().map(t=>t.clone())),mime=supportedMime(true),rec=new MediaRecorder(stream,mime?{mimeType:mime}:{}),chunks=[];rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise((r,j)=>{rec.onstop=r;rec.onerror=j;});rec.start();set('audio-test-details','מקליט שתי שניות לבדיקה…');await new Promise(r=>setTimeout(r,2000));rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:rec.mimeType||'audio/mp4'});const ack=await(await api('/api/mobile/audio-test',{method:'POST',headers:{'Content-Type':blob.type},body:blob})).json();set('audio-test-details','השרת קיבל '+Math.round(ack.bytes/1024)+' KB של קול. אפשר להאזין לדגימה שהתקבלה.');$('audio-echo').src='/api/mobile/audio-test?t='+Date.now();$('audio-echo').hidden=false;}
  catch{set('audio-test-details','בדיקת המיקרופון לא הושלמה.');}
  finally{button.disabled=!micStream;}
};
$('logout').onclick=async()=>{stopCamera();eventSource?.close();try{await api('/api/mobile/logout',{method:'POST'});}catch{}applyAuth(null);toast('הטלפון נותק מהשרת.');};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;});
$('install').onclick=async()=>{if(deferredInstall){await deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;return;}set('install-instructions',(navigator.standalone||matchMedia('(display-mode: standalone)').matches)?'האפליקציה כבר פתוחה ממסך הבית.':'זו אפליקציית Web להתקנה. אין צורך בקובץ APK או בחנות אפליקציות לצורך הבדיקות.');$('install-dialog').showModal();};
$('close-install').onclick=()=>$('install-dialog').close();
document.addEventListener('visibilitychange',()=>{if(document.hidden&&probe)set('video-test-details','האפליקציה ברקע. הדגימות יתחדשו כשחוזרים אליה.');if(!document.hidden&&cameraStream&&navigator.wakeLock)navigator.wakeLock.request('screen').then(lock=>wakeLock=lock).catch(()=>{});});
window.addEventListener('online',()=>{void checkSession();});window.addEventListener('offline',()=>{set('server-state','אין רשת');$('server-state').classList.remove('ok');});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/mobile/sw.js',{scope:'/mobile/'}).catch(()=>{});
await checkSession();if(session?.authenticated){await loadCatalog();connectEvents();}setInterval(checkSession,12000);
$('output-quality').onchange=()=>{const value=$('output-quality').value;output.width=value==='720'?720:1080;output.height=value==='720'?1280:1920;targetFps=value==='1080-60'?60:30;set('preview-metrics',output.width+' × '+output.height+' · '+targetFps+' FPS');};

$('effect-audio').onclick=()=>{const on=mixer.toggleEffects();$('effect-audio').textContent=on?'השתק קול אפקטים':'הפעל קול אפקטים';};

mountBattle(document.getElementById("live-battle"));
