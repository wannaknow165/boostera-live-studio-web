import fs from 'node:fs';
import path from 'node:path';
export function configureMediaTools(root, env=process.env){
  const pick=(name,pkg)=>{const choices=[env[name.toUpperCase()],...(name==='ffmpeg'?[path.join(root,'node_modules','ffmpeg-static','ffmpeg.exe')]:[]),path.join(root,'node_modules',pkg,name+'.exe'),path.join(root,'tools',name+'.exe')];return choices.find(p=>p&&fs.existsSync(p))||name;};
  const ffmpeg=pick('ffmpeg','@ffmpeg-installer/win32-x64'),ffprobe=pick('ffprobe','@ffprobe-installer/win32-x64');
  env.FFMPEG=ffmpeg;env.FFPROBE=ffprobe;
  const dirs=[ffmpeg,ffprobe].filter(p=>path.isAbsolute(p)).map(p=>path.dirname(p));
  env.PATH=[...new Set([...dirs,...(env.PATH||env.Path||'').split(path.delimiter)])].join(path.delimiter);
  return{ffmpeg,ffprobe,installed:fs.existsSync(ffmpeg)&&fs.existsSync(ffprobe)};
}
