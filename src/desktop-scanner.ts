import jsQR from 'jsqr';

const FRAME_INTERVAL_MS = 200;
const MAX_FRAME_SIDE = 960;
const VIDEO_START_TIMEOUT_MS = 10_000;

export function desktopCameraAvailable(): boolean {
  return typeof navigator.mediaDevices !== 'undefined'
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

function cameraError(error: unknown): Error {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError': case 'SecurityError':
        return new Error('Camera access was denied. Allow Murmur in Mac System Settings → Privacy & Security → Camera, then reopen the app. In a browser, check this site’s camera permission.');
      case 'NotFoundError': case 'DevicesNotFoundError':
        return new Error('No camera was found. Connect a camera and try again, or paste an invitation.');
      case 'NotReadableError': case 'TrackStartError':
        return new Error('The camera could not start. Close other apps using it, then try again.');
      case 'AbortError':
        return new Error('The camera stopped before scanning. Try opening it again.');
      case 'OverconstrainedError':
        return new Error('This camera does not support the requested video format. Try another camera or paste an invitation.');
    }
  }
  return error instanceof Error ? error : new Error('The camera could not start. Try again or paste an invitation.');
}

/** Decode locally; camera frames are never stored or sent to another device. */
export function scanDesktopInvitation(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onStatus: (message: string) => void,
): Promise<string | null> {
  if (signal.aborted || document.hidden) return Promise.resolve(null);
  if (!desktopCameraAvailable()) {
    return Promise.reject(new Error('Camera access is unavailable here. Open the installed app or use a secure browser page, or paste an invitation.'));
  }

  return new Promise<string | null>((resolve, reject) => {
    let finished = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    function finish(value: string | null, error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', cancel);
      if (stream !== null) {
        for (const track of stream.getTracks()) {
          track.removeEventListener('ended', cameraEnded);
          track.stop();
        }
      }
      video.pause();
      video.srcObject = null;
      canvas.width = 0;
      canvas.height = 0;
      if (error === undefined) resolve(value);
      else reject(error);
    }

    function cancel() { finish(null); }
    function visibilityChanged() { if (document.hidden) cancel(); }
    function cameraEnded() { finish(null, new Error('The camera disconnected. Connect it again and reopen the scanner.')); }

    signal.addEventListener('abort', cancel, { once: true });
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pagehide', cancel, { once: true });

    async function start() {
      if (context === null) throw new Error('This device cannot read camera images. Paste an invitation instead.');
      onStatus('Allow camera access when asked.');
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } },
      });
      // getUserMedia cannot be aborted while the system permission prompt is
      // open. A late permission grant must never reopen a cancelled scanner.
      if (finished) {
        for (const track of acquired.getTracks()) track.stop();
        return;
      }
      stream = acquired;
      if (stream.getVideoTracks().length === 0) throw new Error('The camera did not provide video. Try again or paste an invitation.');
      for (const track of stream.getTracks()) track.addEventListener('ended', cameraEnded);
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      const readyDeadline = performance.now() + VIDEO_START_TIMEOUT_MS;
      timer = setTimeout(() => finish(null, new Error('The camera did not start in time. Reopen the scanner or paste an invitation.')), VIDEO_START_TIMEOUT_MS);
      await video.play();
      if (finished) return;
      clearTimeout(timer);
      onStatus('Hold a Murmur QR code in front of your camera.');

      function decodeFrame() {
        if (finished) return;
        try {
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
            if (performance.now() >= readyDeadline) throw new Error('The camera is not sending images. Reopen the scanner or paste an invitation.');
          } else {
            const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
            const width = Math.max(1, Math.floor(video.videoWidth * scale));
            const height = Math.max(1, Math.floor(video.videoHeight * scale));
            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;
            if (context === null) throw new Error('The camera image reader is unavailable.');
            context.drawImage(video, 0, 0, width, height);
            const frame = context.getImageData(0, 0, width, height);
            const code = jsQR(frame.data, width, height, { inversionAttempts: 'attemptBoth' });
            if (code !== null) {
              if (code.data.startsWith('murmur://join#') && code.data.length <= 4096) {
                finish(code.data);
                return;
              }
              onStatus('That is not a Murmur invitation. Show the QR code from Invite a device.');
            }
          }
          // Schedule after decoding completes: only one bounded frame is ever
          // processed at a time, even on slower devices.
          timer = setTimeout(decodeFrame, FRAME_INTERVAL_MS);
        } catch (error) { finish(null, cameraError(error)); }
      }

      decodeFrame();
    }

    void start().catch(error => finish(null, cameraError(error)));
  });
}
