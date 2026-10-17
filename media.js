export function captureConstraints(camera, microphone, quality, mode, captureType = 'video') {
  const [width, height] = quality.split('x').map(Number);
  return {
    video: captureType === 'audio' ? false : { ...(camera ? { deviceId: { exact: camera } } : {}), ...(!camera ? { facingMode: { ideal: 'user' }, advanced: [{ facingMode: 'user' }] } : {}), width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    audio: { ...(microphone ? { deviceId: { exact: microphone } } : {}), channelCount: { ideal: mode === 'stereo' ? 2 : 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  };
}
export function stereoReady(settings) { return settings.channelCount >= 2; }
export function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].slice(whole >= 3600 ? 0 : 1).map(v => String(v).padStart(2, '0')).join(':');
}
export function selectMime(isSupported) {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(isSupported);
}
export function mediaError(error, captureType = 'video') {
  const device = captureType === 'audio' ? 'マイク' : 'カメラ・マイク';
  const messages = {
    NotAllowedError: `${device}へのアクセスが許可されていません。Chrome のアドレスバーのサイト設定で許可してください。Windows では OS のプライバシー設定と「デスクトップアプリ」のアクセス許可も確認してから再接続してください。`,
    NotFoundError: `${device}が見つかりません。接続を確認して再検出してください。`,
    NotReadableError: 'デバイスを開始できません。他の録画・通話アプリを閉じ、Windows のカメラ／マイクのアクセス許可も確認してから再接続してください。',
    OverconstrainedError: captureType === 'audio' || (error.constraint && !['width', 'height', 'aspectRatio', 'frameRate'].includes(error.constraint)) ? `選択した${device}の設定を使用できません。デバイスを再検出し、別の入力を選んで再接続してください（${error.constraint || '音声設定'}）。` : '対応する解像度（1080p / 720p / 480p）で接続できませんでした。別のカメラを選ぶか、デバイスを再接続してください。',
    TimeoutError: error.message || 'デバイスからの応答がありません。再接続してください。',
    AbortError: '接続をキャンセルしました。デバイスを選んで再接続できます。',
    SecurityError: 'ブラウザのセキュリティ設定でデバイスへのアクセスが制限されています。',
  };
  return messages[error.name] || `デバイスを開始できませんでした（${error.name || '不明なエラー'}）。接続とブラウザの対応状況を確認してください。`;
}

// Negotiate once using ideal resolution; retain retries for drivers rejecting video constraints.
export async function acquireMedia(getUserMedia, camera, microphone, quality, mode, captureType = 'video') {
  const qualities = ['1920x1080', '1280x720', '640x480'];
  const candidates = captureType === 'audio' ? [quality] : qualities.slice(Math.max(0, qualities.indexOf(quality)));
  for (const candidate of candidates) {
    try {
      const stream = await getUserMedia(captureConstraints(camera, microphone, candidate, mode, captureType));
      const actual = stream.getVideoTracks?.()[0]?.getSettings();
      return { stream, quality: actual?.width && actual?.height ? `${actual.width}x${actual.height}` : candidate, requestedQuality: quality };
    } catch (error) {
      const videoConstraint = !error.constraint || ['width', 'height', 'aspectRatio', 'frameRate'].includes(error.constraint);
      if (captureType === 'audio' || error.name !== 'OverconstrainedError' || !videoConstraint || candidate === candidates.at(-1)) throw error;
    }
  }
}
export function peakDecibels(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak ? Math.min(0, Math.max(-60, 20 * Math.log10(peak))) : -60;
}

export function recordingPlans(isSupported, target = 'mp4') {
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const aac = ['video/mp4;codecs=avc1.424028,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'];
  const avc = ['video/mp4;codecs=avc1.424028,opus', 'video/mp4;codecs=avc1,opus'];
  return [
    ...(target === 'mp4' ? aac.map(mimeType => ({ mimeType, format: 'mp4', needsConversion: false, copyVideo: true, codecLabel: 'H.264 / AAC' })) : []),
    ...(target === 'mp4' ? avc.map(mimeType => ({ mimeType, format: 'mp4', needsConversion: true, copyVideo: true, codecLabel: 'H.264 / Opus（元データ）' })) : []),
    ...webm.map(mimeType => ({ mimeType, format: 'webm', needsConversion: target === 'mp4', copyVideo: false, codecLabel: 'WebM / Opus' }))
  ].filter(plan => isSupported(plan.mimeType));
}

export function directRecordingPlans(isSupported, target = 'mp4') {
  // No automatic whole-file conversion or container substitution in disk mode.
  return recordingPlans(isSupported, target).filter(plan => plan.format === target).map(plan => ({
    ...plan, compatibilityConversion: plan.needsConversion, needsConversion: false
  }));
}
