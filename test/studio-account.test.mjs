import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import net from 'node:net';
import {StudioAccount,NativeStudioLoginUi} from '../src/studio-account.mjs';
import {createApp} from '../server.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ioAAAAASUVORK5CYII=';
function fixture({phase='qr',cards=1,approvalUrl='https://www.tiktok.com/t/synthetic-login/',duplicateQr=false,nativePhase=null}={}){
  let clicks=0,closed=0;
  const shown={isConnected:true,getClientRects:()=>[{}]};
  const refresh={...shown,cursor:'pointer',click(){clicks++;}};
  const mask={...shown,className:phase==='scanned'?'mask-a translucent-b':'mask-a',querySelectorAll:()=>phase==='expired'?[refresh]:[]};
  const canvas={...shown,width:110,height:110,toDataURL:()=>png,__reactFiber$test:{memoizedProps:{},return:{memoizedProps:{value:approvalUrl,className:'qrCode-fixture'}}}};
  const card={...shown,__reactFiber$test:{memoizedProps:{},return:{memoizedProps:{qrCodeUrl:approvalUrl,state:nativePhase}}},querySelectorAll(selector){
    if(selector.includes('mask-'))return ['scanned','expired','loading'].includes(phase)?[mask]:[];
    return duplicateQr?[canvas,canvas]:[canvas];
  }};
  const document={querySelectorAll:()=>phase==='not_open'?[]:Array.from({length:cards},()=>card)};
  const nativeUi={async connect(surface){assert.equal(surface,'main');return{
    async evaluate(expression){return vm.runInNewContext(expression,{document,getComputedStyle:e=>({visibility:'visible',cursor:e.cursor||'default'})});},
    close(){closed++;},
  };}};
  return{ui:new NativeStudioLoginUi({nativeUi}),get clicks(){return clicks;},get closed(){return closed;}};
}

test('native QR read is scoped to the Studio login canvas and closes the native connection',async()=>{
  const f=fixture(),s=await f.ui.inspect();assert.equal(s.phase,'qr');assert.equal(s.image,png);
  assert.equal(s.approvalUrl,'https://www.tiktok.com/t/synthetic-login/');assert.equal(f.clicks,0);assert.equal(f.closed,1);
  for(const options of [{cards:2},{duplicateQr:true}]){
    const observed=await fixture(options).ui.inspect();assert.notEqual(observed.phase,'qr');assert.equal(observed.image,undefined);
  }
});

test('masked QR phases are distinct and never expose a scannable image',async()=>{
  for(const phase of ['loading','scanned','expired']){
    const s=await fixture({phase}).ui.inspect();assert.equal(s.phase,phase);assert.equal(s.image,undefined);assert.equal(s.approvalUrl,undefined);
  }
  for(const nativePhase of ['expired','refuse','error']){
    const s=await fixture({nativePhase}).ui.inspect();assert.equal(s.phase,'loading');assert.equal(s.image,undefined);
  }
});

test('native refresh clicks only the single expired QR control',async()=>{
  for(const phase of ['qr','scanned','loading','not_open']){
    const f=fixture({phase});await assert.rejects(f.ui.refresh(),/QR_REFRESH_NOT_AVAILABLE/);assert.equal(f.clicks,0);
  }
  const f=fixture({phase:'expired'});assert.equal((await f.ui.refresh()).requested,true);assert.equal(f.clicks,1);assert.equal(f.closed,1);
});

test('only a native PNG and official HTTPS approval link reach the paired panel',async()=>{
  const ui={async inspect(){return{phase:'qr',image:png,approvalUrl:'https://www.tiktok.com/t/synthetic-login/',cookie:'DO_NOT_RETURN'};}};
  const c=new StudioAccount({ui,now:()=>1234}),s=await c.state();
  assert.equal(s.observedAt,1234);assert.equal(s.phase,'qr');assert.ok(s.approvalUrl);assert.ok(!JSON.stringify(s).includes('DO_NOT_RETURN'));
  for(const url of ['javascript:alert(1)','https://tiktok.com.evil.test/t/','https://name:secret@www.tiktok.com/t/','http://www.tiktok.com/t/','https://www.tiktok.com:8443/t/']){
    ui.inspect=async()=>({phase:'qr',image:png,approvalUrl:url});assert.equal((await c.state()).approvalUrl,undefined);
  }
  for(const image of ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,YmFk',png+'!']){
    ui.inspect=async()=>({phase:'qr',image});const s=await c.state();assert.equal(s.phase,'unavailable');assert.equal(s.image,undefined);
  }
});

test('account connection requires live controller identity and removal of the native login screen',async()=>{
  let state={connected:true,self:{name:'Test Creator',handle:'test_creator',cookie:'DO_NOT_RETURN'}};
  let phase='not_open';const c=new StudioAccount({ui:{async inspect(){return{phase,image:png};}},getState:()=>state});
  const connected=await c.state();assert.equal(connected.phase,'connected');assert.equal(connected.account.handle,'test_creator');assert.equal(connected.persistence,'studio-profile');assert.ok(!JSON.stringify(connected).includes('DO_NOT_RETURN'));
  phase='qr';assert.equal((await c.state()).phase,'qr');
  phase='not_open';state.connected=false;assert.notEqual((await c.state()).phase,'connected');
  state={connected:true,self:{name:'Unverified'}};assert.notEqual((await c.state()).phase,'connected');
});

test('lost Studio access clears account proof and never substitutes a generated QR',async()=>{
  const c=new StudioAccount({ui:{async inspect(){throw Error('PRIVATE_INTERNAL_DETAIL');}},getState:()=>({connected:true,self:{handle:'stale'}})});
  const s=await c.state();assert.equal(s.phase,'unavailable');assert.equal(s.image,undefined);assert.equal(s.account,undefined);assert.ok(!JSON.stringify(s).includes('PRIVATE_INTERNAL_DETAIL'));
});

test('refresh is single flight and is blocked when LIVE begins during inspection',async()=>{
  let live=false,clicks=0;
  const c=new StudioAccount({ui:{async inspect(){return{phase:'expired'};},async refresh(){clicks++;}},getState:()=>({live})});
  await Promise.all([c.refresh(),c.refresh()]);assert.equal(clicks,1);
  live=true;await assert.rejects(c.refresh(),/LIVE_ACCOUNT_CHANGE_BLOCKED/);assert.equal(clicks,1);
  live=false;c.ui.inspect=async()=>{live=true;return{phase:'expired'};};
  await assert.rejects(c.refresh(),/LIVE_ACCOUNT_CHANGE_BLOCKED/);assert.equal(clicks,1);
});

test('account endpoints keep the existing authenticated same-origin HTTP boundary',async t=>{
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  let phase='qr',refreshes=0;
  const app=createApp({port,polling:false,service:{close(){}},loginUi:{async inspect(){return{phase,image:png};},async refresh(){refreshes++;}}});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));
  const base='http://127.0.0.1:'+port;
  assert.equal((await fetch(base+'/api/account')).status,401);
  const landing=await fetch(base+'/'),cookie=landing.headers.get('set-cookie').split(';')[0];await landing.arrayBuffer();
  const response=await fetch(base+'/api/account',{headers:{cookie}});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).phase,'qr');
  const post=origin=>fetch(base+'/api/account/refresh',{method:'POST',headers:{cookie,'Content-Type':'application/json',...(origin?{origin}:{})},body:'{}'});
  assert.equal((await post('https://untrusted.example')).status,403);assert.equal(refreshes,0);
  assert.equal((await post()).status,409);assert.equal(refreshes,0);
  phase='expired';assert.equal((await post()).status,200);assert.equal(refreshes,1);
});
