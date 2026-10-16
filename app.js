import { captureConstraints, stereoReady, formatTime, selectMime, mediaError } from './media.js';
import { Mp3Recorder } from './mp3-recorder.js';
const $ = id => document.getElementById(id);
let sourceStream, outputStream, audioContext, audioBus, splitter, meterNodes = [], meterFrame, recorder;
let mode = 'stereo', captureType = 'video', busy = false, chunks = [], startedAt = 0, elapsed = 0, timerInterval, finishing = false;
let recordingMeta, recordingError = false, disconnected = false;
const takes = new Map();
const controls = ['camera', 'microphone', 'quality'];
const isAudioOnly = () => captureType === 'audio';
const action = () => isAudioOnly() ? '録音' : '録画';
function notify(message, type = '') { $('notice').textContent = message; $('notice').className = `notice ${type}`; }
function activeRecording() { return recorder && recorder.state !== 'inactive'; }
function updateControls() {
  const locked = busy || activeRecording() || finishing;
  $('settings').disabled = locked;
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
function stopDevices() {
  cancelAnimationFrame(meterFrame);
  sourceStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  outputStream?.getTracks().forEach(track => track.stop());
  sourceStream = outputStream = undefined;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = audioBus = undefined;
  meterNodes = [];
  $('preview').srcObject = null;
  $('audioPreview').hidden = true;
  $('meterL').value = $('meterR').value = 0;
  $('meterLabel').textContent = '待機中';
  $('actualVideo').textContent = isAudioOnly() ? '映像：使用しません' : '映像：未接続';
  $('actualAudio').textContent = '音声：未接続';
  $('resolutionBadge').textContent = isAudioOnly() ? 'MP3' : 'PREVIEW';
}
async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind, prefix] of [['camera', 'videoinput', 'カメラ'], ['microphone', 'audioinput', 'マイク']]) {
    const select = $(id), chosen = select.value;
    select.replaceChildren();
    devices.filter(device => device.kind === kind).forEach((device, index) => select.add(new Option(device.label || `${prefix} ${index + 1}`, device.deviceId)));
    if (!select.options.length) select.add(new Option(`${prefix}が見つかりません`, ''));
    if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
  }
}
function renderMeters() {
  let level = 0;
  meterNodes.forEach((node, index) => {
    const data = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    const value = Math.min(1, rms * 4);
    $(index === 0 ? 'meterL' : 'meterR').value = value;
    level = Math.max(level, value);
  });
  if (isAudioOnly()) {
    document.querySelector('.sound-bars').style.setProperty('--level', level);
    document.querySelector('.sound-orb').style.setProperty('--level', level);
  }
  meterFrame = requestAnimationFrame(renderMeters);
}
async function buildAudio() {
  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.resume();
  const input = audioContext.createMediaStreamSource(new MediaStream(sourceStream.getAudioTracks()));
  // Explicit speaker mixing preserves stereo and downmixes mono before either encoder.
  audioBus = audioContext.createGain();
  audioBus.channelCount = mode === 'stereo' ? 2 : 1;
  audioBus.channelCountMode = 'explicit'; audioBus.channelInterpretation = 'speakers';
  input.connect(audioBus);
  const destination = audioContext.createMediaStreamDestination();
  destination.channelCount = audioBus.channelCount;
  destination.channelCountMode = 'explicit'; destination.channelInterpretation = 'speakers';
  audioBus.connect(destination);
  splitter = audioContext.createChannelSplitter(2); input.connect(splitter);
  meterNodes = [0, 1].map(channel => {
    const analyser = audioContext.createAnalyser(); analyser.fftSize = 1024;
    splitter.connect(analyser, channel); return analyser;
  });
  outputStream = new MediaStream([...sourceStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
  renderMeters();
}
async function connect() {
  if (busy || activeRecording() || finishing) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notify('カメラ・マイクを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error'); return;
  }
  if (!window.AudioContext || (!isAudioOnly() && !window.MediaRecorder)) {
    notify('このブラウザは収録に対応していません。最新の Chrome を使用してください。', 'error'); return;
  }
  busy = true; updateControls(); disconnected = false;
  notify(`${isAudioOnly() ? 'マイク' : 'カメラとマイク'}に接続しています。確認画面が出たらアクセスを許可してください。`);
  stopDevices();
  try {
    sourceStream = await navigator.mediaDevices.getUserMedia(captureConstraints($('camera').value, $('microphone').value, $('quality').value, mode, captureType));
    const videoSettings = sourceStream.getVideoTracks()[0]?.getSettings();
    const audioSettings = sourceStream.getAudioTracks()[0].getSettings();
    await enumerateDevices();
    if (videoSettings?.deviceId) $('camera').value = videoSettings.deviceId;
    if (audioSettings.deviceId) $('microphone').value = audioSettings.deviceId;
    await buildAudio();
    if (isAudioOnly() && !audioContext.audioWorklet) throw new Error('このブラウザは MP3 録音に対応していません。最新の Chrome を使用してください。');
    if (!isAudioOnly()) { $('preview').srcObject = sourceStream; await $('preview').play(); }
    $('placeholder').hidden = true;
    $('audioPreview').hidden = !isAudioOnly();
    $('previewStatus').textContent = isAudioOnly() ? '● マイク接続中 · カメラ不使用' : '● プレビュー中';
    $('actualVideo').textContent = isAudioOnly() ? '映像：使用しません' : `映像：${videoSettings.width} × ${videoSettings.height} · ${Math.round(videoSettings.frameRate || 0)} fps`;
    $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · 録音：${mode === 'stereo' ? '2 ch' : '1 ch'}`;
    $('resolutionBadge').textContent = isAudioOnly() ? 'MP3' : `${videoSettings.height}p`;
    $('meterLabel').textContent = '入力を確認';
    if (mode === 'stereo' && !stereoReady(audioSettings)) {
      notify(`このマイクの入力はステレオ（2 ch）と確認できません。ステレオ${action()}は開始できません。対応する USB マイクを選ぶか、モノラルに切り替えてください。`, 'warning');
      $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · ステレオ非対応`;
    } else notify(`${action()}できます。${mode === 'stereo' ? 'ステレオ 2 ch' : 'モノラル 1 ch'}で${isAudioOnly() ? ' MP3 に' : ''}保存します。まずは短い試し撮りで確認してください。`);
    sourceStream.getTracks().forEach(track => { track.onended = () => {
      disconnected = true;
      if (activeRecording()) stopRecording();
      // Keep the audio context alive until the worklet flushes its final PCM block.
      if (!finishing) { stopDevices(); $('placeholder').hidden = false; }
      $('previewStatus').textContent = 'デバイスが切断されました';
      notify('デバイスが切断されました。収録中のデータは停止して一覧に残します。デバイスを再接続してください。', 'error'); updateControls();
    }; });
  } catch (error) {
    stopDevices(); $('placeholder').hidden = false;
    $('previewStatus').textContent = '接続できませんでした';
    // Even after a failed resolution request, expose available devices for recovery.
    await enumerateDevices().catch(() => {});
    notify(error.name === 'Error' ? error.message : mediaError(error, captureType), 'error');
  } finally { busy = false; updateControls(); }
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
    await audioContext.resume();
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
$('connectButton').addEventListener('click', connect);
controls.forEach(id => $(id).addEventListener('change', () => { if (sourceStream) connect(); }));
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
  if (sourceStream) connect();
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
window.addEventListener('pagehide', () => { if (activeRecording()) recorder.stop(); stopDevices(); });
if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) notify('カメラ・マイクを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error');
