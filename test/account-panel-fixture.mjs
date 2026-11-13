// Explicitly disposable loopback fixture. Never connects to TikTok, Studio or a user's media.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {createMobileGateway} from '../server-integration/wanna-studio-server/mobile-gateway.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'boostera-account-ui-'));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ioAAAAASUVORK5CYII=';
let phase='qr';
const service={close(){},async state(name,key){
  if(key==='snapshot')return{health:'ready',session:null,users:{},operations:[]};
  if(name==='user')return{nickname:'Synthetic Creator',display_id:'qa_creator'};
  if(key==='linkedUsers')return[];
  return{};
}};
const control=createApp({port:18882,polling:false,service,nativeUi:{async inspect(){return{ready:false};}},loginUi:{
  async inspect(){if(phase==='offline')throw Error('Synthetic disconnected controller');return{phase:phase==='connected'?'not_open':phase,image:png,approvalUrl:'https://www.tiktok.com/t/synthetic-qa-only/'};},
  async refresh(){phase='loading';},
}});
await control.poll();
const gateway=createMobileGateway({port:18883,upstreamPort:18885,studioPort:18882,workspaceRoot:root,workspaceOptions:{tools:{installed:false}}});
const data=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/phase'){res.writeHead(404);return res.end();}
  let body='';for await(const part of req){body+=part;if(body.length>100){res.writeHead(413);return res.end();}}
  if(!['qr','scanned','expired','loading','connected','offline'].includes(body)){res.writeHead(400);return res.end();}
  phase=body;res.end('ok');
});
for(const [server,port]of [[control.server,18882],[gateway.server,18883],[data,18884]])await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
console.log('Synthetic account UI fixture ready at http://127.0.0.1:18883/mobile/box');
async function stop(){for(const server of [data,gateway.server,control.server])await new Promise(r=>server.close(r));if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Invalid fixture path');fs.rmSync(root,{recursive:true,force:true});}
process.on('SIGTERM',()=>{void stop().then(()=>process.exit());});process.on('SIGINT',()=>{void stop().then(()=>process.exit());});
