// Single-client gateway to the box's existing native Studio controller.
// Controller cookies stay server-side. The phone gets only paired, allowlisted operations.
const apiRoutes = new Set([
  'GET /state', 'GET /battles', 'GET /phone', 'POST /refresh',
  'GET /account', 'POST /account/refresh',
  'POST /invites/prepare', 'POST /invites/send', 'POST /battles/action',
  'POST /phone/import', 'DELETE /phone',
]);
const assets = new Map([
  ['/mobile/studio', ['/', 'text/html; charset=utf-8']],
  ['/mobile/studio/', ['/', 'text/html; charset=utf-8']],
  ['/mobile/studio/app.js', ['/app.js', 'text/javascript; charset=utf-8']],
  ['/mobile/studio/style.css', ['/style.css', 'text/css; charset=utf-8']],
]);
const unavailable = () => Object.assign(Error('STUDIO_CONTROL_UNAVAILABLE'), {status:503});
export class MobileStudio {
  #cookie = ''; #opening = null;
  constructor({port=47831, fetcher=fetch}={}) {
    if (!Number.isInteger(port) || port<1 || port>65535) throw Error('INVALID_STUDIO_PORT');
    this.origin = 'http://127.0.0.1:' + port; this.fetcher = fetcher;
  }
  async #open() {
    if (this.#cookie) return;
    if (!this.#opening) this.#opening = (async () => {
      const response = await this.fetcher(this.origin+'/', {redirect:'error',signal:AbortSignal.timeout(5000)});
      const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
      await response.body?.cancel();
      if (!response.ok || !/^boostera_session=[a-f0-9]{64}$/.test(cookie)) throw unavailable();
      this.#cookie = cookie;
    })().finally(()=>{this.#opening=null;});
    await this.#opening;
  }
  async #request(route, method='GET', body) {
    await this.#open();
    const send = () => this.fetcher(this.origin+route, {method, redirect:'error',
      headers:{cookie:this.#cookie,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body}:{}), signal:AbortSignal.timeout(20000)});
    let response = await send();
    // A controller restart invalidates its cookie. A 401 occurs before any action.
    if (response.status===401) {
      await response.body?.cancel(); this.#cookie=''; await this.#open(); response=await send();
    }
    const parts=[]; let length=0;
    for await (const part of response.body) {
      length+=part.length; if(length>1024*1024) throw unavailable(); parts.push(part);
    }
    return {status:response.status, body:Buffer.concat(parts).toString('utf8')};
  }
  async handle(req,res,url,session,readJson) {
    const prefix='/api/mobile/studio', asset=assets.get(url.pathname);
    if(!asset && !url.pathname.startsWith(prefix)) return false;
    const reply=(status,body,type='application/json; charset=utf-8')=>{
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});
      res.end(body); return true;
    };
    if(!session) return reply(401,JSON.stringify({error:'PAIRING_REQUIRED'}));
    if(url.search) return reply(404,JSON.stringify({error:'NOT_SUPPORTED'}));
    const route=url.pathname.slice(prefix.length);
    if(asset && req.method!=='GET' || !asset && !apiRoutes.has(req.method+' '+route))
      return reply(404,JSON.stringify({error:'NOT_SUPPORTED'}));
    try {
      let body;
      if(!asset && req.method==='POST') body=JSON.stringify(await readJson(req));
      const result=await this.#request(asset?asset[0]:'/api'+route,req.method,body);
      if(asset && result.status===200 && asset[0]==='/') result.body=result.body
        .replace('href="/style.css"','href="/mobile/studio/style.css"')
        .replace('src="/app.js"','src="/mobile/studio/app.js"')
        .replace('href="/"','href="/mobile/box"');
      return reply(result.status,result.body,asset?asset[1]:undefined);
    } catch(error) {
      return reply(error.status||503,JSON.stringify({error:error.status?error.message:'STUDIO_CONTROL_UNAVAILABLE'}));
    }
  }
}
