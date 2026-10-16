// Requires Chromium and FFmpeg/ffprobe on the test machine; no physical devices used.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'frame-test-'));
const rate = 48000, seconds = 20;
const pcm = Buffer.alloc(rate * seconds * 4);
for (let i = 0; i < rate * seconds; i++) {
  pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 4);
  pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 880 * i / rate)), i * 4 + 2);
}
const wav = Buffer.alloc(44);
wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
const audioFile = join(directory, 'stereo.wav'); writeFileSync(audioFile, Buffer.concat([wav, pcm]));
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], {cwd:root, stdio:'ignore'});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch('http://127.0.0.1:8765')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'development server starts');
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless:true, args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream=device-count=2', `--use-file-for-fake-audio-capture=${audioFile}`]});
  const page = await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  const errors = []; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:8765');
  await page.locator('#connectButton').click();
  await page.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  assert.match(await page.locator('#actualVideo').textContent(), /1920 × 1080/);
  assert.match(await page.locator('#actualAudio').textContent(), /入力：2 ch/);
  for (const mode of ['stereo','mono']) {
    if (mode==='mono') { await page.locator('#mono').click(); await page.waitForFunction(()=>document.getElementById('actualAudio').textContent.includes('録音：1 ch')); }
    await page.locator('#recordButton').click(); await page.waitForTimeout(1500);
    await page.locator('#pauseButton').click(); assert.equal(await page.locator('#recordState').textContent(),'一時停止');
    assert.equal(await page.locator('#camera').isDisabled(),true);
    const pausedTime = await page.locator('#timer').textContent(); await page.waitForTimeout(1100);
    assert.equal(await page.locator('#timer').textContent(),pausedTime);
    await page.locator('#pauseButton').click(); await page.waitForTimeout(700);
    await page.locator('#recordButton').click();
    await page.waitForFunction(count=>document.querySelectorAll('.take').length===count,mode==='stereo'?1:2);
    const playback=page.locator('.take video').first(); await playback.evaluate(video=>video.play());
    await page.waitForFunction(()=>document.querySelector('.take video').currentTime>0);
    const download = page.waitForEvent('download'); await page.getByRole('link',{name:'端末に保存'}).first().click();
    const file=join(directory,`${mode}.webm`); await (await download).saveAs(file);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
    assert.equal(probe.streams.find(s=>s.codec_type==='video').width,1920);
    assert.equal(probe.streams.find(s=>s.codec_type==='video').height,1080);
    assert.equal(probe.streams.find(s=>s.codec_type==='audio').channels,mode==='stereo'?2:1);
    // Check that left/right really remain separate in the encoded file, not just its metadata.
    if (mode==='stereo') {
      const decoded=execFileSync('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-f','f32le','-acodec','pcm_f32le','-ar',String(rate),'-'],{maxBuffer:10*1024*1024});
      function amplitude(channel, frequency) {
        let real=0,imaginary=0; const samples=Math.min(rate,Math.floor(decoded.length/8));
        for(let i=0;i<samples;i++){const value=decoded.readFloatLE(i*8+channel*4);const angle=2*Math.PI*frequency*i/rate;real+=value*Math.cos(angle);imaginary+=value*Math.sin(angle);}
        return Math.hypot(real,imaginary)/samples;
      }
      assert.ok(amplitude(0,440)>amplitude(0,880)*10,'left retains 440 Hz');
      assert.ok(amplitude(1,880)>amplitude(1,440)*10,'right retains 880 Hz');
    }
    await playback.evaluate(video=>video.pause());
  }
  await page.locator('#quality').selectOption('1280x720');
  await page.waitForFunction(()=>document.getElementById('actualVideo').textContent.includes('1280 × 720'));
  await page.locator('#camera').selectOption({index:1});
  await page.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  assert.match(await page.locator('#actualVideo').textContent(),/1280 × 720/);
  await page.locator('#microphone').selectOption({index:1});
  await page.waitForFunction(()=>{const video=document.getElementById('preview');return video.srcObject?.getAudioTracks()[0].getSettings().deviceId===document.getElementById('microphone').value && !document.getElementById('recordButton').disabled;});
  await page.locator('#recordButton').click(); await page.waitForTimeout(1200);
  await page.locator('#preview').evaluate(video=>video.srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForFunction(()=>document.querySelectorAll('.take').length===3);
  assert.equal(await page.locator('#placeholder').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#helpButton').click(); assert.equal(await page.locator('#helpDialog').isVisible(),true); await page.locator('#closeHelp').click();
  assert.deepEqual(errors,[]);
  // Audio-only must work even when every camera request is rejected.
  const audioPage = await browser.newPage({viewport:{width:1366,height:900},acceptDownloads:true});
  audioPage.on('pageerror',error=>errors.push(error.message));
  await audioPage.addInitScript(()=>{
    window.captureRequests=[]; window.captureStreams=[];
    const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=constraints=>{
      window.captureRequests.push(constraints);
      if(constraints.video!==false) return Promise.reject(new DOMException('Camera blocked','NotAllowedError'));
      return getUserMedia(constraints).then(stream=>{window.captureStreams.push(stream); return stream;});
    };
  });
  await audioPage.goto('http://127.0.0.1:8765');
  await audioPage.locator('#audioMode').click(); await audioPage.locator('#connectButton').click();
  await audioPage.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  assert.equal(await audioPage.locator('#videoSettings').isVisible(),false);
  assert.match(await audioPage.locator('#actualVideo').textContent(),/使用しません/);
  assert.equal(await audioPage.evaluate(()=>document.getElementById('preview').srcObject),null);
  for (const mode of ['stereo','mono']) {
    if(mode==='mono'){
      await audioPage.locator('#mono').click();
      await audioPage.waitForFunction(()=>document.getElementById('actualAudio').textContent.includes('録音：1 ch'));
    }
    await audioPage.locator('#recordButton').click();
    await audioPage.waitForFunction(()=>document.getElementById('recordState').textContent==='録音中');
    assert.equal(await audioPage.locator('#videoMode').isDisabled(),true);
    await audioPage.waitForTimeout(1600); await audioPage.locator('#pauseButton').click();
    const paused=await audioPage.locator('#timer').textContent(); await audioPage.waitForTimeout(1100);
    assert.equal(await audioPage.locator('#timer').textContent(),paused);
    await audioPage.locator('#pauseButton').click(); await audioPage.waitForTimeout(800);
    await audioPage.locator('#recordButton').click();
    await audioPage.waitForFunction(count=>document.querySelectorAll('.take audio').length===count,mode==='stereo'?1:2);
    const player=audioPage.locator('.take audio').first(); await player.evaluate(audio=>audio.play());
    await audioPage.waitForFunction(()=>document.querySelector('.take audio').currentTime>0);
    const download=audioPage.waitForEvent('download'); await audioPage.getByRole('link',{name:'端末に保存'}).first().click();
    const downloaded=await download; assert.match(downloaded.suggestedFilename(),/\.mp3$/);
    const file=join(directory,`${mode}.mp3`); await downloaded.saveAs(file);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
    assert.equal(probe.streams.length,1); assert.equal(probe.streams[0].codec_name,'mp3');
    assert.equal(probe.streams[0].channels,mode==='stereo'?2:1);
    assert.equal(probe.streams[0].sample_rate,'48000');
    assert.ok(Number(probe.format.duration)>2 && Number(probe.format.duration)<3,'MP3 duration excludes pause');
    const raw=execFileSync('ffmpeg',['-v','error','-i',file,'-f','f32le','-acodec','pcm_f32le','-ar',String(rate),'-'],{maxBuffer:10*1024*1024});
    function amplitude(channel,frequency) {
      const count=mode==='stereo'?2:1; let real=0,imaginary=0;
      const samples=Math.min(rate,Math.floor(raw.length/(4*count)));
      for(let i=0;i<samples;i++){const value=raw.readFloatLE((i*count+channel)*4),angle=2*Math.PI*frequency*i/rate;real+=value*Math.cos(angle);imaginary+=value*Math.sin(angle);}
      return Math.hypot(real,imaginary)/samples;
    }
    if(mode==='stereo'){
      assert.ok(amplitude(0,440)>amplitude(0,880)*10,'MP3 left remains separate');
      assert.ok(amplitude(1,880)>amplitude(1,440)*10,'MP3 right remains separate');
    } else assert.ok(amplitude(0,440)>0.01 || amplitude(0,880)>0.01,'mono MP3 is not silent');
    await player.evaluate(audio=>audio.pause());
  }
  assert.ok(await audioPage.evaluate(()=>window.captureRequests.length>=2&&window.captureRequests.every(c=>c.video===false)));
  await audioPage.setViewportSize({width:390,height:844});
  assert.equal(await audioPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await audioPage.screenshot({path:join(directory,'audio-mobile.png'),fullPage:true});
  // A second recording must still flush when a microphone is unplugged.
  await audioPage.locator('#recordButton').click();
  await audioPage.waitForFunction(()=>document.getElementById('recordState').textContent==='録音中');
  await audioPage.waitForTimeout(1200);
  await audioPage.evaluate(()=>window.captureStreams.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await audioPage.waitForFunction(()=>document.querySelectorAll('.take audio').length===3);
  assert.equal(await audioPage.locator('#recordButton').isDisabled(),true);
  assert.ok(await audioPage.evaluate(()=>window.captureStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));
  await audioPage.locator('#videoMode').click();
  assert.equal(await audioPage.locator('#audioPreview').isVisible(),false);
  assert.equal(await audioPage.locator('#recordButton').isDisabled(),true);
  assert.equal(await audioPage.locator('.take audio').count(),3);
  assert.deepEqual(errors,[]);
  const switching=await browser.newPage();
  await switching.goto('http://127.0.0.1:8765'); await switching.locator('#connectButton').click();
  await switching.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await switching.evaluate(()=>{window.previousCamera=document.getElementById('preview').srcObject;});
  await switching.locator('#audioMode').click();
  assert.ok(await switching.evaluate(()=>window.previousCamera.getTracks().every(track=>track.readyState==='ended')));
  const brokenEncoder=await browser.newPage();
  await brokenEncoder.route('**/mp3-worker.js',route=>route.abort());
  await brokenEncoder.goto('http://127.0.0.1:8765'); await brokenEncoder.locator('#audioMode').click(); await brokenEncoder.locator('#connectButton').click();
  await brokenEncoder.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  await brokenEncoder.locator('#recordButton').click();
  await brokenEncoder.waitForFunction(()=>document.getElementById('notice').textContent.includes('MP3 エンコーダーを読み込めません'));
  assert.equal(await brokenEncoder.locator('#audioMode').isDisabled(),false);
  assert.equal(await brokenEncoder.locator('.take').count(),0);
  console.log('PASS: MP3 stereo/mono encoding, separate L/R signals, pause duration, playback, download, no camera permission, mode locks, repeat recording, mobile and mode switching.');
  // Real browser error states with deterministic rejected device requests.
  const failure=await browser.newPage();
  await failure.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});
  await failure.goto('http://127.0.0.1:8765'); await failure.locator('#connectButton').click();
  await failure.waitForFunction(()=>document.getElementById('notice').textContent.includes('許可されていません'));
  assert.equal(await failure.locator('#recordButton').isDisabled(),true);
  const monoInput=await browser.newPage();
  await monoInput.addInitScript(()=>{const original=MediaStreamTrack.prototype.getSettings;MediaStreamTrack.prototype.getSettings=function(){const settings=original.call(this);if(this.kind==='audio')settings.channelCount=1;return settings;};});
  await monoInput.goto('http://127.0.0.1:8765'); await monoInput.locator('#connectButton').click();
  await monoInput.waitForFunction(()=>document.getElementById('notice').textContent.includes('ステレオ録画は開始できません'));
  assert.equal(await monoInput.locator('#recordButton').isDisabled(),true);
  await monoInput.locator('#mono').click(); await monoInput.waitForFunction(()=>!document.getElementById('recordButton').disabled);
  const unsupported=await browser.newPage();
  await unsupported.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Resolution','OverconstrainedError');};});
  await unsupported.goto('http://127.0.0.1:8765'); await unsupported.locator('#connectButton').click();
  await unsupported.waitForFunction(()=>document.getElementById('notice').textContent.includes('720p または 480p'));
  assert.equal(await unsupported.locator('#recordButton').isDisabled(),true);
  console.log('PASS: 1080p encoding; separate stereo tones; mono encoding; pause/resume; playback; local downloads; 720p/camera/mic switching; device disconnect recovery; mobile; help; permission/unsupported resolution errors; mono input protection.');
} finally {
  await browser?.close(); server.kill(); rmSync(directory,{recursive:true,force:true});
}
