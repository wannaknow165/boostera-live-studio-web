import crypto from 'node:crypto';
export class MobileSessions {
  constructor({now=Date.now,ttl=12*60*60*1000}={}){this.now=now;this.ttl=ttl;this.codes=new Map();this.sessions=new Map();this.attempts=new Map();}
  issue(){this.prune();const code=crypto.randomInt(0,1e8).toString().padStart(8,'0'),expiresAt=this.now()+180000;this.codes.clear();this.codes.set(this.hash(code),expiresAt);return{code,expiresAt};}
  hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
  pair(code,label,ip){
    this.prune();const entry=this.attempts.get(ip)||{count:0,until:this.now()+60000};
    if(entry.count>=8&&entry.until>this.now())throw new Error('TOO_MANY_ATTEMPTS');
    const key=this.hash(code),expires=this.codes.get(key);
    if(typeof code!=='string'||!/^\d{8}$/.test(code)||!expires||expires<this.now()){entry.count++;this.attempts.set(ip,entry);throw new Error('INVALID_PAIRING_CODE');}
    if(this.sessions.size>=12)throw new Error('DEVICE_LIMIT');this.codes.delete(key);this.attempts.delete(ip);
    const token=crypto.randomBytes(32).toString('hex'),session={id:crypto.randomBytes(6).toString('hex'),label:String(label||'טלפון').slice(0,60),at:this.now(),expiresAt:this.now()+this.ttl,frames:0,bytes:0,audioTests:0};
    this.sessions.set(this.hash(token),session);return{token,session};
  }
  get(token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;const s=this.sessions.get(this.hash(token));if(!s||s.expiresAt<this.now())return null;s.at=this.now();return s;}
  revoke(token){this.sessions.delete(this.hash(token||''));}
  prune(){for(const[k,t]of this.codes)if(t<this.now())this.codes.delete(k);for(const[k,s]of this.sessions)if(s.expiresAt<this.now())this.sessions.delete(k);for(const[k,a]of this.attempts)if(a.until<this.now())this.attempts.delete(k);}
}
