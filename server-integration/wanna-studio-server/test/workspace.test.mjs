import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createMobileGateway} from '../mobile-gateway.mjs';
import {validateRecipe,ANCHORS} from '../lib/mobile-workspace.mjs';
import {Broadcasts} from '../lib/mobile-broadcast.mjs';
import {configureMediaTools} from '../lib/mobile-tools.mjs';
test('recipe validation bounds body anchors and excludes external files',()=>{
 const r=validateRecipe({title:'Hat',url:'/media/mobile/test.png',anchor:'handL',scale:999,opacity:9,targetHead:20});assert.equal(r.anchor,'handL');assert.equal(r.scale,2);assert.equal(r.opacity,1);assert.equal(r.targetHead,3);assert.equal(ANCHORS.length,10);
 for(const url of ['https://evil.example/image.png','/media/../secret.png','/media/.env','/fx/../../photo.png'])assert.throws(()=>validateRecipe({url}),/INVALID_MEDIA_URL/);
});
test('workspace persists clients, recipes and custom gift rules while keeping keys private',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-workspace-'));let rules=[];const fired=[];
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');if(req.url==='/api/automations'){if(req.method==='PUT')rules=JSON.parse(raw);res.end(JSON.stringify({rules,history:[]}));}else if(req.url==='/api/event'){fired.push(JSON.parse(raw));res.end('{"ok":true}');}else{res.end('{}');}});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const app=createMobileGateway({port,upstreamPort:upstream.address().port,workspaceRoot:root,apiKey:'private-api-test',clientKey:'private-client-test',env:{},workspaceOptions:{tools:{ffmpeg:'not-used',installed:false}}});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 async function call(route,method='GET',data,headers={}){const response=await fetch('http://127.0.0.1:'+port+route,{method,headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});return{status:response.status,value:await response.json()};}
 try{
   assert.equal((await call('/api/workspace/overview','GET',undefined,{'cf-connecting-ip':'203.0.113.1',host:'phone.example'})).status,401);
   const client=(await call('/api/workspace/clients','POST',{name:'Test customer',handle:'@customer',avatarUrl:'/media/photo.png'})).value;assert.ok(client.id.startsWith('client_'));
   const recipe=(await call('/api/workspace/recipes','POST',{clientId:client.id,title:'Personal hat',url:'/media/photo.png',anchor:'head'})).value;
   const played=await call('/api/workspace/play','POST',{id:recipe.id});assert.equal(played.value.ok,true);let commands=await call('/api/workspace/commands?after=0');assert.equal(commands.value.commands.length,1);
   await call('/api/workspace/automations','PUT',[{id:'custom',enabled:true,on:'gift',match:'Rose',cooldownMs:0,delayMs:0,action:{type:'recipe',id:recipe.id}}]);
   await call('/api/workspace/test-event','POST',{type:'gift',gift:'Rose',count:1});await new Promise(r=>setTimeout(r,20));
   commands=await call('/api/workspace/commands?after=1');assert.equal(commands.value.commands[0].recipe.id,recipe.id);assert.equal(fired[0].source,'manual-test');
   assert.equal((await call('/api/workspace/generate','POST',{clientId:client.id,templateId:'ar:effect',spendAccepted:true})).status,409);
   assert.equal((await call('/api/workspace/tiktok/invite','POST',{})).status,501);
   await call('/api/workspace/rtmp','PUT',{url:'rtmps://example.com/live',key:'private-stream-test'});
   const overview=(await call('/api/workspace/overview')).value;const serialized=JSON.stringify(overview);for(const secret of ['private-api-test','private-client-test','private-stream-test'])assert.ok(!serialized.includes(secret));
   assert.equal(overview.clients.length,1);assert.equal(overview.config.rtmpConfigured,true);assert.equal(overview.config.tiktok.invitations,false);
   const disk=JSON.parse(fs.readFileSync(path.join(root,'data','mobile-workspace.json'),'utf8'));assert.equal(disk.recipes[0].id,recipe.id);assert.equal(disk.recipeRules.length,1);
   assert.equal((await call('/api/workspace/clients','POST',{name:'Bad'}, {origin:'https://evil.example'})).status,403);
   await call('/api/workspace/clients/'+client.id,'DELETE');const after=(await call('/api/workspace/overview')).value;assert.equal(after.clients.length,0);assert.equal(after.recipes.length,0);
 }finally{await new Promise(r=>app.server.close(r));await new Promise(r=>upstream.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
test('real FFmpeg ingests ordered video chunks and creates playable HLS segments',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-stream-')),project=path.dirname(path.dirname(fileURLToPath(import.meta.url))),tools=configureMediaTools(project),input=path.join(root,'input.mp4');
 const generated=spawnSync(tools.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc=size=360x640:rate=15','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov',input],{timeout:30000});assert.equal(generated.status,0,generated.stderr?.toString());
 const manager=new Broadcasts({root,ffmpeg:tools.ffmpeg});try{
   const stream=manager.start({mode:'preview',mime:'video/mp4',owner:'phone'}),raw=fs.readFileSync(input);let sequence=0;
   await assert.rejects(()=>manager.append(stream.id,'different-phone',0,raw.subarray(0,100)),/BROADCAST_NOT_FOUND/);
   const first=raw.subarray(0,Math.min(16384,raw.length));await manager.append(stream.id,'phone',sequence++,first);const repeat=await manager.append(stream.id,'phone',0,first);assert.equal(repeat.repeated,true);
   await assert.rejects(()=>manager.append(stream.id,'phone',99,first),/SEQUENCE_MISMATCH/);
   for(let offset=first.length;offset<raw.length;offset+=16384)await manager.append(stream.id,'phone',sequence++,raw.subarray(offset,offset+16384));
   const item=manager.items.get(stream.id),exited=once(item.child,'exit');await manager.stop(stream.id,'phone');const[exit]=await exited;assert.equal(exit,0);const playlist=manager.file(stream.id,'live.m3u8');assert.ok(playlist);assert.match(fs.readFileSync(playlist,'utf8'),/#EXTINF:/);assert.ok(manager.file(stream.id,'init.mp4'));assert.equal(manager.file(stream.id,'../../secret'),null);
 }finally{await manager.close();fs.rmSync(root,{recursive:true,force:true});}
});
