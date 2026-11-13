import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const mediaRoot=path.resolve(process.env.BOX_MEDIA_ROOT||path.join(os.homedir(),'wanna-studio-server'));
const services=[{name:'effects',port:8800,url:'/health',cwd:mediaRoot,script:'server.mjs'},
 {name:'phone',port:8801,url:'/api/mobile/session',cwd:mediaRoot,script:'mobile-gateway.mjs'},
 {name:'studio-control',port:47831,url:'/',cwd:root,script:'server.mjs'}];
async function probe(service){try{const r=await fetch(`http://127.0.0.1:${service.port}${service.url}`,{signal:AbortSignal.timeout(1500)});if(!r.ok)return{ready:false};if(service.name==='phone'){const s=await r.json();return{ready:true,version:s.version};}return{ready:true};}catch{return{ready:false};}}
const report=[];
for(const service of services){
 let state=await probe(service);
 if(!state.ready&&process.argv.includes('--start')){
  if(!fs.existsSync(path.join(service.cwd,service.script)))throw Error('Missing '+service.name+' source');
  const logdir=path.join(root,'runtime','box');fs.mkdirSync(logdir,{recursive:true});
  const out=fs.openSync(path.join(logdir,service.name+'.log'),'a'),err=fs.openSync(path.join(logdir,service.name+'-error.log'),'a');
  const child=spawn(process.execPath,[service.script],{cwd:service.cwd,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  child.on('error',()=>{});child.unref();fs.closeSync(out);fs.closeSync(err);
  for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,500));state=await probe(service);if(state.ready)break;}
 }
 report.push({service:service.name,...state,...(service.name==='phone'&&state.version!=='1.2.0'?{attention:'Phone gateway must run version 1.2.0'}:{})});
}
let studio=false;try{const r=await fetch('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(1500)});studio=r.ok;}catch{}
console.log(JSON.stringify({box:'first-client',encoding:'CPU/libx264',services:report,studioDebugReachable:studio,
 manager:'http://127.0.0.1:8801/mobile/box',pairing:'http://127.0.0.1:8801/mobile/pair',
 attention:studio?'Verify account, media output and battle state before broadcasting.':'Open installed LIVE Studio with the local bridge enabled; no LIVE has been started.'},null,2));
if(report.some(s=>!s.ready||s.attention))process.exitCode=1;
