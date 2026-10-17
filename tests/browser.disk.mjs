import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=new URL('../',import.meta.url).pathname,dir=mkdtempSync(join(tmpdir(),'frame-disk-'));
const audioFile=join(dir,'stereo.wav');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=20','-filter_complex','[0:a][1:a]amerge=inputs=2[a]','-map','[a]','-c:a','pcm_s16le',audioFile]);
const server=spawn('python3',['-m','http.server','8768','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});let browser;
try{
  let ready=false;for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8768')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${audioFile}`]});
  const errors=[];
  async function open(setup){
    const page=await browser.newPage({acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      window.targets=[];window.writeCount=0;window.writtenBytes=0;window.closeCount=0;window.pickerCalls=[];window.activations=[];
      window.showSaveFilePicker=async options=>{
        window.pickerCalls.push(options);window.activations.push(navigator.userActivation.isActive);
        if(window.cancelPicker)throw new DOMException('cancel','AbortError');
        const root=await navigator.storage.getDirectory();
        const handle=await root.getFileHandle(options.suggestedName,{create:true});window.targets.push(handle);
        return {name:handle.name,getFile:()=>handle.getFile(),createWritable:async()=>{
          const writer=await handle.createWritable();
          return {write:async data=>{
            window.writeCount++;
            if(window.failWrite)throw new DOMException('Disk full','QuotaExceededError');
            if(window.holdWrite)await new Promise(resolve=>{window.releaseWrite=()=>{window.holdWrite=false;resolve();};});
            await writer.write(data);window.writtenBytes+=data.size;
          },close:async()=>{await writer.close();window.closeCount++;},abort:()=>writer.abort()};
        }};
      };
    });
    if(setup)await page.addInitScript(setup);
    await page.goto('http://127.0.0.1:8768');await page.locator('#mono').click();return page;
  }
  async function connect(p){await p.locator('#connectButton').click();await p.waitForFunction(()=>!document.getElementById('recordButton').disabled);}
  async function stop(p){await p.locator('#recordButton').click();await p.waitForFunction(()=>document.getElementById('recordState').textContent.endsWith('終了'));}
  async function download(p,name){const event=p.waitForEvent('download');await p.getByRole('link',{name:'保存済みファイルのコピー'}).first().click();const result=await event;await result.saveAs(join(dir,name));return JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',join(dir,name)],{encoding:'utf8'}));}
  const p=await open();assert.equal(await p.locator('#storageMode').inputValue(),'disk');await p.locator('#stereo').click();await connect(p);
  await p.evaluate(()=>{window.cancelPicker=true;});await p.locator('#recordButton').click();await p.waitForFunction(()=>document.getElementById('notice').textContent.includes('キャンセル'));
  assert.equal(await p.locator('.take').count(),0);assert.equal(await p.locator('#recordButton').isEnabled(),true);
  await p.evaluate(()=>{window.cancelPicker=false;});await p.locator('#recordButton').click();await p.waitForFunction(()=>document.getElementById('recordState').textContent==='録画中');
  await p.waitForFunction(()=>window.writtenBytes>0);assert.equal(await p.evaluate(()=>window.closeCount),0,'writes occur during recording before commit');
  assert.ok(await p.evaluate(()=>window.activations.every(Boolean)),'picker invoked in user gesture');
  assert.equal(await p.evaluate(()=>window.pickerCalls.at(-1).types[0].accept['video/mp4'][0]),'.mp4');
  await p.locator('#pauseButton').click();await p.waitForTimeout(300);await p.locator('#pauseButton').click();await p.waitForTimeout(1100);await stop(p);
  assert.match(await p.locator('#storageStatus').textContent(),/保存完了/);assert.equal(await p.evaluate(()=>window.closeCount),1);
  assert.ok(await p.evaluate(async()=>{const file=await window.targets.at(-1).getFile();return file.size>0&&new TextDecoder().decode((await file.arrayBuffer()).slice(4,8))==='ftyp';}));
  const probe=await download(p,'direct.mp4');assert.equal(probe.streams.find(s=>s.codec_type==='video').codec_name,'h264');assert.equal(probe.streams.find(s=>s.codec_type==='audio').channels,2);
  assert.ok(await p.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return !event.defaultPrevented;}),'already saved file does not produce an unsaved warning');
  const size=await p.evaluate(async()=>(await window.targets[0].getFile()).size);
  await p.locator('#audioMode').click();await connect(p);await p.locator('#recordButton').click();await p.waitForFunction(()=>document.getElementById('recordState').textContent==='録音中');
  const before=await p.evaluate(()=>window.writtenBytes);await p.waitForFunction(previous=>window.writtenBytes>previous,before);await stop(p);
  const audio=await download(p,'direct.mp3');assert.equal(audio.streams.length,1);assert.equal(audio.streams[0].codec_name,'mp3');assert.equal(audio.streams[0].channels,2);assert.equal(await p.evaluate(async()=>(await window.targets[0].getFile()).size),size);
  await p.close();console.log('PASS: default direct MP4/MP3, writes during recording, final commit, picker gesture/cancel, real OPFS file contents, correct formats, repeated recordings, saved state.');

  const slow=await open();await connect(slow);
  await slow.evaluate(async()=>{
    const {DirectFileSink}=await import('./file-sink.js');const create=DirectFileSink.create.bind(DirectFileSink);
    DirectFileSink.create=(handle,options)=>create(handle,{...options,highWater:1,lowWater:0,batchSize:1});window.holdWrite=true;
  });
  await slow.locator('#recordButton').click();await slow.waitForFunction(()=>document.getElementById('recordState').textContent==='ストレージ待ち');await slow.waitForFunction(()=>typeof window.releaseWrite==='function');
  const paused=await slow.locator('#timer').textContent();await slow.waitForTimeout(500);assert.equal(await slow.locator('#timer').textContent(),paused);assert.equal(await slow.locator('#pauseButton').isDisabled(),true);
  await slow.evaluate(()=>window.releaseWrite());await slow.waitForFunction(()=>document.getElementById('recordState').textContent==='録画中');await slow.waitForTimeout(1000);await stop(slow);assert.match(await slow.locator('#storageStatus').textContent(),/保存完了/);await slow.close();
  console.log('PASS: slow disk pauses capture, timer stops, writing drains, capture resumes, recording commits.');

  const fail=await open();await connect(fail);await fail.evaluate(()=>{window.failWrite=true;});await fail.locator('#recordButton').click();await fail.waitForFunction(()=>document.getElementById('storageStatus').textContent.includes('QuotaExceededError'));
  await fail.waitForFunction(()=>!document.getElementById('recordButton').disabled);assert.equal(await fail.locator('.take').count(),0);assert.equal(await fail.evaluate(()=>window.closeCount),0);
  await fail.evaluate(()=>{window.failWrite=false;});await fail.locator('#recordButton').click();await fail.waitForFunction(()=>window.writtenBytes>0);await stop(fail);assert.match(await fail.locator('#storageStatus').textContent(),/保存完了/);await fail.close();
  console.log('PASS: write failure stops capture, does not claim saved or silently use RAM, next recording recovers.');

  const unsupported=await open(()=>{const original=MediaRecorder.isTypeSupported.bind(MediaRecorder);MediaRecorder.isTypeSupported=t=>!t.startsWith('video/mp4')&&original(t);});
  await connect(unsupported);await unsupported.locator('#recordButton').click();await unsupported.waitForFunction(()=>document.getElementById('notice').textContent.includes('直接録画できません'));
  assert.equal(await unsupported.evaluate(()=>window.pickerCalls.length),0);
  await unsupported.locator('#videoFormat').selectOption('webm');await unsupported.locator('#recordButton').click();await unsupported.waitForFunction(()=>window.writtenBytes>0);await stop(unsupported);
  const webm=await download(unsupported,'direct.webm');assert.ok(['vp8','vp9'].includes(webm.streams.find(s=>s.codec_type==='video').codec_name));await unsupported.close();
  const noAPI=await open(()=>{window.showSaveFilePicker=undefined;});assert.equal(await noAPI.locator('#storageMode').inputValue(),'memory');assert.match(await noAPI.locator('#storageStatus').textContent(),/メモリ使用/);await noAPI.close();
  assert.deepEqual(errors,[]);console.log('PASS: explicit unsupported format recovery, direct WebM, unsupported File System API clearly selects memory mode, no page errors.');
}finally{await browser?.close();server.kill();rmSync(dir,{recursive:true,force:true});}
