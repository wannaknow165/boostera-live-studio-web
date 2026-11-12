import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export class Broadcasts{
  constructor({root,ffmpeg='ffmpeg',rtmp=()=>null,spawnProcess=spawn}={}){
    this.root=path.join(root,'runtime','mobile-broadcast');this.ffmpeg=ffmpeg;this.rtmp=rtmp;this.spawnProcess=spawnProcess;this.items=new Map();
    this.timer=setInterval(()=>{for(const s of this.items.values()){if(s.state==='running'&&Date.now()-s.lastChunkAt>60000)void this.stop(s.id,s.owner,'INPUT_TIMEOUT');if(s.state==='running'&&Date.now()-s.startedAt>3600000)void this.stop(s.id,s.owner,'SESSION_LIMIT');if(s.state!=='running'&&Date.now()-(s.stoppedAt||s.startedAt)>1800000){fs.rmSync(s.dir,{recursive:true,force:true});this.items.delete(s.id);}}},10000);this.timer.unref();
  }
  view(s){return{id:s.id,mode:s.mode,state:s.state,mime:s.mime,bytes:s.bytes,sequence:s.sequence,startedAt:s.startedAt,lastChunkAt:s.lastChunkAt,error:s.error,...(s.state==='failed'&&s.mode==='preview'?{diagnostic:s.diagnostic||null}:{}),playback:s.mode==='preview'?'/api/workspace/broadcast/'+s.id+'/files/live.m3u8':null};}
  list(){return[...this.items.values()].map(s=>this.view(s));}
  start({mode='preview',mime,owner}){
    if(!['preview','rtmp','record'].includes(mode)||!/^video\/(mp4|webm)(;|$)/.test(mime||''))throw Object.assign(Error('INVALID_BROADCAST_FORMAT'),{status:400});
    if([...this.items.values()].filter(s=>s.state==='running').length>=2)throw Object.assign(Error('BROADCAST_LIMIT'),{status:409});
    const destination=mode==='rtmp'?this.rtmp():null;if(mode==='rtmp'&&!destination)throw Object.assign(Error('RTMP_NOT_CONFIGURED'),{status:409});
    const id=crypto.randomBytes(12).toString('hex'),dir=path.join(this.root,id);fs.mkdirSync(dir,{recursive:true});
    const base=['-hide_banner','-loglevel','warning','-y','-analyzeduration','1000000','-probesize','1000000','-i','pipe:0','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-r','30','-g','60','-b:v','2500k','-c:a','aac','-b:a','128k'];
    const output=mode==='preview'?['-f','hls','-hls_time','2','-hls_list_size','6','-hls_flags','delete_segments+independent_segments','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','part-%06d.m4s','live.m3u8']:mode==='record'?['-movflags','+faststart','recording.mp4']:['-f','flv',destination];
    const child=this.spawnProcess(this.ffmpeg,[...base,...output],{cwd:dir,windowsHide:true,stdio:['pipe','ignore','pipe']});
    const s={id,dir,mode,mime,owner,child,state:'running',bytes:0,sequence:0,startedAt:Date.now(),lastChunkAt:Date.now(),error:null,writing:false,recent:new Map(),ready:false};this.items.set(id,s);
    child.stdin.on('error',()=>{});child.stderr.on('data',d=>{const text=d.toString();if(s.mode==='preview')s.diagnostic=((s.diagnostic||'')+text).slice(-2000);if(/Error|Invalid|failed|not found|denied/i.test(text))s.error='ENCODER_OR_DESTINATION_ERROR';});
    child.on('error',()=>{s.state='failed';s.error='FFMPEG_UNAVAILABLE';s.stoppedAt=Date.now();});
    child.on('exit',code=>{if(s.state==='running'){s.state=code===0?'stopped':'failed';if(code!==0)s.error||='ENCODER_STOPPED';}else if(code===0&&s.state==='stopping')s.state='stopped';else if(s.state==='stopping')s.state='failed';s.stoppedAt=Date.now();});
    return this.view(s);
  }
  async append(id,owner,sequence,raw){
    const s=this.items.get(id);if(!s||s.owner!==owner)throw Object.assign(Error('BROADCAST_NOT_FOUND'),{status:404});
    if(s.state!=='running')throw Object.assign(Error(s.error||'BROADCAST_STOPPED'),{status:409});
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
    if(s.state==='running'){s.state='stopping';if(reason)s.error=reason;s.child.stdin.end();const timer=setTimeout(()=>{if(s.state==='stopping')s.child.kill();},6000);timer.unref();s.child.once('exit',()=>clearTimeout(timer));}
    return this.view(s);
  }
  file(id,name){const s=this.items.get(id);if(!s||!/^((live\.m3u8)|(init\.mp4)|(part-\d+\.m4s)|(recording\.mp4))$/.test(name))return null;const file=path.join(s.dir,name);return fs.existsSync(file)?file:null;}
  async close(){clearInterval(this.timer);for(const s of this.items.values())if(s.state==='running')await this.stop(s.id,s.owner);}
}
