import {hash,uid} from './transfer.js';
export function b64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
export async function encode(value){const raw=new TextEncoder().encode(JSON.stringify(value));if(typeof CompressionStream!=='undefined'){const stream=new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));return 'IW2.Z.'+b64(new Uint8Array(await new Response(stream).arrayBuffer()))}return 'IW2.J.'+b64(raw)}
export async function decode(input){
 let s=input.trim();if(s.startsWith('http'))s=new URLSearchParams(new URL(s).hash.slice(1)).get('code')||'';
 if(s.length>20000||!/^IW2\.[JZ]\.[A-Za-z0-9_-]+$/.test(s))throw new Error('El código no es válido. Copia el código completo.');
 let bytes=Uint8Array.from(atob(s.slice(6).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 if(s[4]==='Z'){
  if(typeof DecompressionStream==='undefined')throw new Error('Este navegador no puede leer el código comprimido. Actualiza el navegador.');
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();let parts=[],n=0;
  for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>32000){await reader.cancel();throw new Error('Código demasiado grande.')}parts.push(r.value)}bytes=new Uint8Array(n);let off=0;for(const p of parts){bytes.set(p,off);off+=p.length}
 }
 const v=JSON.parse(new TextDecoder().decode(bytes));if(!v||!['offer','answer'].includes(v.type)||typeof v.sdp!=='string'||v.sdp.length>24000||!/^v=0/m.test(v.sdp)||!/^a=fingerprint:sha-256 /m.test(v.sdp)||!Number.isFinite(v.exp)||v.exp<Date.now()||v.exp>Date.now()+660000||!/^[a-f0-9]{32}$/.test(v.session))throw new Error('Código caducado o incorrecto. Crea una nueva invitación.');return v;
}
export class Connection extends EventTarget{
 constructor(){super();this.pc=null;this.session=null;this.offer=null;this.answer=null;this.timeout=null}
 emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}))}
 make(){this.close();const pc=new RTCPeerConnection({iceServers:[],iceTransportPolicy:'all'});this.pc=pc;pc.onconnectionstatechange=()=>{this.emit('state',pc.connectionState);if(pc.connectionState==='connected')clearTimeout(this.timeout)};pc.ondatachannel=e=>this.channel(e.channel);return pc}
 channel(c){c.onopen=()=>{clearTimeout(this.timeout);this.emit('channel',c)};if(c.readyState==='open')this.emit('channel',c)}
 async gathered(){if(this.pc.iceGatheringState==='complete')return;const pc=this.pc;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',change);reject(new Error('No se pudo reunir la información de la red local.'))},15000);function change(){if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',change);resolve()}}pc.addEventListener('icegatheringstatechange',change)})}
 async create(){const pc=this.make();this.session=uid();this.channel(pc.createDataChannel('archivos',{ordered:true}));await pc.setLocalDescription(await pc.createOffer());await this.gathered();this.offer={type:'offer',sdp:pc.localDescription.sdp,session:this.session,exp:Date.now()+600000};return this.offer}
 async accept(value){
  if(value.type==='offer'){
   const pc=this.make();this.session=value.session;this.offer=value;await pc.setRemoteDescription({type:'offer',sdp:value.sdp});await pc.setLocalDescription(await pc.createAnswer());await this.gathered();this.answer={type:'answer',sdp:pc.localDescription.sdp,session:value.session,exp:value.exp};this.startTimeout();return this.answer;
  }
  if(!this.pc||!this.offer||value.session!==this.session||this.pc.signalingState!=='have-local-offer')throw new Error('Esta respuesta no pertenece a la invitación abierta. Mantén abierta la página que creó la invitación.');
  this.answer=value;await this.pc.setRemoteDescription({type:'answer',sdp:value.sdp});this.startTimeout();return null;
 }
 startTimeout(){clearTimeout(this.timeout);this.timeout=setTimeout(()=>{if(this.pc?.connectionState!=='connected')this.emit('error','No se ha podido conectar. Comprueba la misma red wifi, el firewall y que no sea una red de invitados.')},30000)}
 async verification(){const fp=s=>s.match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]?.trim();if(!this.offer||!this.answer)return '';const h=await hash(new TextEncoder().encode(this.session+'|'+fp(this.offer.sdp)+'|'+fp(this.answer.sdp)));return h.slice(0,12).toUpperCase().match(/.{4}/g).join(' ')}
 close(){clearTimeout(this.timeout);if(this.pc){this.pc.onconnectionstatechange=null;this.pc.close()}this.pc=null;this.offer=null;this.answer=null;this.emit('state','closed')}
}
