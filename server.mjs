import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {RpcClient} from './src/rpc.mjs';
import {normalizeSnapshot,summarizeChanges} from './src/model.mjs';
import {NativeUi} from './src/native-ui.mjs';
import {InviteController} from './src/invites.mjs';
import {BattleController,NativeBattleUi} from './src/battles.mjs';
import {PhoneLink} from './src/phone-link.mjs';
import {StudioAccount,NativeStudioLoginUi} from './src/studio-account.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
export function requestAllowed(req,port,token,api=true){
  if(!new Set(['127.0.0.1:'+port,'localhost:'+port]).has(req.headers.host))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers.origin;
  if(origin&&!new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]).has(origin))return false;
  if(!api)return true;
  return(req.headers.cookie||'').split(';').some(c=>c.trim()==='boostera_session='+token);
}
export function createApp({port=47831,service=new RpcClient(9225),polling=true,focus=focusStudio,nativeUi=new NativeUi(),battleUi=new NativeBattleUi(),loginUi=new NativeStudioLoginUi(),phoneLink=null}={}){
  const token=crypto.randomBytes(32).toString('hex');
  let state={connected:false,live:false,candidates:[],operations:[],battle:null,events:[],error:'CONNECTING'};
  let running=false,lastCandidatesAt=0,batches={},batchEpoch,self=null,lastUserAt=0;
  const history=[];
  let nativeStatus={ready:false},lastNativeAt=0;
  const roomGuard=roomId=>phoneLink?.assertRoom(roomId);
  const invites=new InviteController({service,ui:nativeUi,getState:()=>state,roomGuard});
  const battles=new BattleController({service,ui:battleUi,roomGuard});
  const account=new StudioAccount({ui:loginUi,getState:()=>state});
  async function poll(){
    if(running)return;
    running=true;
    try{
      const[snapshot,providerReady,panel,battleStatus,linked]=await Promise.all([
        service.state('interactionConnection','snapshot'),service.state('interactionConnection','providerReady'),
        service.state('coHostContext','invitePanelState'),service.state('coHostContext','battleStatus'),
        service.state('coHostContext','linkedUsers')]);
      if(!snapshot||typeof snapshot!=='object')throw new Error('INVALID_BRIDGE_STATE');
      if(batchEpoch!==snapshot.session?.epoch){batches={};batchEpoch=snapshot.session?.epoch;lastCandidatesAt=0;}
      if(snapshot.session&&Date.now()-lastCandidatesAt>8000){
        try{batches=await service.state('interactionConnection','candidates.batches')||{};lastCandidatesAt=Date.now();}catch{batches={};}
      }
      if(Date.now()-lastUserAt>15000){
        try{const u=await service.state('user','anchorInfo')||await service.state('user','userInfo');self={name:String(u?.nickname||u?.name||'').slice(0,120),handle:String(u?.display_id||u?.username||'').slice(0,100)};lastUserAt=Date.now();}catch{}
      }
      if(Date.now()-lastNativeAt>4000){try{nativeStatus=await nativeUi.inspect();}catch{nativeStatus={ready:false};}lastNativeAt=Date.now();}
      const next={...normalizeSnapshot(snapshot,{providerReady,panel,battleStatus,linked,batches,nativeCandidates:nativeStatus.ready?nativeStatus.candidates:[]}),self};
      next.actions={mode:nativeStatus?.ready?'native-ui':'observe',invite:Boolean(nativeStatus?.ready&&next.live&&next.providerReady),accept:false,reject:false,reason:nativeStatus?.ready?null:'OPEN_COHOST_PANEL'};
      try{await roomGuard(snapshot.session?.roomId||'');}
      catch(error){next.actions.invite=false;next.actions.reason=error.code||'PHONE_LINK_UNAVAILABLE';}
      for(const event of summarizeChanges(state,next))history.push({...event,id:crypto.randomUUID(),at:Date.now()});
      state={...next,events:history.slice(-100),error:null,version:'0.2.0'};
    }catch{
      const next={connected:false,live:false,health:'offline',candidates:[],operations:[],battle:null,actions:{mode:'observe'},error:'BRIDGE_UNAVAILABLE',lastObservedAt:state.observedAt||state.lastObservedAt,version:'0.1.0'};
      for(const event of summarizeChanges(state,next))history.push({...event,id:crypto.randomUUID(),at:Date.now()});
      state={...next,events:history.slice(-100)};
    }finally{running=false;}
  }
  const timer=polling?setInterval(poll,1800):null;timer?.unref();if(polling)void poll();
  const server=http.createServer(async(req,res)=>{
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    if(!requestAllowed(req,port,token,false))return send(403,{error:'ORIGIN_REJECTED'});
    const url=new URL(req.url,'http://127.0.0.1:'+port);
    if(url.pathname.startsWith('/api/')){
      if(!requestAllowed(req,port,token))return send(401,{error:'OPEN_PANEL_FIRST'});
      if(url.pathname==='/api/state'&&req.method==='GET')return send(200,state);
      if(url.pathname==='/api/account'&&req.method==='GET')return send(200,await account.state());
      if(url.pathname==='/api/account/refresh'&&req.method==='POST'){
        try{await readJson(req);return send(200,await account.refresh());}
        catch(error){return send(error.status||409,{error:['LIVE_ACCOUNT_CHANGE_BLOCKED','QR_REFRESH_NOT_AVAILABLE'].includes(error.message)?error.message:'STUDIO_LOGIN_UNAVAILABLE'});}
      }
      if(url.pathname==='/api/phone'&&req.method==='GET')return send(200,phoneLink?await phoneLink.state(state.session?.roomId):{configured:false,error:'PHONE_LINK_NOT_CONFIGURED'});
      if(url.pathname==='/api/phone/import'&&req.method==='POST'){
        try{if(!phoneLink)throw new Error('PHONE_LINK_NOT_CONFIGURED');return send(200,await phoneLink.importTarget());}
        catch(error){return send(error.status||503,{error:error.code||'PHONE_LINK_UNAVAILABLE'});}
      }
      if(url.pathname==='/api/phone'&&req.method==='DELETE'){
        try{if(!phoneLink)throw new Error('PHONE_LINK_NOT_CONFIGURED');return send(200,await phoneLink.unlink());}
        catch(error){return send(error.status||503,{error:error.code||'PHONE_LINK_UNAVAILABLE'});}
      }
      if(url.pathname==='/api/battles'&&req.method==='GET')return send(200,await battles.state());
      if(url.pathname==='/api/battles/action'&&req.method==='POST'){
        try{const receipt=await battles.execute(await readJson(req));await poll();return send(200,receipt);}
        catch(error){return send(error.status||503,{error:error.code||error.message||'BATTLE_ACTION_FAILED'});}
      }
      if(url.pathname==='/api/refresh'&&req.method==='POST'){await poll();return send(200,{ok:true,connected:state.connected});}
      if((url.pathname==='/api/invites/prepare'||url.pathname==='/api/invites/send')&&req.method==='POST'){
        try{
          const body=await readJson(req);
          if(url.pathname.endsWith('/prepare'))return send(200,await invites.prepare(body));
          const receipt=await invites.send(body);
          history.push({id:crypto.randomUUID(),at:Date.now(),type:receipt.outcome==='failed'?'error':'invite',title:receipt.submitted===true?'הזמנה מהפאנל נקלטה בסטודיו':'נדרש לבדוק את מצב ההזמנה בסטודיו',detail:receipt.error?.message||''});
          await poll();return send(200,receipt);
        }catch(error){return send(error.status||503,{error:error.code||error.message||'INVITE_FAILED'});}
      }
      if(url.pathname==='/api/focus-studio'&&req.method==='POST'){try{return send(200,{ok:await focus()});}catch{return send(503,{error:'FOCUS_UNAVAILABLE'});}}
      return send(404,{error:'NOT_SUPPORTED'});
    }
    const asset=assets.get(url.pathname);
    if(!asset||!['GET','HEAD'].includes(req.method))return send(404,{error:'NOT_FOUND'});
    try{
      const body=await readFile(path.join(root,'dist',asset[0]));
      res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Set-Cookie':'boostera_session='+token+'; HttpOnly; SameSite=Strict; Path=/'});
      res.end(req.method==='HEAD'?undefined:body);
    }catch{send(500,{error:'ASSET_UNAVAILABLE'});}
  });
  server.on('close',()=>{clearInterval(timer);service.close();});
  server.on('error',()=>{clearInterval(timer);service.close();});
  return{server,poll,getState:()=>state};
}

async function readJson(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json')){const e=new Error('JSON_REQUIRED');e.status=415;throw e;}
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){const e=new Error('BODY_TOO_LARGE');e.status=413;throw e;}}
  try{const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{const e=new Error('INVALID_JSON');e.status=400;throw e;}
}

function focusStudio(){
  if(process.platform!=='win32')return Promise.resolve(false);
  return new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-Command',"(New-Object -ComObject WScript.Shell).AppActivate('TikTok LIVE Studio')"],{windowsHide:true});
    let output='';child.stdout.on('data',d=>{output+=d;});child.on('error',()=>resolve(false));child.on('close',()=>resolve(output.trim().endsWith('True')));
    setTimeout(()=>{child.kill();resolve(false);},4000).unref();
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const phoneLink=new PhoneLink({directory:process.env.BOOSTERA_PHONE_CONNECTION_DIR||path.join(os.homedir(),'tikapi','boostera-studio','data','connection'),stateFile:path.join(root,'runtime','phone-link.json')});
  const port=47831,{server}=createApp({port,phoneLink});
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'BOOSTERA is already running on http://127.0.0.1:47831':'Unable to start BOOSTERA');process.exitCode=e.code==='EADDRINUSE'?0:1;if(e.code==='EADDRINUSE'&&process.argv.includes('--open')&&process.platform==='win32')spawn('cmd.exe',['/d','/c','start','','http://127.0.0.1:'+port],{windowsHide:true});});
  server.listen(port,'127.0.0.1',()=>{console.log('BOOSTERA LIVE Web: http://127.0.0.1:'+port);if(process.argv.includes('--open')&&process.platform==='win32')spawn('cmd.exe',['/d','/c','start','','http://127.0.0.1:'+port],{windowsHide:true});});
  process.on('SIGINT',()=>server.close(()=>process.exit(0)));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
