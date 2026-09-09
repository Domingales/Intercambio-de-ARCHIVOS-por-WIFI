import test from 'node:test';
import assert from 'node:assert/strict';
import {Files,hash,BLOCK} from '../transfer.js';
import {encode,decode} from '../connection.js';
import crypto from 'node:crypto';
globalThis.window={};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=6000){const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw new Error('Condition timed out');await sleep(5)}}
class Channel{
 constructor(){this.readyState='open'}
 send(data){if(this.readyState!=='open')throw new Error('closed');let value=typeof data==='string'?data:data.slice(0);if(this.corrupt&&value instanceof ArrayBuffer){new Uint8Array(value)[0]^=255;this.corrupt=false}setImmediate(()=>{if(this.other.readyState==='open')this.other.onmessage?.({data:value})})}
 close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.();if(this.other.readyState!=='closed'){this.other.readyState='closed';this.other.onclose?.()}}
}
async function pair(){const a=new Channel(),b=new Channel();a.other=b;b.other=a;const A=new Files(a,{id:'A',name:'PC'}),B=new Files(b,{id:'B',name:'Móvil'});await until(()=>A.peer&&B.peer);A.trust();B.trust();await until(()=>A.ready()&&B.ready());return{A,B,a,b}}
function file(bytes,name='prueba.zip'){const f=new Blob([bytes]);Object.defineProperty(f,'name',{value:name});return f}
function autoAccept(F){F.addEventListener('update',()=>{for(const t of F.items.values())if(t.direction==='in'&&t.state==='Pendiente')F.accept(t.id,false)})}
async function cleanup(A,B){for(const F of [A,B])for(const t of F.items.values())if(t.url)URL.revokeObjectURL(t.url);A.c.close()}
test('binary files, empty files, queue, checksums and explicit save confirmation',async()=>{
 const {A,B}=await pair();autoAccept(B);const data=crypto.randomBytes(BLOCK*19+27);A.enqueue([file(data),file(new Uint8Array(0),'vacío.txt')]);await until(()=>A.items.size===2&&!A.running);
 const recv=[...B.items.values()];assert.equal(recv.length,2);assert.equal(recv[0].state,'Descargar');assert.deepEqual(Buffer.from(await recv[0].blob.arrayBuffer()),data);assert.equal(recv[1].blob.size,0);
 await B.saved(recv[0].id);await until(()=>A.items.get(recv[0].id).state==='Guardado');assert.equal(recv[0].blob,null);await cleanup(A,B);
});
test('simultaneous transfers in both directions',async()=>{const{A,B}=await pair();autoAccept(A);autoAccept(B);A.enqueue([file(new Uint8Array(90000).fill(7))]);B.enqueue([file(new Uint8Array(110000).fill(9))]);await until(()=>A.items.size===2&&B.items.size===2&&!A.running&&!B.running);assert.equal([...A.items.values()].find(t=>t.direction==='in').blob.size,110000);assert.equal([...B.items.values()].find(t=>t.direction==='in').blob.size,90000);await cleanup(A,B)});
test('reject and cancel pending offers without transferring bytes',async()=>{const{A,B}=await pair();A.enqueue([file(new Uint8Array(1000))]);await until(()=>B.items.size===1);let t=[...B.items.values()][0];await B.cancel(t.id,true);await until(()=>!A.running);assert.equal(A.items.get(t.id).state,'Rechazado');assert.equal(t.offset,0);A.enqueue([file(new Uint8Array(500))]);await until(()=>B.items.size===2);t=[...A.items.values()][1];await A.cancel(t.id);await until(()=>B.items.get(t.id).state==='Cancelado');await cleanup(A,B)});
test('a corrupt data block closes the connection and cannot complete a file',async()=>{const{A,B,a}=await pair();autoAccept(B);a.corrupt=true;A.enqueue([file(new Uint8Array(200000))]);await until(()=>a.readyState==='closed');assert.ok([...B.items.values()].every(t=>!['Descargar','Guardado'].includes(t.state)));await cleanup(A,B)});
test('trust is required before files can be offered',async()=>{const{A,B}=await pair();A.localTrust=false;assert.throws(()=>A.enqueue([file(new Uint8Array(1))]),/Acepta/);await cleanup(A,B)});
test('SHA-256 against independent implementation',async()=>{for(const n of [0,1,56,64,65536]){const b=crypto.randomBytes(n);assert.equal(await hash(b),crypto.createHash('sha256').update(b).digest('hex'))}});
test('manual codes: round trip, URL, expiration and malformed packets',async()=>{const v={type:'offer',session:'a'.repeat(32),sdp:'v=0\r\na=fingerprint:sha-256 AA:BB\r\n',exp:Date.now()+600000};const code=await encode(v);assert.deepEqual(await decode(code),v);assert.deepEqual(await decode('https://example.test/repo/#code='+code),v);await assert.rejects(decode('IW2.Z.bad'));await assert.rejects(decode(await encode({...v,exp:Date.now()-1})),/caducado/)});
test('direct file writer path saves bounded blocks before reporting completion',async()=>{const chunks=[];let closed=false;window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async data=>chunks.push(Buffer.from(data)),close:async()=>{closed=true},abort:async()=>{}})});const{A,B}=await pair();B.addEventListener('update',()=>{for(const t of B.items.values())if(t.direction==='in'&&t.state==='Pendiente')B.accept(t.id,true)});const data=crypto.randomBytes(150000);A.enqueue([file(data)]);await until(()=>A.items.size===1&&!A.running);assert.ok(closed);assert.deepEqual(Buffer.concat(chunks),data);assert.equal([...B.items.values()][0].state,'Guardado');delete window.showSaveFilePicker;await cleanup(A,B)});
test('receiver cancellation during transmission preserves the connection',async()=>{const{A,B,a}=await pair();autoAccept(B);let cancelled=false;B.addEventListener('update',()=>{const t=[...B.items.values()][0];if(t?.state==='Recibiendo'&&t.offset>=BLOCK&&!cancelled){cancelled=true;B.cancel(t.id)}});A.enqueue([file(new Uint8Array(BLOCK*100))]);await until(()=>A.items.size===1&&!A.running);await sleep(30);assert.equal(a.readyState,'open');assert.equal([...A.items.values()][0].state,'Cancelado');await cleanup(A,B)});
