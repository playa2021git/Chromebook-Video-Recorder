import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingWakeLock } from '../wake-lock.js';
function setup(api) {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const states=[]; const locks=[];
  const wakeLock=api || {request:async type=>{assert.equal(type,'screen'); const lock=new EventTarget();lock.released=false;lock.release=async()=>{lock.released=true;lock.dispatchEvent(new Event('release'));};locks.push(lock);return lock;}};
  const manager=new RecordingWakeLock({wakeLock,document,onStatus:s=>states.push(s)});
  return {manager,document,states,locks};
}
test('収録中に取得し、画面復帰で再取得、保存完了で解除',async()=>{
  const {manager,document,states,locks}=setup();
  await manager.start();assert.equal(states.at(-1),'held');
  document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));
  await locks[0].release();assert.equal(states.at(-1),'hidden');
  document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));
  await manager.pending;assert.equal(locks.length,2);assert.equal(states.at(-1),'held');
  manager.stop();assert.equal(locks[1].released,true);assert.equal(states.at(-1),'idle');
});
test('拒否・解除・非対応を表示して手動で再取得できる',async()=>{
  const rejected=setup({request:async()=>{throw new Error('denied');}});
  await rejected.manager.start();assert.equal(rejected.states.at(-1),'failed');
  const normal=setup();await normal.manager.start();await normal.locks[0].release();
  assert.equal(normal.states.at(-1),'released');await normal.manager.acquire();assert.equal(normal.states.at(-1),'held');
  const missing=setup({});await missing.manager.start();assert.equal(missing.states.at(-1),'unsupported');
});
test('停止後に届くロックを解除し、次の収録のロックは維持する',async()=>{
  let resolve;
  const lock=new EventTarget();lock.released=false;lock.release=async()=>{lock.released=true;};
  let count=0;
  const {manager,states}=setup({request:()=>++count===1?new Promise(r=>resolve=r):Promise.resolve(Object.assign(new EventTarget(),{released:false,release:async()=>{}}))});
  const pending=manager.start();manager.stop();manager.start();resolve(lock);await pending;
  assert.equal(lock.released,true);assert.equal(count,2);assert.equal(states.at(-1),'held');manager.stop();
});
