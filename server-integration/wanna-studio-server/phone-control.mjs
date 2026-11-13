// Hosted camera-page account controls. Reuse existing pairing and native Studio bridge.
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MobileSessions} from './lib/mobile-session.mjs';
import {MobileStudio} from './lib/mobile-studio.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const nativeRoutes=new Set(['GET /api/mobile/studio/account','POST /api/mobile/studio/account/refresh']);
export function createPhoneControl({port=8801,origin,studioPort=47831,sessions=new MobileSessions()}={}){
  const publicOrigin=new URL(origin);if(publicOrigin.protocol!=='https:')throw Error('HTTPS_REQUIRED');
  const bridge=new MobileStudio({port:studioPort});
  const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&!req.headers['x-forwarded-for']&&!req.headers['cf-connecting-ip']&&['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host);
  const session=req=>{const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('wm_sid='))?.slice(7);return{token,device:sessions.get(token)};};
  async function json(req){
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(Error('JSON_REQUIRED'),{status:415});
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>4096)throw Object.assign(Error('BODY_TOO_LARGE'),{status:413});}
    try{const value=JSON.parse(data);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(Error('INVALID_JSON'),{status:400});}
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));};
    try{
      if(!local(req)&&req.headers.host!==publicOrigin.host)return send(403,{error:'HOST_REJECTED'});
      if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==publicOrigin.origin)return send(403,{error:'ORIGIN_REJECTED'});
      const url=new URL(req.url,publicOrigin);if(url.search)return send(404,{error:'NOT_SUPPORTED'});
      const p=url.pathname;
      if(p==='/health'&&req.method==='GET')return send(200,{status:'ok',service:'phone-control',version:'1.2.1'});
      if(p==='/api/mobile/pairing-code'&&req.method==='POST')return local(req)?send(200,sessions.issue()):send(403,{error:'LOCAL_SETUP_ONLY'});
      if(p==='/api/mobile/pair'&&req.method==='POST'){
        const b=await json(req),ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress);
        try{const paired=sessions.pair(b.code,b.label,ip);res.setHeader('Set-Cookie','wm_sid='+paired.token+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age='+Math.floor(sessions.ttl/1000));return send(200,{ok:true,device:{id:paired.session.id,label:paired.session.label}});}
        catch(error){return send(error.message==='TOO_MANY_ATTEMPTS'?429:401,{error:['TOO_MANY_ATTEMPTS','INVALID_PAIRING_CODE','DEVICE_LIMIT'].includes(error.message)?error.message:'PAIRING_FAILED'});}
      }
      if(p==='/mobile/box.js'&&req.method==='GET'){
        const body=await readFile(path.join(root,'public/mobile/box.js'));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(body);
      }
      const {token,device}=session(req);
      if(!device)return send(401,{error:'PAIRING_REQUIRED'});
      if(p==='/api/mobile/session'&&req.method==='GET')return send(200,{authenticated:true,device:{id:device.id,label:device.label},local:false,version:'1.2.1'});
      if(p==='/api/mobile/logout'&&req.method==='POST'){sessions.revoke(token);res.setHeader('Set-Cookie','wm_sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
      if(nativeRoutes.has(req.method+' '+p))return void await bridge.handle(req,res,url,device,json);
      return send(404,{error:'NOT_SUPPORTED'});
    }catch(error){return send(error.status||503,{error:error.status?error.message:'CONTROL_UNAVAILABLE'});}
  });
  return{server,sessions};
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.MOBILE_PORT)||8801;
  const sessions=new MobileSessions({stateFile:path.join(process.env.STATE_DIRECTORY||path.join(root,'data'),'phone-sessions.json')});
  const app=createPhoneControl({port,origin:process.env.PHONE_PUBLIC_ORIGIN,sessions});
  app.server.listen(port,'127.0.0.1',()=>console.log('Phone account controls ready'));
  app.server.on('error',()=>{console.error('PHONE_CONTROL_FAILED');process.exitCode=1;});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.server.close(()=>process.exit(0)));
}
