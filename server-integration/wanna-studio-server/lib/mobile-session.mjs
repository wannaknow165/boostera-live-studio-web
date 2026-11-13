import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export class MobileSessions {
  constructor({now=Date.now,ttl=12*60*60*1000,stateFile=null}={}){
    this.now=now;this.ttl=ttl;this.stateFile=stateFile;this.codes=new Map();this.sessions=new Map();this.attempts=new Map();
    if(stateFile&&fs.existsSync(stateFile)){
      const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      if(saved.version!==1||!Array.isArray(saved.sessions)||saved.sessions.length>12)throw Error('INVALID_SESSION_STORE');
      for(const [hash,s]of saved.sessions){
        if(!/^[a-f0-9]{64}$/.test(hash)||!s||!/^[a-f0-9]{12}$/.test(s.id)||typeof s.label!=='string'||s.label.length>60||!Number.isFinite(s.expiresAt))throw Error('INVALID_SESSION_STORE');
        if(s.expiresAt>now())this.sessions.set(hash,s);
      }
    }
  }
  save(){if(!this.stateFile)return;fs.mkdirSync(path.dirname(this.stateFile),{recursive:true,mode:0o700});const temp=this.stateFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,sessions:[...this.sessions]}),{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,this.stateFile);}
  issue(){this.prune();const code=crypto.randomInt(0,1e8).toString().padStart(8,'0'),expiresAt=this.now()+180000;this.codes.clear();this.codes.set(this.hash(code),expiresAt);return{code,expiresAt};}
  hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
  pair(code,label,ip){
    this.prune();const entry=this.attempts.get(ip)||{count:0,until:this.now()+60000};
    if(entry.count>=8&&entry.until>this.now())throw new Error('TOO_MANY_ATTEMPTS');
    const key=this.hash(code),expires=this.codes.get(key);
    if(typeof code!=='string'||!/^\d{8}$/.test(code)||!expires||expires<this.now()){entry.count++;this.attempts.set(ip,entry);throw new Error('INVALID_PAIRING_CODE');}
    if(this.sessions.size>=12)throw new Error('DEVICE_LIMIT');this.codes.delete(key);this.attempts.delete(ip);
    const token=crypto.randomBytes(32).toString('hex'),session={id:crypto.randomBytes(6).toString('hex'),label:String(label||'טלפון').slice(0,60),at:this.now(),expiresAt:this.now()+this.ttl,frames:0,bytes:0,audioTests:0};
    const hash=this.hash(token);this.sessions.set(hash,session);try{this.save();}catch(e){this.sessions.delete(hash);throw e;}return{token,session};
  }
  get(token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;const s=this.sessions.get(this.hash(token));if(!s||s.expiresAt<this.now())return null;s.at=this.now();return s;}
  revoke(token){this.sessions.delete(this.hash(token||''));this.save();}
  prune(){for(const[k,t]of this.codes)if(t<this.now())this.codes.delete(k);for(const[k,s]of this.sessions)if(s.expiresAt<this.now())this.sessions.delete(k);for(const[k,a]of this.attempts)if(a.until<this.now())this.attempts.delete(k);}
}
