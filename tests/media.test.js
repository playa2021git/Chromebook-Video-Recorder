import test from 'node:test';
import assert from 'node:assert/strict';
import {captureConstraints, stereoReady, formatTime, selectMime, mediaError} from '../media.js';
test('1080p と選択デバイスを厳密に指定し、音声処理を無効にする', () => {
  const {video, audio} = captureConstraints('usb-camera', 'usb-mic', '1920x1080', 'stereo');
  assert.deepEqual(video.width, {exact:1920}); assert.deepEqual(video.height, {exact:1080});
  assert.deepEqual(video.deviceId, {exact:'usb-camera'}); assert.deepEqual(audio.deviceId,{exact:'usb-mic'});
  assert.deepEqual(audio.channelCount,{ideal:2});
  assert.equal(audio.echoCancellation,false); assert.equal(audio.noiseSuppression,false); assert.equal(audio.autoGainControl,false);
});
test('モノラルは1ch、初回はデバイス指定なし', () => {
  const {video,audio}=captureConstraints('', '', '1280x720','mono');
  assert.equal(video.deviceId,undefined); assert.equal(audio.deviceId,undefined);
  assert.deepEqual(audio.channelCount,{ideal:1}); assert.deepEqual(video.height,{exact:720});
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
