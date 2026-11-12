export function createAudioMixer(){
 let context=null,destination=null,effects=null,micSource=null;const routed=new WeakSet(),attached=new WeakSet();
 function start(stream){try{if(!context){context=new (window.AudioContext||window.webkitAudioContext)();destination=context.createMediaStreamDestination();effects=context.createGain();effects.connect(destination);effects.connect(context.destination);}void context.resume();micSource?.disconnect();micSource=stream?.getAudioTracks().length?context.createMediaStreamSource(stream):null;micSource?.connect(destination);}catch{}}
 function route(element){if(!context||!element||routed.has(element))return;try{const source=context.createMediaElementSource(element);source.connect(effects);routed.add(element);}catch{}}
 function attach(engine){if(!context||!engine||attached.has(engine))return;const proxy=new Proxy(context,{get(target,key){if(key==='destination')return effects;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});engine.ac=proxy;
   if(engine.battle){engine.battle.ac=proxy;const original=engine.battle._sound?.bind(engine.battle);if(original)engine.battle._sound=s=>{if(s.file){const audio=new Audio(s.file);audio.volume=s.volume??1;route(audio);audio.play().catch(()=>{});}else original(s);};}
   engine.wakeVoice=()=>{const audio=new Audio('/media/fx/assets/wake-up.mp3');route(audio);audio.play().catch(()=>{});};attached.add(engine);
 }
 function update(engine,overlay){attach(engine);route(overlay);route(engine?.gnomeA?.c?.v);for(const item of engine?.battle?.live||[])route(item.v);if(engine?.active?.remix)route(engine.active.remix);}
 return{start,attach,update,stopMic(){micSource?.disconnect();micSource=null;},get active(){return Boolean(destination);},track(){return destination?.stream.getAudioTracks()[0]?.clone()||null;},toggleEffects(){if(!effects)return false;effects.gain.value=effects.gain.value?0:1;return Boolean(effects.gain.value);}};
}
