import { RecordingWakeLock } from './wake-lock.js';
import { acquireMedia, peakDecibels, stereoReady, formatTime, recordingPlans, directRecordingPlans, mediaError } from './media.js';
import { DirectFileSink, formatBytes } from './file-sink.js';
import { convertToMp4 } from './mp4.js';
import { waitFor, stopStream } from './connection.js';
import { Mp3Recorder } from './mp3-recorder.js';
const $ = id => document.getElementById(id);
const recordingWakeLock = new RecordingWakeLock({ onStatus: state => {
  const messages = {
    requesting: 'スリープ防止を開始しています…',
    held: '● スリープ防止中 · この画面を開いたまま収録してください',
    hidden: '⚠ 画面が非表示のためスリープ防止を維持できません。この画面に戻ってください。',
    unsupported: '⚠ このブラウザはスリープ防止に非対応です。端末の設定で自動スリープを無効にしてください。',
    failed: '⚠ スリープ防止を有効にできません。再試行するか、端末の設定で自動スリープを無効にしてください。',
    released: '⚠ スリープ防止が解除されました。再試行するか、端末の設定で自動スリープを無効にしてください。'
  };
  $('wakeStatus').hidden = state === 'idle';
  $('wakeMessage').textContent = messages[state] || '';
  $('wakeStatus').classList.toggle('warning', !['held', 'requesting', 'idle'].includes(state));
  $('retryWakeLock').hidden = !['failed', 'released'].includes(state);
} });
$('retryWakeLock').addEventListener('click', () => recordingWakeLock.acquire());

let sourceStream, outputStream, audioContext, audioBus, audioInput, audioDestination, splitter, meterNodes = [], meterFrame, recorder;
let mode = 'stereo', captureType = 'video', busy = false, chunks = [], startedAt = 0, elapsed = 0, timerInterval, finishing = false;
let recordingMeta, recordingError = false, disconnected = false;
let connectionAttempt, conversionController, fileSink, storagePaused = false, diskWriteError, enumerationVersion = 0;
const takes = new Map();
// DOM-only alignment guide: never drawn into, or added to, the recording stream.
let guideEnabled = false;
function updateGuide() {
  const video = $('preview'), area = video.parentElement;
  const visible = guideEnabled && !isAudioOnly() && !!sourceStream?.getVideoTracks().some(track => track.readyState === 'live') && !!video.videoWidth;
  $('guideToolbar').hidden = isAudioOnly();
  $('levelGuide').hidden = !visible;
  if (!visible) return;
  const scale = Math.min(area.clientWidth / video.videoWidth, area.clientHeight / video.videoHeight);
  $('levelGuide').style.width = `${video.videoWidth * scale}px`;
  $('levelGuide').style.height = `${video.videoHeight * scale}px`;
}
$('guideButton').addEventListener('click', () => {
  guideEnabled = !guideEnabled;
  $('guideButton').setAttribute('aria-pressed', String(guideEnabled));
  $('guideButton').textContent = `＋ 十字ガイド：${guideEnabled ? 'ON' : 'OFF'}`;
  updateGuide();
});
$('preview').addEventListener('loadedmetadata', updateGuide);
$('preview').addEventListener('resize', updateGuide);
new ResizeObserver(updateGuide).observe($('preview').parentElement);

const controls = ['camera', 'microphone', 'quality'];
const isAudioOnly = () => captureType === 'audio';
const action = () => isAudioOnly() ? '録音' : '録画';
const diskMode = () => $('storageMode').value === 'disk';
function refreshStorageUI() {
  const format = isAudioOnly() ? 'mp3' : $('videoFormat').value;
  $('storageMode').options[0].textContent = `${action()}中に直接保存（おすすめ）`;
  const nativePlan = !isAudioOnly() && window.MediaRecorder ? directRecordingPlans(type => MediaRecorder.isTypeSupported(type), format)[0] : undefined;
  $('saveFormat').textContent = `${format.toUpperCase()} · ${diskMode() ? `${action()}中に直接保存` : '停止後に保存'}`;
  $('storageHint').textContent = diskMode() ? (isAudioOnly() ? '開始時に MP3 の保存先を選択。録音中に順次書き込みます。' : !nativePlan ? 'この Chrome は選択した形式の直接保存に非対応です。WebM または停止後保存を選んでください。' : `開始時に保存先を選択。${nativePlan.codecLabel}${nativePlan.compatibilityConversion ? '。AAC 互換変換は停止後に任意で実行できます（短時間向け）' : ''}。録画中に順次書き込みます。`) : '動画全体をメモリに保持します。MP4 は必要に応じて停止後に H.264 / AAC へ変換します。短時間向けです。';
}
function notify(message, type = '') { $('notice').textContent = message; $('notice').className = `notice ${type}`; }
function activeRecording() { return recorder && recorder.state !== 'inactive'; }
function updateControls() {
  const locked = busy || activeRecording() || finishing;
  $('settings').disabled = locked;
  $('cancelConvertButton').hidden = !conversionController;
  document.querySelectorAll('.convert-retry').forEach(button => { button.disabled = locked; });
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
  $('saveFormat').textContent = `${isAudioOnly() ? 'MP3' : $('videoFormat').value.toUpperCase()} 形式 · クラウド送信なし`;
  $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}をはじめる`;
  $('recordState').textContent = `${action()}前`;
  $('timer').textContent = '00:00';
  refreshStorageUI();
  updateGuide();
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
  updateGuide();
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
    if (mode === 'mono') setMeter('R', decibels);
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
  // Monitor the same post-mix signal sent to the recording encoders.
  splitter = audioContext.createChannelSplitter(2); audioBus.connect(splitter);
  meterNodes = (mode === 'mono' ? [0] : [0, 1]).map(channel => {
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
    updateGuide();
    $('audioPreview').hidden = !isAudioOnly();
    $('previewStatus').textContent = isAudioOnly() ? '● マイク接続中 · カメラ不使用' : '● プレビュー中';
    $('actualVideo').textContent = isAudioOnly() ? '映像：使用しません' : `映像：${videoSettings.width} × ${videoSettings.height} · ${Math.round(videoSettings.frameRate || 0)} fps`;
    $('actualAudio').textContent = `入力：${audioSettings.channelCount ?? '不明'} ch · 録音：${mode === 'stereo' ? '2 ch' : '1 ch'}`;
    $('resolutionBadge').textContent = isAudioOnly() ? 'MP3' : `${videoSettings.height}p`;
    $('meterLabel').textContent = mode === 'mono' ? 'MONO · L/R 共通' : 'STEREO · 左右独立';
    $('meterHint').textContent = mode === 'mono' ? 'モノラルにまとめた音を L/R に同じ値で表示します。保存される音声は 1ch です。' : '録音される左右の音量を個別に表示します。入力音が左右同じなら、メーターも同じ動きになります。';
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
  busy = true; updateControls(); fileSink = undefined; storagePaused = false; diskWriteError = undefined;
  const direct = diskMode();
  const plans = isAudioOnly() ? [] : (direct ? directRecordingPlans : recordingPlans)(type => MediaRecorder.isTypeSupported(type), $('videoFormat').value);
  try {
    let picker;
    if (direct) {
      if (typeof window.showSaveFilePicker !== 'function') throw new Error('このブラウザは直接保存に非対応です。停止後保存を選んでください。');
      if (!isAudioOnly() && !plans.length) throw new Error('この Chrome は選択した形式を直接録画できません。WebM または停止後保存を選んでください。');
      const extension = isAudioOnly() ? 'mp3' : $('videoFormat').value;
      const mime = isAudioOnly() ? 'audio/mpeg' : `video/${extension}`;
      picker = window.showSaveFilePicker({ id: 'frame-recordings', startIn: 'downloads', suggestedName: `frame-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, excludeAcceptAllOption: true, types: [{ description: `${extension.toUpperCase()} ファイル`, accept: { [mime]: [`.${extension}`] } }] });
    }
    const audioReady = audioContext.resume(); audioReady.catch(() => {});
    if (picker) {
      const handle = await picker;
      fileSink = await DirectFileSink.create(handle, {
        onProgress: bytes => { $('storageStatus').textContent = `保存中：${handle.name} · ${formatBytes(bytes)} 書き込み済み（停止後に確定）`; },
        onBackpressure: blocked => {
          if (!activeRecording() || finishing) return;
          if (blocked && recorder.state === 'recording') {
            elapsed += performance.now() - startedAt; recorder.pause(); storagePaused = true;
            $('recordState').textContent = 'ストレージ待ち'; $('pauseButton').disabled = true; $('liveBadge').textContent = 'Ⅱ 保存待ち'; updateTimer();
            notify('ストレージの書き込みを待っています。録画は一時停止し、書き込みが追いつくと自動で再開します。', 'warning');
          } else if (!blocked && storagePaused && recorder.state === 'paused') {
            storagePaused = false; recorder.resume(); startedAt = performance.now();
            $('recordState').textContent = `${action()}中`; $('pauseButton').disabled = false; $('pauseButton').textContent = '一時停止'; $('liveBadge').textContent = '● REC';
            notify('書き込みが追いついたため、収録を再開しました。');
          }
        },
        onError: error => { diskWriteError = error; recordingError = true; if (activeRecording()) stopRecording(); }
      });
      $('storageStatus').hidden = false; $('storageStatus').classList.remove('error');
      $('storageStatus').textContent = `保存先：${handle.name} · 停止後に保存を確定します。`;
    } else $('storageStatus').hidden = true;
    await waitFor(audioReady, { timeout: 3000, label: '音声の開始' });
    if (!sourceStream || sourceStream.getAudioTracks()[0].readyState !== 'live') throw new Error('マイクが切断されました。再接続してください。');
    chunks = []; elapsed = 0; recordingError = false;
    const bind = candidate => {
      candidate.ondataavailable = event => {
        if (!event.data.size) return;
        if (fileSink) fileSink.enqueue(event.data); else chunks.push(event.data);
      };
      candidate.onerror = () => { recordingError = true; notify('収録エラーが発生しました。停止後のファイルを確認し、保存できるデータを保存してください。', 'error'); if (activeRecording()) stopRecording(); };
      candidate.onstop = finishRecording;
    };
    let plan = { format: 'mp3', needsConversion: false };
    if (isAudioOnly()) {
      recorder = await Mp3Recorder.create(audioContext, audioBus, mode === 'stereo' ? 2 : 1);
      bind(recorder); recorder.start();
    } else {
      let started = false, lastError;
      for (const candidatePlan of plans) {
        let candidate;
        try {
          candidate = new MediaRecorder(outputStream, { mimeType: candidatePlan.mimeType, videoBitsPerSecond: 8000000, audioBitsPerSecond: mode === 'stereo' ? 192000 : 128000 });
          bind(candidate); candidate.start(1000);
          recorder = candidate; plan = candidatePlan; started = true; break;
        } catch (error) {
          lastError = error;
          if (candidate) { candidate.ondataavailable = candidate.onstop = candidate.onerror = null; if (candidate.state !== 'inactive') candidate.stop(); }
        }
      }
      if (!started) throw lastError || new Error('このブラウザは動画録画に対応していません。最新の Chrome を使用してください。');
    }
    const video = sourceStream.getVideoTracks()[0]?.getSettings();
    recordingMeta = { ...plan, direct, captureType, width: video?.width, height: video?.height, channels: mode === 'stereo' ? 2 : 1, date: new Date() };
    recordingWakeLock.start();
    startedAt = performance.now();
    $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}を停止する`;
    $('recordButton').classList.add('recording'); $('recordState').textContent = `${action()}中`;
    $('pauseButton').hidden = false; $('pauseButton').textContent = '一時停止';
    $('liveBadge').textContent = '● REC'; $('liveBadge').hidden = $('recordOverlay').hidden = false;
    timerInterval = setInterval(updateTimer, 250);
    if (direct) $('storageHint').textContent = `${isAudioOnly() ? 'MP3' : plan.codecLabel} で直接保存中。停止後に保存完了を確認してください。${plan.compatibilityConversion ? 'AAC への互換変換は停止後に任意で実行できます（短時間向け）。' : ''}`;
    notify(direct ? `${action()}中です。選択したファイルへ順次書き込んでいます。停止後の「保存完了」を確認してください。` : `${action()}中です。動画全体をメモリに保持します。適度に停止して保存してください。`);
  } catch (error) {
    recordingWakeLock.stop();
    if (activeRecording()) { recorder.onstop = recorder.ondataavailable = null; recorder.stop(); }
    recorder?.dispose?.();
    if (fileSink) { await fileSink.abort(); fileSink = undefined; }
    notify(error.name === 'AbortError' ? '保存先の選択をキャンセルしました。収録は開始していません。' : `${action()}を開始できませんでした。${error.message}`, error.name === 'AbortError' ? '' : 'error');
  } finally { busy = false; updateControls(); }
}
function stopRecording() {
  if (!activeRecording()) return;
  if (recorder.state === 'recording') elapsed += performance.now() - startedAt;
  finishing = true; storagePaused = false; recorder.stop();
  clearInterval(timerInterval); updateTimer(); updateControls();
  $('pauseButton').disabled = true; notify(`${action()}したファイルを準備しています…`);
}
async function finishRecording() {
  finishing = true; updateControls();
  clearInterval(timerInterval);
  $('liveBadge').hidden = $('recordOverlay').hidden = true;
  $('pauseButton').hidden = true;
  $('recordButton').classList.remove('recording');
  $('recordButton').textContent = recordingMeta.needsConversion ? 'MP4 を準備中…' : 'ファイルを準備中…';
  $('recordState').textContent = recordingMeta.needsConversion ? 'MP4 変換中' : '保存準備中';
  let blob, outcome;
  if (fileSink) {
    const sink = fileSink;
    try {
      const file = await sink.finish();
      blob = file.slice(0, file.size, recorder.mimeType || file.type);
      if (!file.size) throw new Error('保存ファイルにデータがありません。');
      addTake(blob, { ...recordingMeta, savedToDisk: true, savedFileName: sink.handle.name }, elapsed);
      $('storageStatus').textContent = `保存完了：${sink.handle.name} · ${formatBytes(file.size)}`;
      outcome = { message: recordingError ? '収録エラー前のデータをファイルに保存しました。再生して確認してください。' : '保存が完了しました。選択した場所にファイルが保存されています。', type: recordingError ? 'warning' : '' };
    } catch (error) {
      const message = error.committed ? 'ファイルへの保存は確定しましたが、再生用に読み込めませんでした。「ファイル」アプリで確認してください。' : `直接保存を完了できませんでした（${(diskWriteError || error).name}）。空き容量と保存先を確認してください。録画中の一時データは保存されていない場合があります。`;
      $('storageStatus').classList.add('error'); $('storageStatus').textContent = message;
      outcome = { message, type: 'error' };
    } finally { fileSink = undefined; chunks = []; }
  } else {
    blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' }); chunks = [];
    outcome = blob.size ? await prepareTake(blob, recordingMeta, elapsed) : undefined;
  }
  finishing = false;
  recordingWakeLock.stop();
  $('recordButton').innerHTML = `<span class="record-icon"></span>${action()}をはじめる`;
  $('recordButton').classList.remove('recording'); $('recordState').textContent = `${action()}終了`;
  $('pauseButton').hidden = true; $('pauseButton').disabled = false;
  $('liveBadge').hidden = $('recordOverlay').hidden = true;
  if (disconnected) { stopDevices(); $('placeholder').hidden = false; }
  if (outcome) notify(!recordingMeta.direct && recordingError && !outcome.type ? `録画エラー前のデータを MP4 にしました。再生して映像・音声を確認してください。` : outcome.message, outcome.type || (recordingError ? 'warning' : ''));
  else if (blob.size) notify(recordingError ? 'エラー発生前のファイルを残しました。再生して確認し、保存してください。' : `${action()}ができました。下で再生して確認し「端末に保存」を押してください。`, recordingError ? 'warning' : '');
  else notify('収録データがありません。デバイスの接続を確認して再収録してください。', 'error');
  updateControls();
}
async function prepareTake(blob, meta, duration) {
  if (!meta.needsConversion) { addTake(blob, meta, duration); return; }
  const controller = new AbortController(); conversionController = controller; updateControls();
  try {
    const converted = await convertToMp4(blob, {
      signal: controller.signal, channels: meta.channels, copyVideo: meta.copyVideo, duration,
      onProgress: ({ stage, progress }) => notify(stage === 'loading' ? 'MP4 変換エンジンを読み込んでいます（初回は約 31 MB）。動画は端末の外へ送信しません。' : stage === 'complete' ? 'MP4 の準備ができました。' : `MP4 に変換しています… ${Math.floor(progress * 100)}%`)
    });
    addTake(converted, { ...meta, savedToDisk: false, savedFileName: undefined, compatibilityConversion: false, format: 'mp4', needsConversion: false, unconverted: false, codecLabel: 'H.264 / AAC' }, duration);
    return { message: 'MP4 の準備ができました。再生して確認し「端末に保存」を押してください。', type: '' };
  } catch (error) {
    addTake(blob, { ...meta, unconverted: true }, duration);
    return { message: `${error.name === 'AbortError' ? 'MP4 変換をキャンセルしました。' : 'MP4 変換を完了できませんでした。'}元データを一覧に残しました。保存するか「MP4 に変換」で再試行できます。`, type: 'warning' };
  } finally { conversionController = undefined; updateControls(); }
}
function addTake(blob, meta, duration) {
  const audioOnly = meta.captureType === 'audio';
  const url = URL.createObjectURL(blob), extension = meta.format || (audioOnly ? 'mp3' : 'webm');
  const filename = meta.savedFileName || `frame-${meta.date.toISOString().replace(/[:.]/g, '-')}.${extension}`;
  const item = document.createElement('article'); item.className = 'take';
  const playback = document.createElement(audioOnly ? 'audio' : 'video');
  playback.controls = true; if (!audioOnly) playback.playsInline = true;
  playback.src = url; playback.preload = 'metadata';
  const info = document.createElement('div');
  const title = document.createElement('h3'); title.textContent = `${audioOnly ? '♫ 録音' : '▣ 動画'} · ${meta.date.toLocaleString('ja-JP')}`;
  const details = document.createElement('p'); details.textContent = `${audioOnly ? 'MP3' : `${meta.width} × ${meta.height} · ${extension.toUpperCase()} · ${meta.codecLabel || ''}${meta.unconverted ? ' · 互換変換前' : ''}`} · ${meta.channels === 2 ? 'ステレオ' : 'モノラル'} · ${formatTime(duration / 1000)} · ${formatBytes(blob.size)}`;
  const actions = document.createElement('div'); actions.className = 'take-actions';
  const save = document.createElement('a'); save.href = url; save.download = filename; save.textContent = meta.savedToDisk ? '↓ 保存済みファイルのコピー' : meta.unconverted ? `↓ 元データを保存（${extension.toUpperCase()}）` : '↓ 端末に保存';
  const saved = document.createElement('p'); saved.textContent = meta.savedToDisk ? `保存済み：${meta.savedFileName}` : '未保存：端末に保存してください';
  save.addEventListener('click', () => { saved.textContent = meta.savedToDisk ? `元ファイルは保存済み：${meta.savedFileName}。コピーのダウンロードを開始しました。` : 'ダウンロードを開始しました。Chrome のダウンロード一覧で保存完了を確認してください。'; });
  const remove = document.createElement('button'); remove.textContent = '削除';
  remove.addEventListener('click', () => {
    if (!confirm(meta.savedToDisk ? '一覧から外します。保存したファイルは端末に残ります。' : 'このページからファイルを削除します。端末に保存していないデータは復元できません。削除しますか？')) return;
    playback.pause(); playback.removeAttribute('src'); playback.load(); URL.revokeObjectURL(url); takes.delete(url); item.remove();
    $('recordingsSection').hidden = !takes.size;
  });
  actions.append(save, remove);
  if (meta.unconverted || meta.compatibilityConversion) {
    const retry = document.createElement('button'); retry.className = 'convert-retry'; retry.textContent = meta.savedToDisk ? 'AAC 互換 MP4 に変換（短時間向け）' : 'MP4 に変換';
    retry.addEventListener('click', async () => {
      if (busy || activeRecording() || finishing) return;
      if (meta.savedToDisk && !confirm('この互換変換は動画全体をメモリに読み込みます。長時間の動画では失敗する場合があります。元の保存ファイルは変更しません。実行しますか？')) return;
      finishing = true; updateControls();
      try { const outcome = await prepareTake(blob, { ...meta, needsConversion: true }, duration); if (outcome) notify(outcome.message, outcome.type); }
      finally { finishing = false; updateControls(); }
    });
    actions.append(retry);
  } info.append(title, details, actions, saved); item.append(playback, info);
  $('recordingsList').prepend(item); $('recordingsSection').hidden = false; takes.set(url, { blob, savedToDisk: !!meta.savedToDisk });
}
$('connectButton').addEventListener('click', () => connect());
$('reconnectButton').addEventListener('click', () => connect());
$('cancelConvertButton').addEventListener('click', () => conversionController?.abort(new DOMException('MP4 変換をキャンセルしました。', 'AbortError')));
$('videoFormat').addEventListener('change', () => {
  $('saveFormat').textContent = `${$('videoFormat').value.toUpperCase()} 形式 · クラウド送信なし`;
  $('videoFormatLabel').textContent = `カメラ ＋ マイク · ${$('videoFormat').value.toUpperCase()}`;
  refreshStorageUI();
});
$('storageMode').addEventListener('change', refreshStorageUI);
$('cancelConnectButton').addEventListener('click', () => connectionAttempt?.abort(new DOMException('接続をキャンセルしました。', 'AbortError')));
controls.forEach(id => $(id).addEventListener('change', () => { if (sourceStream) connect(id === 'microphone' ? 'audio' : 'video'); }));
for (const type of ['video', 'audio']) $(`${type}Mode`).addEventListener('click', () => {
  if (captureType === type || busy || activeRecording() || finishing) return;
  captureType = type; stopDevices();
  $('placeholder').hidden = false; updateModeUI(); updateControls();
  notify(isAudioOnly() ? '「マイクを接続」を押してください。カメラなしで MP3 を録音できます。' : '「カメラ・マイクを接続」を押してください。動画は選択した形式で保存します。');
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
    if (fileSink?.blocked) {
      storagePaused = true; $('pauseButton').disabled = true; $('recordState').textContent = 'ストレージ待ち';
      notify('書き込みが追いつくと自動で再開します。', 'warning'); return;
    }
    recorder.resume(); startedAt = performance.now();
    $('pauseButton').textContent = '一時停止'; $('recordState').textContent = `${action()}中`; $('liveBadge').textContent = '● REC';
  }
  updateTimer();
});
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close());
navigator.mediaDevices?.addEventListener('devicechange', () => { if (!busy && !activeRecording() && !finishing) enumerateDevices().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (activeRecording() || finishing || [...takes.values()].some(take => !take.savedToDisk)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { recordingWakeLock.stop(); conversionController?.abort(new DOMException('ページを閉じました。', 'AbortError'));  connectionAttempt?.abort(new DOMException('ページを閉じました。', 'AbortError'));  if (activeRecording()) recorder.stop(); stopDevices(); });
if (typeof window.showSaveFilePicker !== 'function') {
  $('storageMode').value = 'memory'; $('storageMode').options[0].disabled = true;
  $('storageStatus').hidden = false; $('storageStatus').textContent = 'このブラウザは直接保存に非対応です。停止後保存（メモリ使用）で動作します。';
}
refreshStorageUI();
if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) notify('カメラ・マイクを使うには HTTPS（開発時は localhost）で、Chrome から開いてください。', 'error');
