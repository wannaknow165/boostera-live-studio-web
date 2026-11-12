import {readFile,stat,mkdir,writeFile,rename} from 'node:fs/promises';
import {createDecipheriv,createHash} from 'node:crypto';
import path from 'node:path';

const fail=code=>Object.assign(new Error(code),{code,status:409});
const room=value=>typeof value==='string'&&/^\d{5,30}$/.test(value)?value:'';

// Consume the encrypted handoff already written by BOOSTERA Android's server.
// The complete destination stays inside the local server-to-server path.
export async function readPhoneTarget(directory,{now=Date.now(),requireFresh=true}={}){
  if(!directory)throw fail('PHONE_LINK_NOT_CONFIGURED');
  let record;
  try{
    const file=path.join(directory,'rtmp-target.enc.json');
    if((await stat(file)).size>16384)throw Error();
    const envelope=JSON.parse(await readFile(file,'utf8'));
    if(envelope.version!==1)throw Error();
    const key=await readFile(path.join(directory,'.rtmp-target.key'));
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    record=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
  }catch(e){throw fail(e.code==='ENOENT'?'PHONE_ROOM_NOT_RECEIVED':'PHONE_HANDOFF_INVALID');}
  let target,share;
  try{target=new URL(record.rtmpPushUrl);share=new URL(record.shareUrl);}catch{throw fail('PHONE_HANDOFF_INVALID');}
  if(!['rtmp:','rtmps:'].includes(target.protocol)||target.username||target.password||target.hash||!target.hostname||target.pathname==='/'||record.rtmpPushUrl.length>2000||/[\s\\\x00-\x1f]/.test(record.rtmpPushUrl))throw fail('PHONE_HANDOFF_INVALID');
  if(share.protocol!=='https:'||!['m.tiktok.com','www.tiktok.com','tiktok.com'].includes(share.hostname)||share.username||share.password||share.port)throw fail('PHONE_HANDOFF_INVALID');
  // Installed Android 1.1.22 may omit roomId even though its share URL includes it.
  const sharedRoom=room(share.pathname.match(/^\/share\/live\/(\d+)\/?$/)?.[1]||share.searchParams.get('room_id'));
  const declaredRoom=room(record.roomId),roomId=declaredRoom||sharedRoom;
  if(!roomId||(declaredRoom&&sharedRoom&&declaredRoom!==sharedRoom))throw fail('PHONE_ROOM_ID_UNAVAILABLE');
  const storedAt=Date.parse(record.storedAt),age=now-storedAt;
  const expires=Number(target.searchParams.get('expire'))*1000;
  const fresh=Number.isFinite(storedAt)&&age>=-30000&&age<=15*60000&&(!expires||expires>now);
  if(requireFresh&&!fresh)throw fail('PHONE_ROOM_EXPIRED');
  return{target:record.rtmpPushUrl,roomId,storedAt:record.storedAt,fresh,host:target.hostname,
    fingerprint:createHash('sha256').update(record.rtmpPushUrl).digest('hex')};
}

export class PhoneLink {
  constructor({directory,stateFile,fetcher=fetch,now=Date.now,mobileOrigin='http://127.0.0.1:8801'}={}){
    if(new URL(mobileOrigin).origin!=='http://127.0.0.1:8801')throw fail('PHONE_INVALID_MOBILE_ORIGIN');
    Object.assign(this,{directory,stateFile,fetcher,now,mobileOrigin});this.pending=null;this.binding=null;
    this.loaded=this.loadBinding();
  }
  async loadBinding(){
    if(!this.stateFile)return;
    try{const v=JSON.parse(await readFile(this.stateFile,'utf8'));if(room(v.roomId)&&/^[a-f0-9]{64}$/.test(v.fingerprint))this.binding=v;}catch{}
  }
  async state(studioRoomId=''){
    await this.loaded;
    try{
      const r=await readPhoneTarget(this.directory,{now:this.now(),requireFresh:false});
      return{configured:true,received:true,fresh:r.fresh,roomId:r.roomId,storedAt:r.storedAt,
        imported:this.binding?.fingerprint===r.fingerprint,sameStudioRoom:!!studioRoomId&&studioRoomId===r.roomId,error:null};
    }catch(e){return{configured:!!this.directory,received:false,imported:false,sameStudioRoom:false,error:e.code||'PHONE_LINK_UNAVAILABLE'};}
  }
  async assertRoom(studioRoomId){
    await this.loaded;
    if(this.binding&&this.binding.roomId!==studioRoomId)throw fail('PHONE_ROOM_NOT_ATTACHED_TO_STUDIO');
  }
  importTarget(){
    if(this.pending)return this.pending;
    this.pending=this.transfer().finally(()=>{this.pending=null;});return this.pending;
  }
  async transfer(){
    await this.loaded;
    const r=await readPhoneTarget(this.directory,{now:this.now()});
    const request=async(route,options)=>{
      try{const reply=await this.fetcher(this.mobileOrigin+route,{...options,signal:AbortSignal.timeout(5000)});if(!reply.ok)throw Error();return await reply.json();}
      catch{throw fail('PHONE_MEDIA_SERVER_UNAVAILABLE');}
    };
    const overview=await request('/api/workspace/overview');
    if((overview.broadcasts||[]).some(b=>b.mode==='rtmp'&&['starting','running','stopping'].includes(b.state)))throw fail('PHONE_BROADCAST_ALREADY_ACTIVE');
    const config=await request('/api/workspace/rtmp',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:r.target,key:''})});
    if(config.rtmpConfigured!==true)throw fail('PHONE_TARGET_NOT_ACKNOWLEDGED');
    this.binding={roomId:r.roomId,fingerprint:r.fingerprint,importedAt:new Date(this.now()).toISOString()};
    if(this.stateFile){await mkdir(path.dirname(this.stateFile),{recursive:true});await writeFile(this.stateFile+'.tmp',JSON.stringify(this.binding),{mode:0o600});await rename(this.stateFile+'.tmp',this.stateFile);}
    return{imported:true,roomId:r.roomId,importedAt:this.binding.importedAt};
  }
}
