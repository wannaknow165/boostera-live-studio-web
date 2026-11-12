import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadEnv,ROOT} from './lib/env.mjs';
import {MobileSessions} from './lib/mobile-session.mjs';
import {createWorkspace} from './lib/mobile-workspace.mjs';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
export function localRequest(req,port){return['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&!req.headers['cf-connecting-ip']&&!req.headers['x-forwarded-for']&&['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host);}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]));}
async function body(req,max=4096){let n=0;const chunks=[];for await(const part of req){n+=part.length;if(n>max)throw Object.assign(new Error('BODY_TOO_LARGE'),{status:413});chunks.push(part);}return Buffer.concat(chunks);}
async function jsonBody(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(new Error('JSON_REQUIRED'),{status:415});try{return JSON.parse((await body(req)).toString('utf8'));}catch(e){if(e.status)throw e;throw Object.assign(new Error('INVALID_JSON'),{status:400});}}
export function validMediaPath(input){
  if(typeof input!=='string'||input.includes('\\')||input.split('/').some(x=>x.startsWith('.')||x==='..'))return false;
  if(!/^\/(fx\/(fx-engine\.js|head-tomato\.js|opponent\.js|battle-stage\.js|assets\/|effects\/)|media\/)/.test(input))return false;
  return/\.(js|mjs|json|mp4|webm|mov|png|jpe?g|webp|svg|mp3|wav|glb|gltf|bin|task|tflite|wasm)$/i.test(input);
}
export function createMobileGateway({port=8801,upstreamPort=8800,clientKey='',apiKey='',env={},workspaceRoot=ROOT,workspaceOptions={},sessions=new MobileSessions()}={}){
  const mobileDir=path.join(ROOT,'public','mobile'),frames=new Map(),audio=new Map();let publicUrl='';
  const workspace=createWorkspace({root:workspaceRoot,upstreamPort,apiKey,clientKey,env,...workspaceOptions});
  const localSession={id:'local-desktop',label:'המחשב',frames:0,bytes:0,audioTests:0};
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  function auth(req){return localRequest(req,port)?localSession:sessions.get(cookies(req).wm_sid);}
  function sameOrigin(req){if(req.headers['sec-fetch-site']==='cross-site')return false;const o=req.headers.origin;if(!o)return true;try{const origin=new URL(o);return origin.host===req.headers.host||origin.origin===publicUrl;}catch{return false;}}
  function proxy(req,res,target,method='GET',payload){
    const headers={'x-key':clientKey};if(payload){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(payload);}
    if(req.headers.range){if(!/^bytes=\d*-\d*$/.test(req.headers.range))return send(res,416,{error:'INVALID_RANGE'});headers.range=req.headers.range;}
    const upstream=http.request({host:'127.0.0.1',port:upstreamPort,path:target,method,headers},reply=>{
      const safe={};for(const key of ['content-type','content-length','content-range','accept-ranges'])if(reply.headers[key])safe[key]=reply.headers[key];
      safe['Cache-Control']='private, max-age=0';res.writeHead(reply.statusCode||502,safe);reply.pipe(res);res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
    });
    upstream.setTimeout(target==='/api/stage-events'?180000:20000,()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)send(res,502,{error:'EFFECTS_SERVER_UNAVAILABLE'});else res.end();});
    if(payload)upstream.write(payload);upstream.end();
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Permissions-Policy','camera=(self), microphone=(self), display-capture=(self)');
    try{
      const url=new URL(req.url,'http://gateway'),p=decodeURIComponent(url.pathname);
      if(['POST','PUT','DELETE'].includes(req.method)&&!sameOrigin(req))return send(res,403,{error:'ORIGIN_REJECTED'});
      if(req.method==='OPTIONS'){res.writeHead(405);return res.end();}
      if(await workspace.publicMedia(req,res,url))return;
      if(p==='/'){res.writeHead(302,{Location:'/mobile/'});return res.end();}
      if(p==='/api/mobile/pairing-code'&&req.method==='POST'){
        if(!localRequest(req,port))return send(res,403,{error:'LOCAL_SETUP_ONLY'});
        return send(res,200,{...sessions.issue(),publicUrl});
      }
      if(p==='/api/mobile/public-url'&&req.method==='GET'){
        if(!localRequest(req,port))return send(res,403,{error:'LOCAL_SETUP_ONLY'});return send(res,200,{publicUrl});
      }
      if(p==='/api/mobile/pair'&&req.method==='POST'){
        const b=await jsonBody(req),ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress);
        try{const pair=sessions.pair(b.code,b.label,ip);const secure=Boolean(req.headers['cf-connecting-ip']||req.headers['x-forwarded-proto']==='https');
          res.setHeader('Set-Cookie','wm_sid='+pair.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(secure?'; Secure':''));
          return send(res,200,{ok:true,device:{id:pair.session.id,label:pair.session.label}});
        }catch(e){return send(res,e.message==='TOO_MANY_ATTEMPTS'?429:401,{error:e.message});}
      }
      if(p==='/mobile/manifest.webmanifest'||p==='/mobile/sw.js'||p.startsWith('/mobile/')){
        let name=p==='/mobile/'?'index.html':p.slice('/mobile/'.length);
        if(name==='pair')name='pair.html';
        if(name==='manage'||name==='manage/')name='manage.html';
        if(name==='viewer'||name==='viewer/')name='viewer.html';
        if(name==='pair.html'&&!localRequest(req,port))return send(res,403,{error:'LOCAL_SETUP_ONLY'});
        if(!['index.html','pair.html','app.js','app.css','manage.html','manage.js','workspace.css','render.js','battle.js','chat.js','audio.js','viewer.html','viewer.js','pair.js','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png','icon.svg'].includes(name))return send(res,404,{error:'NOT_FOUND'});
        const file=path.join(mobileDir,name);if(!fs.existsSync(file))return send(res,404,{error:'NOT_FOUND'});
        res.writeHead(200,{'Content-Type':TYPES[path.extname(name)]||'application/octet-stream','Cache-Control':name==='sw.js'?'no-cache':'no-cache',
          'Service-Worker-Allowed':'/mobile/',
          'Content-Security-Policy':"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"});
        fs.createReadStream(file).pipe(res);return;
      }
      const session=auth(req);if(!session)return send(res,401,{error:'PAIRING_REQUIRED'});
      if(await workspace.handle(req,res,url,session))return;
      if(p==='/api/mobile/logout'&&req.method==='POST'){sessions.revoke(cookies(req).wm_sid);res.setHeader('Set-Cookie','wm_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});}
      if(p==='/api/mobile/session'&&req.method==='GET'){
        let online=false,counts={};try{const response=await fetch('http://127.0.0.1:'+upstreamPort+'/health',{signal:AbortSignal.timeout(3000)});const h=await response.json();online=response.ok;counts={effects:Number(h.liveEffects)||0,templates:Number(h.templates)||0};}catch{}
        return send(res,200,{authenticated:true,local:localRequest(req,port),device:{id:session.id,label:session.label},effectsServer:online,counts,serverTime:Date.now(),stats:{frames:session.frames,bytes:session.bytes,audioTests:session.audioTests,lastFrameAt:frames.get(session.id)?.at||null},platform:{tiktokConnected:workspace.live.state.status==='connected',battlesConnected:workspace.live.state.status==='connected'&&Boolean(workspace.live.state.battle)},version:'1.2.0'});
      }
      if(p==='/api/mobile/frame'&&req.method==='POST'){
        const raw=await body(req,512*1024),mime=String(req.headers['content-type']||'').split(';')[0];
        const jpeg=raw.length>20&&raw[0]===255&&raw[1]===216&&raw[2]===255,png=raw.length>20&&raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        if(!(mime==='image/jpeg'&&jpeg||mime==='image/png'&&png))return send(res,400,{error:'INVALID_FRAME'});
        if(frames.get(session.id)&&Date.now()-frames.get(session.id).at<200)return send(res,429,{error:'FRAME_RATE_LIMIT'});
        const at=Date.now();session.frames++;session.bytes+=raw.length;frames.set(session.id,{raw,mime,at});
        return send(res,200,{accepted:true,sequence:session.frames,bytes:raw.length,serverTime:at,digest:crypto.createHash('sha256').update(raw).digest('hex')});
      }
      if(p==='/api/mobile/frame'&&req.method==='GET'){
        const item=frames.get(session.id);if(!item||Date.now()-item.at>30000)return send(res,404,{error:'NO_RECENT_FRAME'});
        res.writeHead(200,{'Content-Type':item.mime,'Cache-Control':'no-store'});res.end(item.raw);return;
      }
      if(p==='/api/mobile/audio-test'&&req.method==='POST'){
        const raw=await body(req,1024*1024),mime=String(req.headers['content-type']||'');
        if(raw.length<20||!/^(audio|video)\/(mp4|webm|ogg)/.test(mime))return send(res,400,{error:'INVALID_AUDIO'});
        audio.set(session.id,{raw,mime,at:Date.now()});session.audioTests++;return send(res,200,{accepted:true,bytes:raw.length,serverTime:Date.now()});
      }
      if(p==='/api/mobile/audio-test'&&req.method==='GET'){const a=audio.get(session.id);if(!a||Date.now()-a.at>60000)return send(res,404,{error:'NO_RECENT_AUDIO'});res.writeHead(200,{'Content-Type':a.mime,'Cache-Control':'no-store'});res.end(a.raw);return;}
      if(p==='/api/mobile/catalog'&&req.method==='GET')return proxy(req,res,'/api/catalog');
      if(p==='/api/battle'&&req.method==='GET')return proxy(req,res,'/api/battle');
      if(p==='/api/mobile/effects'&&req.method==='GET')return proxy(req,res,'/fx/effects/index.json');
      if(p==='/api/mobile/events'&&req.method==='GET')return proxy(req,res,'/api/stage-events');
      if(p==='/api/mobile/screen'&&req.method==='POST'){
        const b=await jsonBody(req);if(!['hits','double','wake','tomato','stop'].includes(b.type))return send(res,400,{error:'UNKNOWN_EFFECT'});
        const clean={type:b.type,count:Math.max(1,Math.min(10,Number(b.count)||1)),mult:[2,3,5].includes(Number(b.mult))?Number(b.mult):2,seconds:Math.max(1,Math.min(60,Number(b.seconds)||30))};
        return proxy(req,res,'/api/screen','POST',JSON.stringify(clean));
      }
      if(p==='/api/mobile/overlay'&&req.method==='POST'){
        const b=await jsonBody(req);if(typeof b.id!=='string'||!/^[\w.-]{1,100}$/.test(b.id))return send(res,400,{error:'INVALID_EFFECT_ID'});
        return proxy(req,res,'/api/overlay/play','POST',JSON.stringify({id:b.id,loop:false}));
      }
      if(p==='/api/mobile/stop'&&req.method==='POST')return proxy(req,res,'/api/desk/stop','POST','{}');
      if(req.method==='GET'&&validMediaPath(p))return proxy(req,res,p+url.search);
      return send(res,404,{error:'NOT_FOUND'});
    }catch(e){if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'REQUEST_FAILED'});else res.end();}
  });
  const cleanup=setInterval(()=>{sessions.prune();for(const[k,v]of frames)if(Date.now()-v.at>30000)frames.delete(k);for(const[k,v]of audio)if(Date.now()-v.at>60000)audio.delete(k);},15000);cleanup.unref();
  server.on('close',()=>{clearInterval(cleanup);void workspace.close();});
  return{server,sessions,workspace,setPublicUrl(value){const u=new URL(value);if(u.protocol!=='https:')throw new Error('HTTPS_REQUIRED');publicUrl=u.origin;workspace.setPublicUrl(publicUrl);},getPublicUrl:()=>publicUrl};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const env=loadEnv(),port=Number(process.env.MOBILE_PORT)||8801,app=createMobileGateway({port,upstreamPort:Number(env.PORT)||8800,clientKey:env.STUDIO_CLIENT_KEY||'',apiKey:env.API_TOKEN||'',env});
  let tunnel;
  app.server.listen(port,'127.0.0.1',()=>{
    console.log('WANNA mobile: http://127.0.0.1:'+port+'/mobile/');console.log('Local pairing: http://127.0.0.1:'+port+'/mobile/pair');
    if(process.argv.includes('--tunnel')){
      const exe=process.platform==='win32'?'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe':'cloudflared';
      tunnel=spawn(exe,['tunnel','--url','http://127.0.0.1:'+port,'--no-autoupdate','--protocol','http2'],{windowsHide:true});
      let buffer='';tunnel.stderr.on('data',data=>{buffer=(buffer+data.toString()).slice(-8000);const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match&&!app.getPublicUrl()){app.setPublicUrl(match[0]);console.log('MOBILE_PUBLIC_URL '+app.getPublicUrl()+'/mobile/');fs.mkdirSync(path.join(ROOT,'runtime'),{recursive:true});fs.writeFileSync(path.join(ROOT,'runtime','mobile-url.txt'),app.getPublicUrl()+'/mobile/');}});
      tunnel.on('error',()=>console.error('HTTPS_TUNNEL_UNAVAILABLE'));tunnel.on('exit',()=>console.log('HTTPS_TUNNEL_STOPPED'));
    }
    if(process.argv.includes('--open')&&process.platform==='win32')spawn('cmd.exe',['/d','/c','start','','http://127.0.0.1:'+port+'/mobile/pair'],{windowsHide:true});
  });
  app.server.on('error',e=>{console.error('MOBILE_START_FAILED '+e.code);process.exitCode=1;});
  const stop=()=>{tunnel?.kill();app.server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}