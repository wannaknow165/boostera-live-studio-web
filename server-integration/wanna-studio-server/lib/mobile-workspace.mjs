import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {LiveEvents} from './mobile-live-events.mjs';
import {videoModels,generateRemix,resumeVideo} from './mobile-generation.mjs';
import {Broadcasts} from './mobile-broadcast.mjs';
import {readCapturedTarget} from './mobile-rtmp-import.mjs';
import {configureMediaTools} from './mobile-tools.mjs';
export const ANCHORS=['screen','head','eyes','chest','shoulderL','shoulderR','handL','handR','waist','body'];
const fail=(code,status=400)=>Object.assign(Error(code),{status});
const text=(v,max=120)=>typeof v==='string'?v.trim().slice(0,max):'';
const number=(v,f,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):f;
const id=p=>p+'_'+crypto.randomBytes(8).toString('hex');
const mediaUrl=v=>typeof v==='string'&&/^\/(media|fx)\/[a-zA-Z0-9_/.% -]+\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(v)&&!v.split('/').some(s=>s.startsWith('.'))?v:null;
export function validateRecipe(input,previous={}){
  const anchor=ANCHORS.includes(input.anchor)?input.anchor:'screen',kind=['image','video','battle','live'].includes(input.kind)?input.kind:'image';
  const url=mediaUrl(input.url);if(!['battle','live'].includes(kind)&&!url)throw fail('INVALID_MEDIA_URL');
  return{id:previous.id||id('fx'),clientId:text(input.clientId,60),title:text(input.title)||'אפקט אישי',kind,url: url||null,effectId:text(input.effectId,100),anchor,targetHead:Math.round(number(input.targetHead,0,0,3)),x:number(input.x,.5,0,1),y:number(input.y,.5,0,1),scale:number(input.scale,.3,.03,2),offsetX:number(input.offsetX,0,-1,1),offsetY:number(input.offsetY,0,-1,1),rotation:number(input.rotation,0,-180,180),opacity:number(input.opacity,1,0,1),duration:number(input.duration,10,1,300),loop:Boolean(input.loop),circle:Boolean(input.circle),layer:input.layer==='back'?'back':'front',createdAt:previous.createdAt||Date.now(),updatedAt:Date.now()};
}
async function read(req,max=16384){const parts=[];let n=0;for await(const part of req){n+=part.length;if(n>max)throw fail('BODY_TOO_LARGE',413);parts.push(part);}return Buffer.concat(parts);}
async function json(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail('JSON_REQUIRED',415);try{return JSON.parse(await read(req,262144));}catch(e){if(e.status)throw e;throw fail('INVALID_JSON');}}
function imageExtension(raw,mime){if(mime==='image/png'&&raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'png';if(mime==='image/jpeg'&&raw[0]===255&&raw[1]===216)return'jpg';if(mime==='image/webp'&&raw.toString('ascii',0,4)==='RIFF'&&raw.toString('ascii',8,12)==='WEBP')return'webp';return null;}
export function createWorkspace({root,upstreamPort=8800,apiKey='',clientKey='',env={},liveFactory,tools:providedTools}={}){
  const tools=providedTools||configureMediaTools(root),file=path.join(root,'data','mobile-workspace.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  let db={version:1,clients:[],recipes:[],jobs:[],recipeRules:[],rtmp:null};
  if(fs.existsSync(file))db={...db,...JSON.parse(fs.readFileSync(file,'utf8'))};
  for(const job of db.jobs)if(['queued','processing'].includes(job.status))job.status=job.taskId?'queued':'interrupted';
  const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(db,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const original=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'data','db.json'),'utf8'));}catch{return{templates:{},avatars:{},orders:{},costs:[]};}};
  const fxTemplates=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'fx','effects','index.json'),'utf8')).map(e=>({id:'ar:'+e.id,title:e.title?.includes('???')?e.id:e.title,character:e.id,modes:['replace'],layer:'front',duration:e.duration,fxDir:e.dir}));}catch{return[];}};
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
  async function upstream(route,method='GET',data){const r=await fetch('http://127.0.0.1:'+upstreamPort+route,{method,headers:{'x-api-key':apiKey,'x-key':clientKey,...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(20000)});const j=await r.json();if(!r.ok)throw fail('EFFECTS_API_'+r.status,r.status);return j;}
  let publicBase='',working=0;const tickets=new Map(),commands=[];let commandSequence=0;
  const live=new LiveEvents({factory:liveFactory,signApiKey:env.SIGN_API_KEY||env.EULER_API_KEY||'',onAutomation:event=>fire(event)});
  const ruleTimes=new Map();
  function command(recipe){const entry={sequence:++commandSequence,at:Date.now(),recipe};commands.push(entry);if(commands.length>40)commands.shift();return entry;}
  async function fire(event){
    for(const rule of db.recipeRules.filter(r=>r.enabled&&r.on===event.type&&(!r.match||r.match.toLowerCase()===String(event.gift||'').toLowerCase()))){
      const key=rule.id+'|'+(event.user||'');if(Date.now()-(ruleTimes.get(key)||0)<rule.cooldownMs)continue;const recipe=db.recipes.find(r=>r.id===rule.action.id);if(!recipe)continue;ruleTimes.set(key,Date.now());const timer=setTimeout(()=>command(recipe),rule.delayMs||0);timer.unref();
    }
    return upstream('/api/event','POST',event);
  }
  function rtmpUrl(){if(!db.rtmp?.url)return null;return db.rtmp.key?db.rtmp.url.replace(/\/$/,'')+'/'+db.rtmp.key:db.rtmp.url;}
  const broadcasts=new Broadcasts({root,ffmpeg:tools.ffmpeg,rtmp:rtmpUrl});
  function config(){return{version:'1.1.0',mediaTools:tools.installed,aiConfigured:Boolean(env.KLING_API_KEY||env.OPENROUTER_API_KEY),aiReachable:Boolean(env.OPENROUTER_API_KEY||env.KLING_API_KEY&&publicBase),remixConfigured:Boolean(env.OPENROUTER_API_KEY),remixModel:env.FX_REMIX_MODEL||env.FX_VIDEO_MODEL||'kwaivgi/kling-v3.0-pro',publicHttps:Boolean(publicBase),rtmpConfigured:Boolean(rtmpUrl()),rtmpHost:db.rtmp?.host||null,tiktok:{readEventsInstalled:true,connected:live.state.status==='connected',startLive:false,invitations:false,startBattle:false,reason:'ACCOUNT_WRITE_CONNECTOR_REQUIRED'},features:[{id:'camera',name:'מצלמה ומיקרופון',ready:true},{id:'tracking',name:'מעקב פנים וגוף',ready:true},{id:'multihead',name:'בחירת ראש מתוך ארבעה',ready:true},{id:'customer',name:'לקוחות ואווטרים',ready:true},{id:'recipes',name:'שכבות על פנים וגוף',ready:true},{id:'generation',name:'יצירת סרטונים מותאמים',ready:Boolean(env.OPENROUTER_API_KEY||env.KLING_API_KEY&&publicBase)},{id:'automations',name:'כללי מתנות ובאטלים',ready:true},{id:'ingest',name:'וידאו מעובד לשרת',ready:tools.installed},{id:'rtmp',name:'שידור RTMP',ready:tools.installed&&Boolean(rtmpUrl())},{id:'battle_read',name:'קליטת אירועי TikTok מחוברת',ready:live.state.status==='connected'},{id:'live_start',name:'פתיחת לייב עצמאית ב־TikTok',ready:false},{id:'battle_write',name:'הזמנות ופתיחת באטל ב־TikTok',ready:false}]};}
  async function run(job){
    working++;job.status='processing';job.startedAt=Date.now();save();
    try{
      const client=db.clients.find(c=>c.id===job.clientId),template=job.templateId.startsWith('ar:')?fxTemplates().find(t=>t.id===job.templateId):original().templates[job.templateId];
      if(!client||!template)throw fail('SOURCE_NOT_FOUND');
      let response,task=null,token=null;
      if(template.fxDir){
        const effect=JSON.parse(fs.readFileSync(path.join(root,'fx','effects',template.fxDir,'effect.json'),'utf8'));
        const result=job.taskId?await resumeVideo({env,taskId:job.taskId,onTick:status=>{job.providerStatus=status;save();}}):await generateRemix({env,effect,imagePath:path.join(root,client.avatarUrl.slice(1)),model:job.model,resolution:job.resolution,transparent:job.transparent,onTask:taskId=>{job.taskId=taskId;save();},onTick:status=>{job.providerStatus=status;save();}});
        response=result.response;job.costUsd=result.costUsd;
      }else{
        token=crypto.randomBytes(24).toString('hex');tickets.set(token,{file:path.join(root,'media',template.file),expires:Date.now()+75*60000});
        const {buildPrompt,submitEdit,waitTask}=await import('./kling.mjs');
        if(!job.taskId)job.taskId=await submitEdit({env,videoUrl:publicBase+'/api/workspace/generation-media/'+token,imagePath:path.join(root,client.avatarUrl.slice(1)),prompt:buildPrompt({mode:job.mode,character:template.character,green:job.transparent}),resolution:job.resolution});save();
        task=await waitTask({env,taskId:job.taskId,onTick:status=>{job.providerStatus=status;save();}});
        const video=task.outputs?.find(o=>o.type==='video');if(!video?.url||new URL(video.url).protocol!=='https:')throw fail('INVALID_PROVIDER_OUTPUT');
        response=await fetch(video.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw fail('OUTPUT_DOWNLOAD_FAILED');
      }
      const out=path.join(root,'media','mobile',job.id);fs.mkdirSync(out,{recursive:true});const destination=path.join(out,'result.mp4');
      const handle=fs.openSync(destination,'w');let bytes=0;try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024*1024)throw fail('OUTPUT_TOO_LARGE');fs.writeSync(handle,chunk);}}finally{fs.closeSync(handle);}
      job.url='/media/mobile/'+job.id+'/result.mp4';
      if(job.transparent){const {makeTransparent}=await import('./media.mjs');await makeTransparent(destination,path.join(out,'overlay'),{prores:false});job.url='/media/mobile/'+job.id+'/overlay.webm';}
      job.units=(task?.billing||[]).filter(b=>b.charge_type==='unit').reduce((sum,b)=>sum+Number(b.amount||0),0);job.status='succeeded';job.finishedAt=Date.now();db.recipes.push(validateRecipe({clientId:client.id,title:client.name+' · '+(template.title||template.id),kind:'video',url:job.url,anchor:'screen',scale:1,duration:template.duration||15,circle:false}));
      tickets.delete(token);
    }catch(e){job.status='failed';job.error=e.status?e.message:'GENERATION_OR_TRANSPARENCY_FAILED';job.finishedAt=Date.now();}
    finally{working--;save();kick();}
  }
  function kick(){if(!env.KLING_API_KEY&&!env.OPENROUTER_API_KEY)return;for(const job of db.jobs.filter(j=>j.status==='queued'&&(j.taskId||j.templateId.startsWith('ar:')||publicBase))){if(working>=2)break;void run(job);}}
  async function publicMedia(req,res,url){const match=/^\/api\/workspace\/generation-media\/([a-f0-9]{48})$/.exec(url.pathname);if(!match)return false;const item=tickets.get(match[1]);if(req.method!=='GET'||!item||Date.now()>item.expires||!fs.existsSync(item.file))return send(res,404,{error:'NOT_FOUND'});res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'no-store','Content-Length':fs.statSync(item.file).size});fs.createReadStream(item.file).pipe(res);return true;}
  async function handle(req,res,url,session){
    const p=url.pathname;if(!p.startsWith('/api/workspace/'))return false;
    if(p==='/api/workspace/video-models'&&req.method==='GET')return send(res,200,{models:await videoModels(env)});
    if(p==='/api/workspace/config'&&req.method==='GET')return send(res,200,config());
    if(p==='/api/workspace/overview'&&req.method==='GET'){const source=original();return send(res,200,{config:config(),clients:db.clients,recipes:db.recipes,jobs:db.jobs.slice(-100).reverse(),templates:[...fxTemplates(),...Object.values(source.templates||{}).filter(t=>t.enabled!==false).map(t=>({id:t.id,title:t.title,character:t.character,modes:t.modes,layer:t.layer,url:'/media/'+t.file,duration:t.duration}))],avatars:Object.values(source.avatars||{}).map(a=>({id:a.id,name:a.name,url:'/media/'+a.file})),broadcasts:broadcasts.list()});}
    if(p==='/api/workspace/clients'&&req.method==='POST'){
      const b=await json(req),old=db.clients.find(c=>c.id===b.id),name=text(b.name);if(!name)throw fail('CLIENT_NAME_REQUIRED');if(!old&&db.clients.length>=1000)throw fail('CLIENT_LIMIT',409);
      const client={id:old?.id||id('client'),name,handle:text(b.handle,40).replace(/^@/,''),avatarUrl:mediaUrl(b.avatarUrl)||old?.avatarUrl||null,notes:text(b.notes,1000),createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};db.clients= db.clients.filter(c=>c.id!==client.id).concat(client);save();return send(res,old?200:201,client);
    }
    if(/^\/api\/workspace\/clients\/[\w-]+$/.test(p)&&req.method==='DELETE'){const clientId=p.split('/').pop();if(db.jobs.some(j=>j.clientId===clientId&&['queued','processing'].includes(j.status)))throw fail('CLIENT_HAS_ACTIVE_JOBS',409);db.clients=db.clients.filter(c=>c.id!==clientId);db.recipes=db.recipes.filter(r=>r.clientId!==clientId);save();return send(res,200,{ok:true});}
    if(p==='/api/workspace/templates'&&req.method==='POST'){
      const raw=await read(req,64*1024*1024);if(raw.length<16||raw.toString('ascii',4,8)!=='ftyp')throw fail('MP4_TEMPLATE_REQUIRED');
      const params=new URLSearchParams({title:text(url.searchParams.get('title'),100)||'תבנית אישית',character:text(url.searchParams.get('character'),200)||'the main character',trimStart:String(number(url.searchParams.get('trimStart'),0,0,3600)),trimEnd:String(number(url.searchParams.get('trimEnd'),0,0,3600)),layer:url.searchParams.get('layer')==='background'?'background':'front',modes:'replace,add'});
      const response=await fetch('http://127.0.0.1:'+upstreamPort+'/api/templates?'+params,{method:'POST',headers:{'x-api-key':apiKey,'Content-Type':'video/mp4'},body:raw,signal:AbortSignal.timeout(180000)});const value=await response.json();if(!response.ok)throw fail('TEMPLATE_PREPARATION_FAILED',response.status);return send(res,201,{id:value.id,title:value.title,url:'/media/'+value.file});
    }
    if(/^\/api\/workspace\/templates\/[\w-]+$/.test(p)&&req.method==='DELETE'){const templateId=p.split('/').pop();if(!original().templates[templateId])throw fail('TEMPLATE_NOT_FOUND',404);return send(res,200,await upstream('/api/templates/'+templateId,'DELETE'));}
    if(p==='/api/workspace/upload'&&req.method==='POST'){
      const raw=await read(req,64*1024*1024),mime=String(req.headers['content-type']||'').split(';')[0],image=imageExtension(raw,mime);
      let ext=image;if(!ext&&mime==='video/mp4'&&raw.toString('ascii',4,8)==='ftyp')ext='mp4';if(!ext&&mime==='video/webm'&&raw.subarray(0,4).equals(Buffer.from([26,69,223,163])))ext='webm';if(!ext)throw fail('INVALID_MEDIA_FILE');
      if(image&&raw.length>8*1024*1024)throw fail('IMAGE_TOO_LARGE',413);
      const assetId=id('asset'),dir=path.join(root,'media','mobile','uploads');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,assetId+'.'+ext),raw);return send(res,201,{id:assetId,url:'/media/mobile/uploads/'+assetId+'.'+ext,kind:image?'image':'video',bytes:raw.length});
    }
    if(p==='/api/workspace/recipes'&&req.method==='POST'){const b=await json(req),old=db.recipes.find(r=>r.id===b.id);if(b.clientId&&!db.clients.some(c=>c.id===b.clientId))throw fail('CLIENT_NOT_FOUND');const recipe=validateRecipe(b,old);db.recipes=db.recipes.filter(r=>r.id!==recipe.id).concat(recipe);save();return send(res,old?200:201,recipe);}
    if(/^\/api\/workspace\/recipes\/[\w-]+$/.test(p)&&req.method==='DELETE'){db.recipes=db.recipes.filter(r=>r.id!==p.split('/').pop());save();return send(res,200,{ok:true});}
    if(p==='/api/workspace/commands'&&req.method==='GET')return send(res,200,{commands:commands.filter(c=>c.sequence>Number(url.searchParams.get('after')||0)),latest:commandSequence});
    if(p==='/api/workspace/play'&&req.method==='POST'){const b=await json(req),recipe=db.recipes.find(r=>r.id===b.id);if(!recipe)throw fail('RECIPE_NOT_FOUND',404);command(recipe);return send(res,200,{ok:true,sequence:commandSequence});}
    if(p==='/api/workspace/generate'&&req.method==='POST'){
      const b=await json(req);const ar=String(b.templateId||'').startsWith('ar:');if(ar?!env.OPENROUTER_API_KEY:!env.KLING_API_KEY)throw fail('AI_KEY_NOT_CONFIGURED',409);if(!ar&&!publicBase)throw fail('PUBLIC_HTTPS_REQUIRED_FOR_PROVIDER_VIDEO',409);if(!tools.installed&&b.transparent)throw fail('MEDIA_TOOLS_REQUIRED',409);
      const client=db.clients.find(c=>c.id===b.clientId),template=ar?fxTemplates().find(t=>t.id===b.templateId):original().templates[b.templateId];if(!client?.avatarUrl||!template||template.enabled===false)throw fail('CLIENT_AVATAR_AND_TEMPLATE_REQUIRED');if(!b.spendAccepted)throw fail('GENERATION_COST_NOT_ACCEPTED');
      if(b.requestId&&db.jobs.some(j=>j.requestId===b.requestId))return send(res,200,db.jobs.find(j=>j.requestId===b.requestId));
      const job={id:id('job'),requestId:text(b.requestId,100)||null,clientId:client.id,templateId:template.id,mode:b.mode==='add'?'add':'replace',transparent:Boolean(b.transparent),resolution:b.resolution==='720p'?'720p':'1080p',model:ar?text(b.model,150):null,status:'queued',createdAt:Date.now()};if(ar){const models=await videoModels(env);if(!models.some(m=>m.id===job.model&&m.frames.includes('first_frame')))throw fail('VIDEO_MODEL_NOT_AVAILABLE');}if(!template.modes?.includes(job.mode))throw fail('MODE_NOT_SUPPORTED');db.jobs.push(job);save();kick();return send(res,202,job);
    }
    if(p==='/api/workspace/automations'&&req.method==='GET'){const data=await upstream('/api/automations');return send(res,200,{...data,rules:[...(data.rules||[]),...db.recipeRules]});}
    if(p==='/api/workspace/automations'&&req.method==='PUT'){
      const b=await json(req);if(!Array.isArray(b)||b.length>200)throw fail('INVALID_RULES');
      const events=['battle_start','gift_x2','gift_x3','gift_x5','snipe','lead','win','lose','coins_goal','quiet','gift','supporter_gift'],actions=['recipe','overlay','special','player_random','clip','live','supporter_video','screen_hits','double','wake_up','tomato'];
      const rules=b.map(r=>{if(!events.includes(r.on)||!actions.includes(r.action?.type))throw fail('INVALID_RULE');return{id:text(r.id,80)||id('rule'),on:r.on,match:text(r.match,80),enabled:Boolean(r.enabled),note:text(r.note,250),delayMs:number(r.delayMs,0,0,60000),cooldownMs:number(r.cooldownMs,2500,0,600000),action:{type:r.action.type,id:text(r.action.id,100),count:number(r.action.count,1,1,10),mult:[2,3,5].includes(Number(r.action.mult))?Number(r.action.mult):2,seconds:number(r.action.seconds,30,1,60),perGift:Boolean(r.action.perGift),style:r.action.style==='head'?'head':'live'}};});
      for(const rule of rules)if(rule.action.type==='recipe'&&!db.recipes.some(r=>r.id===rule.action.id))throw fail('RECIPE_NOT_FOUND');
      const result=await upstream('/api/automations','PUT',rules.filter(r=>r.action.type!=='recipe'));db.recipeRules=rules.filter(r=>r.action.type==='recipe');save();return send(res,200,{...result,rules});
    }
    if(p==='/api/workspace/test-event'&&req.method==='POST'){const b=await json(req);return send(res,200,await fire({type:text(b.type,40),gift:text(b.gift,60),count:number(b.count,1,1,10),user:text(b.user,50),supporter:text(b.supporter,60),source:'manual-test'}));}
    if(p==='/api/workspace/tiktok'&&req.method==='GET')return send(res,200,live.snapshot());
    if(p==='/api/workspace/tiktok/connect'&&req.method==='POST'){const b=await json(req);return send(res,200,await live.connect(text(b.handle,40)));}
    if(p==='/api/workspace/tiktok/disconnect'&&req.method==='POST')return send(res,200,await live.disconnect());
    if(['/api/workspace/tiktok/invite','/api/workspace/tiktok/start-battle'].includes(p))return send(res,501,{error:'ACCOUNT_WRITE_CONNECTOR_REQUIRED',message:'לא הוגדר חיבור מורשה לשליחת הזמנות או לפתיחת באטל. קליטת אירועי לייב זמינה בנפרד.'});
    if(p==='/api/workspace/rtmp'&&req.method==='PUT'){
      const b=await json(req);if(b.clear){db.rtmp=null;save();return send(res,200,config());}
      let destination;try{destination=new URL(text(b.url,1500));}catch{throw fail('INVALID_RTMP_URL');}
      if(!['rtmp:','rtmps:'].includes(destination.protocol)||destination.username||destination.password)throw fail('INVALID_RTMP_URL');
      db.rtmp={url:destination.href,key:text(b.key,500),host:destination.hostname};save();return send(res,200,config());
    }
    if(p==='/api/workspace/rtmp/import'&&req.method==='POST'){db.rtmp=readCapturedTarget(env.RTMP_IMPORT_FILE);save();return send(res,200,config());}
    if(p==='/api/workspace/broadcast/start'&&req.method==='POST'){if(!tools.installed)throw fail('MEDIA_TOOLS_REQUIRED',409);const b=await json(req);return send(res,201,broadcasts.start({mode:b.mode,mime:b.mime,owner:session.id}));}
    const match=/^\/api\/workspace\/broadcast\/([a-f0-9]{24})\/(chunk|stop|files\/(.+))$/.exec(p);
    if(match){const [,stream,action,name]=match;
      if(action==='chunk'&&req.method==='POST')return send(res,200,await broadcasts.append(stream,session.id,Number(req.headers['x-sequence']),await read(req,8*1024*1024)));
      if(action==='stop'&&req.method==='POST')return send(res,200,await broadcasts.stop(stream,session.id));
      if(name&&req.method==='GET'){const f=broadcasts.file(stream,name);if(!f)return send(res,404,{error:'STREAM_FILE_NOT_READY'});const type=name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.m4s')?'video/iso.segment':'video/mp4';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Length':fs.statSync(f).size});fs.createReadStream(f).pipe(res);return true;}
    }
    if(p==='/api/workspace/costs'&&req.method==='GET')return send(res,200,{mobile:db.jobs.filter(j=>j.units||j.costUsd).map(j=>({id:j.id,clientId:j.clientId,units:j.units,costUsd:j.costUsd})),existing:original().costs||[]});
    if(p==='/api/workspace/balance'&&req.method==='GET')return send(res,200,await upstream('/api/kling/units'));
    return send(res,404,{error:'WORKSPACE_ROUTE_NOT_FOUND'});
  }
  queueMicrotask(kick);
  return{handle,publicMedia,config,live,broadcasts,db,setPublicUrl(value){publicBase=value?new URL(value).origin:'';kick();},async close(){await live.disconnect();await broadcasts.close();}};
}
