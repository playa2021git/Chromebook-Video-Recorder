export function captureConstraints(camera, microphone, quality, mode) {
  const [width, height] = quality.split('x').map(Number);
  return {
    video: { ...(camera ? { deviceId: { exact: camera } } : {}), width: { exact: width }, height: { exact: height }, frameRate: { ideal: 30 } },
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
export function mediaError(error) {
  const messages = {
    NotAllowedError: 'カメラ・マイクへのアクセスが許可されていません。アドレスバーのサイト設定で許可してから、再接続してください。',
    NotFoundError: 'カメラまたはマイクが見つかりません。接続を確認して再検出してください。',
    NotReadableError: 'デバイスを開始できません。他のカメラアプリを閉じてから再接続してください。',
    OverconstrainedError: '選択したデバイスは、この解像度に対応していません。720p または 480p、別のデバイスを選んで再接続してください。',
    SecurityError: 'ブラウザのセキュリティ設定でデバイスへのアクセスが制限されています。',
  };
  return messages[error.name] || `デバイスを開始できませんでした（${error.name || '不明なエラー'}）。接続とブラウザの対応状況を確認してください。`;
}
