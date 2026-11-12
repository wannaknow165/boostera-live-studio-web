const el=id=>document.getElementById(id);
async function api(route,method='GET',data){const response=await fetch('/api/workspace/'+route,{method,cache:'no-store',...(data!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw Error(value.error||'SERVER_ERROR');return value;}
const cover=(source,ctx,w,h)=>{const sw=source.videoWidth||source.naturalWidth||source.width,sh=source.videoHeight||source.naturalHeight||source.height;if(!sw||!sh)return;const k=Math.max(w/sw,h/sh);ctx.drawImage(source,(w-sw*k)/2,(h-sh*k)/2,sw*k,sh*k);};
export function createMobileWorkspace({getEngine,initEngine,getCamera,getMic,createStream,output,video,getFacing,toast}){
  let authenticated=false,state={clients:[],recipes:[]},recipe=null,media=null,startedAt=0,client=null,avatar=null,lastCommand=0,picking=false,broadcast=null,broadcastRecorder=null,broadcastStream=null,uploadQueue=Promise.resolve(),pending=0,sequence=0,failed=false;
  const cutout=document.createElement('canvas');cutout.width=320;cutout.height=380;const cut=cutout.getContext('2d');
  function provider(){return{hold:()=>()=>{},head:()=>{
    const engine=getEngine();let source=el('head-source').value==='avatar'?avatar:null;
    cut.clearRect(0,0,320,380);cut.save();cut.beginPath();cut.ellipse(160,190,147,182,0,0,Math.PI*2);cut.clip();
    if(source)cover(source,cut,320,380);
    else{const heads=engine?.heads||[],h=engine?.target||heads[Number(el('target-head').value)||0];if(!h||!video.videoWidth){cut.restore();return null;}const w=h.w*1.55*video.videoWidth,hh=h.h*1.65*video.videoHeight;cut.drawImage(video,h.cx*video.videoWidth-w/2,h.cy*video.videoHeight-hh*.52,w,hh,0,0,320,380);}
    cut.restore();return{canvas:cutout,ax:160,ay:190,fh:285};
  }};}
  function attach(engine){if(engine?.battle)engine.battle.opp=provider();}
  async function refresh(){
    if(!authenticated||document.hidden)return;
    try{state=await api('overview');const selected=el('active-client').value;el('active-client').replaceChildren(new Option('כל הלקוחות',''));for(const c of state.clients)el('active-client').add(new Option(c.name,c.id));el('active-client').value=selected;renderRecipes();el('server-stream-state').textContent=state.config.mediaTools?'שידור לשרת זמין · '+(state.config.rtmpConfigured?'יעד RTMP שמור':'אפשר לשמור יעד RTMP בניהול השרת'):'כלי הווידאו בשרת אינם זמינים.';}catch{}
  }
  function renderRecipes(){const selected=el('active-client').value;el('personal-effects').replaceChildren();for(const r of state.recipes.filter(r=>!selected||!r.clientId||r.clientId===selected)){const b=document.createElement('button');b.textContent=r.title;b.onclick=()=>play(r);el('personal-effects').append(b);}if(!el('personal-effects').childNodes.length)el('personal-effects').textContent='הוסף אפקט אישי דרך ״לקוחות ויצירה״.';}
  async function setClient(){client=state.clients.find(c=>c.id===el('active-client').value)||null;avatar=null;if(client?.avatarUrl){const im=new Image();im.src=client.avatarUrl;try{await im.decode();avatar=im;}catch{}}renderRecipes();}
  el('active-client').onchange=setClient;
  async function play(r){
    if(!getCamera()){toast('הפעל את המצלמה כדי לראות את האפקט.');return;}
    try{
      const engine=await initEngine();attach(engine);
      if(r.kind==='battle'){await engine.playBattle(r.effectId);return;}
      if(r.kind==='live'){const item=await fetch('/api/mobile/effects').then(r=>r.json()),e=item.find(e=>e.id===r.effectId);if(e){if(!engine.effects[e.id])await engine.loadEffect('/fx/effects/'+e.dir);engine.trigger(e.id);}return;}
      stopRecipe();recipe=r;startedAt=performance.now();
      if(r.kind==='video'){media=document.createElement('video');media.playsInline=true;media.muted=true;media.loop=r.loop;media.src=r.url;await media.play();}
      else{media=new Image();media.src=r.url;await media.decode();}
      toast('האפקט האישי פועל על המצלמה.');
    }catch{stopRecipe();toast('לא ניתן להפעיל את הקובץ הזה במכשיר.');}
  }
  function stopRecipe(){if(media instanceof HTMLVideoElement){media.pause();media.removeAttribute('src');media.load();}media=null;if(recipe?.layer==='back'&&getEngine())getEngine().plateLocked=false;recipe=null;}
  function point(r,engine){const f=engine?.face,P=engine?.pose||{},head=engine?.heads?.[r.targetHead];if(r.anchor==='screen')return{x:output.width*r.x,y:output.height*r.y,roll:0};
    if(!engine?.W||!engine.H)return null;let p=null,roll=f?.roll||0;
    if(r.anchor==='head'&&head)p={x:head.cx*engine.W,y:head.cy*engine.H};
    else if(r.anchor==='head'&&f)p={x:(f.top.x+f.chin.x)/2,y:(f.top.y+f.chin.y)/2};
    else if(r.anchor==='eyes'&&f)p={x:(f.irisL.x+f.irisR.x)/2,y:(f.irisL.y+f.irisR.y)/2};
    else if(r.anchor==='chest'||r.anchor==='body')p=P.shoulders&&{x:P.shoulders.x,y:P.shoulders.y+(P.shoulderW||f?.faceW||100)*.4};
    else if(r.anchor==='waist')p=P.hipL&&P.hipR&&{x:(P.hipL.x+P.hipR.x)/2,y:(P.hipL.y+P.hipR.y)/2};
    else p=P[r.anchor];
    if(!p)return null;const k=Math.max(output.width/engine.W,output.height/engine.H);let x=(output.width-engine.W*k)/2+p.x*k;const y=(output.height-engine.H*k)/2+p.y*k;if(getFacing()==='user'){x=output.width-x;roll=-roll;}return{x:x+r.offsetX*output.width,y:y+r.offsetY*output.height,roll};
  }
  function draw(ctx,now){
    if(!recipe||!media)return;if(now-startedAt>recipe.duration*1000){stopRecipe();return;}if(media instanceof HTMLVideoElement&&media.readyState<2)return;
    const engine=getEngine();
    if(recipe.layer==='back'&&engine?.plateCtx&&engine.W){engine.plateLocked=true;engine.plateCtx.save();engine.plateCtx.globalCompositeOperation='copy';cover(media,engine.plateCtx,engine.W,engine.H);engine.plateCtx.restore();return;}
    const p=point(recipe,engine);if(!p)return;const sw=media.videoWidth||media.naturalWidth,sh=media.videoHeight||media.naturalHeight;if(!sw||!sh)return;const w=recipe.scale*output.width,h=w*sh/sw;
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.roll+recipe.rotation*Math.PI/180);ctx.globalAlpha=recipe.opacity;
    if(recipe.circle){ctx.beginPath();ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);ctx.clip();}ctx.drawImage(media,-w/2,-h/2,w,h);ctx.restore();
  }
  el('show-landmarks').onclick=async()=>{if(!getCamera())return toast('הפעל קודם מצלמה.');const engine=await initEngine();engine.debug=!engine.debug;el('show-landmarks').textContent=engine.debug?'הסתר סימונים':'הצג סימוני פנים וגוף';};
  el('target-head').onchange=async()=>{if(!getCamera())return;const e=await initEngine();await e.setMaxHeads(4);e.target=null;attach(e);toast('המעקב מחפש עד ארבעה ראשים בתמונה.');};
  el('pick-target').onclick=async()=>{if(!getCamera())return toast('הפעל קודם מצלמה.');const e=await initEngine();await e.setMaxHeads(4);attach(e);picking=true;el('stage').style.cursor='crosshair';toast('לחץ על הראש הרצוי בתצוגה.');};
  output.addEventListener('click',event=>{if(!picking)return;const e=getEngine(),box=output.getBoundingClientRect(),nx=(event.clientX-box.left)/box.width,ny=(event.clientY-box.top)/box.height,k=Math.max(output.width/e.W,output.height/e.H);let x=nx*output.width;if(getFacing()==='user')x=output.width-x;const px=(x-(output.width-e.W*k)/2)/(e.W*k),py=(ny*output.height-(output.height-e.H*k)/2)/(e.H*k);e.pickHeadAt(px,py);picking=false;el('stage').style.cursor='';toast('הראש נבחר.');});
  el('capture-room').onclick=async()=>{if(getCamera()){const e=await initEngine();e.capturePlate();toast('הרקע נקלט.');}else toast('הפעל קודם מצלמה.');};
  el('room-file').onchange=async()=>{const f=el('room-file').files[0];if(!f||!getCamera())return;const e=await initEngine(),url=URL.createObjectURL(f);e._plateIsVideo=f.type.startsWith('video');try{await e.plateFromUrl(url);toast('הרקע נטען.');}finally{URL.revokeObjectURL(url);}};
  el('head-source').onchange=()=>{attach(getEngine());if(el('head-source').value==='avatar'&&!avatar)toast('בחר לקוח עם תמונת פנים כדי להשתמש באווטר.');};
  function enqueue(blob){if(!blob.size||!broadcast)return;pending++;if(pending>8){failed=true;toast('החיבור איטי מדי. שידור הווידאו נעצר.');void stopBroadcast();return;}
    const streamId=broadcast.id,n=sequence++;
    uploadQueue=uploadQueue.then(async()=>{if(failed)return;for(let attempt=0;attempt<3;attempt++){try{const r=await fetch('/api/workspace/broadcast/'+streamId+'/chunk',{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream','x-sequence':String(n)},body:blob,signal:AbortSignal.timeout(20000)});const ack=await r.json();if(!r.ok)throw Error(ack.error);el('server-stream-state').textContent='השרת קיבל '+(ack.bytes/1048576).toFixed(2)+' MB · '+ack.sequence+' מקטעים';return;}catch(e){if(attempt===2)throw e;}}}).catch(()=>{failed=true;toast('השרת לא אישר את מקטע הווידאו. השידור נעצר.');if(broadcastRecorder?.state==='recording')broadcastRecorder.stop();}).finally(()=>pending--);
  }
  async function startBroadcast(mode){
    if(broadcast)return stopBroadcast();if(!getCamera())return toast('הפעל קודם מצלמה.');if(!window.MediaRecorder||!output.captureStream)return toast('הדפדפן אינו תומך בהעברת וידאו.');
    try{
      const types=['video/webm;codecs=vp8,opus','video/webm','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4'],mime=types.find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error();
      broadcastStream=createStream();broadcast=await api('broadcast/start','POST',{mode,mime});broadcastRecorder=new MediaRecorder(broadcastStream,{mimeType:mime,videoBitsPerSecond:2500000});sequence=0;pending=0;failed=false;uploadQueue=Promise.resolve();broadcastRecorder.ondataavailable=e=>enqueue(e.data);
      broadcastRecorder.onstop=()=>{const stream=broadcast,id=stream?.id;uploadQueue.finally(async()=>{if(id)try{await api('broadcast/'+id+'/stop','POST');}catch{}broadcastStream?.getTracks().forEach(t=>t.stop());broadcast=null;broadcastRecorder=null;broadcastStream=null;el('send-server').classList.remove('broadcast-on');el('send-rtmp').classList.remove('broadcast-on');el('send-server').textContent='שלח וידאו לשרת';el('send-rtmp').textContent='שדר ל־RTMP';el('preview-label').textContent='PREVIEW';});};
      broadcastRecorder.onerror=()=>{failed=true;void stopBroadcast();};broadcastRecorder.start(1000);
      el(mode==='rtmp'?'send-rtmp':'send-server').classList.add('broadcast-on');el(mode==='rtmp'?'send-rtmp':'send-server').textContent='עצור שידור';el('preview-label').textContent=mode==='rtmp'?'RTMP · נשלח ליעד השמור':'SERVER · וידאו מעובד';toast(mode==='rtmp'?'הווידאו נשלח ליעד ה־RTMP השמור.':'הווידאו המעובד נשלח לשרת. פתח את נגן השרת כדי לצפות.');
    }catch{broadcastStream?.getTracks().forEach(t=>t.stop());broadcastStream=null;broadcast=null;toast(mode==='rtmp'?'הגדר יעד RTMP בניהול השרת ובדוק את מפתח השידור.':'לא ניתן להתחיל העברת וידאו. בדוק את כלי הווידאו בשרת.');}
  }
  async function stopBroadcast(){if(broadcastRecorder?.state==='recording')broadcastRecorder.stop();}
  el('send-server').onclick=()=>startBroadcast('preview');el('send-rtmp').onclick=()=>startBroadcast('rtmp');
  setInterval(async()=>{if(!authenticated||document.hidden)return;try{const result=await api('commands?after='+lastCommand);for(const c of result.commands)if(Date.now()-c.at<10000)void play(c.recipe);lastCommand=result.latest;}catch{}},800);
  setInterval(refresh,8000);
  return{draw,attach,refresh,play,stopRecipe,stopBroadcast,setAuth(value){authenticated=value;if(value)void refresh();},mute(on){broadcastStream?.getAudioTracks().forEach(t=>t.enabled=on);}};
}
