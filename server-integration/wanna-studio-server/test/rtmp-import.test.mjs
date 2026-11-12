import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readCapturedTarget} from '../lib/mobile-rtmp-import.mjs';
test('existing extractor output imports only a recent valid RTMP target',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wanna-import-')),file=path.join(root,'capture.json');
 try{
  assert.throws(()=>readCapturedTarget(file),/MISSING/);
  fs.writeFileSync(file,JSON.stringify({obs:[{server:'rtmps://example.com/live',stream_key:'fixture-only'}]}));assert.equal(readCapturedTarget(file).host,'example.com');
  assert.throws(()=>readCapturedTarget(file,Date.now()+16*60000),/EXPIRED/);
  fs.writeFileSync(file,JSON.stringify({all:[{server:'https://example.com/',stream_key:'fixture-only'}]}));assert.throws(()=>readCapturedTarget(file),/INVALID/);
  fs.writeFileSync(file,JSON.stringify({all:[{server:'rtmp://127.0.0.1/live',stream_key:'fixture-only'}]}));assert.equal(readCapturedTarget(file).key,'fixture-only');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
