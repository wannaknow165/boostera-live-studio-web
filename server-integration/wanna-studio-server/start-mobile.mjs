import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadEnv} from './lib/env.mjs';
import {configureMediaTools} from './lib/mobile-tools.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),env=loadEnv(),port=Number(process.env.MOBILE_PORT)||8801,upstreamPort=Number(env.PORT)||8800;
configureMediaTools(root);
async function healthy(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});return r.ok?await r.json():null;}catch{return null;}}
if(!await healthy('http://127.0.0.1:'+upstreamPort+'/health')){
  console.log('Starting existing WANNA effects server.');
  const core=spawn(process.execPath,['server.mjs'],{cwd:root,env:process.env,stdio:'ignore',windowsHide:true});core.on('error',()=>console.error('EFFECTS_SERVER_START_FAILED'));
  let ready=false;for(let i=0;i<24;i++){if(await healthy('http://127.0.0.1:'+upstreamPort+'/health')){ready=true;break;}await new Promise(r=>setTimeout(r,500));}
  if(!ready){console.error('EFFECTS_SERVER_UNAVAILABLE');process.exit(1);}
}
const existing=await healthy('http://127.0.0.1:'+port+'/api/mobile/session');
if(existing?.authenticated&&existing.version?.startsWith('1.')){
  console.log('WANNA FX Mobile is already running.');
  if(process.platform==='win32')spawn('cmd.exe',['/d','/c','start','','http://127.0.0.1:'+port+'/mobile/'],{windowsHide:true});
}else{
  const child=spawn(process.execPath,['mobile-gateway.mjs','--open',...(process.argv.includes('--tunnel')?['--tunnel']:[])],{cwd:root,env:process.env,stdio:'inherit'});
  child.on('exit',code=>process.exitCode=code||0);child.on('error',()=>{console.error('MOBILE_START_FAILED');process.exitCode=1;});
}
