import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateRemix,resumeVideo} from '../lib/mobile-generation.mjs';
test('avatar generation uses real API schema and chooses supported parameters',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-generation-')),image=path.join(root,'avatar.png');fs.writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10]));
 const requests=[],ticks=[],tasks=[];
 const fetcher=async(url,options)=>{requests.push({url,options});if(url.endsWith('/models'))return Response.json({data:[{id:'model-test',name:'Test',supported_frame_images:['first_frame'],supported_aspect_ratios:['9:16'],supported_resolutions:['720p'],supported_durations:[5,10]}]});if(url.endsWith('/videos'))return Response.json({id:'job-test'},{status:202});if(url.includes('/content'))return new Response(Buffer.from('mock-video'));return Response.json({status:'completed',usage:{cost:.25}});};
 try{
 const result=await generateRemix({env:{OPENROUTER_API_KEY:'test-private'},effect:{duration:14,remix:{prompt:'Turn the person into a knight.'}},imagePath:image,model:'model-test',resolution:'1080p',transparent:true,fetcher,pause:async()=>{},onTask:id=>tasks.push(id),onTick:s=>ticks.push(s)});
 const posted=JSON.parse(requests.find(r=>r.url.endsWith('/videos')).options.body);assert.equal(posted.model,'model-test');assert.equal(posted.duration,10);assert.equal(posted.resolution,'720p');assert.match(posted.frame_images[0].image_url.url,/^data:image\/png;base64,/);assert.equal(posted.frame_images[0].frame_type,'first_frame');assert.match(posted.prompt,/chroma green/);assert.deepEqual(tasks,['job-test']);assert.deepEqual(ticks,['completed']);assert.equal(result.costUsd,.25);assert.equal(await result.response.text(),'mock-video');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('resuming accepted generation only polls and downloads; it never submits a new paid task',async()=>{
 const methods=[];const fetcher=async(url,options)=>{methods.push(options.method||'GET');return url.includes('/content')?new Response('video'):Response.json({status:'completed'});};
 const result=await resumeVideo({env:{OPENROUTER_API_KEY:'test-only'},taskId:'existing-job',fetcher,pause:async()=>{}});assert.deepEqual(methods,['GET','GET']);assert.equal(await result.response.text(),'video');
});
