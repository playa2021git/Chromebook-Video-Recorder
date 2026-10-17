import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=new URL('../',import.meta.url).pathname,dir=mkdtempSync(join(tmpdir(),'frame-mp4-'));
const audioFile=join(dir,'stereo.wav');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=20','-filter_complex','[0:a][1:a]amerge=inputs=2[a]','-map','[a]','-c:a','pcm_s16le',audioFile]);
const server=spawn('python3',['-m','http.server','8767','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});let browser;
try{
  let ready=false;for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8767')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${audioFile}`]});
  const errors=[],requests=[];
  async function open(setup){const page=await browser.newPage({acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));if(setup)await page.addInitScript(setup);await page.goto('http://127.0.0.1:8767');return page;}
  async function connect(page){await page.locator('#connectButton').click();await page.waitForFunction(()=>!document.getElementById('recordButton').disabled);}
  async function record(page){await page.locator('#recordButton').click();await page.waitForFunction(()=>document.getElementById('recordState').textContent==='録画中');await page.waitForTimeout(1300);await page.locator('#pauseButton').click();await page.waitForTimeout(400);await page.locator('#pauseButton').click();await page.waitForTimeout(800);await page.locator('#recordButton').click();}
  async function check(page,file,channels,height){
    await page.waitForSelector('.take video',{timeout:120000});
    const download=page.waitForEvent('download');await page.getByRole('link',{name:'端末に保存',exact:false}).first().click();const result=await download;assert.match(result.suggestedFilename(),/\.mp4$/);await result.saveAs(file);
    assert.equal(readFileSync(file).subarray(4,8).toString(),'ftyp');
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8'}));
    assert.equal(probe.streams.find(s=>s.codec_type==='video').codec_name,'h264');assert.equal(probe.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
    assert.equal(probe.streams.find(s=>s.codec_type==='video').height,height);assert.equal(probe.streams.find(s=>s.codec_type==='audio').channels,channels);
    assert.ok(Number(probe.format.duration)>1.8&&Number(probe.format.duration)<3.5,'duration excludes pause');
    const player=page.locator('.take video').first();await player.evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('.take video').currentTime>0);await player.evaluate(v=>{v.pause();v.currentTime=v.duration/2;});await page.waitForFunction(()=>!document.querySelector('.take video').seeking&&document.querySelector('.take video').currentTime>0);
    return probe;
  }
  const native=await open(()=>{
    // Test fallback when a browser claims AAC support but its actual encoder rejects it.
    const original=MediaRecorder.isTypeSupported.bind(MediaRecorder);MediaRecorder.isTypeSupported=t=>t.includes('mp4a')||original(t);
  });
  assert.equal(await native.locator('#videoFormat').inputValue(),'mp4');assert.equal(await native.evaluate(()=>crossOriginIsolated),false);
  await connect(native);await record(native);const stereo=join(dir,'stereo.mp4');await check(native,stereo,2,1080);
  const pcm=execFileSync('ffmpeg',['-v','error','-i',stereo,'-map','0:a:0','-f','f32le','-ar','48000','-'],{maxBuffer:10*1024*1024});
  const amplitude=(c,f)=>{let re=0,im=0;for(let i=0;i<48000;i++){const v=pcm.readFloatLE(i*8+c*4),a=2*Math.PI*f*i/48000;re+=v*Math.cos(a);im+=v*Math.sin(a);}return Math.hypot(re,im)/48000;};
  assert.ok(amplitude(0,440)>amplitude(0,880)*10);assert.ok(amplitude(1,880)>amplitude(1,440)*10);await native.close();
  console.log('PASS: default MP4 H.264/AAC, 1080p stereo separation, download signature, pause, playback and seeking without cross-origin isolation.');
  const webm=await open(()=>{const Native=MediaRecorder;window.sourceMimes=[];window.MediaRecorder=class extends Native{constructor(s,o){super(s,o);window.sourceMimes.push(o.mimeType);}static isTypeSupported(t){return !t.startsWith('video/mp4')&&Native.isTypeSupported(t);}};});
  await webm.locator('#quality').selectOption('640x480');await webm.locator('#mono').click();await connect(webm);await record(webm);await check(webm,join(dir,'mono.mp4'),1,480);
  assert.ok(await webm.evaluate(()=>window.sourceMimes.every(t=>t.startsWith('video/webm'))));await webm.close();
  console.log('PASS: browser without native MP4 support converts actual WebM to H.264/AAC MP4 with mono audio.');
  const cancel=await open();let heldRoute;
  await cancel.route('**/ffmpeg-core.wasm',route=>{heldRoute=route;});
  await cancel.locator('#quality').selectOption('640x480');await connect(cancel);
  const wasm=cancel.waitForRequest('**/ffmpeg-core.wasm');await record(cancel);await wasm;
  assert.equal(await cancel.locator('#liveBadge').isVisible(),false);
  assert.equal(await cancel.locator('#recordState').textContent(),'MP4 変換中');
  await cancel.locator('#cancelConvertButton').click();await cancel.waitForSelector('.convert-retry');
  assert.equal(await cancel.locator('#recordButton').isEnabled(),true);assert.match(await cancel.locator('#notice').textContent(),/キャンセル/);
  assert.equal(await cancel.getByRole('link',{name:/元データを保存/}).count(),1);
  await heldRoute?.abort().catch(()=>{});await cancel.unroute('**/ffmpeg-core.wasm');
  await cancel.locator('.convert-retry').click();await cancel.waitForFunction(()=>document.querySelectorAll('.take').length===2,{},{timeout:120000});
  await check(cancel,join(dir,'retry.mp4'),2,480);await cancel.close();
  assert.deepEqual(errors,[]);assert.ok(requests.every(url=>url.startsWith('http://127.0.0.1:8767/')||url.startsWith('blob:')),'no external uploads or CDN requests');
  console.log('PASS: conversion cancellation preserves source, retry succeeds, no external network requests or unhandled page errors.');
}finally{await browser?.close();server.kill();rmSync(dir,{recursive:true,force:true});}
