import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, stopStream } from '../connection.js';
test('キャンセル後に届いたストリームを停止し、新しい接続へ渡さない',async()=>{
  const controller=new AbortController(); let resolve, stopped=0;
  const pending=waitFor(new Promise(done=>{resolve=done;}),{signal:controller.signal,onLate:stopStream});
  controller.abort(new DOMException('cancel','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});
  const track={onended:()=>{},stop:()=>stopped++};resolve({getTracks:()=>[track]});
  await new Promise(done=>setImmediate(done)); assert.equal(stopped,1);assert.equal(track.onended,null);
});
test('応答がない処理はTimeoutErrorで制御を返し、遅い結果を片付ける',async()=>{
  let resolve,late;
  const promise=waitFor(new Promise(done=>{resolve=done;}),{timeout:10,label:'カメラ',onLate:value=>late=value});
  await assert.rejects(promise,{name:'TimeoutError'});
  resolve('late');await new Promise(done=>setImmediate(done));assert.equal(late,'late');
});
test('成功後のabortで正常なストリームを停止しない',async()=>{
  const controller=new AbortController();let stopped=false;
  const value=await waitFor(Promise.resolve('ready'),{signal:controller.signal,timeout:10,onLate:()=>stopped=true});
  controller.abort();assert.equal(value,'ready');assert.equal(stopped,false);
});
test('中断済みの要求と遅い拒否を安全に扱う',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(waitFor(Promise.resolve('unused'),{signal:controller.signal}),{name:'AbortError'});
  let reject;const promise=waitFor(new Promise((_,fail)=>{reject=fail;}),{timeout:10});
  await assert.rejects(promise,{name:'TimeoutError'});reject(new Error('late failure'));
  await new Promise(done=>setImmediate(done));
});
