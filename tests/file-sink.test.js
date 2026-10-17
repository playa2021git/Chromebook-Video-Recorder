import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectFileSink} from '../file-sink.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('書き込み順序を保ち、最終チャンクまで書いてcloseした後にファイルを返す',async()=>{
  const parts=[],events=[];
  const sink=await DirectFileSink.create({createWritable:async()=>({write:async blob=>{parts.push(await blob.text());events.push('write');},close:async()=>events.push('close'),abort:async()=>events.push('abort')}),getFile:async()=>{events.push('file');return new File(parts,'record.mp4');}}, {batchSize:1});
  sink.enqueue(new Blob(['header']));sink.enqueue(new Blob(['frame']));sink.enqueue(new Blob(['tail']));
  const file=await sink.finish();assert.equal(await file.text(),'headerframetail');assert.deepEqual(events,['write','write','write','close','file']);assert.equal(sink.pendingBytes,0);
});
test('書き込みが遅いと上限で一時停止を通知し、排出後に再開する',async()=>{
  const pressure=[];let release,calls=0;
  const sink=new DirectFileSink({getFile:async()=>({size:8})},{write:()=>++calls===1?new Promise(resolve=>release=resolve):Promise.resolve(),close:async()=>{},abort:async()=>{}},{batchSize:1,highWater:8,lowWater:2,onBackpressure:blocked=>pressure.push(blocked)});
  let produced=0;
  while(!sink.blocked&&produced<1000){sink.enqueue(new Blob(['data']));produced++;}
  assert.equal(produced,2);assert.equal(sink.pendingBytes,8);assert.deepEqual(pressure,[true]);
  await tick();release();await sink.queue;assert.deepEqual(pressure,[true,false]);assert.equal(sink.pendingBytes,0);await sink.finish();
});
test('合計64MBを保存しても過去のチャンクを保持せず、待ち行列は64KBに収まる',async()=>{
  const chunk=new Blob([new Uint8Array(65536)]);let written=0;
  const sink=new DirectFileSink({getFile:async()=>({size:written})},{write:async blob=>{written+=blob.size;},close:async()=>{},abort:async()=>{}},{batchSize:1});
  for(let i=0;i<1024;i++){sink.enqueue(chunk);await sink.queue;}
  await sink.finish();assert.equal(written,64*1024*1024);assert.equal(sink.maxPendingBytes,65536);assert.equal(sink.batch.length,0);assert.equal(sink.pendingBytes,0);
});
test('空き容量不足は通知し、失敗した一時ファイルを保存済み扱いしない',async()=>{
  const quota=new DOMException('full','QuotaExceededError');let errors=0,closed=0,aborted=0;
  const sink=new DirectFileSink({getFile:async()=>{throw new Error('must not read');}},{write:async()=>{throw quota;},close:async()=>{closed++;},abort:async()=>{aborted++;}},{batchSize:1,onError:()=>errors++});
  sink.enqueue(new Blob(['data']));await assert.rejects(sink.finish(),{name:'QuotaExceededError'});assert.equal(errors,1);assert.equal(closed,0);assert.equal(aborted,1);assert.equal(sink.pendingBytes,0);
});
test('応答しない書き込みにもタイムアウトがある',async()=>{
  let aborted=false;
  const sink=new DirectFileSink({}, {write:()=>new Promise(()=>{}),abort:async()=>{aborted=true;}},{batchSize:1,writeTimeout:10});
  sink.enqueue(new Blob(['data']));await assert.rejects(sink.finish(),{name:'TimeoutError'});assert.equal(aborted,true);
});
test('保存確定後の読み取り失敗と、保存失敗を区別する',async()=>{
  const sink=new DirectFileSink({getFile:async()=>{throw new DOMException('denied','NotAllowedError');}},{write:async()=>{},close:async()=>{},abort:async()=>{throw new Error('must not abort committed file');}},{batchSize:1});
  sink.enqueue(new Blob(['data']));await assert.rejects(sink.finish(),error=>error.committed===true&&error.name==='NotAllowedError');
});
