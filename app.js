import { acquireMedia, peakDecibels, stereoReady, formatTime, selectMime, mediaError } from './media.js';
import { waitFor, stopStream } from './connection.js';
import { Mp3Recorder } from './mp3-recorder.js';
const $ = id => document.getElementById(id);
let sourceStream, outputStream, audioContext, audioBus, audioInput, audioDestination, splitter, meterNodes = [], meterFrame, recorder;
let mode = 'stereo', captureType = 'video', busy = false, chunks = [], startedAt = 0, elapsed = 0, timerInterval, finishing = false;
let recordingMeta, recordingError = false, disconnected = false;
let connectionAttempt, enumerationVersion = 0;
const takes = new Map();
const controls = ['camera', 'microphone', 'quality'];
const isAudioOnly = () => captureType === 'audio';
const action = () => isAudioOnly() ? '録音' : '録画';
function notify(message, type = '') { $('notice').textContent = message; $('notice').className = `notice ${type}`; }
function activeRecording() { return recorder && recorder.state !== 'inactive'; }
function updateControls() {
  const locked = busy || activeRecording() || finishing;
  $('settings').disabled = locked;
  $('cancelConnectButton').hidden = !connectionAttempt;
  $('reconnectButton').hidden = busy || !!sourceStream || activeRecording() || finishing;
  for (const id of ['refreshButton', 'connectButton', 'videoMode', 'audioMode']) $(id).disabled = locked;
  $('recordButton').disabled = busy || finishing || (!activeRecording() && (!sourceStream || (mode === 'stereo' && !stereoReady(sourceStream.getAudioTracks()[0]?.getSettings() || {}))));
}
function updateModeUI() {
  for (const type of ['video', 'audio']) {
    $(`${type}Mode`).classList.toggle('selected', type === captureType);
    $(`${type}Mode`).setAttribute('aria-pressed', String(type === captureType));
  }
  $('videoSettings').hidden = isAudioOnly();
  $('preview').hidden = isAudioOnly();
  $('audioPreview').hidden = !isAudioOnly() || !sourceStream;
  $('settingsTitle').textContent = `${action()}の設定`;
  $('placeholderTitle').textContent = isAudioOnly() ? '音声だけを、MP3 で残しましょう' : '準備ができたら、ここに映像が映ります';
  $('placeholderHint').textContent = isAudioOnly() ? '必要なのはマイクだけ。カメラは使用しません。' : 'カメラとマイクへのアクセスを許可して始めましょう。';
  $('connectButton').textContent = isAudioOnly() ? 'マイクを接続 ↗' : 'カメラ・マイクを接続 ↗';
  $('previewStatus').textContent = isAudioOnly() ? 'マイクを接続してください' : 'カメラを接続してください';
  $('saveFormat').textContent = `${isAudioOnly() ? 'MP3' : 'WebM'} 形式 · クラウド送信なし`;
  $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}をはじめる`;
  $('recordState').textContent = `${action()}前`;
  $('timer').textContent = '00:00';
}
function detachPreview() {
  const preview = $('preview');
  preview.pause(); preview.srcObject = null; preview.load();
}
function stopAudioGraph() {
  cancelAnimationFrame(meterFrame);
  audioInput?.disconnect(); audioBus?.disconnect(); splitter?.disconnect();
  meterNodes.forEach(node => node.disconnect());
  stopStream(audioDestination?.stream);
  audioInput = audioBus = audioDestination = splitter = undefined; meterNodes = [];
  setMeter('L', -60); setMeter('R', -60);
}
function stopDevices() {
  enumerationVersion++;
  document.body.classList.remove('connected');
  detachPreview();
  stopStream(sourceStream); stopStream(outputStream);
  sourceStream = outputStream = undefined;
  stopAudioGraph();
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = undefined;
  $('audioPreview').hidden = true;
  $('meterLabel').textContent = '待機中';
  $('actualVideo').textContent = isAudioOnly() ? '映像：使用しません' : '映像：未接続';
  $('actualAudio').textContent = '音声：未接続';
  $('resolutionBadge').textContent = isAudioOnly() ? 'MP3' : 'PREVIEW';
}
async function enumerateDevices() {
  const version = ++enumerationVersion, stream = sourceStream;
  const devices = await waitFor(navigator.mediaDevices.enumerateDevices(), { timeout: 3000, label: 'デバイス一覧' });
  if (version !== enumerationVersion || stream !== sourceStream) return;
  for (const [id, kind, prefix] of [['camera', 'videoinput', 'カメラ'], ['microphone', 'audioinput', 'マイク']]) {
    const select = $(id);
    const track = kind === 'videoinput' ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0];
    const chosen = track?.getSettings().deviceId || select.value;
    select.replaceChildren();
    devices.filter(device => device.kind === kind).forEach((device, index) => select.add(new Option(device.label || `${prefix} ${index + 1}`, device.deviceId)));
    if (!select.options.length) select.add(new Option(`${prefix}が見つかりません`, ''));
    if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
  }
}
const meterLevels = { L: -60, R: -60 };
function setMeter(channel, decibels) {
  meterLevels[channel] = decibels;
  const meter = $(`meter${channel}`);
  const value = (decibels + 60) / 60;
  meter.querySelectorAll('.led').forEach((led, index) => led.classList.toggle('lit', index < Math.ceil(value * 24)));
  meter.setAttribute('aria-valuenow', String(Math.round(decibels)));
  $(`meter${channel}Db`).textContent = decibels <= -60 ? '−∞' : decibels.toFixed(0);
}
function renderMeters() {
  let level = 0;
  meterNodes.forEach((node, index) => {
    const data = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(data);
    const channel = index === 0 ? 'L' : 'R';
    const decibels = Math.max(peakDecibels(data), meterLevels[channel] - 1.2);
    const value = (decibels + 60) / 60;
    setMeter(channel, decibels);
    level = Math.max(level, value);
  });
  if (isAudioOnly()) {
    document.querySelector('.sound-bars').style.setProperty('--level', level);
    document.querySelector('.sound-orb').style.setProperty('--level', level);
  }
  meterFrame = requestAnimationFrame(renderMeters);
}
function buildAudio() {
  stopAudioGraph();
  audioInput = audioContext.createMediaStreamSource(new MediaStream(sourceStream.getAudioTracks()));
  audioBus = audioContext.createGain();
  audioBus.channelCount = mode === 'stereo' ? 2 : 1;
  audioBus.channelCountMode = 'explicit'; audioBus.channelInterpretation = 'speakers';
  audioInput.connect(audioBus);
  audioDestination = audioContext.createMediaStreamDestination();
  audioDestination.channelCount = audioBus.channelCount;
  audioDestination.channelCountMode = 'explicit'; audioDestination.channelInterpretation = 'speakers';
  audioBus.connect(audioDestination);
  splitter = audioContext.createChannelSplitter(2); audioInput.connect(splitter);
  meterNodes = [0, 1].map(channel => {
    const analyser = audioContext.createAnalyser(); analyser.fftSize = 1024;
    splitter.connect(analyser, channel); return analyser;
  });
  renderMeters();
}
async function connect(reason = 'all') {
  if (busy || activeRecording() || finishing) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notify('カメラ・マイクを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error'); return;
  }
  if (!window.AudioContext || (!isAudioOnly() && !window.MediaRecorder)) {
    notify('このブラウザは収録に対応していません。最新の Chrome を使用してください。', 'error'); return;
  }
  const controller = new AbortController(), { signal } = controller;
  const timeout = setTimeout(() => controller.abort(new DOMException('接続が 20 秒以内に完了しませんでした。権限とデバイスを確認し、再接続してください。', 'TimeoutError')), 20000);
  connectionAttempt = controller; enumerationVersion++;
  busy = true; disconnected = false; updateControls();
  const camera = $('camera').value, microphone = $('microphone').value, quality = $('quality').value;
  let stage = '音声の準備';
  try {
    // Invoke resume in the original click/change gesture, before permission/driver awaits.
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext({ sampleRate: 48000 });
    const audioReady = audioContext.state === 'running' ? Promise.resolve() : audioContext.resume();
    audioReady.catch(() => {});
    const retained = sourceStream;
    const needVideo = !isAudioOnly() && (reason !== 'audio' || !retained?.getVideoTracks().some(track => track.readyState === 'live'));
    const needAudio = reason !== 'video' || !retained?.getAudioTracks().some(track => track.readyState === 'live');
    if (needVideo) detachPreview();
    if (needAudio) stopAudioGraph();
    if (!sourceStream) sourceStream = new MediaStream();
    for (const track of sourceStream.getTracks()) {
      if ((needVideo && track.kind === 'video') || (needAudio && track.kind === 'audio')) {
        track.onended = null; track.stop(); sourceStream.removeTrack(track);
      }
    }
    document.body.classList.remove('connected');
    stage = needVideo && needAudio ? 'カメラ・マイク' : needVideo ? 'カメラ切替' : 'マイク切替';
    $('previewStatus').textContent = `${stage}に接続中…`;
    notify(`${stage}に接続しています。権限の確認画面が出たら許可してください。応答がない場合はキャンセルできます。`);
    const connection = await acquireMedia(async constraints => {
      if (!needAudio) constraints.audio = false;
      if (!needVideo) constraints.video = false;
      const request = () => waitFor(navigator.mediaDevices.getUserMedia(constraints), { signal, onLate: stopStream });
      try { return await request(); }
      catch (error) {
        if (!needVideo || needAudio || error.name !== 'NotReadableError' || signal.aborted) throw error;
        // Some mobile/Windows drivers release Front/Back camera hardware asynchronously.
        notify('前のカメラの解放を待って、切替を再試行しています…');
        await waitFor(new Promise(resolve => setTimeout(resolve, 250)), { signal });
        return request();
      }
    }, camera, microphone, quality, mode, needVideo ? 'video' : 'audio');
    // An aborted attempt must never attach a late camera/microphone to the page.
    if (signal.aborted) { stopStream(connection.stream); throw signal.reason; }
    connection.stream.getTracks().forEach(track => sourceStream.addTrack(track));
    stage = '音声の開始'; $('previewStatus').textContent = `${stage}…`;
    await waitFor(audioReady, { signal, timeout: 3000, label: '音声の開始' });
    if (needAudio || !audioDestination) buildAudio();
    outputStream = new MediaStream([...sourceStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
    if (isAudioOnly() && !audioContext.audioWorklet) throw new Error('このブラウザは MP3 録音に対応していません。最新の Chrome を使用してください。');
    const videoSettings = sourceStream.getVideoTracks()[0]?.getSettings();
    const audioSettings = sourceStream.getAudioTracks()[0].getSettings();
    const actualQuality = videoSettings ? `${videoSettings.width}x${videoSettings.height}` : quality;
    const adjusted = !isAudioOnly() && actualQuality !== quality;
    const adjustment = adjusted ? `${quality.split('x')[1]}p から ${videoSettings.height}p に自動調整しました。` : '';
    if (!isAudioOnly()) {
      if (![...$('quality').options].some(option => option.value === actualQuality)) $('quality').add(new Option(`${videoSettings.height}p · ${videoSettings.width} × ${videoSettings.height}（自動）`, actualQuality));
      $('quality').value = actualQuality;
      $('qualityHint').textContent = adjustment || 'カメラが対応する解像度へ自動調整します。';
      $('qualityHint').classList.toggle('adjusted', adjusted);
      stage = '映像の開始'; $('previewStatus').textContent = `${stage}…`;
      if ($('preview').srcObject !== sourceStream) $('preview').srcObject = sourceStream;
      await waitFor($('preview').play(), { signal, timeout: 5000, label: '映像の開始' });
    }
    $('placeholder').hidden = true; document.body.classList.add('connected');
    $('audioPreview').hidden = !isAudioOnly();
    $('previewStatus').textContent = isAudioOnly() ? '● マイク接続中 · カメラ不使用' : '● プレビュー中';
    $('actualVideo').textContent = isAudioOnly() ? '映像：使用しません' : `映像：${videoSettings.width} × ${videoSettings.height} · ${Math.round(videoSettings.frameRate || 0)} fps`;
    $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · 録音：${mode === 'stereo' ? '2 ch' : '1 ch'}`;
    $('resolutionBadge').textContent = isAudioOnly() ? 'MP3' : `${videoSettings.height}p`;
    $('meterLabel').textContent = '入力を確認';
    if (mode === 'stereo' && !stereoReady(audioSettings)) {
      notify(`${adjustment}このマイクの入力はステレオ（2 ch）と確認できません。ステレオ${action()}は開始できません。対応する USB マイクを選ぶか、モノラルに切り替えてください。`, 'warning');
      $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · ステレオ非対応`;
    } else notify(`${adjustment}${action()}できます。${mode === 'stereo' ? 'ステレオ 2 ch' : 'モノラル 1 ch'}で${isAudioOnly() ? ' MP3 に' : ''}保存します。まずは短い試し撮りで確認してください。`);
    sourceStream.getTracks().forEach(track => { track.onended = () => {
      disconnected = true;
      if (connectionAttempt) connectionAttempt.abort(new DOMException('デバイスが切断されました。', 'NotReadableError'));
      if (activeRecording()) stopRecording();
      if (!finishing) { stopDevices(); $('placeholder').hidden = false; }
      $('previewStatus').textContent = 'デバイスが切断されました';
      notify('デバイスが切断されました。収録中のデータは停止して一覧に残します。デバイスを再接続してください。', 'error'); updateControls();
    }; });
    // Device enumeration is optional metadata; never hold preview/controls hostage to it.
    enumerateDevices().catch(() => {});
  } catch (error) {
    stopDevices(); $('placeholder').hidden = false;
    $('previewStatus').textContent = error.name === 'AbortError' ? '接続をキャンセルしました' : `${stage}で接続できませんでした`;
    notify(`${error.name === 'Error' ? error.message : mediaError(error, captureType)}${error.name === 'AbortError' ? '' : `（${stage} / ${error.name}）`}`, error.name === 'AbortError' ? '' : 'error');
    enumerateDevices().catch(() => {});
  } finally {
    clearTimeout(timeout);
    if (connectionAttempt === controller) connectionAttempt = undefined;
    busy = false; updateControls();
  }
}
function updateTimer() {
  const seconds = (elapsed + (recorder?.state === 'recording' ? performance.now() - startedAt : 0)) / 1000;
  $('timer').textContent = $('overlayTime').textContent = formatTime(seconds);
}
async function startRecording() {
  if (!sourceStream || !outputStream || busy || finishing || activeRecording()) return;
  if (mode === 'stereo' && !stereoReady(sourceStream.getAudioTracks()[0].getSettings())) return;
  busy = true; updateControls();
  try {
    await waitFor(audioContext.resume(), { timeout: 3000, label: '音声の開始' });
    if (isAudioOnly()) recorder = await Mp3Recorder.create(audioContext, audioBus, mode === 'stereo' ? 2 : 1);
    else {
      const mimeType = selectMime(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('WebM 録画に対応していません。最新の Chrome を使用してください。');
      recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 8000000, audioBitsPerSecond: mode === 'stereo' ? 192000 : 96000 });
    }
    if (!sourceStream || sourceStream.getAudioTracks()[0].readyState !== 'live') throw new Error('マイクが切断されました。再接続してください。');
    chunks = []; elapsed = 0; recordingError = false;
    const video = sourceStream.getVideoTracks()[0]?.getSettings();
    recordingMeta = { captureType, width: video?.width, height: video?.height, channels: mode === 'stereo' ? 2 : 1, date: new Date() };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { recordingError = true; notify('収録エラーが発生しました。停止後のファイルを確認し、保存できるデータを保存してください。', 'error'); if (activeRecording()) stopRecording(); };
    recorder.onstop = finishRecording;
    recorder.start(1000); startedAt = performance.now();
    $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}を停止する`;
    $('recordButton').classList.add('recording'); $('recordState').textContent = `${action()}中`;
    $('pauseButton').hidden = false; $('pauseButton').textContent = '一時停止';
    $('liveBadge').textContent = '● REC'; $('liveBadge').hidden = $('recordOverlay').hidden = false;
    timerInterval = setInterval(updateTimer, 250);
    notify(`${action()}中です。長時間の収録はメモリを使用します。適度に停止して端末に保存してください。`);
  } catch (error) {
    recorder?.dispose?.();
    notify(`${action()}を開始できませんでした。${error.message}`, 'error');
  } finally { busy = false; updateControls(); }
}
function stopRecording() {
  if (!activeRecording()) return;
  if (recorder.state === 'recording') elapsed += performance.now() - startedAt;
  finishing = true; recorder.stop();
  clearInterval(timerInterval); updateTimer(); updateControls();
  $('pauseButton').disabled = true; notify(`${action()}したファイルを準備しています…`);
}
function finishRecording() {
  clearInterval(timerInterval);
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' }); chunks = [];
  if (blob.size) addTake(blob, recordingMeta, elapsed);
  finishing = false;
  $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}をはじめる`;
  $('recordButton').classList.remove('recording'); $('recordState').textContent = `${action()}終了`;
  $('pauseButton').hidden = true; $('pauseButton').disabled = false;
  $('liveBadge').hidden = $('recordOverlay').hidden = true;
  if (disconnected) { stopDevices(); $('placeholder').hidden = false; }
  if (blob.size) notify(recordingError ? 'エラー発生前のファイルを残しました。再生して確認し、保存してください。' : `${action()}ができました。下で再生して確認し「端末に保存」を押してください。`, recordingError ? 'warning' : '');
  else notify('収録データがありません。デバイスの接続を確認して再収録してください。', 'error');
  updateControls();
}
function addTake(blob, meta, duration) {
  const audioOnly = meta.captureType === 'audio';
  const url = URL.createObjectURL(blob), extension = audioOnly ? 'mp3' : 'webm';
  const filename = `frame-${meta.date.toISOString().replace(/[:.]/g, '-')}.${extension}`;
  const item = document.createElement('article'); item.className = 'take';
  const playback = document.createElement(audioOnly ? 'audio' : 'video');
  playback.controls = true; if (!audioOnly) playback.playsInline = true;
  playback.src = url; playback.preload = 'metadata';
  const info = document.createElement('div');
  const title = document.createElement('h3'); title.textContent = `${audioOnly ? '♫ 録音' : '▣ 動画'} · ${meta.date.toLocaleString('ja-JP')}`;
  const details = document.createElement('p'); details.textContent = `${audioOnly ? 'MP3' : `${meta.width} × ${meta.height} · WebM`} · ${meta.channels === 2 ? 'ステレオ' : 'モノラル'} · ${formatTime(duration / 1000)} · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  const actions = document.createElement('div'); actions.className = 'take-actions';
  const save = document.createElement('a'); save.href = url; save.download = filename; save.textContent = '↓ 端末に保存';
  const saved = document.createElement('p'); saved.textContent = '未保存：端末に保存してください';
  save.addEventListener('click', () => { saved.textContent = 'ダウンロードを開始しました。Chrome のダウンロード一覧で保存完了を確認してください。'; });
  const remove = document.createElement('button'); remove.textContent = '削除';
  remove.addEventListener('click', () => {
    if (!confirm('このページからファイルを削除します。端末に保存していないデータは復元できません。削除しますか？')) return;
    playback.pause(); playback.removeAttribute('src'); playback.load(); URL.revokeObjectURL(url); takes.delete(url); item.remove();
    $('recordingsSection').hidden = !takes.size;
  });
  actions.append(save, remove); info.append(title, details, actions, saved); item.append(playback, info);
  $('recordingsList').prepend(item); $('recordingsSection').hidden = false; takes.set(url, blob);
}
$('connectButton').addEventListener('click', () => connect());
$('reconnectButton').addEventListener('click', () => connect());
$('cancelConnectButton').addEventListener('click', () => connectionAttempt?.abort(new DOMException('接続をキャンセルしました。', 'AbortError')));
controls.forEach(id => $(id).addEventListener('change', () => { if (sourceStream) connect(id === 'microphone' ? 'audio' : 'video'); }));
for (const type of ['video', 'audio']) $(`${type}Mode`).addEventListener('click', () => {
  if (captureType === type || busy || activeRecording() || finishing) return;
  captureType = type; stopDevices();
  $('placeholder').hidden = false; updateModeUI(); updateControls();
  notify(isAudioOnly() ? '「マイクを接続」を押してください。カメラなしで MP3 を録音できます。' : '「カメラ・マイクを接続」を押してください。動画は WebM で保存します。');
});
for (const nextMode of ['stereo', 'mono']) $(nextMode).addEventListener('click', () => {
  if (mode === nextMode) return;
  mode = nextMode;
  for (const id of ['stereo', 'mono']) { $(id).classList.toggle('selected', id === mode); $(id).setAttribute('aria-pressed', String(id === mode)); }
  $('modeHint').textContent = mode === 'stereo' ? '左右の音を分けて録音。USB ステレオマイクにおすすめ。' : '左右の音を 1 チャンネルにまとめて録音。声の録音におすすめ。';
  if (sourceStream) connect('audio');
});
$('refreshButton').addEventListener('click', async () => { try { await enumerateDevices(); notify('デバイス一覧を更新しました。使用する入力を選んでください。'); } catch (error) { notify(mediaError(error, captureType), 'error'); } });
$('recordButton').addEventListener('click', () => activeRecording() ? stopRecording() : startRecording());
$('pauseButton').addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    elapsed += performance.now() - startedAt; recorder.pause();
    $('pauseButton').textContent = `${action()}を再開`; $('recordState').textContent = '一時停止'; $('liveBadge').textContent = 'Ⅱ PAUSED';
  } else if (recorder?.state === 'paused') {
    recorder.resume(); startedAt = performance.now();
    $('pauseButton').textContent = '一時停止'; $('recordState').textContent = `${action()}中`; $('liveBadge').textContent = '● REC';
  }
  updateTimer();
});
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close());
navigator.mediaDevices?.addEventListener('devicechange', () => { if (!busy && !activeRecording() && !finishing) enumerateDevices().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (activeRecording() || finishing || takes.size) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { connectionAttempt?.abort(new DOMException('ページを閉じました。', 'AbortError'));  if (activeRecording()) recorder.stop(); stopDevices(); });
if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) notify('カメラ・マイクを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error');
