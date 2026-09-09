// Intercambio WiFi 2.1: señalización por PIN. Nunca recibe archivos.
const enc=new TextEncoder(),hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
function problem(message,status=400){return Object.assign(new Error(message),{status})}
async function body(req){if(!req.headers.get('Content-Type')?.startsWith('application/json'))throw problem('Se requiere JSON.');const reader=req.body?.getReader();if(!reader)throw problem('Cuerpo vacío.');let n=0,parts=[];for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>22000){await reader.cancel();throw problem('Petición demasiado grande.',413)}parts.push(r.value)}const b=new Uint8Array(n);let off=0;for(const p of parts){b.set(p,off);off+=p.length}const v=JSON.parse(new TextDecoder().decode(b));if(!v||typeof v!=='object'||Array.isArray(v))throw problem('Petición incorrecta.');return v}
const validCode=s=>typeof s==='string'&&s.length<=20000&&/^IW2\.[ZJ]\.[A-Za-z0-9_-]+$/.test(s);
const validKey=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
async function cleanup(env){const now=Date.now();await env.DB.batch([env.DB.prepare('DELETE FROM pin_sessions WHERE expires < ?').bind(now),env.DB.prepare('DELETE FROM rates WHERE expires < ?').bind(now)])}
async function rate(env,key,expires,max){const r=await env.DB.prepare('INSERT INTO rates (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,expires).first();if(r.count>max)throw problem('Demasiados intentos. Espera unos minutos antes de volver a conectar.',429)}
export default {
 async fetch(req,env){
  const origin=req.headers.get('Origin'),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'},reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
  if(!env.ALLOWED_ORIGIN||!env.DB)return reply({error:'Configura DB y ALLOWED_ORIGIN en el Worker.'},503);
  if(origin!==env.ALLOWED_ORIGIN)return reply({error:'Origen no permitido.'},403);
  Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  try{
   const url=new URL(req.url),now=Date.now(),ip=req.headers.get('CF-Connecting-IP');if(!ip)throw problem('No se ha podido identificar la conexión de red.',400);
   const scope=await hash(origin+'|'+ip); // Network heuristic, not a WiFi/SSID proof.
   await rate(env,await hash('requests|'+Math.floor(now/60000)+'|'+scope),now+120000,120);
   if(req.method==='POST'&&url.pathname==='/pin/join'){
    await rate(env,await hash('pin-attempts|'+Math.floor(now/300000)+'|'+scope),now+600000,12);
    const b=await body(req);if(!/^[0-9]{6}$/.test(b.pin)||typeof b.pin!=='string'||!validKey(b.client)||!validCode(b.offer))throw problem('Escribe un PIN de seis cifras y vuelve a conectar.');
    await cleanup(env);
    const codehash=await hash(origin+'|'+b.pin),client=await hash(b.client),id=hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT INTO pin_sessions (id,codehash,firstkey,offer,expires,state) VALUES (?,?,?,?,?,?) ON CONFLICT(codehash) DO NOTHING').bind(id,codehash,client,b.offer,now+180000,'waiting').run();
    let row=await env.DB.prepare('SELECT * FROM pin_sessions WHERE codehash=? AND expires>?').bind(codehash,now).first();if(!row)throw problem('La búsqueda ha caducado. Pulsa CONECTAR otra vez.',410);
    if(row.state!=='waiting')throw problem('Este PIN ya se ha utilizado. Elige otro PIN en ambos equipos.',409);
    if(row.firstkey===client)return reply({id:row.id,role:'first',expires:row.expires});
    await env.DB.prepare('UPDATE pin_sessions SET secondkey=? WHERE id=? AND secondkey IS NULL AND state=? AND expires>?').bind(client,row.id,'waiting',now).run();
    row=await env.DB.prepare('SELECT * FROM pin_sessions WHERE id=?').bind(row.id).first();
    if(row.secondkey!==client)throw problem('Este PIN ya tiene dos dispositivos. Elige otro en ambos equipos.',409);
    return reply({id:row.id,role:'second',offer:row.offer,expires:row.expires});
   }
   const m=url.pathname.match(/^\/pin\/([a-f0-9]{32})(\/(answer|connected))?$/);if(!m)throw problem('Actualiza la página y el servicio a la versión 2.1.',404);
   const key=req.headers.get('Authorization')?.replace(/^Bearer /,'')||'';if(!validKey(key))throw problem('Acceso no autorizado.',403);
   const client=await hash(key),row=await env.DB.prepare('SELECT * FROM pin_sessions WHERE id=? AND expires>?').bind(m[1],now).first();if(!row)throw problem('El PIN ha caducado. Pulsa CONECTAR en ambos equipos.',410);
   if(client!==row.firstkey&&client!==row.secondkey)throw problem('Acceso no autorizado.',403);
   if(req.method==='DELETE'&&!m[3]){await env.DB.prepare('UPDATE pin_sessions SET state=?,offer=NULL,answer=NULL WHERE id=?').bind('closed',row.id).run();return reply({ok:true})}
   if(row.state==='closed')throw problem('El otro dispositivo ha cancelado. Elige otro PIN y vuelve a conectar.',410);
   if(req.method==='GET'&&!m[3])return reply({state:row.state,paired:!!row.secondkey,answer:client===row.firstkey?row.answer:null,expires:row.expires});
   if(req.method==='POST'&&m[3]==='answer'){
    if(client!==row.secondkey)throw problem('Solo puede responder el segundo dispositivo.',403);
    const b=await body(req);if(!validCode(b.answer))throw problem('Respuesta no válida.');
    if(row.answer===b.answer)return reply({ok:true});
    const r=await env.DB.prepare('UPDATE pin_sessions SET answer=? WHERE id=? AND answer IS NULL AND state=? AND expires>?').bind(b.answer,row.id,'waiting',now).run();if(!r.meta.changes)throw problem('La respuesta ya se ha procesado.',409);return reply({ok:true});
   }
   if(req.method==='POST'&&m[3]==='connected'){
    if(!row.secondkey)throw problem('Falta el otro dispositivo.',409);
    await env.DB.prepare('UPDATE pin_sessions SET state=?,offer=NULL,answer=NULL WHERE id=?').bind('connected',row.id).run();return reply({ok:true});
   }
   throw problem('Método no permitido.',405);
  }catch(e){return reply({error:e.status?e.message:e instanceof SyntaxError?'JSON incorrecto.':'No se pudo coordinar la conexión. Comprueba que se ha ejecutado el nuevo schema.sql y que queda cuota gratuita.'},e.status||(e instanceof SyntaxError?400:500))}
 },
 async scheduled(event,env,ctx){ctx.waitUntil(cleanup(env))}
};
