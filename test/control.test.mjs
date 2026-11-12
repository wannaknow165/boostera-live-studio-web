import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {RpcClient} from '../src/rpc.mjs';
import {normalizeSnapshot,normalizeCandidates,summarizeChanges} from '../src/model.mjs';
import {createApp,requestAllowed} from '../server.mjs';

const snapshot={health:'ready',session:{selfUid:'111',roomId:'222',epoch:'fresh'},users:{'111':{linked:true},'333':{roomId:'444',linked:true,availableActions:{invite:true}}},operations:[]};
const batches={current:{accepted:true,ticket:{epoch:'fresh',query:{section:'followed_list'}},entries:[{target:{uid:'333',roomId:'444',nickname:'שלום',avatarUrls:['javascript:alert(1)']},room:{owner:{secret_token:'DO_NOT_RETURN'}}}]},stale:{accepted:true,ticket:{epoch:'old',query:{section:'followed_list'}},entries:[{target:{uid:'555',roomId:'666',nickname:'stale'}}]}};
test('only current-session candidate fields reach the dashboard',()=>{
  const rows=normalizeCandidates(batches,snapshot);
  assert.equal(rows.length,1);assert.equal(rows[0].name,'שלום');assert.equal(rows[0].avatar,'');assert.equal(rows[0].linked,true);
  assert.ok(!JSON.stringify(rows).includes('DO_NOT_RETURN'));assert.ok(!JSON.stringify(rows).includes('stale'));
});

test('rendered native cards recover candidates omitted by Studio Map serialization without overriding a denial',()=>{
  const rows=normalizeCandidates({__type:'Map',size:1},snapshot,[],[
    {uid:'777',roomId:'888',name:'Native creator',inviteAvailable:true,sources:['recommend_list'],avatar:'javascript:bad'},
    {uid:'333',roomId:'444',name:'Known creator',inviteAvailable:true,sources:['recommend_list']},
    {uid:'bad',roomId:'444',name:'Invalid'},
  ]);
  assert.equal(rows.find(r=>r.uid==='777').nativeObserved,true);assert.equal(rows.find(r=>r.uid==='777').avatar,'');assert.equal(rows.length,2);
  const denied=normalizeCandidates({}, {...snapshot,users:{'333':{availableActions:{invite:false}}}},[],[{uid:'333',roomId:'444',inviteAvailable:true}]);
  assert.equal(denied[0].inviteAvailable,false);
});
test('pending battle is never promoted because a presentation field says ONGOING',()=>{
  const result=normalizeSnapshot({...snapshot,battle:{battleId:'999',status:'pending',participantUids:['111','333']}},{battleStatus:'ONGOING',providerReady:true,batches});
  assert.equal(result.battle.status,'pending');assert.equal(result.actions.invite,false);assert.equal(result.coverage.friends,true);
});
test('event feed records waiting, failure and connection loss without duplicating a poll',()=>{
  const base=normalizeSnapshot(snapshot),op={id:'one',kind:'manual_cohost',step:'awaiting_peer',outcome:'pending',phase:'waiting',targetUid:'333'};
  const next={...base,operations:[op]};
  assert.ok(summarizeChanges(base,next).some(e=>e.title.includes('ממתינים')));
  assert.equal(summarizeChanges(next,next).length,0);
  assert.ok(summarizeChanges(next,{...next,operations:[{...op,outcome:'cancelled',step:'cancelled'}]}).some(e=>e.title.includes('בוטלה')));
  assert.ok(summarizeChanges(next,{connected:false}).some(e=>e.type==='error'));
});
test('local HTTP contract rejects cross-site origins, rebinding and missing session',()=>{
  const req={headers:{host:'127.0.0.1:47831',cookie:'boostera_session=secret'}};
  assert.equal(requestAllowed(req,47831,'secret'),true);
  assert.equal(requestAllowed({headers:{...req.headers,origin:'https://evil.example'}},47831,'secret'),false);
  assert.equal(requestAllowed({headers:{...req.headers,host:'evil.example'}},47831,'secret'),false);
  assert.equal(requestAllowed({headers:{host:req.headers.host}},47831,'secret'),false);
  assert.equal(requestAllowed({headers:{...req.headers,'sec-fetch-site':'cross-site'}},47831,'secret'),false);
});
test('TCP responses correlate by ID and preserve split Hebrew UTF-8',async()=>{
  const server=net.createServer(socket=>{
    let text='';socket.on('data',chunk=>{text+=chunk;let n;while((n=text.indexOf('\n'))>=0){const request=JSON.parse(text.slice(0,n));text=text.slice(n+1);const response=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{word:'שלום',method:request.method}})+'\n');const split=response.indexOf(Buffer.from('ש'))+1;setTimeout(()=>{socket.write(response.subarray(0,split));setTimeout(()=>socket.write(response.subarray(split)),2);},request.method==='second'?10:30);}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const rpc=new RpcClient(server.address().port,{timeout:500});
  try{const[first,second]=await Promise.all([rpc.call('first'),rpc.call('second')]);assert.equal(first.word,'שלום');assert.equal(first.method,'first');assert.equal(second.method,'second');}
  finally{rpc.close();await new Promise(resolve=>server.close(resolve));}
});
test('a missing response times out and clears pending requests',async()=>{
  const server=net.createServer(socket=>socket.on('data',()=>{}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const rpc=new RpcClient(server.address().port,{timeout:80});
  try{await assert.rejects(rpc.call('never'),/BRIDGE_TIMEOUT/);assert.equal(rpc.pending.size,0);}finally{rpc.close();await new Promise(resolve=>server.close(resolve));}
});
test('bridge failure removes actionable stale state',async()=>{
  let healthy=true;
  const service={close(){},async state(name,key){if(!healthy)throw new Error('gone');if(key==='snapshot')return snapshot;if(key==='providerReady')return true;if(key==='battleStatus')return 'SELECT_MODE';if(key==='invitePanelState')return {status:'ready'};if(key==='linkedUsers')return [];if(key==='candidates.batches')return batches;if(key==='userInfo')return {nickname:'Wanna',secret:'DO_NOT_RETURN'};}};
  const app=createApp({service,polling:false,nativeUi:{async inspect(){return{ready:false};}}});await app.poll();assert.equal(app.getState().connected,true);assert.equal(app.getState().candidates.length,1);assert.ok(!JSON.stringify(app.getState()).includes('DO_NOT_RETURN'));
  healthy=false;await app.poll();assert.equal(app.getState().connected,false);assert.deepEqual(app.getState().candidates,[]);assert.deepEqual(app.getState().operations,[]);app.server.emit('close');
});
test('HTTP panel grants a session, API requires it, arbitrary RPC is not exposed',async()=>{
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const service={close(){},async state(){return null;}},app=createApp({port,service,polling:false,nativeUi:{async inspect(){return{ready:false};}}});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const call=(route,headers={})=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:route,headers},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));}).on('error',reject);});
  try{
    assert.equal((await call('/api/state')).status,401);
    const page=await call('/');assert.equal(page.status,200);assert.ok(page.body.includes('BOOSTERA'));
    const cookie=page.headers['set-cookie'][0].split(';')[0];assert.equal((await call('/api/state',{cookie})).status,200);
    assert.equal((await call('/api/rpc',{cookie})).status,404);
    assert.equal((await call('/api/state',{cookie,origin:'https://evil.example'})).status,403);
    assert.equal((await call('/../../package.json',{cookie})).status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));}
});

test('a phone room mismatch disables outgoing invitation state without hiding Studio state',async()=>{
  const service={close(){},async state(name,key){if(key==='snapshot')return snapshot;if(key==='providerReady')return true;if(key==='linkedUsers')return [];}};
  const phoneLink={async assertRoom(){throw Object.assign(new Error('mismatch'),{code:'PHONE_ROOM_NOT_ATTACHED_TO_STUDIO'});}};
  const app=createApp({service,phoneLink,polling:false,nativeUi:{async inspect(){return{ready:true};}}});
  try{await app.poll();assert.equal(app.getState().connected,true);assert.equal(app.getState().actions.invite,false);assert.equal(app.getState().actions.reason,'PHONE_ROOM_NOT_ATTACHED_TO_STUDIO');}
  finally{app.server.emit('close');}
});
