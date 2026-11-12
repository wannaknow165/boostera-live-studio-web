import crypto from 'node:crypto';
export class InviteError extends Error {
  constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
export class InviteController {
  constructor({service,ui,getState,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms)),observeMs=6000,roomGuard=async()=>{}}){
    Object.assign(this,{service,ui,getState,now,pause,observeMs,roomGuard});this.drafts=new Map();this.requests=new Map();this.cooldowns=new Map();this.active=false;
  }
  validateInput(uid,epoch){
    if(typeof uid!=='string'||!/^\d{1,30}$/.test(uid)||typeof epoch!=='string'||epoch.length>160)throw new InviteError('INVALID_TARGET',400);
  }
  async fresh(uid,epoch){
    this.validateInput(uid,epoch);
    const snapshot=await this.service.state('interactionConnection','snapshot');
    await this.roomGuard(snapshot?.session?.roomId||'');
    if(!snapshot?.session?.epoch||snapshot.session.epoch!==epoch)throw new InviteError('SESSION_CHANGED');
    if(snapshot.health!=='ready')throw new InviteError('STUDIO_NOT_READY');
    if(snapshot.session.selfUid===uid)throw new InviteError('SELF_INVITE_NOT_ALLOWED');
    const user=snapshot.users?.[uid];
    const nativeTarget=this.getState().session?.epoch===epoch&&this.getState().candidates?.some(p=>p.uid===uid&&p.nativeObserved&&p.inviteAvailable);
    const nativeAllowed=nativeTarget&&snapshot.availability?.manual_cohost?.allowed===true;
    if(snapshot.availability?.manual_cohost?.allowed===false||user?.linked||user?.availableActions?.invite===false||(!user?.availableActions?.invite&&!nativeAllowed))throw new InviteError('TARGET_UNAVAILABLE');
    if(user?.invited||(snapshot.operations||[]).some(op=>op.targetUid===uid&&op.outcome==='pending'))throw new InviteError('INVITATION_ALREADY_PENDING');
    return snapshot;
  }
  cleanup(){
    for(const[key,draft]of this.drafts)if(draft.expiresAt<this.now())this.drafts.delete(key);
    for(const[key,entry]of this.requests)if(entry.expiresAt<this.now())this.requests.delete(key);
    for(const[key,expiry]of this.cooldowns)if(expiry<this.now())this.cooldowns.delete(key);
  }
  async prepare({uid,epoch}){
    this.cleanup();await this.fresh(uid,epoch);
    if(this.active||this.cooldowns.has(uid))throw new InviteError('INVITE_BUSY');
    const target=this.getState().candidates?.find(x=>x.uid===uid);
    if(!target||this.getState().session?.epoch!==epoch)throw new InviteError('REFRESH_CANDIDATES');
    try{await this.ui.prepare(uid,target.sources);}catch(error){throw new InviteError(error.message);}
    await this.fresh(uid,epoch);
    const draftToken=crypto.randomBytes(24).toString('hex'),expiresAt=this.now()+30000;
    if(this.drafts.size>=32)this.drafts.delete(this.drafts.keys().next().value);
    this.drafts.set(draftToken,{uid,epoch,expiresAt});
    return{draftToken,uid,epoch,name:target.name||target.handle||uid,handle:target.handle||'',expiresAt};
  }
  send({uid,epoch,draftToken,requestId}){
    this.cleanup();this.validateInput(uid,epoch);
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw new InviteError('INVALID_REQUEST_ID',400);
    const existing=this.requests.get(requestId);
    if(existing){if(existing.uid!==uid||existing.epoch!==epoch)throw new InviteError('REQUEST_ID_CONFLICT');return existing.promise;}
    const draft=this.drafts.get(draftToken);
    if(!draft||draft.uid!==uid||draft.epoch!==epoch||draft.expiresAt<this.now())throw new InviteError('CONFIRMATION_EXPIRED');
    if(this.active||this.cooldowns.has(uid))throw new InviteError('INVITE_BUSY');
    this.drafts.delete(draftToken);this.active=true;this.cooldowns.set(uid,this.now()+30000);
    const promise=this.dispatch(uid,epoch).finally(()=>{this.active=false;});
    this.requests.set(requestId,{uid,epoch,promise,expiresAt:this.now()+5*60000});
    return promise;
  }
  async dispatch(uid,epoch){
    const before=await this.fresh(uid,epoch),known=new Set((before.operations||[]).map(op=>op.operationId)),started=this.now();
    try{await this.ui.clickInvite(uid);}catch(error){if(/TIMEOUT|CLOSED|UNAVAILABLE/.test(error.message))return{submitted:null,outcome:'unknown',error:'NATIVE_ACTION_UNCERTAIN'};throw new InviteError(error.message);}
    for(let attempt=0;attempt<=Math.ceil(this.observeMs/300);attempt++){
      let snapshot;try{snapshot=await this.service.state('interactionConnection','snapshot');}catch{return{submitted:null,outcome:'unknown',error:'BRIDGE_LOST_AFTER_CLICK'};}
      if(snapshot?.session?.epoch!==epoch)return{submitted:null,outcome:'unknown',error:'SESSION_CHANGED_AFTER_CLICK'};
      const operation=(snapshot.operations||[]).find(op=>!known.has(op.operationId)&&op.kind==='manual_cohost'&&op.action==='invite'&&op.targetUid===uid&&Number(op.createdAt)>=started-2000);
      if(operation)return{submitted:true,operationId:operation.operationId,outcome:operation.outcome||'pending',step:operation.step||operation.phase,error:operation.error?{code:String(operation.error.code||''),message:String(operation.error.message||'').slice(0,250)}:null};
      if(snapshot.users?.[uid]?.invited===true)return{submitted:true,outcome:'pending',step:'awaiting_peer'};
      if(attempt<Math.ceil(this.observeMs/300))await this.pause(300);
    }
    return{submitted:null,outcome:'unknown',error:'NATIVE_ACTION_NOT_OBSERVED'};
  }
}
