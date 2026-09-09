// Cloudflare Worker, módulo ES. Solo señalización; no hay endpoints de archivos.
const encoder=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(s)));
function roomCode(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',b=crypto.getRandomValues(new Uint8Array(16));return Array.from(b,x=>chars[x&31]).join('')}
function error(message,status=400){const e=new Error(message);e.status=status;return e}
async function body(req){if(!req.headers.get('Content-Type')?.startsWith('application/json'))throw error('Se requiere JSON.');const reader=req.body?.getReader();if(!reader)throw error('Cuerpo vacío.');let n=0,parts=[];for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>22000){await reader.cancel();throw error('Petición demasiado grande.',413)}parts.push(r.value)}const b=new Uint8Array(n);let off=0;for(const p of parts){b.set(p,off);off+=p.length}const v=JSON.parse(new TextDecoder().decode(b));if(!v||typeof v!=='object'||Array.isArray(v))throw error('Petición incorrecta.');return v}
function validCode(s){return typeof s==='string'&&s.length<=20000&&/^IW2\.[ZJ]\.[A-Za-z0-9_-]+$/.test(s)}
async function cleanup(env){const now=Date.now();await env.DB.batch([env.DB.prepare('DELETE FROM rooms WHERE expires < ?').bind(now),env.DB.prepare('DELETE FROM rates WHERE expires < ?').bind(now)])}
export default {
 async fetch(req,env){
  const allowed=env.ALLOWED_ORIGIN,origin=req.headers.get('Origin'),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
  if(!allowed||!env.DB)return reply({error:'Configura DB y ALLOWED_ORIGIN en el Worker.'},503);
  if(origin!==allowed)return reply({error:'Origen no permitido.'},403);
  headers['Access-Control-Allow-Origin']=allowed;headers['Access-Control-Allow-Methods']='GET, POST, DELETE, OPTIONS';headers['Access-Control-Allow-Headers']='Content-Type, Authorization';
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  try{
   const url=new URL(req.url),now=Date.now();
   // A shared WiFi can have several browsers behind one IP. No raw IP is stored.
   const bucket=Math.floor(now/60000),ip=req.headers.get('CF-Connecting-IP')||'unknown',rateKey=await hash(bucket+'|'+ip);
   const rate=await env.DB.prepare('INSERT INTO rates (key, count, expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(rateKey,now+120000).first();
   if(rate.count>120)throw error('Demasiadas solicitudes. Espera un minuto.',429);
   if(req.method==='POST'&&url.pathname==='/rooms'){
    const b=await body(req);if(!validCode(b.offer))throw error('Invitación no válida.');
    const createKey=await hash('create|'+bucket+'|'+ip);const n=await env.DB.prepare('INSERT INTO rates (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(createKey,now+120000).first();if(n.count>10)throw error('Demasiadas salas. Espera un minuto.',429);
    await cleanup(env);const room=roomCode(),key=hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare('INSERT INTO rooms (id, owner, offer, expires) VALUES (?,?,?,?)').bind(room,await hash(key),b.offer,now+600000).run();return reply({room,key});
   }
   const m=url.pathname.match(/^\/rooms\/([A-Z2-7]{16})(\/answer)?$/);if(!m)throw error('Ruta desconocida.',404);
   const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=? AND expires>?').bind(m[1],now).first();if(!room)throw error('Sala no encontrada o caducada.',404);
   if(req.method==='GET'&&!m[2])return reply({offer:room.offer});
   if((req.method==='GET'&&m[2])||req.method==='DELETE'){
    const key=req.headers.get('Authorization')?.replace(/^Bearer /,'')||'';if(await hash(key)!==room.owner)throw error('Acceso no autorizado.',403);
    if(req.method==='DELETE'){await env.DB.prepare('DELETE FROM rooms WHERE id=?').bind(room.id).run();return reply({ok:true})}
    return reply({answer:room.answer||null});
   }
   if(req.method==='POST'&&m[2]){
    const b=await body(req);if(!validCode(b.answer))throw error('Respuesta no válida.');
    const result=await env.DB.prepare('UPDATE rooms SET answer=? WHERE id=? AND answer IS NULL AND expires>?').bind(b.answer,room.id,now).run();if(!result.meta.changes)throw error('Esta sala ya ha recibido una respuesta. Crea otra sala.',409);return reply({ok:true});
   }
   throw error('Método no permitido.',405);
  }catch(e){return reply({error:e.status?e.message:e instanceof SyntaxError?'JSON incorrecto.':'No se pudo completar la conexión. Comprueba la configuración y la cuota gratuita.'},e.status|| (e instanceof SyntaxError?400:500))}
 },
 async scheduled(event,env,ctx){ctx.waitUntil(cleanup(env))}
};
