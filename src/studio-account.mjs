import {NativeUi} from './native-ui.mjs';

// Relay only the QR rendered by Studio. Keep authentication and cookies in Studio.
const inspectExpression=String.raw`(()=>{
  const shown=e=>!!(e&&e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const cards=[...document.querySelectorAll('[class^="scan-code-"]')].filter(shown);
  if(!cards.length)return{phase:'not_open'};
  if(cards.length!==1)return{phase:'unavailable'};
  const card=cards[0],cardKey=Object.keys(card).find(k=>k.startsWith('__reactFiber$'));
  let owner=cardKey?card[cardKey]:null;
  for(let depth=0;owner&&depth<8;depth++,owner=owner.return){
    const props=owner.memoizedProps;
    if(typeof props?.qrCodeUrl==='string'&&['expired','refuse','error'].includes(props.state))return{phase:'loading'};
  }
  const mask=[...card.querySelectorAll('[class*="mask-"]')].find(shown);
  if(mask){
    if(String(mask.className).includes('translucent-'))return{phase:'scanned'};
    const refresh=[...mask.querySelectorAll('img')].filter(e=>shown(e)&&getComputedStyle(e).cursor==='pointer');
    return{phase:refresh.length===1?'expired':'loading'};
  }
  const canvases=[...card.querySelectorAll('canvas[class^="qrCode-"]')].filter(shown);
  if(canvases.length!==1||canvases[0].width<64||canvases[0].height<64)return{phase:'loading'};
  const canvas=canvases[0],key=Object.keys(canvas).find(k=>k.startsWith('__reactFiber$'));
  let fiber=key?canvas[key]:null,approvalUrl;
  for(let depth=0;fiber&&depth<8;depth++,fiber=fiber.return){
    const props=fiber.memoizedProps;
    if(typeof props?.value==='string'&&String(props.className||'').startsWith('qrCode-')){approvalUrl=props.value;break;}
  }
  return{phase:'qr',image:canvas.toDataURL('image/png'),approvalUrl};
})()`;

export class NativeStudioLoginUi {
  constructor({nativeUi=new NativeUi()}={}){this.nativeUi=nativeUi;}
  async inspect(){
    const session=await this.nativeUi.connect('main');
    try{return await session.evaluate(inspectExpression);}finally{session.close();}
  }
  async refresh(){
    const session=await this.nativeUi.connect('main');
    try{
      const result=await session.evaluate(String.raw`(()=>{
        const shown=e=>!!(e&&e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
        const cards=[...document.querySelectorAll('[class^="scan-code-"]')].filter(shown);
        if(cards.length!==1)return false;
        const masks=[...cards[0].querySelectorAll('[class*="mask-"]')].filter(e=>shown(e)&&!String(e.className).includes('translucent-'));
        if(masks.length!==1)return false;
        const buttons=[...masks[0].querySelectorAll('img')].filter(e=>shown(e)&&getComputedStyle(e).cursor==='pointer');
        if(buttons.length!==1)return false;
        buttons[0].click();return true;
      })()`);
      if(result!==true)throw Error('QR_REFRESH_NOT_AVAILABLE');
      return{requested:true};
    }finally{session.close();}
  }
}

function qrImage(value){
  if(typeof value!=='string'||value.length>131072||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return null;
  const bytes=Buffer.from(value.slice(value.indexOf(',')+1),'base64');
  return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?value:null;
}

function approvalLink(value){
  if(typeof value!=='string'||value.length>8192)return null;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='tiktok.com'||u.hostname.endsWith('.tiktok.com'))?u.href:null;}catch{return null;}
}

export class StudioAccount {
  constructor({ui=new NativeStudioLoginUi(),getState=()=>({}),now=Date.now}={}){
    Object.assign(this,{ui,getState,now});this.refreshing=null;
  }
  async state(){
    const observedAt=this.now();let observed;
    try{observed=await this.ui.inspect();}catch{return{phase:'unavailable',observedAt,error:'STUDIO_LOGIN_UNAVAILABLE'};}
    if(observed?.phase==='qr'){
      const image=qrImage(observed.image);
      const approvalUrl=approvalLink(observed.approvalUrl);
      return image?{phase:'qr',image,...(approvalUrl?{approvalUrl}:{}),observedAt}:{phase:'unavailable',observedAt,error:'INVALID_NATIVE_QR'};
    }
    if(['scanned','expired','loading'].includes(observed?.phase))return{phase:observed.phase,observedAt};
    const state=this.getState(),self=state.self;
    if(observed?.phase==='not_open'&&state.connected&&self?.handle){
      return{phase:'connected',account:{handle:String(self.handle).slice(0,100),name:String(self.name||'').slice(0,120)},persistence:'studio-profile',observedAt};
    }
    return{phase:'unavailable',observedAt,error:observed?.phase==='not_open'?'OPEN_STUDIO_LOGIN':'STUDIO_LOGIN_UNAVAILABLE'};
  }
  async refresh(){
    if(this.getState().live)throw Error('LIVE_ACCOUNT_CHANGE_BLOCKED');
    if(!this.refreshing)this.refreshing=(async()=>{
      const state=await this.state();
      if(state.phase!=='expired')throw Error('QR_REFRESH_NOT_AVAILABLE');
      if(this.getState().live)throw Error('LIVE_ACCOUNT_CHANGE_BLOCKED');
      await this.ui.refresh();return{requested:true,phase:'loading'};
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
}
