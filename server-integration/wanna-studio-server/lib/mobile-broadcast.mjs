import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const active=s=>s.state==='starting'||s.state==='running';
export class Broadcasts{
  constructor({root,ffmpeg='ffmpeg',rtmp=()=>null,spawnProcess=spawn}={}){
    this.root=path.join(root,'runtime','mobile-broadcast');this.ffmpeg=ffmpeg;this.rtmp=rtmp;this.spawnProcess=spawnProcess;this.items=new Map();
    this.timer=setInterval(()=>{for(const s of this.items.values()){if(active(s)&&Date.now()-s.lastChunkAt>60000)void this.stop(s.id,s.owner,'INPUT_TIMEOUT');if(active(s)&&Date.now()-(s.lastOutputAt||s.startedAt)>60000)void this.stop(s.id,s.owner,'OUTPUT_TIMEOUT');if(['stopped','failed'].includes(s.state)&&Date.now()-s.stoppedAt>1800000){fs.rmSync(s.dir,{recursive:true,force:true});this.items.delete(s.id);}}},10000);this.timer.unref();
  }
  view(s){return{id:s.id,mode:s.mode,state:s.state,mime:s.mime,bytes:s.bytes,sequence:s.sequence,startedAt:s.startedAt,lastChunkAt:s.lastChunkAt,outputConfirmed:s.outputConfirmed,outputFrames:s.outputFrames,lastOutputAt:s.lastOutputAt,error:s.error,playback:s.mode==='preview'?'/api/workspace/broadcast/'+s.id+'/files/live.m3u8':null};}
  list(){return[...this.items.values()].map(s=>this.view(s));}
  start({mode='preview',mime,owner}){
    if(!['preview','rtmp','record'].includes(mode)||!/^video\/(mp4|webm)(;|$)/.test(mime||''))throw Object.assign(Error('INVALID_BROADCAST_FORMAT'),{status:400});
    if([...this.items.values()].filter(s=>active(s)||s.state==='stopping').length>=2)throw Object.assign(Error('BROADCAST_LIMIT'),{status:409});
    const destination=mode==='rtmp'?this.rtmp():null;if(mode==='rtmp'&&!destination)throw Object.assign(Error('RTMP_NOT_CONFIGURED'),{status:409});
    const id=crypto.randomBytes(12).toString('hex'),dir=path.join(this.root,id);fs.mkdirSync(dir,{recursive:true});
    const base=['-hide_banner','-loglevel','warning','-nostats','-progress','pipe:1','-y','-analyzeduration','1000000','-probesize','1000000','-i','pipe:0','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-r','30','-g','60','-b:v','2500k','-c:a','aac','-b:a','128k'];
    const output=mode==='preview'?['-f','hls','-hls_time','2','-hls_list_size','6','-hls_flags','delete_segments+independent_segments','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','part-%06d.m4s','live.m3u8']:mode==='record'?['-movflags','+faststart','recording.mp4']:['-f','flv',destination];
    const child=this.spawnProcess(this.ffmpeg,[...base,...output],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const s={id,dir,mode,mime,owner,child,state:'starting',bytes:0,sequence:0,startedAt:Date.now(),lastChunkAt:Date.now(),error:null,writing:false,recent:new Map(),outputConfirmed:false,outputFrames:0,lastOutputAt:null};this.items.set(id,s);
    let progressBuffer='',progress={};
    child.stdout.on('data',chunk=>{progressBuffer+=chunk.toString();let end;while((end=progressBuffer.indexOf('\n'))!==-1){const line=progressBuffer.slice(0,end).trim();progressBuffer=progressBuffer.slice(end+1);const eq=line.indexOf('=');if(eq<0)continue;progress[line.slice(0,eq)]=line.slice(eq+1);if(line.startsWith('progress=')){const frames=Number(progress.frame)||0;if(frames>s.outputFrames&&Number(progress.out_time_us)>0){s.outputFrames=frames;s.outputConfirmed=true;s.lastOutputAt=Date.now();if(s.state==='starting')s.state='running';}progress={};}}});
    child.stdin.on('error',()=>{});child.stderr.on('data',d=>{const text=d.toString();if(s.mode==='preview')s.diagnostic=((s.diagnostic||'')+text).slice(-2000);if(/Error|Invalid|failed|not found|denied/i.test(text))s.error='ENCODER_OR_DESTINATION_ERROR';});
    child.on('error',()=>{s.state='failed';s.error='FFMPEG_UNAVAILABLE';s.stoppedAt=Date.now();});
    s.ended=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
    child.on('exit',code=>{if(s.state!=='failed'){s.state=code===0&&!s.error?'stopped':'failed';if(code!==0)s.error||='ENCODER_STOPPED';}s.stoppedAt=Date.now();});
    return this.view(s);
  }
  async append(id,owner,sequence,raw){
    const s=this.items.get(id);if(!s||s.owner!==owner)throw Object.assign(Error('BROADCAST_NOT_FOUND'),{status:404});
    if(!active(s))throw Object.assign(Error(s.error||'BROADCAST_STOPPED'),{status:409});
    const digest=crypto.createHash('sha256').update(raw).digest('hex');
    if(sequence<s.sequence&&s.recent.get(sequence)===digest)return{...this.view(s),accepted:true,repeated:true};
    if(sequence!==s.sequence)throw Object.assign(Error('SEQUENCE_MISMATCH'),{status:409});
    if(s.writing)throw Object.assign(Error('BACKPRESSURE'),{status:429});
    if(!raw.length||raw.length>8*1024*1024)throw Object.assign(Error('INVALID_CHUNK_SIZE'),{status:413});
    s.writing=true;
    try{await new Promise((resolve,reject)=>s.child.stdin.write(raw,error=>error?reject(error):resolve()));s.recent.set(sequence,digest);while(s.recent.size>8)s.recent.delete(s.recent.keys().next().value);s.bytes+=raw.length;s.sequence++;s.lastChunkAt=Date.now();return{...this.view(s),accepted:true};}
    finally{s.writing=false;}
  }
  async stop(id,owner,reason){
    const s=this.items.get(id);if(!s||s.owner!==owner)throw Object.assign(Error('BROADCAST_NOT_FOUND'),{status:404});
    if(active(s)){s.state='stopping';if(reason)s.error=reason;s.child.stdin.end();const timer=setTimeout(()=>{if(s.state==='stopping')s.child.kill();},6000);timer.unref();s.child.once('exit',()=>clearTimeout(timer));}
    return this.view(s);
  }
  file(id,name){const s=this.items.get(id);if(!s||!/^((live\.m3u8)|(init\.mp4)|(part-\d+\.m4s)|(recording\.mp4))$/.test(name))return null;const file=path.join(s.dir,name);return fs.existsSync(file)?file:null;}
  async close(){clearInterval(this.timer);await Promise.all([...this.items.values()].map(async s=>{if(!active(s)&&s.state!=='stopping')return;await this.stop(s.id,s.owner);await s.ended;}));}
}
