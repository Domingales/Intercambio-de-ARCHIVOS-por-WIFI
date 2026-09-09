import {Files,uid} from './transfer.js';
import {Connection,encode,decode} from './connection.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const get=k=>{try{return localStorage.getItem('iw2.'+k)}catch{return null}},put=(k,v)=>{try{localStorage.setItem('iw2.'+k,v)}catch{}};
const identity={id:get('id')||uid().slice(0,12),name:get('name')||(/Android|iPhone|iPad/i.test(navigator.userAgent)?'Mi móvil':'Mi ordenador')};put('id',identity.id);
let conn=null,files=null,selected=[],renderTimer,toastTimer,audioCtx,signalTimer,deadlineTimer,generation=0,ticket=null,busy=false;
let service=get('service')??window.INTERCAMBIO_CONFIG?.signalUrl??'';
let status='Preparado para conectar.';
const supported=window.isSecureContext&&window.RTCPeerConnection&&window.crypto?.subtle;
function toast(s){$('toast').textContent=s;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,11000)}
function view(name){document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!=='view-'+name);document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name))}
function fmt(n){if(n<1024)return n+' B';const i=Math.min(3,Math.floor(Math.log(n)/Math.log(1024)));return (n/1024**i).toFixed(1)+' '+['B','KiB','MiB','GiB'][i]}
function beep(){if(!$('sound').checked||!audioCtx)return;const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);g.gain.value=.04;o.frequency.value=650;o.start();o.stop(audioCtx.currentTime+.15)}
function setStatus(s){status=s;$('pairStatus').textContent=s;render()}
function render(){
 const ready=files?.ready()&&files.peer;
 $('connection').textContent=ready?'Conectados':busy?'Conectando…':'Sin conectar';$('pairStatus').textContent=ready?'Conexión establecida. Ya puedes enviar archivos.':status;
 $('connected').hidden=!ready;if(ready)$('peerName').textContent='Conectado con '+files.peer.name;
 $('destination').textContent=ready?'Enviar a '+files.peer.name:'Conecta un dispositivo mediante el PIN.';$('send').disabled=!ready;
 $('connect').disabled=!supported||busy||!!ready;$('pin').disabled=busy||!!ready;$('deviceName').disabled=busy||!!ready;
 $('disconnect').hidden=!busy&&!conn;$('disconnect').textContent=ready?'Desconectar':'Cancelar conexión';
 $('setupNotice').hidden=!!service;
 const items=files?[...files.items.values()].reverse():[];
 $('transfers').innerHTML=items.map(t=>{const pct=t.size?Math.floor(t.offset/t.size*100):['Guardado','Descargar','Recibido'].includes(t.state)?100:0;
 let actions='';const btn=(a,label,cls='')=>`<button data-action="${a}" data-id="${t.id}" class="${cls}">${label}</button>`;
 if(t.direction==='in'&&t.state==='Pendiente')actions+=btn('accept','Aceptar archivo','primary')+btn('reject','Rechazar');
 if(['Pendiente','Enviando','Recibiendo'].includes(t.state))actions+=btn('cancel','Cancelar','danger');
 if(t.state==='Descargar')actions+=btn('download','Guardar en Descargas','primary')+btn('saved','Ya está guardado');
 const label=t.state==='Descargar'?'Recibido y verificado · falta guardarlo':t.state==='Recibido'?'Recibido por el otro navegador · falta guardar':t.state;
 return `<article class="card transfer"><strong class="filename">${esc(t.name)}</strong><small>${t.direction==='out'?'Envío':'Recepción'} · ${fmt(t.size)}</small><progress max="100" value="${pct}" aria-label="Progreso ${esc(t.name)}"></progress><div class="meta"><span>${esc(label)}</span><span>${pct}%${t.speed&&t.state==='Enviando'?' · '+fmt(t.speed)+'/s · ~'+Math.ceil((t.size-t.offset)/t.speed)+' s':''}</span></div><div class="actions">${actions}</div></article>`}).join('')||'<article class="card empty">Todavía no hay transferencias en esta conexión.</article>';
}
function scheduleRender(){if(renderTimer)return;renderTimer=setTimeout(()=>{renderTimer=null;render()},120)}
function hasPending(){return files&&[...files.items.values()].some(t=>['Pendiente','Enviando','Recibiendo','Descargar'].includes(t.state))}
async function signal(method,path,body,key,endpoint=service){
 if(!endpoint)throw new Error('Falta configurar la ayuda de conexión en Ajustes. Consulta ACTUALIZAR_PIN.txt.');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(endpoint.replace(/\/$/,'')+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{Authorization:'Bearer '+key}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal});
  let d;try{d=await r.json()}catch{throw new Error('La ayuda de conexión no responde correctamente. Comprueba su dirección y actualiza el Worker.')}
  if(!r.ok){const e=new Error(d.error||'No se pudo coordinar la conexión.');e.status=r.status;throw e}return d;
 }catch(e){if(e.name==='AbortError')throw new Error('La ayuda de conexión no responde. Comprueba Internet y su configuración.');throw e}finally{clearTimeout(timer)}
}
async function disconnect(ask=true){
 if(ask&&hasPending()&&!confirm('Hay archivos pendientes o sin guardar. ¿Cerrar esta conexión?'))return false;
 generation++;clearTimeout(signalTimer);clearInterval(deadlineTimer);const previous=ticket;ticket=null;busy=false;
 if(previous)signal('DELETE','/pin/'+previous.id,null,previous.key,previous.endpoint).catch(()=>{});
 conn?.close();conn=null;
 if(files){const previousFiles=files;files=null;previousFiles.c.close();for(const t of previousFiles.items.values()){if(t.url)URL.revokeObjectURL(t.url);await previousFiles.removeTemp(t)}}
 $('countdown').textContent='';setStatus('Preparado para conectar.');return true;
}
function fail(message,gen){if(gen!==generation)return;generation++;clearTimeout(signalTimer);clearInterval(deadlineTimer);busy=false;$('countdown').textContent='';conn?.close();setStatus(message);toast(message)}
function attach(connection,gen){
 connection.addEventListener('channel',e=>{
  if(gen!==generation||!ticket){e.detail.close();return}
  clearTimeout(signalTimer);clearInterval(deadlineTimer);$('countdown').textContent='';busy=false;
  const engine=new Files(e.detail,{...identity});files=engine;const observed=new Map();
  engine.addEventListener('update',()=>{if(files!==engine)return;if(engine.c.readyState==='closed'){fail('La conexión se ha cerrado. Comprueba la red y vuelve a conectar con un nuevo PIN.',gen);return}for(const t of engine.items.values()){if((!observed.has(t.id)&&t.direction==='in'&&t.state==='Pendiente')||(observed.has(t.id)&&observed.get(t.id)!==t.state&&['Descargar','Guardado'].includes(t.state)))beep();observed.set(t.id,t.state)}scheduleRender()});
  engine.addEventListener('error',e=>{if(gen===generation){setStatus(e.detail);toast(e.detail)}});
  // Both peers already consented by submitting the same PIN to this session.
  engine.trust();setStatus('Conexión establecida.');beep();
  const current=ticket;signal('POST','/pin/'+current.id+'/connected',{},current.key,current.endpoint).catch(()=>{});
 });
 connection.addEventListener('state',e=>{if(gen!==generation)return;if(e.detail==='connecting')setStatus('Dispositivo encontrado. Comprobando la conexión directa…');if(['failed','disconnected'].includes(e.detail))fail('No se ha podido conectar. Comprueba que ambos equipos estén en la misma red y que el router o el firewall permitan la comunicación.',gen)});
 connection.addEventListener('error',e=>fail(e.detail,gen));
}
async function pollPin(gen){
 if(gen!==generation||!ticket)return;
 const current=ticket;
 try{
  const r=await signal('GET','/pin/'+current.id,null,current.key,current.endpoint);if(gen!==generation||ticket!==current)return;
  if(r.answer&&current.role==='first'&&!current.applied){current.applied=true;setStatus('Dispositivo encontrado. Comprobando la conexión directa…');await conn.accept(await decode(r.answer))}
  else if(!current.applied)setStatus(r.paired?'Dispositivo encontrado. Preparando conexión…':'Esperando al otro dispositivo. Escribe el mismo PIN y pulsa CONECTAR allí.');
 }catch(e){if(gen!==generation)return;if(e.status){fail(e.message,gen);return}setStatus('No se pudo consultar la conexión. Reintentando…')}
 if(gen===generation&&ticket===current&&!files?.ready())signalTimer=setTimeout(()=>pollPin(gen),2500);
}
async function connect(){
 if(busy||files?.ready())return;
 const pin=$('pin').value.trim();if(!/^[0-9]{6}$/.test(pin))throw new Error('El PIN debe tener exactamente seis números.');
 if(!service){view('settings');throw new Error('Configura primero la ayuda de conexión. Está explicado en ACTUALIZAR_PIN.txt.')}
 if(!navigator.onLine)throw new Error('No hay conexión de red. Activa la wifi y comprueba Internet.');
 if(!await disconnect())return;
 identity.name=$('deviceName').value.trim()||'Mi dispositivo';put('name',identity.name);$('name').value=identity.name;renderIdentity();
 const gen=generation,key=uid()+uid(),endpoint=service;busy=true;setStatus('Preparando la conexión…');const connection=new Connection();conn=connection;attach(connection,gen);
 try{
  const offer=await connection.create();if(gen!==generation)return;
  const r=await signal('POST','/pin/join',{pin,client:key,offer:await encode(offer)},null,endpoint);
  if(gen!==generation){signal('DELETE','/pin/'+r.id,null,key,endpoint).catch(()=>{});return}
  ticket={...r,key,endpoint,applied:false};
  const tick=()=>{if(gen!==generation)return;const seconds=Math.max(0,Math.ceil((r.expires-Date.now())/1000));$('countdown').textContent='Tiempo para conectar: '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');if(!seconds)fail('No se ha podido conectar a tiempo. Comprueba el mismo PIN y la misma red; después pulsa CONECTAR de nuevo en ambos equipos.',gen)};
  tick();deadlineTimer=setInterval(tick,1000);
  if(r.role==='second'){
   ticket.applied=true;setStatus('Dispositivo encontrado. Comprobando la conexión directa…');
   const answer=await connection.accept(await decode(r.offer));if(gen!==generation)return;
   await signal('POST','/pin/'+r.id+'/answer',{answer:await encode(answer)},key,endpoint);
  }
  if(gen===generation&&!files?.ready())pollPin(gen);
 }catch(e){fail(e.message,gen)}
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.view){view(b.dataset.view);return}if(!b.dataset.action)return;b.disabled=true;try{const t=files.items.get(b.dataset.id);switch(b.dataset.action){case'accept':await files.accept(t.id);beep();break;case'reject':await files.cancel(t.id,true);break;case'cancel':await files.cancel(t.id);break;case'download':{const a=document.createElement('a');a.href=t.url;a.download=t.name;document.body.append(a);a.click();a.remove();toast('Comprueba la descarga. Después pulsa Ya está guardado para liberar el temporal.');break}case'saved':if(confirm('¿Has comprobado que el archivo está guardado? Se liberará la copia temporal.'))await files.saved(t.id);break}render()}catch(e){toast(e.message)}finally{b.disabled=false}});
function action(id,fn){$(id).addEventListener('click',async()=>{const b=$(id);b.disabled=true;try{await fn()}catch(e){toast(e.message)}finally{b.disabled=false}})}
$('connectForm').addEventListener('submit',async e=>{e.preventDefault();try{await connect()}catch(e){toast(e.message);setStatus(e.message)}});
$('pin').addEventListener('input',()=>{$('pin').value=$('pin').value.replace(/[^0-9]/g,'').slice(0,6)});
action('disconnect',()=>disconnect());
action('send',()=>{if(!selected.length)throw new Error('Selecciona archivos primero.');files.enqueue(selected);selected=[];$('files').value='';selection();view('activity');render()});
function selection(){ $('selection').textContent=selected.length?selected.length+' archivo(s) · '+fmt(selected.reduce((s,f)=>s+f.size,0)):'Ningún archivo seleccionado.'}
$('files').addEventListener('change',()=>{selected=[...$('files').files];selection()});$('drop').addEventListener('dragover',e=>{e.preventDefault();$('drop').classList.add('drag')});$('drop').addEventListener('dragleave',()=>$('drop').classList.remove('drag'));$('drop').addEventListener('drop',e=>{e.preventDefault();$('drop').classList.remove('drag');selected=[...e.dataTransfer.files];selection()});window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('name').value=identity.name;$('deviceName').value=identity.name;
function renderIdentity(){$('identity').textContent='ID de este navegador: '+identity.id}renderIdentity();
$('nameForm').addEventListener('submit',e=>{e.preventDefault();identity.name=$('name').value.trim()||'Mi dispositivo';put('name',identity.name);$('deviceName').value=identity.name;renderIdentity();toast('Nombre guardado. Se mostrará al conectar de nuevo.')});
$('theme').value=get('theme')||'dark';function theme(){document.body.classList.toggle('light',$('theme').value==='light');put('theme',$('theme').value)}$('theme').addEventListener('change',theme);theme();
$('sound').checked=get('sound')==='true';$('sound').addEventListener('change',()=>put('sound',$('sound').checked));
$('service').value=service;action('saveService',()=>{if(busy||files?.ready())throw new Error('Desconecta antes de cambiar esta configuración.');const s=$('service').value.trim();if(s){const u=new URL(s);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Introduce una URL HTTPS sin credenciales ni parámetros.')}service=s.replace(/\/$/,'');put('service',service);render();toast('Configuración guardada. Ya puedes volver a Conectar.')});
document.addEventListener('pointerdown',()=>{if(window.AudioContext){audioCtx=new AudioContext();audioCtx.resume().catch(()=>{})}},{once:true});
window.addEventListener('beforeunload',e=>{if(busy||hasPending()){e.preventDefault();e.returnValue=''}});
history.replaceState(null,'',location.pathname+location.search);
if(!supported){$('unsupported').hidden=false;$('unsupported').textContent='Abre el enlace HTTPS de GitHub Pages en un navegador actualizado. No abras index.html directamente.'}
render();
