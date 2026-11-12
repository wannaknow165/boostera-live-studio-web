import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {MobileSessions} from '../lib/mobile-session.mjs';
import {createMobileGateway,validMediaPath,localRequest} from '../mobile-gateway.mjs';
test('pairing codes are one-use and sessions expire',()=>{
  let now=1000;const s=new MobileSessions({now:()=>now,ttl:5000}),issued=s.issue(),paired=s.pair(issued.code,'Phone','ip');
  assert.equal(s.get(paired.token).label,'Phone');assert.throws(()=>s.pair(issued.code,'Other','other'),/INVALID_PAIRING_CODE/);
  now=7000;assert.equal(s.get(paired.token),null);assert.equal(s.get('not-a-token'),null);
});
test('expired codes and repeated invalid codes cannot create a session',()=>{
  let now=0;const s=new MobileSessions({now:()=>now}),issued=s.issue();now=180001;
  assert.throws(()=>s.pair(issued.code,'Phone','ip'),/INVALID_PAIRING_CODE/);
  for(let n=0;n<7;n++)assert.throws(()=>s.pair('invalid','Phone','ip'),/INVALID_PAIRING_CODE/);
  assert.throws(()=>s.pair('invalid','Phone','ip'),/TOO_MANY_ATTEMPTS/);
});
test('private setup cannot be reached through forwarded requests or rebinding',()=>{
  const req={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:8801'}};
  assert.equal(localRequest(req,8801),true);
  assert.equal(localRequest({...req,headers:{...req.headers,'cf-connecting-ip':'203.0.113.1'}},8801),false);
  assert.equal(localRequest({...req,headers:{host:'evil.example'}},8801),false);
});
test('media proxy excludes secrets, traversal, builders and arbitrary origins',()=>{
  for(const p of ['/fx/fx-engine.js','/fx/effects/a/remix/name.mp4','/media/overlays/item.webm'])assert.equal(validMediaPath(p),true);
  for(const p of ['/.env','/fx/../server.env','/fx/effects/.env','/fx/builder/remix.mjs','https://evil.example/clip.mp4','/api/orders','/media\\..\\secret.png'])assert.equal(validMediaPath(p),false);
});
test('PWA has install metadata and every declared app icon exists with the right size',()=>{
  const m=JSON.parse(fs.readFileSync(new URL('../public/mobile/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(m.display,'standalone');assert.equal(m.scope,'/mobile/');assert.equal(m.start_url,'/mobile/');
  for(const icon of m.icons){const p=new URL('../public'+icon.src,import.meta.url),raw=fs.readFileSync(p),expected=Number(icon.sizes.split('x')[0]);assert.equal(raw.readUInt32BE(16),expected);assert.equal(raw.readUInt32BE(20),expected);}
  const apple=fs.readFileSync(new URL('../public/mobile/apple-touch-icon.png',import.meta.url));assert.equal(apple.readUInt32BE(16),180);
  const html=fs.readFileSync(new URL('../public/mobile/index.html',import.meta.url),'utf8');assert.match(html,/apple-mobile-web-app-capable/);assert.match(html,/playsinline/);
});
test('HTTP pairing, effect proxy and real byte acknowledgement work in isolation',async()=>{
  const requests=[];const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;requests.push({path:req.url,key:req.headers['x-key'],body});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/health')res.end(JSON.stringify({liveEffects:5,templates:2}));
    else if(req.url==='/api/catalog')res.end(JSON.stringify({rows:[{id:'example',name:'Example',url:'/media/example.mp4'}]}));
    else if(req.url==='/api/battle')res.end(JSON.stringify({clips:[{id:'multiplier_x2',url:'/media/battle/x2.mp4'}]}));
    else if(req.url==='/api/screen')res.end(JSON.stringify({ok:true,stage:{screen:JSON.parse(body)}}));
    else{res.statusCode=404;res.end('{}');}
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const app=createMobileGateway({port,upstreamPort:upstream.address().port,clientKey:'test-only-key'});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
  async function call(route,{method='GET',data,headers={}}={}){
    const raw=Buffer.isBuffer(data)?data:data===undefined?null:Buffer.from(JSON.stringify(data));
    return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{...(raw?{'Content-Type':Buffer.isBuffer(data)?'application/octet-stream':'application/json','Content-Length':raw.length}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks);let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,raw,json});});});req.on('error',reject);if(raw)req.write(raw);req.end();});
  }
  const remote={host:'phone.example','cf-connecting-ip':'203.0.113.5'};
  try{
    const shell=await call('/mobile/',{headers:remote});assert.equal(shell.status,200);assert.ok(shell.raw.toString().includes('WANNA FX'));
    assert.equal((await call('/api/mobile/session',{headers:remote})).status,401);
    assert.equal((await call('/mobile/pair',{headers:remote})).status,403);
    assert.equal((await call('/api/mobile/pairing-code',{method:'POST',headers:remote})).status,403);
    const issued=(await call('/api/mobile/pairing-code',{method:'POST'})).json;
    assert.equal((await call('/api/mobile/pair',{method:'POST',data:{code:issued.code},headers:{...remote,origin:'https://evil.example'}})).status,403);
    const paired=await call('/api/mobile/pair',{method:'POST',data:{code:issued.code,label:'Test phone'},headers:remote});
    assert.equal(paired.status,200);const cookie=paired.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
    const authenticated={...remote,cookie:cookie.split(';')[0]};
    const state=await call('/api/mobile/session',{headers:authenticated});assert.equal(state.json.effectsServer,true);assert.equal(state.json.platform.tiktokConnected,false);
    const catalog=await call('/api/mobile/catalog',{headers:authenticated});assert.equal(catalog.json.rows.length,1);assert.equal(requests.at(-1).key,'test-only-key');assert.ok(!catalog.raw.toString().includes('test-only-key'));
    assert.equal((await call('/api/battle',{headers:remote})).status,401);
    const battle=await call('/api/battle',{headers:authenticated});assert.equal(battle.json.clips[0].id,'multiplier_x2');assert.equal(requests.at(-1).key,'test-only-key');
    const screen=await call('/api/mobile/screen',{method:'POST',data:{type:'double',count:999,mult:5,seconds:999},headers:authenticated});assert.equal(screen.status,200);assert.equal(screen.json.stage.screen.seconds,60);assert.equal(screen.json.stage.screen.count,10);
    assert.equal((await call('/api/mobile/screen',{method:'POST',data:{type:'shell'},headers:authenticated})).status,400);
    const fakeJpeg=Buffer.alloc(64,1);fakeJpeg[0]=255;fakeJpeg[1]=216;fakeJpeg[2]=255;
    const sent=await call('/api/mobile/frame',{method:'POST',data:fakeJpeg,headers:{...authenticated,'content-type':'image/jpeg'}});
    assert.equal(sent.status,200);assert.equal(sent.json.accepted,true);assert.equal(sent.json.sequence,1);assert.equal(sent.json.digest,crypto.createHash('sha256').update(fakeJpeg).digest('hex'));
    const echoed=await call('/api/mobile/frame',{headers:authenticated});assert.deepEqual(echoed.raw,fakeJpeg);assert.equal(echoed.headers['access-control-allow-origin'],undefined);
    assert.equal((await call('/api/mobile/frame',{method:'POST',data:fakeJpeg,headers:{...authenticated,'content-type':'image/jpeg'}})).status,429);
    assert.equal((await call('/api/mobile/frame',{headers:remote})).status,401);
    assert.equal((await call('/api/orders',{method:'POST',data:{},headers:authenticated})).status,404);
    assert.equal((await call('/api/mobile/logout',{method:'POST',headers:authenticated})).status,200);
    assert.equal((await call('/api/mobile/session',{headers:authenticated})).status,401);
  }finally{await new Promise(r=>app.server.close(r));await new Promise(r=>upstream.close(r));}
});
