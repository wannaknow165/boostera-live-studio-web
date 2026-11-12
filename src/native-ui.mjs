export class NativeUi {
  constructor({fetcher=fetch,Socket=WebSocket,timeout=3000}={}){Object.assign(this,{fetcher,Socket,timeout});this.nextId=0;}
  async connect(surface='popupMulti'){
    if(!['popupMulti','main'].includes(surface))throw new Error('INVALID_NATIVE_SURFACE');
    const response=await this.fetcher('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(this.timeout)});
    const pages=await response.json();
    const page=pages.find(p=>{
      if(p.type!=='page')return false;
      try{const u=new URL(p.url);return u.protocol==='file:'&&new RegExp('^/C:/Program Files/TikTok LIVE Studio/[\\d.]+/resources/app/+html/'+surface+'/index\\.html$','i').test(decodeURIComponent(u.pathname));}catch{return false;}
    });
    if(!page)throw new Error('NATIVE_PANEL_UNAVAILABLE');
    const endpoint=new URL(page.webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||endpoint.port!=='9222')throw new Error('INVALID_NATIVE_ENDPOINT');
    const ws=new this.Socket(endpoint.href),pending=new Map();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.close();reject(new Error('NATIVE_UI_TIMEOUT'));},this.timeout);
      ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('NATIVE_UI_UNAVAILABLE'));},{once:true});
    });
    ws.addEventListener('message',event=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      const waiter=pending.get(message.id);if(!waiter)return;
      clearTimeout(waiter.timer);pending.delete(message.id);
      if(message.error)waiter.reject(new Error('NATIVE_COMMAND_FAILED'));
      else waiter.resolve(message.result);
    });
    ws.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('NATIVE_UI_CLOSED'));}pending.clear();});
    const evaluate=async(expression)=>{
      const result=await new Promise((resolve,reject)=>{
        const id=++this.nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('NATIVE_UI_TIMEOUT'));},this.timeout);
        pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
      });
      if(result.exceptionDetails)throw new Error('NATIVE_UI_SCRIPT_FAILED');
      return result.result?.value;
    };
    return{evaluate,close:()=>ws.close()};
  }
  async inspect(){
    const session=await this.connect();
    try{return await session.evaluate(String.raw`(()=>{
      const tab=document.querySelector('[role="tab"][aria-controls="friend"]');
      const shown=e=>!!(e&&e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
      const enabled=e=>shown(e)&&!e.disabled&&!e.hasAttribute('data-disabled')&&e.getAttribute('aria-disabled')!=='true';
      const candidates=[...document.querySelectorAll('[data-cohost-candidate][data-uid][data-roomid]')].filter(shown).map(e=>{
        const button=e.querySelector('button[data-action="cohost-invite"]');
        return{uid:e.getAttribute('data-uid'),roomId:e.getAttribute('data-roomid'),name:e.innerText.split('\n')[0],avatar:e.querySelector('img')?.src||'',
          sources:[e.getAttribute('data-roomtype')==='suggested_creators'?'recommend_list':'followed_list'],inviteAvailable:enabled(button)};
      });
      return{ready:shown(tab),selected:document.querySelector('[role="tab"][aria-selected="true"][aria-controls="friend"],[role="tab"][aria-selected="true"][aria-controls="suggested_creators"]')?.getAttribute('aria-controls')||'',
        candidates,buttons:[...document.querySelectorAll('button[data-uid][data-action="cohost-invite"]')].map(e=>({uid:e.getAttribute('data-uid'),enabled:enabled(e)}))};
    })()`);}finally{session.close();}
  }
  async prepare(uid,sources=[]){
    if(!/^\d{1,30}$/.test(uid))throw new Error('INVALID_TARGET');
    let observed=await this.inspect();
    if(!observed?.ready)throw new Error('OPEN_COHOST_PANEL');
    let button=observed.buttons.filter(x=>x.uid===uid);
    if(button.length===1&&button[0].enabled)return{ready:true,uid};
    const target=sources.includes('followed_list')?'friend':sources.some(s=>['recommend_list','league_recommend_list','may_know_list','game_list','search_list'].includes(s))?'suggested_creators':null;
    if(target&&observed.selected!==target){
      const session=await this.connect();
      try{const result=await session.evaluate('(()=>{const e=document.querySelector('+JSON.stringify('[role="tab"][aria-controls="'+target+'"]')+');if(!e||!e.getClientRects().length)return false;e.click();return true;})()');if(!result)throw new Error('NATIVE_LIST_UNAVAILABLE');}
      finally{session.close();}
      for(let attempt=0;attempt<6;attempt++){
        await new Promise(r=>setTimeout(r,250));observed=await this.inspect();button=observed.buttons.filter(x=>x.uid===uid);
        if(button.length===1)break;
      }
    }
    if(button.length!==1)throw new Error('TARGET_NOT_IN_NATIVE_LIST');
    if(!button[0].enabled)throw new Error('NATIVE_INVITE_DISABLED');
    return{ready:true,uid};
  }
  async clickInvite(uid){
    if(!/^\d{1,30}$/.test(uid))throw new Error('INVALID_TARGET');
    const session=await this.connect();
    try{
      const expression='(()=>{if(!document.querySelector(\'[role="tab"][aria-controls="friend"]\'))return{clicked:false,error:"OPEN_COHOST_PANEL"};const nodes=[...document.querySelectorAll(\'button[data-action="cohost-invite"][data-uid="'+uid+'"]\')];if(nodes.length!==1)return{clicked:false,error:"AMBIGUOUS_NATIVE_TARGET"};const e=nodes[0];if(e.disabled||e.hasAttribute("data-disabled")||e.getAttribute("aria-disabled")==="true"||!e.getClientRects().length||getComputedStyle(e).visibility==="hidden")return{clicked:false,error:"NATIVE_INVITE_DISABLED"};e.scrollIntoView({block:"nearest"});e.click();return{clicked:true,uid:'+JSON.stringify(uid)+'};})()';
      const result=await session.evaluate(expression);
      if(!result?.clicked)throw new Error(result?.error||'NATIVE_CLICK_FAILED');
      return result;
    }finally{session.close();}
  }
}
