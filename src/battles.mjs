import crypto from 'node:crypto';
import {NativeUi} from './native-ui.mjs';
import {InviteError} from './invites.mjs';

export const battleActions=Object.freeze({
  'match.select':'באטל רגיל',
  'match.individual.select':'באטל אישי',
  'match.team.select':'באטל קבוצות',
  'cohostMode.getStarted':'המשך להגדרת הבאטל',
  'match.start':'שלח הזמנת באטל',
  'match.accept':'קבל הזמנת באטל',
  'match.decline':'דחה הזמנת באטל',
  'match.withdraw':'בטל את הזמנת הבאטל',
});

// Runs only in the original Studio renderer. No private service calls, caller
// impersonation, permission changes, or native application patches are used.
export function nativeBattleDocument(allowed,command){
  const attr=(e,key)=>e?.getAttribute('data-ix-'+key)||'';
  const shown=e=>Boolean(e&&e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility==='visible'&&!e.closest('[inert]'));
  const enabled=e=>{
    if(!shown(e)||e.disabled||e.hasAttribute('data-disabled')||e.closest('[aria-disabled="true"],[aria-busy="true"]'))return false;
    const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return Boolean(top&&(top===e||e.contains(top)));
  };
  const ids=value=>{try{return [...new Set(JSON.parse(value||'[]').flat().filter(x=>typeof x==='string'&&/^\d{1,30}$/.test(x)))].sort();}catch{return [];}};
  const scopes=[...document.querySelectorAll('[data-ix-state="match.invitation"],[data-ix-surface="matchStart"],[data-ix-surface="cohostModeSelect"]')].filter(shown);
  const context=document.querySelector('[data-ix-state="match.context"]');
  const scopeInfo=e=>({surface:attr(e,'surface')||attr(e,'state'),battleId:attr(e,'battle-id'),channelId:attr(e,'channel-id')||attr(context,'channel-id'),
    role:attr(e,'invitation-role'),mode:attr(e,'mode')||attr(e,'selected-match-mode'),teams:attr(e,'teams'),
    participantCount:attr(e,'participant-count'),selectedTeammateCount:attr(e,'selected-teammate-count'),
    giftType:attr(e,'gift-type'),giftId:attr(e,'gift-id')});
  const buttons=[];
  // Minimized Electron windows report a hidden document while their real UI
  // remains rendered. Use element visibility and the controller's fresh room
  // identity, so dispatch never needs to activate the user's desktop window.
  for(const action of allowed){
    const matches=[...document.querySelectorAll('[data-ix-action="'+action+'"]')].filter(shown);
    if(matches.length!==1)continue;
    const element=matches[0],scope=scopes.find(s=>s.contains(element));
    if(!scope)continue;
    const info=scopeInfo(scope);
    if(['match.accept','match.decline'].includes(action)&&(!/^\d{1,30}$/.test(info.battleId)||info.role!=='invitee'))continue;
    if(action==='match.withdraw'&&(!/^\d{1,30}$/.test(info.battleId)||info.role!=='inviter'))continue;
    if(action==='match.start'&&(info.surface!=='matchStart'||Number(info.participantCount)<2||ids(info.teams).length<2))continue;
    if(action==='cohostMode.getStarted'&&!scope.querySelector('[data-ix-action="match.select"][data-ix-selected="true"],[data-ix-action="match.individual.select"][data-ix-selected="true"],[data-ix-action="match.team.select"][data-ix-selected="true"]'))continue;
    buttons.push({action,enabled:enabled(element),selected:attr(element,'selected')==='true'});
  }
  const value={ready:true,scopes:scopes.map(scopeInfo),buttons};
  const identity=JSON.stringify(value);
  if(!command)return{...value,identity};
  if(identity!==command.identity)return{clicked:false,error:'BATTLE_CHANGED'};
  if(!buttons.some(b=>b.action===command.action&&b.enabled))return{clicked:false,error:'BATTLE_ACTION_UNAVAILABLE'};
  const element=[...document.querySelectorAll('[data-ix-action="'+command.action+'"]')].find(shown);
  if(!enabled(element))return{clicked:false,error:'BATTLE_ACTION_UNAVAILABLE'};
  element.click();
  return{clicked:true};
}

export class NativeBattleUi extends NativeUi {
  async run(command){
    const session=await this.connect('main');
    try{return await session.evaluate('('+nativeBattleDocument.toString()+')('+JSON.stringify(Object.keys(battleActions))+','+JSON.stringify(command??null)+')');}
    finally{session.close();}
  }
  inspect(){return this.run();}
  async act(action,identity){
    const result=await this.run({action,identity});
    if(!result?.clicked)throw new InviteError(result?.error||'BATTLE_ACTION_UNAVAILABLE');
    return result;
  }
}

export class BattleController {
  constructor({service,ui=new NativeBattleUi(),now=Date.now,roomGuard=async()=>{}}){
    Object.assign(this,{service,ui,now,roomGuard});this.requests=new Map();this.revisions=new Map();this.active=false;
  }
  async inspect(){
    const before=await this.service.state('interactionConnection','snapshot');
    await this.roomGuard(before?.session?.roomId||'');
    if(before?.health!=='ready'||!before.session?.epoch||!before.session?.roomId)throw new InviteError('STUDIO_NOT_READY');
    const native=await this.ui.inspect();
    const after=await this.service.state('interactionConnection','snapshot');
    if(after?.health!=='ready'||after?.session?.epoch!==before.session.epoch)throw new InviteError('SESSION_CHANGED');
    const revision=crypto.createHash('sha256').update(JSON.stringify([before.session.epoch,native.identity])).digest('hex');
    return {native,revision,epoch:before.session.epoch,battle:after.battle};
  }
  async state(){
    try{
      const observed=await this.inspect();
      return{available:observed.native.ready,revision:observed.revision,epoch:observed.epoch,
        scopes:observed.native.scopes,actions:observed.native.buttons.map(b=>({...b,label:battleActions[b.action]})),error:null};
    }catch(e){return{available:false,actions:[],scopes:[],error:e.code||e.message||'BATTLE_UNAVAILABLE'};}
  }
  execute({action,revision,epoch,requestId}){
    if(!Object.hasOwn(battleActions,action)||typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision)||typeof epoch!=='string'||epoch.length>160||typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw new InviteError('INVALID_BATTLE_REQUEST',400);
    for(const[id,r]of this.requests)if(r.expiresAt<this.now())this.requests.delete(id);
    for(const[id,r]of this.revisions)if(r.expiresAt<this.now())this.revisions.delete(id);
    const signature=JSON.stringify([action,revision,epoch]),existing=this.requests.get(requestId);
    if(existing){if(existing.signature!==signature)throw new InviteError('REQUEST_ID_CONFLICT');return existing.promise;}
    if(this.requests.size>=200)throw new InviteError('BATTLE_RATE_LIMIT',429);
    const previous=this.revisions.get(signature);
    if(previous){this.requests.set(requestId,{...previous,signature});return previous.promise;}
    if(this.active)throw new InviteError('BATTLE_BUSY');
    this.active=true;
    const promise=this.dispatch({action,revision,epoch}).finally(()=>{this.active=false;});
    const entry={signature,promise,expiresAt:this.now()+300000};
    this.requests.set(requestId,entry);this.revisions.set(signature,entry);
    return promise;
  }
  async dispatch({action,revision,epoch}){
    const observed=await this.inspect();
    if(observed.epoch!==epoch)throw new InviteError('SESSION_CHANGED');
    if(observed.revision!==revision)throw new InviteError('BATTLE_CHANGED');
    if(!observed.native.buttons.some(b=>b.action===action&&b.enabled))throw new InviteError('BATTLE_ACTION_UNAVAILABLE');
    try{await this.ui.act(action,observed.native.identity);}
    catch(e){
      if(/TIMEOUT|CLOSED|UNAVAILABLE/.test(e.message)&&!(e instanceof InviteError))return{action,dispatched:null,outcome:'unknown',error:'BATTLE_ACTION_UNCERTAIN'};
      throw e;
    }
    // Native click acknowledgement is never represented as peer acceptance.
    return{action,dispatched:true,outcome:'awaiting_studio',error:null};
  }
}
