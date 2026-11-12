import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createCipheriv} from 'node:crypto';
import {PhoneLink,readPhoneTarget} from '../src/phone-link.mjs';

async function fixture(t,overrides={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'boostera-phone-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const record={rtmpPushUrl:'rtmps://push.example.test/live/private-test-key',shareUrl:'https://m.tiktok.com/share/live/1234567890123456789/?u_code=private-share-value',storedAt:new Date().toISOString(),...overrides};
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(JSON.stringify(record)),cipher.final()]);
  await writeFile(path.join(directory,'.rtmp-target.key'),key);
  await writeFile(path.join(directory,'rtmp-target.enc.json'),JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  return directory;
}
test('installed phone handoff recovers room ID from the TikTok share URL',async t=>{
  const directory=await fixture(t),r=await readPhoneTarget(directory);
  assert.equal(r.roomId,'1234567890123456789');assert.equal(r.fresh,true);
  const link=new PhoneLink({directory}),status=await link.state('1234567890123456789');
  assert.equal(status.sameStudioRoom,true);assert.ok(!JSON.stringify(status).includes('private-'));assert.equal(status.imported,false);
});
test('expired, contradictory and tampered handoffs never reach the media server',async t=>{
  for(const overrides of [{storedAt:'2020-01-01T00:00:00Z'},{roomId:'999999999'},{shareUrl:'https://other.example/share/live/1234567890123456789/'}]){
    const directory=await fixture(t,overrides);let calls=0;
    const link=new PhoneLink({directory,fetcher:async()=>{calls++;}});
    await assert.rejects(link.importTarget());assert.equal(calls,0);
  }
  const directory=await fixture(t);await writeFile(path.join(directory,'.rtmp-target.key'),randomBytes(32));
  await assert.rejects(readPhoneTarget(directory),{code:'PHONE_HANDOFF_INVALID'});
});
test('key transfer uses the existing RTMP endpoint, binds the room and excludes secrets from receipts',async t=>{
  const directory=await fixture(t),calls=[];
  const link=new PhoneLink({directory,stateFile:path.join(directory,'binding.json'),fetcher:async(url,options)=>{
    calls.push({url,options});return{ok:true,json:async()=>options?.method==='PUT'?{rtmpConfigured:true}:{broadcasts:[]}};
  }});
  const result=await link.importTarget();assert.equal(result.imported,true);assert.equal(calls.length,2);
  assert.equal(calls[1].url,'http://127.0.0.1:8801/api/workspace/rtmp');
  assert.equal(JSON.parse(calls[1].options.body).url,'rtmps://push.example.test/live/private-test-key');
  assert.ok(!JSON.stringify(result).includes('private-'));
  await assert.rejects(link.assertRoom('different'),{code:'PHONE_ROOM_NOT_ATTACHED_TO_STUDIO'});
  await link.assertRoom(result.roomId);
  const restored=new PhoneLink({directory,stateFile:path.join(directory,'binding.json')});
  await assert.rejects(restored.assertRoom('different'),{code:'PHONE_ROOM_NOT_ATTACHED_TO_STUDIO'});
});
test('an active broadcast cannot have its destination replaced',async t=>{
  const directory=await fixture(t);let calls=0;
  const link=new PhoneLink({directory,fetcher:async()=>{calls++;return{ok:true,json:async()=>({broadcasts:[{mode:'rtmp',state:'running'}]})}}});
  await assert.rejects(link.importTarget(),{code:'PHONE_BROADCAST_ALREADY_ACTIVE'});assert.equal(calls,1);
});
