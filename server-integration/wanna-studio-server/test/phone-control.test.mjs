import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {MobileSessions} from '../lib/mobile-session.mjs';
import {createPhoneControl} from '../phone-control.mjs';

test('saved phone sessions survive a restart without saving raw tokens or pairing codes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-owner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stateFile=path.join(root,'sessions.json');let now=1000;
 const a=new MobileSessions({stateFile,now:()=>now,ttl:5000}),issued=a.issue(),paired=a.pair(issued.code,'My phone','ip');
 const stored=fs.readFileSync(stateFile,'utf8');assert.ok(!stored.includes(paired.token));assert.ok(!stored.includes(issued.code));
 const b=new MobileSessions({stateFile,now:()=>now});assert.equal(b.get(paired.token).label,'My phone');
 now=7000;assert.equal(new MobileSessions({stateFile,now:()=>now}).get(paired.token),null);
 now=1000;b.revoke(paired.token);assert.equal(new MobileSessions({stateFile,now:()=>now}).get(paired.token),null);
});

test('hosted camera panel pairs once, protects native account data and rejects unsupported controls',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-control-'));
 let calls=0;const token='a'.repeat(64);
 const controller=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Set-Cookie','boostera_session='+token+'; HttpOnly');return res.end('native controller');}
  assert.equal(req.headers.cookie,'boostera_session='+token);calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({phase:'unavailable'}));
 });await new Promise(r=>controller.listen(0,'127.0.0.1',r));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const sessions=new MobileSessions({stateFile:path.join(root,'sessions.json')});
 const app=createPhoneControl({port,origin:'https://phone.example',studioPort:controller.address().port,sessions});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.server.close(r));await new Promise(r=>controller.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port,remote={host:'phone.example','cf-connecting-ip':'203.0.113.1','x-forwarded-for':'203.0.113.1'};
 const request=(route,{method='GET',headers=remote,body}={})=>new Promise((resolve,reject)=>{
  const payload=body?JSON.stringify(body):null;
  const req=http.request(base+route,{method,headers:{...headers,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)]))})));
  });req.on('error',reject);if(payload)req.write(payload);req.end();
 });
 assert.equal((await request('/api/mobile/studio/account')).status,401);assert.equal(calls,0);
 assert.equal((await request('/api/mobile/pairing-code',{method:'POST'})).status,403);
 assert.equal((await request('/api/mobile/pairing-code',{method:'POST',headers:{host:'evil.example'}})).status,403);
 const issued=await(await request('/api/mobile/pairing-code',{method:'POST',headers:{host:'127.0.0.1:'+port}})).json();
 assert.equal((await request('/api/mobile/pair',{method:'POST',headers:{...remote,origin:'https://untrusted.example'},body:{code:issued.code}})).status,403);
 const paired=await request('/api/mobile/pair',{method:'POST',headers:{...remote,origin:'https://phone.example'},body:{code:issued.code,label:'My phone'}});
 assert.equal(paired.status,200);const cookie=paired.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
 const auth={...remote,cookie:cookie.split(';')[0]};
 assert.equal((await request('/api/mobile/pair',{method:'POST',body:{code:issued.code}})).status,401);
 const session=await(await request('/api/mobile/session',{headers:auth})).json();assert.equal(session.authenticated,true);assert.equal(session.device.label,'My phone');
 const account=await request('/api/mobile/studio/account',{headers:auth});assert.equal((await account.json()).phase,'unavailable');assert.equal(account.headers.get('set-cookie'),null);assert.equal(calls,1);
 assert.equal((await request('/api/mobile/studio/focus-studio',{method:'POST',headers:auth,body:{}})).status,404);
 assert.equal((await request('/api/mobile/studio/account?target=other',{headers:auth})).status,404);assert.equal(calls,1);
 assert.equal((await request('/api/mobile/logout',{method:'POST',headers:auth})).status,200);
 assert.equal((await request('/api/mobile/studio/account',{headers:auth})).status,401);
});
