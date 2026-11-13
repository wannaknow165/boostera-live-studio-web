import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMobileGateway} from '../mobile-gateway.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('paired phone uses the existing Studio panel and allowlisted native actions without controller cookies',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'box-studio-'));let opens=0,token='a'.repeat(64);const calls=[];
 const control=http.createServer(async(req,res)=>{
   if(req.url==='/'){opens++;res.setHeader('Set-Cookie','boostera_session='+token+'; HttpOnly');return res.end('<link href="/style.css"><script src="/app.js"></script><a href="/">Home</a>');}
   if(req.headers.cookie!=='boostera_session='+token){res.writeHead(401);return res.end('{}');}
   let body='';for await(const part of req)body+=part;calls.push({path:req.url,method:req.method,body});
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connected:true,dispatched:req.method==='POST'}));
 });const studioPort=await listen(control);
 const app=createMobileGateway({port:8801,studioPort,workspaceRoot:root,workspaceOptions:{tools:{installed:false}}});
 const port=await listen(app.server),base='http://127.0.0.1:'+port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));await new Promise(r=>control.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const remote={host:'phone.example','cf-connecting-ip':'203.0.113.9'};
 const call=(route,method='GET',body,headers=remote)=>fetch(base+route,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await call('/mobile/studio')).status,401);assert.equal(opens,0);
 const issued=app.sessions.issue(),pair=app.sessions.pair(issued.code,'phone','203.0.113.9');
 const auth={...remote,cookie:'wm_sid='+pair.token};
 const panel=await call('/mobile/studio','GET',null,auth),html=await panel.text();
 assert.equal(panel.status,200);assert.match(html,/\/mobile\/studio\/app.js/);assert.match(html,/\/mobile\/box/);
 assert.equal(panel.headers.get('set-cookie'),null);assert.ok(!html.includes(token));
 const state=await call('/api/mobile/studio/state','GET',null,auth);assert.equal((await state.json()).connected,true);
 const account=await call('/api/mobile/studio/account','GET',null,auth);assert.equal(account.status,200);assert.equal(account.headers.get('set-cookie'),null);assert.equal(calls.at(-1).path,'/api/account');
 const refresh=await call('/api/mobile/studio/account/refresh','POST',{},auth);assert.equal(refresh.status,200);assert.equal(calls.at(-1).path,'/api/account/refresh');
 const action={action:'match.start',requestId:'one',revision:'viewed-revision',epoch:'live-epoch'};
 const result=await call('/api/mobile/studio/battles/action','POST',action,auth);assert.equal((await result.json()).dispatched,true);
 assert.deepEqual(JSON.parse(calls.at(-1).body),action);assert.equal(calls.at(-1).path,'/api/battles/action');
 const count=calls.length;
 for(const route of ['/api/mobile/studio/rpc','/api/mobile/studio/focus-studio','/api/mobile/studio/state?url=https://evil.example'])assert.equal((await call(route,'POST',{},auth)).status,404);
 assert.equal((await call('/api/mobile/studio/battles/action','POST',action,{...auth,origin:'https://evil.example'})).status,403);
 assert.equal(calls.length,count);
 const beforeRestart=opens;token='b'.repeat(64);assert.equal((await call('/api/mobile/studio/state','GET',null,auth)).status,200);assert.equal(opens,beforeRestart+1);
 app.sessions.revoke(pair.token);assert.equal((await call('/api/mobile/studio/state','GET',null,auth)).status,401);
 assert.equal((await call('/api/mobile/studio/account','GET',null,auth)).status,401);
});
