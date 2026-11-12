import net from 'node:net';
export class RpcClient {
  constructor(port, {host='127.0.0.1',timeout=3000}={}) {
    Object.assign(this,{port,host,timeout}); this.nextId=0; this.pending=new Map(); this.buffer='';
  }
  connect() {
    if(this.socket && !this.socket.destroyed && !this.socket.connecting) return Promise.resolve();
    if(this.connecting) return this.connecting;
    this.connecting=new Promise((resolve,reject)=>{
      const socket=net.createConnection({host:this.host,port:this.port}); this.socket=socket; socket.setEncoding('utf8');
      const timer=setTimeout(()=>socket.destroy(new Error('BRIDGE_TIMEOUT')),this.timeout);
      socket.once('connect',()=>{clearTimeout(timer);resolve();});
      socket.on('data',chunk=>this.receive(chunk));
      socket.on('error',error=>{clearTimeout(timer);reject(error);this.fail(error);});
      socket.on('close',()=>{clearTimeout(timer);if(this.socket===socket)this.fail(new Error('BRIDGE_CLOSED'));});
    }).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  receive(chunk) {
    this.buffer+=chunk.toString('utf8');
    if(Buffer.byteLength(this.buffer)>16*1024*1024){this.socket.destroy(new Error('RESPONSE_TOO_LARGE'));return;}
    let n;
    while((n=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);
      let response;try{response=JSON.parse(line);}catch{continue;}
      const p=this.pending.get(response.id);if(!p)continue;
      clearTimeout(p.timer);this.pending.delete(response.id);
      if(response.error)p.reject(new Error(response.error.message||'BRIDGE_ERROR'));else p.resolve(response.result);
    }
  }
  async call(method,params={}) {
    await this.connect(); const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('BRIDGE_TIMEOUT'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async state(serviceName,propertyPath) {
    const r=await this.call('get_service_state',{serviceName,propertyPath});
    return r?.state?.[propertyPath];
  }
  fail(error){this.buffer='';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  close(){this.socket?.destroy();this.fail(new Error('CLIENT_CLOSED'));}
}
