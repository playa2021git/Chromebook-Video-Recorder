import { captureConstraints, stereoReady, formatTime, selectMime, mediaError } from './media.js';
const $ = id => document.getElementById(id);
let sourceStream, outputStream, audioContext, splitter, meterNodes = [], meterFrame, recorder;
let mode = 'stereo', busy = false, chunks = [], startedAt = 0, elapsed = 0, timerInterval, finishing = false;
let recordingMeta, recordingError = false;
const takes = new Map();
const controls = ['camera', 'microphone', 'quality'];
function notify(message, type = '') { $('notice').textContent = message; $('notice').className = `notice ${type}`; }
function activeRecording() { return recorder && recorder.state !== 'inactive'; }
function updateControls() {
  const locked = busy || activeRecording() || finishing;
  $('settings').disabled = locked;
  $('refreshButton').disabled = locked;
  $('connectButton').disabled = locked;
  $('recordButton').disabled = busy || finishing || !sourceStream || (mode === 'stereo' && !stereoReady(sourceStream.getAudioTracks()[0]?.getSettings() || {}));
}
function stopDevices() {
  cancelAnimationFrame(meterFrame);
  sourceStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  outputStream?.getTracks().forEach(track => track.stop());
  sourceStream = outputStream = undefined;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = undefined;
  meterNodes = [];
  $('preview').srcObject = null;
  $('meterL').value = $('meterR').value = 0;
  $('meterLabel').textContent = '待機中';
  $('actualVideo').textContent = '映像：未接続';
  $('actualAudio').textContent = '音声：未接続';
  $('resolutionBadge').textContent = 'PREVIEW';
}
async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind, prefix] of [['camera', 'videoinput', 'カメラ'], ['microphone', 'audioinput', 'マイク']]) {
    const select = $(id);
    const chosen = select.value;
    select.replaceChildren();
    devices.filter(device => device.kind === kind).forEach((device, index) => {
      select.add(new Option(device.label || `${prefix} ${index + 1}`, device.deviceId));
    });
    if (!select.options.length) select.add(new Option(`${prefix}が見つかりません`, ''));
    if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
  }
}
function renderMeters() {
  meterNodes.forEach((node, index) => {
    const data = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    $(index === 0 ? 'meterL' : 'meterR').value = Math.min(1, rms * 4);
  });
  meterFrame = requestAnimationFrame(renderMeters);
}
async function buildAudio() {
  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.resume();
  const input = audioContext.createMediaStreamSource(new MediaStream(sourceStream.getAudioTracks()));
  const destination = audioContext.createMediaStreamDestination();
  destination.channelCount = mode === 'stereo' ? 2 : 1;
  destination.channelCountMode = 'explicit';
  destination.channelInterpretation = 'speakers';
  input.connect(destination);
  // Monitor the input channels independently without playing microphone audio to speakers.
  splitter = audioContext.createChannelSplitter(2);
  input.connect(splitter);
  meterNodes = [0, 1].map(channel => {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    splitter.connect(analyser, channel);
    return analyser;
  });
  outputStream = new MediaStream([...sourceStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
  renderMeters();
}
async function connect() {
  if (busy || activeRecording() || finishing) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notify('カメラを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error'); return;
  }
  if (!window.MediaRecorder || !window.AudioContext) {
    notify('このブラウザは録画に対応していません。最新の Chrome を使用してください。', 'error'); return;
  }
  busy = true; updateControls();
  notify('カメラとマイクに接続しています。確認画面が出たらアクセスを許可してください。');
  stopDevices();
  try {
    sourceStream = await navigator.mediaDevices.getUserMedia(captureConstraints($('camera').value, $('microphone').value, $('quality').value, mode));
    const videoSettings = sourceStream.getVideoTracks()[0].getSettings();
    const audioSettings = sourceStream.getAudioTracks()[0].getSettings();
    await enumerateDevices();
    if (videoSettings.deviceId) $('camera').value = videoSettings.deviceId;
    if (audioSettings.deviceId) $('microphone').value = audioSettings.deviceId;
    await buildAudio();
    $('preview').srcObject = sourceStream;
    await $('preview').play();
    $('placeholder').hidden = true;
    $('previewStatus').textContent = '● プレビュー中';
    $('actualVideo').textContent = `映像：${videoSettings.width} × ${videoSettings.height} · ${Math.round(videoSettings.frameRate || 0)} fps`;
    $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · 録音：${mode === 'stereo' ? '2 ch' : '1 ch'}`;
    $('resolutionBadge').textContent = `${videoSettings.height}p`;
    $('meterLabel').textContent = '入力を確認';
    if (mode === 'stereo' && !stereoReady(audioSettings)) {
      notify('このマイクの入力はステレオ（2 ch）と確認できません。ステレオ録画は開始できません。対応する USB マイクを選ぶか、モノラルに切り替えてください。', 'warning');
      $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · ステレオ非対応`;
    } else {
      notify(`録画できます。${mode === 'stereo' ? 'ステレオ 2 ch' : 'モノラル 1 ch'}で保存します。まずは短い試し撮りで映像と音声を確認してください。`);
    }
    sourceStream.getTracks().forEach(track => { track.onended = () => {
      if (activeRecording()) stopRecording();
      stopDevices(); $('placeholder').hidden = false;
      $('previewStatus').textContent = 'デバイスが切断されました';
      notify('カメラまたはマイクが切断されました。録画中のデータは停止して一覧に残します。デバイスを再接続してください。', 'error');
      updateControls();
    }; });
  } catch (error) {
    stopDevices(); $('placeholder').hidden = false;
    $('previewStatus').textContent = '接続できませんでした';
    notify(mediaError(error), 'error');
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
    const mimeType = selectMime(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('WebM 録画に対応していません。最新の Chrome を使用してください。');
    recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 8000000, audioBitsPerSecond: mode === 'stereo' ? 192000 : 96000 });
    chunks = []; elapsed = 0; recordingError = false;
    const video = sourceStream.getVideoTracks()[0].getSettings();
    recordingMeta = { width: video.width, height: video.height, channels: mode === 'stereo' ? 2 : 1, date: new Date() };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { recordingError = true; notify('録画エラーが発生しました。停止後の動画を確認し、保存できるデータを保存してください。', 'error'); if (activeRecording()) stopRecording(); };
    recorder.onstop = finishRecording;
    recorder.start(1000); startedAt = performance.now();
    $('recordButton').innerHTML = '<span class="record-icon"></span>録画を停止する';
    $('recordButton').classList.add('recording');
    $('recordState').textContent = '録画中';
    $('pauseButton').hidden = false; $('pauseButton').textContent = '一時停止';
    $('liveBadge').textContent = '● REC';
    $('liveBadge').hidden = $('recordOverlay').hidden = false;
    timerInterval = setInterval(updateTimer, 250);
    notify('録画中です。長時間の録画はメモリを使用します。適度に停止して端末に保存してください。');
    updateControls();
  } catch (error) { notify(`録画を開始できませんでした。${error.message}`, 'error'); }
  finally { busy = false; updateControls(); }
}
function stopRecording() {
  if (!activeRecording()) return;
  if (recorder.state === 'recording') elapsed += performance.now() - startedAt;
  finishing = true;
  recorder.stop();
  clearInterval(timerInterval); updateTimer(); updateControls();
  $('pauseButton').disabled = true;
  notify('録画した動画を準備しています…');
}
function finishRecording() {
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  chunks = [];
  if (blob.size) addTake(blob, recordingMeta, elapsed);
  else notify('録画データがありません。デバイスの接続を確認して再録画してください。', 'error');
  finishing = false;
  $('recordButton').innerHTML = '<span class="record-icon"></span>録画をはじめる';
  $('recordButton').classList.remove('recording');
  $('recordState').textContent = '録画終了';
  $('pauseButton').hidden = true; $('pauseButton').disabled = false;
  $('liveBadge').hidden = $('recordOverlay').hidden = true;
  if (blob.size) notify(recordingError ? 'エラー発生前の動画を残しました。再生して確認し、保存してください。' : '録画ができました。下のプレビューで確認して「端末に保存」を押してください。', recordingError ? 'warning' : '');
  updateControls();
}
function addTake(blob, meta, duration) {
  const url = URL.createObjectURL(blob);
  const filename = `frame-${meta.date.toISOString().replace(/[:.]/g, '-')}.webm`;
  const item = document.createElement('article'); item.className = 'take';
  const playback = document.createElement('video'); playback.controls = true; playback.playsInline = true; playback.src = url; playback.preload = 'metadata';
  const info = document.createElement('div');
  const title = document.createElement('h3'); title.textContent = meta.date.toLocaleString('ja-JP');
  const details = document.createElement('p'); details.textContent = `${meta.width} × ${meta.height} · ${meta.channels === 2 ? 'ステレオ' : 'モノラル'} · ${formatTime(duration / 1000)} · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  const actions = document.createElement('div'); actions.className = 'take-actions';
  const save = document.createElement('a'); save.href = url; save.download = filename; save.textContent = '↓ 端末に保存';
  const saved = document.createElement('p'); saved.textContent = '未保存：端末に保存してください';
  // A download click cannot prove that Chrome actually wrote the file.
  save.addEventListener('click', () => { saved.textContent = 'ダウンロードを開始しました。Chrome のダウンロード一覧で保存完了を確認してください。'; });
  const remove = document.createElement('button'); remove.textContent = '削除';
  remove.addEventListener('click', () => {
    if (!confirm('このページから動画を削除します。端末に保存していない動画は復元できません。削除しますか？')) return;
    playback.pause(); playback.removeAttribute('src'); playback.load(); URL.revokeObjectURL(url); takes.delete(url); item.remove();
    $('recordingsSection').hidden = !takes.size;
  });
  actions.append(save, remove); info.append(title, details, actions, saved); item.append(playback, info);
  $('recordingsList').prepend(item); $('recordingsSection').hidden = false; takes.set(url, blob);
}
$('connectButton').addEventListener('click', connect);
controls.forEach(id => $(id).addEventListener('change', () => { if (sourceStream) connect(); }));
for (const nextMode of ['stereo', 'mono']) $(nextMode).addEventListener('click', () => {
  if (mode === nextMode) return;
  mode = nextMode;
  for (const id of ['stereo', 'mono']) { $(id).classList.toggle('selected', id === mode); $(id).setAttribute('aria-pressed', String(id === mode)); }
  $('modeHint').textContent = mode === 'stereo' ? '左右の音を分けて録音。USB ステレオマイクにおすすめ。' : '左右の音を 1 チャンネルにまとめて録音。声の録音におすすめ。';
  if (sourceStream) connect();
});
$('refreshButton').addEventListener('click', async () => { try { await enumerateDevices(); notify('デバイス一覧を更新しました。使用するカメラ・マイクを選んでください。'); } catch (error) { notify(mediaError(error), 'error'); } });
$('recordButton').addEventListener('click', () => activeRecording() ? stopRecording() : startRecording());
$('pauseButton').addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    elapsed += performance.now() - startedAt; recorder.pause();
    $('pauseButton').textContent = '録画を再開'; $('recordState').textContent = '一時停止'; $('liveBadge').textContent = 'Ⅱ PAUSED';
  } else if (recorder?.state === 'paused') {
    recorder.resume(); startedAt = performance.now();
    $('pauseButton').textContent = '一時停止'; $('recordState').textContent = '録画中'; $('liveBadge').textContent = '● REC';
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
if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) notify('カメラを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error');
