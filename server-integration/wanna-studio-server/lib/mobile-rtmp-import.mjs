import fs from 'node:fs';
const fail=code=>Object.assign(Error(code),{status:409});
// Reads the existing tiktok-rtmp-extractor/key_wait.py output contract. Never returns a key to the browser.
export function readCapturedTarget(file,now=Date.now()){
 if(!file||!fs.existsSync(file))throw fail('LOCAL_RTMP_CAPTURE_MISSING');
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw fail('LOCAL_RTMP_CAPTURE_INVALID');
 if(now-stat.mtimeMs>15*60000||stat.mtimeMs-now>30000)throw fail('LOCAL_RTMP_CAPTURE_EXPIRED');
 let data;try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fail('LOCAL_RTMP_CAPTURE_INVALID');}
 const candidate=data.obs?.[0]||data.all?.[0];let destination;
 try{destination=new URL(candidate?.server);}catch{throw fail('LOCAL_RTMP_CAPTURE_INVALID');}
 if(!['rtmp:','rtmps:'].includes(destination.protocol)||destination.username||destination.password||typeof candidate.stream_key!=='string'||!candidate.stream_key||candidate.stream_key.length>2000||/[\r\n]/.test(candidate.stream_key))throw fail('LOCAL_RTMP_CAPTURE_INVALID');
 return{url:destination.href,key:candidate.stream_key,host:destination.hostname};
}
