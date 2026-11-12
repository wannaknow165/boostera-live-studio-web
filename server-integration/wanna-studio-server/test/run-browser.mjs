// Disposable servers and synthetic media: never run these mutations against a user's workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {configureMediaTools} from '../lib/mobile-tools.mjs';
const project=path.dirname(path.dirname(fileURLToPath(import.meta.url))),root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-browser-'));
const excluded=new Set(['node_modules','data','runtime','media','.env','server.env']);
fs.cpSync(project,root,{recursive:true,filter:src=>!path.relative(project,src).split(path.sep).some(p=>excluded.has(p))});
fs.symlinkSync(path.join(project,'node_modules'),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
const media=configureMediaTools(root),jobs=[];
const env={...process.env,PORT:'18880',MOBILE_PORT:'18881',WANNA_TEST_URL:'http://127.0.0.1:18881',PUBLIC_BASE_URL:'http://127.0.0.1:18880',DRY_RUN:'1',OPENROUTER_API_KEY:'',KLING_API_KEY:'',SIGN_API_KEY:'',API_TOKEN:randomBytes(24).toString('hex'),STUDIO_CLIENT_KEY:randomBytes(24).toString('hex'),PYTHONIOENCODING:'utf-8'};
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Test server not ready');}
async function run(script){await new Promise((resolve,reject)=>{const p=spawn(process.env.PYTHON||'python',[script],{cwd:root,env,windowsHide:true,stdio:'inherit'});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Browser test failed: '+script)));});}
try{
 // Fail if another server already owns our test ports, before starting browser mutations.
 for(const port of [18880,18881]){const {default:net}=await import('node:net');const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));}
 fs.mkdirSync(path.join(root,'runtime'),{recursive:true});fs.mkdirSync(path.join(root,'media','battle'),{recursive:true});
 const fixture=spawnSync(media.ffmpeg,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=180x320:r=15','-t','1','-c:v','libvpx-vp9',path.join(root,'media','battle','multiplier_x2.webm')],{windowsHide:true,timeout:15000});if(fixture.status!==0)throw Error('Fixture generation failed');
 for(const script of ['server.mjs','mobile-gateway.mjs']){const p=spawn(process.execPath,[script],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});jobs.push(p);p.stderr.on('data',()=>{});}
 await ready(env.WANNA_TEST_URL+'/api/mobile/session');await ready('http://127.0.0.1:18880/health');
 if(!process.argv.includes('--workspace-only'))await run('test/mobile-browser.py');await run('test/workspace-browser.py');
 console.log('PASS both browser flows on disposable workspace; synthetic camera/microphone and blue battle fixture; no TikTok or paid provider call.');
}finally{
 for(const p of jobs){const done=new Promise(r=>p.once('exit',r));if(p.exitCode===null){p.kill();await done;}}
 const artifacts=path.join(project,'runtime','browser-audit');fs.mkdirSync(artifacts,{recursive:true});
 if(fs.existsSync(path.join(root,'runtime')))for(const name of fs.readdirSync(path.join(root,'runtime')))if(/\.(png|json)$/.test(name))fs.copyFileSync(path.join(root,'runtime',name),path.join(artifacts,name));
 fs.unlinkSync(path.join(root,'node_modules'));fs.rmSync(root,{recursive:true,force:true});
}
