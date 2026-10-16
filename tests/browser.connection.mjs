import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const root=new URL('../',import.meta.url).pathname;
const server=spawn('python3',['-m','http.server','8766','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
let browser;
const url='http://127.0.0.1:8766';
try {
  let ready=false;
  for(let i=0;i<50;i++){try{if((await fetch(url)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream=device-count=2']});
  const errors=[];
  async function pageWith(setup,clock=false){
    const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
    if(clock)await p.clock.install();
    if(setup)await p.addInitScript(setup);
    await p.goto(url);await p.locator('#mono').click();return p;
  }
  const p=await pageWith(()=>{
    window.requests=[];window.streams=[];window.contexts=0;window.transientFailure=true;
    const NativeContext=AudioContext;window.AudioContext=class extends NativeContext{constructor(...args){super(...args);window.contexts++;}};
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async c=>{window.requests.push(c);if(c.video&&c.audio===false&&window.transientFailure){window.transientFailure=false;throw new DOMException('Camera releasing','NotReadableError');}const s=await original(c);window.streams.push(s);return s;};
  });
  await p.locator('#connectButton').click();await p.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await p.waitForFunction(()=>document.getElementById('camera').options.length>=2);
  assert.deepEqual(await p.evaluate(()=>window.requests[0].video.facingMode),{ideal:'user'});
  for(let i=0;i<6;i++){
    await p.evaluate(()=>{window.previousVideo=document.getElementById('preview').srcObject.getVideoTracks()[0];window.previousMic=document.getElementById('preview').srcObject.getAudioTracks()[0];});
    await p.locator('#camera').selectOption({index:(i+1)%2});
    await p.waitForFunction(()=>!document.getElementById('settings').disabled);
    assert.equal(await p.evaluate(()=>document.getElementById('preview').srcObject.getAudioTracks()[0]===window.previousMic),true);
    assert.equal(await p.evaluate(()=>window.previousMic.readyState),'live');
    assert.equal(await p.evaluate(()=>window.previousVideo.readyState),'ended');
    assert.equal(await p.evaluate(()=>window.requests.at(-1).audio),false);
    assert.ok(await p.evaluate(()=>document.getElementById('preview').srcObject.getVideoTracks()[0].getSettings().deviceId===document.getElementById('camera').value));
  }
  assert.equal(await p.evaluate(()=>window.contexts),1,'camera switches reuse AudioContext');
  assert.equal(await p.evaluate(()=>window.transientFailure),false,'transient driver failure retried');
  await p.evaluate(()=>{window.previousVideo=document.getElementById('preview').srcObject.getVideoTracks()[0];window.previousMic=document.getElementById('preview').srcObject.getAudioTracks()[0];});
  await p.locator('#microphone').selectOption({index:1});await p.waitForFunction(()=>!document.getElementById('settings').disabled);
  assert.equal(await p.evaluate(()=>window.requests.at(-1).video),false);
  assert.equal(await p.evaluate(()=>document.getElementById('preview').srcObject.getVideoTracks()[0]===window.previousVideo),true);
  assert.equal(await p.evaluate(()=>window.previousVideo.readyState),'live');assert.equal(await p.evaluate(()=>window.previousMic.readyState),'ended');
  assert.equal(await p.evaluate(()=>window.contexts),1);
  await p.close();
  console.log('PASS: Front preference; six camera switches retain microphone/AudioContext; microphone switch retains camera; old tracks released.');

  const cancelled=await pageWith(()=>{
    window.requests=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=c=>{
      if(++window.requests===1)return new Promise(resolve=>{window.resolveLate=async()=>{const s=await original(c);window.lateStream=s;resolve(s);};});
      return original(c);
    };
  });
  await cancelled.locator('#connectButton').click();await cancelled.locator('#cancelConnectButton').click();
  await cancelled.waitForFunction(()=>!document.getElementById('settings').disabled);
  assert.equal(await cancelled.locator('#cancelConnectButton').isVisible(),false);
  await cancelled.locator('#reconnectButton').click();await cancelled.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await cancelled.evaluate(()=>{window.activeVideo=document.getElementById('preview').srcObject.getVideoTracks()[0];});
  await cancelled.evaluate(()=>window.resolveLate());
  await cancelled.waitForFunction(()=>window.lateStream.getTracks().every(t=>t.readyState==='ended'));
  assert.equal(await cancelled.evaluate(()=>window.activeVideo===document.getElementById('preview').srcObject.getVideoTracks()[0]&&window.activeVideo.readyState==='live'),true);
  await cancelled.close();
  console.log('PASS: cancel/reconnect works; late permission/device results cannot overwrite or leak into a newer connection.');

  const timeout=await pageWith(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise(()=>{});},true);
  await timeout.locator('#connectButton').click();await timeout.waitForFunction(()=>document.getElementById('cancelConnectButton').hidden===false);
  await timeout.clock.fastForward(20001);await timeout.waitForFunction(()=>!document.getElementById('settings').disabled);
  assert.match(await timeout.locator('#notice').textContent(),/20 秒/);
  assert.equal(await timeout.locator('#reconnectButton').isVisible(),true);await timeout.close();

  const enumeration=await pageWith(()=>{navigator.mediaDevices.enumerateDevices=()=>new Promise(()=>{});},true);
  await enumeration.locator('#connectButton').click();await enumeration.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await enumeration.clock.fastForward(20001);
  assert.equal(await enumeration.locator('#recordButton').isEnabled(),true,'enumeration cannot delay preview/readiness');await enumeration.close();

  const audio=await pageWith(()=>{
    window.blockAudio=true;
    const NativeContext=AudioContext;
    window.AudioContext=class extends NativeContext{
      get state(){return window.blockAudio?'suspended':super.state;}
      resume(){return window.blockAudio?new Promise(()=>{}):super.resume();}
    };
  },true);
  await audio.locator('#connectButton').click();await audio.waitForFunction(()=>document.getElementById('previewStatus').textContent==='音声の開始…');
  await audio.clock.fastForward(3001);await audio.waitForFunction(()=>!document.getElementById('settings').disabled);
  assert.match(await audio.locator('#notice').textContent(),/音声の開始/);
  await audio.evaluate(()=>{window.blockAudio=false;});await audio.locator('#reconnectButton').click();await audio.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await audio.close();

  const preview=await pageWith(()=>{
    window.blockPreview=true;const original=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){return this.id==='preview'&&window.blockPreview?new Promise(()=>{}):original.call(this);};
  },true);
  await preview.locator('#connectButton').click();await preview.waitForFunction(()=>document.getElementById('previewStatus').textContent==='映像の開始…');
  await preview.clock.fastForward(5001);await preview.waitForFunction(()=>!document.getElementById('settings').disabled);
  assert.match(await preview.locator('#notice').textContent(),/映像の開始/);
  await preview.evaluate(()=>{window.blockPreview=false;});await preview.locator('#reconnectButton').click();await preview.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await preview.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: bounded device/AudioContext/preview waits, reconnect after failures, nonblocking device enumeration, no unhandled page errors.');
} finally {await browser?.close();server.kill();}
