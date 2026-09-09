export const BLOCK=65536, FRAME=16384, MEMORY_LIMIT=64*1024*1024;
export const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export const hash=async b=>hex(await crypto.subtle.digest('SHA-256',b));
export const uid=()=>hex(crypto.getRandomValues(new Uint8Array(16)));
export function cleanName(v){return String(v||'archivo').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/,'').slice(0,180)||'archivo'}
export class Files extends EventTarget{
 constructor(channel,identity){super();this.c=channel;this.identity=identity;this.peer=null;this.localTrust=false;this.remoteTrust=false;this.items=new Map();this.waiters=new Map();this.incoming=null;this.frame=null;this.queue=[];this.running=false;this.chain=Promise.resolve();channel.binaryType='arraybuffer';channel.onmessage=e=>{this.chain=this.chain.then(()=>this.message(e.data)).catch(e=>this.error(e))};channel.onclose=()=>this.closed();channel.onerror=()=>this.closed();this.send({type:'hello',identity});}
 event(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}))}
 update(){this.event('update',null)}
 send(m){if(this.c.readyState!=='open')throw new Error('La conexión está cerrada.');this.c.send(JSON.stringify(m))}
 ready(){return this.c.readyState==='open'&&this.localTrust&&this.remoteTrust}
 trust(){this.localTrust=true;this.send({type:'trust'});this.update()}
 wait(type,id,ms=60000){const key=type+':'+id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(key);reject(new Error('Tiempo de espera agotado.'))},ms);this.waiters.set(key,{resolve:v=>{clearTimeout(timer);this.waiters.delete(key);resolve(v)},reject:e=>{clearTimeout(timer);this.waiters.delete(key);reject(e)}})})}
 settle(type,id,data){this.waiters.get(type+':'+id)?.resolve(data)}
 rejectWaits(id,e){for(const [key,w] of [...this.waiters])if(key.endsWith(':'+id))w.reject(e)}
 error(e){this.event('error',e.message||String(e));this.c.close();this.closed()}
 closed(){for(const w of [...this.waiters.values()])w.reject(new Error('Conexión interrumpida.'));for(const t of this.items.values())if(['Pendiente','Enviando','Recibiendo'].includes(t.state)){t.state='Interrumpido';t.writer?.abort().catch(()=>{});this.removeTemp(t)}this.frame=null;this.queue=[];this.update()}
 async message(data){
  if(typeof data!=='string')return this.binary(data);
  if(data.length>32768)throw new Error('Mensaje demasiado grande.');const m=JSON.parse(data);if(!m||typeof m.type!=='string')throw new Error('Mensaje no válido.');
  if(m.type==='hello'){if(this.peer)throw new Error('Identidad duplicada.');this.peer={id:String(m.identity?.id||'').slice(0,64),name:String(m.identity?.name||'Dispositivo').slice(0,60)};this.update();return}
  if(m.type==='trust'){this.remoteTrust=true;this.update();return}
  if(!this.ready())throw new Error('La conexión necesita aceptación en ambos dispositivos.');
  const t=this.items.get(m.id);
  if(m.type==='offer'){
   if(!/^[a-f0-9]{32}$/.test(m.id)||this.items.has(m.id)||!Number.isSafeInteger(m.size)||m.size<0||typeof m.name!=='string')throw new Error('Solicitud de archivo incorrecta.');
   if(this.incoming){this.send({type:'reject',id:m.id,reason:'Ya hay un archivo entrante.'});return}
   const item={id:m.id,name:cleanName(m.name),size:m.size,offset:0,direction:'in',state:'Pendiente',parts:[],created:Date.now()};this.items.set(m.id,item);this.incoming=m.id;this.update();return;
  }
  if(!t)throw new Error('Archivo desconocido.');
  if(m.type==='accept'){if(t.direction!=='out'||t.state!=='Pendiente')throw new Error('Aceptación fuera de orden.');this.settle('accept',m.id,m);return}
  if(m.type==='reject'||m.type==='cancel'){
   if(!['Guardado','Recibido','Descargar'].includes(t.state)){t.state=m.type==='reject'?'Rechazado':'Cancelado';this.rejectWaits(t.id,new Error(m.reason||t.state));await t.writer?.abort().catch(()=>{});await this.removeTemp(t);t.parts=[];if(this.incoming===t.id)this.incoming=null;}
   this.update();return;
  }
  if(m.type==='ack'){
   if(t.direction!=='out'||!Number.isSafeInteger(m.offset)||m.offset!==t.expected)throw new Error('Confirmación de bloque incorrecta.');this.settle('ack',m.id,m);return;
  }
  if(m.type==='chunk'){
   if(this.frame||t.direction!=='in'||!['Recibiendo','Cancelado','Rechazado','Interrumpido'].includes(t.state)||(t.state==='Recibiendo'&&m.offset!==t.offset)||!Number.isSafeInteger(m.offset)||m.offset<0||!Number.isInteger(m.length)||m.length<1||m.length>BLOCK||m.offset+m.length>t.size||!/^[a-f0-9]{64}$/.test(m.hash))throw new Error('Bloque fuera de orden o inválido.');
   this.frame={id:m.id,length:m.length,hash:m.hash,data:new Uint8Array(m.length),filled:0};return;
  }
  if(m.type==='end'){
   if(['Cancelado','Rechazado','Interrumpido'].includes(t.state))return;
   if(this.frame||t.direction!=='in'||t.state!=='Recibiendo'||t.offset!==t.size)throw new Error('Archivo incompleto.');
   if(t.writer){await t.writer.close();t.writer=null}
   if(t.direct)t.state='Guardado';else{const file=t.handle?await t.handle.getFile():new Blob(t.parts,{type:'application/octet-stream'});if(file.size!==t.size)throw new Error('Tamaño recibido incorrecto.');t.blob=file;t.parts=[];t.url=URL.createObjectURL(file);t.state='Descargar'}
   this.incoming=null;this.send({type:'done',id:t.id,saved:t.direct===true});this.update();return;
  }
  if(m.type==='done'){if(t.direction!=='out'||t.offset!==t.size)throw new Error('Fin inesperado.');this.settle('done',t.id,m);return}
  if(m.type==='saved'){if(t.direction==='out'){t.state='Guardado';this.update()}return}
  throw new Error('Operación desconocida.');
 }
 async binary(data){
  const f=this.frame,t=f&&this.items.get(f.id);if(!f||!t||!(data instanceof ArrayBuffer)||data.byteLength<1||data.byteLength>FRAME||f.filled+data.byteLength>f.length)throw new Error('Bloque de datos inesperado.');
  f.data.set(new Uint8Array(data),f.filled);f.filled+=data.byteLength;if(f.filled<f.length)return;
  this.frame=null;
  if(t.state!=='Recibiendo')return;
  if(await hash(f.data)!==f.hash)throw new Error('La comprobación SHA-256 del bloque ha fallado.');
  if(t.state!=='Recibiendo')return;
  if(t.writer)await t.writer.write(f.data);else t.parts.push(f.data);
  t.offset+=f.length;this.send({type:'ack',id:t.id,offset:t.offset});this.update();
 }
 async accept(id,direct=true){
  const t=this.items.get(id);if(!t||t.state!=='Pendiente'||t.direction!=='in'||t.preparing)return;t.preparing=true;
  try{
   if(direct&&typeof window.showSaveFilePicker==='function'){
    const h=await window.showSaveFilePicker({suggestedName:t.name});t.writer=await h.createWritable();t.direct=true;
   }else{
    let temporary=false;
    if(navigator.storage?.getDirectory){try{
     const estimate=await navigator.storage.estimate();if(estimate.quota&&estimate.quota-(estimate.usage||0)<t.size+1048576)throw new Error('No hay suficiente espacio temporal en el navegador.');
     const root=await navigator.storage.getDirectory();t.tempRoot=await root.getDirectoryHandle('intercambio-wifi',{create:true});t.tempName=t.id;t.handle=await t.tempRoot.getFileHandle(t.tempName,{create:true});t.writer=await t.handle.createWritable();temporary=true;
    }catch(e){await this.removeTemp(t);t.handle=null;if(t.size>MEMORY_LIMIT)throw new Error('No se pudo preparar almacenamiento temporal: '+e.message)}}
    if(!temporary){const used=[...this.items.values()].reduce((n,x)=>n+(!x.handle&&x.blob?x.size:0),0);if(t.size+used>MEMORY_LIMIT)throw new Error('Este navegador solo permite 64 MiB en memoria. Guarda y libera los recibidos o utiliza un navegador con almacenamiento temporal.');}
   }
   if(t.state!=='Pendiente'||!this.ready()){await t.writer?.abort();await this.removeTemp(t);throw new Error('La solicitud ya no está disponible.');}
   t.state='Recibiendo';this.send({type:'accept',id});this.update();
  }catch(e){if(e.name!=='AbortError')this.event('error',e.message)}finally{t.preparing=false}
 }
 async removeTemp(t){if(t.tempRoot&&t.tempName)await t.tempRoot.removeEntry(t.tempName).catch(()=>{})}
 async cancel(id,reject=false){const t=this.items.get(id);if(!t||['Guardado','Descargar','Recibido','Cancelado','Rechazado','Interrumpido'].includes(t.state))return;this.send({type:reject?'reject':'cancel',id});t.state=reject?'Rechazado':'Cancelado';this.rejectWaits(id,new Error(t.state));await this.chain;await t.writer?.abort().catch(()=>{});t.writer=null;await this.removeTemp(t);t.parts=[];if(this.incoming===id)this.incoming=null;this.update()}
 async saved(id){const t=this.items.get(id);if(t?.state!=='Descargar')return;t.state='Guardado';if(this.ready())this.send({type:'saved',id});URL.revokeObjectURL(t.url);t.url=null;t.blob=null;await this.removeTemp(t);this.update()}
 enqueue(files){if(!this.ready())throw new Error('Acepta la conexión en ambos dispositivos.');if(files.length+this.queue.length>100)throw new Error('Máximo 100 archivos en cola.');this.queue.push(...files);this.run()}
 async run(){if(this.running)return;this.running=true;try{while(this.queue.length&&this.ready()){
  const file=this.queue.shift(),t={id:uid(),name:cleanName(file.name),size:file.size,offset:0,direction:'out',state:'Pendiente',created:Date.now()};this.items.set(t.id,t);this.update();
  try{
   let w=this.wait('accept',t.id,600000);this.send({type:'offer',id:t.id,name:t.name,size:t.size});await w;t.state='Enviando';this.update();
   for(let off=0;off<t.size;off+=BLOCK){
    if(t.state!=='Enviando')throw new Error('Envío cancelado.');const start=performance.now(),part=await file.slice(off,off+BLOCK).arrayBuffer(),h=await hash(part);
    if(t.state!=='Enviando')throw new Error('Envío cancelado.');t.expected=off+part.byteLength;w=this.wait('ack',t.id);this.send({type:'chunk',id:t.id,offset:off,length:part.byteLength,hash:h});
    for(let i=0;i<part.byteLength;i+=FRAME)this.c.send(part.slice(i,i+FRAME));await w;t.offset=t.expected;t.speed=part.byteLength/Math.max(.001,(performance.now()-start)/1000);this.update();
   }
   w=this.wait('done',t.id);this.send({type:'end',id:t.id});const r=await w;t.state=r.saved?'Guardado':'Recibido';this.update();
  }catch(e){if(!['Cancelado','Rechazado'].includes(t.state)){t.state='Interrumpido';if(this.ready())this.send({type:'cancel',id:t.id});this.event('error',t.name+': '+e.message)}this.update()}
 }}finally{this.running=false;this.update()}}
}
