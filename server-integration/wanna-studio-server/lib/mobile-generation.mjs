import fs from 'node:fs';
let cached=null,cachedAt=0,cachedFor=null;
async function request(env,route,options={},fetcher=fetch){
 const response=await fetcher('https://openrouter.ai/api/v1'+route,{...options,headers:{Authorization:'Bearer '+env.OPENROUTER_API_KEY,...options.headers},signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Object.assign(Error(response.status===402?'VIDEO_PROVIDER_BALANCE_REQUIRED':'VIDEO_PROVIDER_'+response.status),{status:502});return response;
}
export async function videoModels(env,fetcher=fetch){
 if(!env.OPENROUTER_API_KEY)return[];
 if(cachedFor===fetcher&&cached&&Date.now()-cachedAt<3600000)return cached;
 const data=await(await request(env,'/videos/models',{},fetcher)).json();cached=(data.data||[]).map(m=>({id:m.id,name:m.name,resolutions:m.supported_resolutions||[],durations:m.supported_durations||[],aspects:m.supported_aspect_ratios||[],frames:m.supported_frame_images||[]}));cachedAt=Date.now();cachedFor=fetcher;return cached;
}
export async function generateRemix({env,effect,imagePath,model,resolution='720p',transparent=false,onTask=()=>{},onTick=()=>{},fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 const available=await videoModels(env,fetcher),selected=available.find(m=>m.id===model);if(!selected)throw Object.assign(Error('VIDEO_MODEL_NOT_AVAILABLE'),{status:400});
 if(!selected.frames.includes('first_frame'))throw Object.assign(Error('MODEL_REQUIRES_IMAGE_SUPPORT'),{status:400});
 const phases=effect.remix?.phases||effect.phases||[];
 let prompt=effect.remix?.prompt||'The person in the reference image transforms with cinematic magic in one continuous shot. '+phases.map(p=>'At '+p.t+' seconds: '+p.what).join(' ')+'. Preserve the identity of the person from the reference photo. Smooth motion, vertical composition.';
 if(transparent)prompt+=' Keep the person and the entire effect in front of a perfectly uniform chroma green #00FF00 background. No scenery, shadows or gradients on the background. Keep all clothing, particles and foreground details visible.';
 const requested=Math.round(Number(effect.remix?.seconds||effect.duration)||10),durations=selected.durations.map(Number).filter(n=>Number.isFinite(n)&&n>0);
 const duration=durations.includes(requested)?requested:durations.sort((a,b)=>Math.abs(a-requested)-Math.abs(b-requested))[0]||requested;
 const mime=imagePath.endsWith('.png')?'image/png':imagePath.endsWith('.webp')?'image/webp':'image/jpeg';
 const payload={model,prompt,duration,aspect_ratio:selected.aspects.includes('9:16')?'9:16':selected.aspects[0]||'9:16',resolution:selected.resolutions.includes(resolution)?resolution:selected.resolutions[0]||resolution,generate_audio:false,frame_images:[{type:'image_url',image_url:{url:'data:'+mime+';base64,'+fs.readFileSync(imagePath).toString('base64')},frame_type:'first_frame'}]};
 const submitted=await(await request(env,'/videos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},fetcher)).json();if(!submitted.id)throw Object.assign(Error('VIDEO_SUBMIT_FAILED'),{status:502});onTask(submitted.id);
 return resumeVideo({env,taskId:submitted.id,onTick,fetcher,pause});
}
export async function resumeVideo({env,taskId,onTick=()=>{},fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 for(let i=0;i<120;i++){await pause(15000);const status=await(await request(env,'/videos/'+encodeURIComponent(taskId),{},fetcher)).json();onTick(status.status);
   if(status.status==='completed')return{response:await request(env,'/videos/'+encodeURIComponent(taskId)+'/content?index=0',{},fetcher),costUsd:Number(status.usage?.cost)||0};
   if(['failed','cancelled','expired'].includes(status.status))throw Object.assign(Error('VIDEO_PROVIDER_'+status.status.toUpperCase()),{status:502});
 }
 throw Object.assign(Error('VIDEO_GENERATION_TIMEOUT'),{status:504});
}
