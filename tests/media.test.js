import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingPlans, acquireMedia, peakDecibels, captureConstraints, stereoReady, formatTime, selectMime, mediaError} from '../media.js';
test('希望解像度と選択デバイスを指定し、音声処理を無効にする', () => {
  const {video, audio} = captureConstraints('usb-camera', 'usb-mic', '1920x1080', 'stereo');
  assert.deepEqual(video.width, {ideal:1920}); assert.deepEqual(video.height, {ideal:1080});
  assert.deepEqual(video.deviceId, {exact:'usb-camera'}); assert.deepEqual(audio.deviceId,{exact:'usb-mic'});
  assert.deepEqual(audio.channelCount,{ideal:2});
  assert.equal(audio.echoCancellation,false); assert.equal(audio.noiseSuppression,false); assert.equal(audio.autoGainControl,false);
});
test('モノラルは1ch、初回はデバイス指定なし', () => {
  const {video,audio}=captureConstraints('', '', '1280x720','mono');
  assert.equal(video.deviceId,undefined); assert.equal(audio.deviceId,undefined);
  assert.deepEqual(audio.channelCount,{ideal:1}); assert.deepEqual(video.height,{ideal:720});
});
test('不明またはモノラル入力をステレオと誤認しない',()=>{
  assert.equal(stereoReady({}),false); assert.equal(stereoReady({channelCount:1}),false);
  assert.equal(stereoReady({channelCount:2}),true);
});
test('1時間以上と端数の時間表示',()=>{
  assert.equal(formatTime(0),'00:00'); assert.equal(formatTime(65.8),'01:05'); assert.equal(formatTime(3661),'01:01:01');
});
test('対応コーデックへフォールバックし、非対応を検出',()=>{
  assert.equal(selectMime(x=>x.includes('vp8')),'video/webm;codecs=vp8,opus'); assert.equal(selectMime(()=>false),undefined);
});
test('解像度エラーと権限エラーの対処を表示',()=>{
  assert.match(mediaError({name:'OverconstrainedError'}),/720p/); assert.match(mediaError({name:'NotAllowedError'}),/許可/);
});

test('録音のみはカメラを要求せず、ステレオの音声設定を維持する', () => {
  const { video, audio } = captureConstraints('unavailable-camera', 'usb-mic', '1920x1080', 'stereo', 'audio');
  assert.equal(video, false);
  assert.deepEqual(audio.deviceId, {exact:'usb-mic'});
  assert.deepEqual(audio.channelCount, {ideal:2});
});
test('音声のみの制約エラーはカメラの解像度を案内しない', () => {
  assert.doesNotMatch(mediaError({name:'OverconstrainedError'}, 'audio'), /720p/);
  assert.match(mediaError({name:'OverconstrainedError',constraint:'deviceId'}), /再検出/);
  assert.match(mediaError({name:'NotAllowedError'}), /Windows/);
});

test('1080p非対応なら選択デバイスと音声設定を保って720pへ自動調整', async () => {
  const calls = [], stream = { id: '720p-stream' };
  const result = await acquireMedia(async constraints => {
    calls.push(constraints);
    if (constraints.video.height.ideal > 720) throw Object.assign(new Error('unsupported'), {name:'OverconstrainedError', constraint:'height'});
    return stream;
  }, 'usb-camera', 'usb-mic', '1920x1080', 'stereo');
  assert.deepEqual(calls.map(c=>c.video.height.ideal), [1080,720]);
  assert.equal(result.stream,stream); assert.equal(result.quality,'1280x720'); assert.equal(result.requestedQuality,'1920x1080');
  assert.deepEqual(calls[1].video.deviceId,{exact:'usb-camera'}); assert.deepEqual(calls[1].audio,calls[0].audio);
});
test('720pも非対応なら480p、対応する1080pはそのまま', async () => {
  const calls=[];
  const result=await acquireMedia(async constraints=>{
    calls.push(constraints.video.height.ideal);
    if (constraints.video.height.ideal>480) throw Object.assign(new Error(),{name:'OverconstrainedError'});
    return {};
  },'','','1920x1080','mono');
  assert.deepEqual(calls,[1080,720,480]); assert.equal(result.quality,'640x480');
  let count=0; await acquireMedia(async()=>{count++;return {};},'','','1920x1080','mono'); assert.equal(count,1);
});
test('権限拒否、デバイスID、音声設定の失敗では解像度を再試行しない',async()=>{
  for(const error of [{name:'NotAllowedError'},{name:'NotReadableError'},{name:'OverconstrainedError',constraint:'deviceId'},{name:'OverconstrainedError',constraint:'channelCount'}]) {
    let count=0;
    await assert.rejects(acquireMedia(async()=>{count++;throw error;},'','','1920x1080','stereo'));
    assert.equal(count,1);
  }
  let count=0;
  await assert.rejects(acquireMedia(async()=>{count++;throw {name:'OverconstrainedError'};},'','','1920x1080','mono','audio'));
  assert.equal(count,1);
});
test('LEDメーターは実際のピークからdBFSを計算する',()=>{
  assert.equal(peakDecibels(new Float32Array([0,0])), -60);
  assert.equal(peakDecibels(new Float32Array([1,-1])),0);
  assert.ok(Math.abs(peakDecibels(new Float32Array([.5,-.5]))+6.02)<.01);
  assert.ok(peakDecibels(new Float32Array([.1]))<-15);
  assert.ok(peakDecibels(new Float32Array([.3]))>-15);
  assert.ok(peakDecibels(new Float32Array([.9]))>-5);
});

test('初回はFrontを優先し、解像度交渉で返った720pをそのまま採用する',async()=>{
  const c=captureConstraints('', '', '1920x1080','mono');
  assert.deepEqual(c.video.facingMode,{ideal:'user'});
  assert.equal(captureConstraints('front-id','','1920x1080','mono').video.facingMode,undefined);
  let calls=0;
  const result=await acquireMedia(async()=>{calls++;return {getVideoTracks:()=>[{getSettings:()=>({width:1280,height:720})}]};},'','','1920x1080','mono');
  assert.equal(calls,1); assert.equal(result.quality,'1280x720');
});

test('MP4はH.264/AACを優先し、H.264/OpusとWebMは実変換を要求する',()=>{
  const all=recordingPlans(()=>true);
  assert.match(all[0].mimeType,/mp4a/);assert.equal(all[0].needsConversion,false);
  const opus=recordingPlans(t=>t.includes('opus')&&t.startsWith('video/mp4'));
  assert.equal(opus[0].needsConversion,true);assert.equal(opus[0].copyVideo,true);
  const webm=recordingPlans(t=>t.startsWith('video/webm'));
  assert.equal(webm[0].needsConversion,true);assert.equal(webm[0].copyVideo,false);
  assert.deepEqual(recordingPlans(()=>false),[]);
});
test('WebM選択時は変換せず、MP4と混同しない',()=>{
  const plans=recordingPlans(()=>true,'webm');
  assert.ok(plans.every(p=>p.format==='webm'&&!p.needsConversion));
});
