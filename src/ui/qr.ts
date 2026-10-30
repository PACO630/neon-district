// QR code rendering (qrcode) and camera scanning (jsQR) for invite / reply codes.
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { h } from './dom';

export async function qrCanvas(text: string): Promise<HTMLElement> {
  const wrap = h('div', { class: 'qr' });
  try {
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'L', margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } });
    wrap.appendChild(canvas);
  } catch {
    wrap.appendChild(h('div', { class: 'note', style: 'color:#000;padding:8px' }, 'Code too long for a QR code — use copy/paste or file instead.'));
  }
  return wrap;
}

/** Opens the camera and resolves with the first QR payload found (or rejects on cancel/error). */
export function scanQR(container: HTMLElement): { promise: Promise<string>; stop: () => void } {
  let stream: MediaStream | null = null;
  let raf = 0;
  let stopped = false;
  const video = h('video', { class: 'scanner', playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
  container.appendChild(video);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let rejectFn: (e: Error) => void = () => {};
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    video.remove();
    rejectFn(new Error('Scan cancelled'));
  };
  const promise = new Promise<string>((resolve, reject) => {
    rejectFn = reject;
    if (!navigator.mediaDevices?.getUserMedia) { reject(new Error('Camera not available in this browser (requires HTTPS).')); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = s;
      video.play().catch(() => {});
      const tick = () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            stopped = true;
            stream?.getTracks().forEach((t) => t.stop());
            video.remove();
            resolve(code.data);
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch((e) => reject(new Error(`Camera permission denied or unavailable (${e.name ?? 'error'}).`)));
  });
  return { promise, stop };
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = h('textarea', { style: 'position:fixed;left:-1000px;top:0' }) as HTMLTextAreaElement;
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export async function shareText(text: string, title: string): Promise<boolean> {
  if (!navigator.share) return false;
  try { await navigator.share({ title, text }); return true; } catch { return false; }
}
