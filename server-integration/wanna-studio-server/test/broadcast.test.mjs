import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Broadcasts} from '../lib/mobile-broadcast.mjs';
import {configureMediaTools} from '../lib/mobile-tools.mjs';
const project=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await pause(100);}throw Error('Timed out waiting for encoder');}
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}

test('input acknowledgements do not imply output; fragmented encoder progress and failure drive status',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-status-'));let child;
 const manager=new Broadcasts({root,rtmp:()=> 'rtmp://127.0.0.1/live/private-test-value',spawnProcess:()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',1);child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('exit',0)));return child;}});
 try{
  const stream=manager.start({owner:'qa',mode:'rtmp',mime:'video/webm'});assert.equal(stream.state,'starting');assert.equal(stream.outputConfirmed,false);
  const ack=await manager.append(stream.id,'qa',0,Buffer.from('input'));assert.equal(ack.state,'starting');assert.equal(ack.outputConfirmed,false);
  child.stdout.write('frame=2\nout_time_us=100000\npro');assert.equal(manager.list()[0].state,'starting');child.stdout.write('gress=continue\n');assert.equal(manager.list()[0].state,'running');assert.equal(manager.list()[0].outputFrames,2);
  child.stderr.write('Error connecting to rtmp://127.0.0.1/live/private-test-value');child.emit('exit',1);
  assert.equal(manager.list()[0].state,'failed');assert.ok(!JSON.stringify(manager.list()).includes('private-test-value'));
 }finally{await manager.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('real RTMP receiver decodes H264 video and AAC audio without LIVE Studio; refused destination never confirms output',{timeout:40000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-rtmp-')),tools=configureMediaTools(project),input=path.join(root,'input.mp4'),received=path.join(root,'received.flv');
 const source=spawnSync(tools.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc=size=180x320:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','frag_keyframe+empty_moov',input],{timeout:15000,windowsHide:true});assert.equal(source.status,0,source.stderr?.toString());
 const url='rtmp://127.0.0.1:'+await freePort()+'/live/qa',receiver=spawn(tools.ffmpeg,['-v','error','-y','-listen','1','-i',url,'-c','copy','-f','flv',received],{windowsHide:true,stdio:['ignore','ignore','pipe']});let receiverLog='';receiver.stderr.on('data',d=>receiverLog+=d);const receiverExit=once(receiver,'exit');
 const manager=new Broadcasts({root,ffmpeg:tools.ffmpeg,rtmp:()=>url});
 try{
  await pause(350);const stream=manager.start({mode:'rtmp',mime:'video/mp4',owner:'qa'});assert.equal(stream.outputConfirmed,false);
  const raw=fs.readFileSync(input);let seq=0;for(let offset=0;offset<raw.length;offset+=16384)await manager.append(stream.id,'qa',seq++,raw.subarray(offset,offset+16384));
  await waitFor(()=>manager.list()[0].outputConfirmed);assert.equal(manager.list()[0].state,'running');const exit=once(manager.items.get(stream.id).child,'exit');await manager.stop(stream.id,'qa');assert.equal((await exit)[0],0);await receiverExit;
  assert.equal(manager.items.get(stream.id).state,'stopped');assert.equal(manager.items.get(stream.id).error,null);
  const probe=spawnSync(tools.ffprobe,['-v','error','-show_streams','-show_format','-of','json',received],{timeout:10000,windowsHide:true});assert.equal(probe.status,0,receiverLog);const media=JSON.parse(probe.stdout);assert.ok(media.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'));assert.ok(media.streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'));assert.ok(Number(media.format.duration)>=7);
  manager.rtmp=()=>url;
  const bad=manager.start({mode:'rtmp',mime:'video/mp4',owner:'qa'});try{await manager.append(bad.id,'qa',0,raw);}catch{}await waitFor(()=>manager.items.get(bad.id).state==='failed');assert.equal(manager.items.get(bad.id).outputConfirmed,false);
 }finally{await manager.close();receiver.kill();fs.rmSync(root,{recursive:true,force:true});}
});

test('successful RTMP shutdown is not failed by fragmented non-seekable FLV header warnings',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-flv-warning-'));let child;
 const manager=new Broadcasts({root,rtmp:()=> 'rtmp://127.0.0.1/live/private-test-value',spawnProcess:()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',1);return child;}});
 try{
  manager.start({owner:'qa',mode:'rtmp',mime:'video/webm'});
  child.stdout.write('frame=375\nout_time_us=15005000\nprogress=end\n');
  child.stderr.write('[flv @ 123] Failed to update header with correct dura');
  child.stderr.write('tion.\r\n[flv @ 123] Failed to update header with correct filesize.\r\n');
  child.emit('exit',0);
  assert.equal(manager.list()[0].state,'stopped');assert.equal(manager.list()[0].error,null);assert.equal(manager.list()[0].outputConfirmed,true);
 }finally{await manager.close();fs.rmSync(root,{recursive:true,force:true});}
});
