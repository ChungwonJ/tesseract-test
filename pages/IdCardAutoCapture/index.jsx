// IdCardAutoCapture.jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import styles from './IdCardAutoCapture.module.scss';

/* ========= Small helpers ========= */
function dataURLtoFile(dataUrl, filename) {
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], filename, { type: mime });
}

/* ========= OCR helpers ========= */
async function extractTextFromDataUrl(dataUrl, lang = 'eng+kor') {
  try {
    const { data: { text } } = await Tesseract.recognize(dataUrl, lang);
    return (text || '').trim();
  } catch (e) {
    console.error('OCR error:', e);
    return '';
  }
}
const JUMIN_REGEX = /\d{6}-\d{7}/;

/* ========= Post-process (auto-levels + sharpen + resize) ========= */
async function enhanceDataURL(
  dataUrl,
  { targetLongSide = 1800, sharpen = 0.45, clip = 0.005 } = {}
) {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });

  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = targetLongSide ? Math.min(1, targetLongSide / Math.max(iw, ih)) : 1;
  const ow = Math.max(1, Math.round(iw * scale));
  const oh = Math.max(1, Math.round(ih * scale));

  const cnv = document.createElement('canvas');
  cnv.width = ow; cnv.height = oh;
  const ctx = cnv.getContext('2d', { alpha: false });

  // 흰 배경 (투명 방지)
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ow, oh);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, ow, oh);

  autoLevels(ctx, ow, oh, clip);
  if (sharpen > 0) applySharpen(ctx, ow, oh, sharpen);

  // ★ 항상 JPEG
  return cnv.toDataURL('image/jpeg', 0.98);
}

function autoLevels(ctx, w, h, clip = 0.005) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const histR = new Array(256).fill(0);
  const histG = new Array(256).fill(0);
  const histB = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++;
  }
  const clipCnt = Math.floor(w * h * clip);
  function loHi(hist) {
    let lo = 0, hi = 255, acc = 0;
    while (acc < clipCnt && lo < 255) { acc += hist[lo++]; }
    acc = 0;
    while (acc < clipCnt && hi > 0)  { acc += hist[hi--]; }
    return [lo, hi];
  }
  const [loR, hiR] = loHi(histR);
  const [loG, hiG] = loHi(histG);
  const [loB, hiB] = loHi(histB);
  function stretch(v, lo, hi) {
    if (hi <= lo) return v;
    return Math.max(0, Math.min(255, Math.round((v - lo) * 255 / (hi - lo))));
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = stretch(d[i], loR, hiR);
    d[i + 1] = stretch(d[i + 1], loG, hiG);
    d[i + 2] = stretch(d[i + 2], loB, hiB);
  }
  ctx.putImageData(img, 0, 0);
}

function applySharpen(ctx, w, h, amt = 0.7) {
  const a = Math.max(0, Math.min(1, amt));
  const k = [ 0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0 ];
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const S = src.data, D = dst.data;
  const idx = (x, y) => (y * w + x) * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let r = 0, g = 0, b = 0, p = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const i = idx(x + kx, y + ky);
          const kv = k[p++];
          r += S[i] * kv; g += S[i + 1] * kv; b += S[i + 2] * kv;
        }
      }
      const di = idx(x, y);
      D[di]     = Math.max(0, Math.min(255, r));
      D[di + 1] = Math.max(0, Math.min(255, g));
      D[di + 2] = Math.max(0, Math.min(255, b));
      D[di + 3] = S[di + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

/* ========= Edge/Glare 파라미터 ========= */
const EDGE_DIFF = 30;
const SIDE_COVER_MIN = 0.6;
const MIN_ROI_PX = 140;
const STABLE_NEED = 2;
const TOL_PCT = 0.05;

const GLARE_Y = 250;
const GLARE_SAT_DELTA = 18;
const GLARE_MAX_RATIO = 0.02;
const GLARE_WARN_RATIO = 0.01;

/* ========= Captured crop expansion ========= */
const CROP_PAD_X_PCT = 0.05;
const CROP_PAD_Y_PCT = 0.12;
const CROP_MIN_PAD_PX = 6;

function expandRectWithin(fRect, boundsRect) {
  const padX = Math.max(CROP_MIN_PAD_PX, fRect.width  * CROP_PAD_X_PCT);
  const padY = Math.max(CROP_MIN_PAD_PX, fRect.height * CROP_PAD_Y_PCT);

  let left   = fRect.left   - padX;
  let top    = fRect.top    - padY;
  let right  = fRect.right  + padX;
  let bottom = fRect.bottom + padY;

  left   = Math.max(boundsRect.left,   left);
  top    = Math.max(boundsRect.top,    top);
  right  = Math.min(boundsRect.right,  right);
  bottom = Math.min(boundsRect.bottom, bottom);

  return {
    left,
    top,
    width:  Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export default function IdCardAutoCapture({
  isOpen,
  onClose,
  onUpload,
  facingMode = 'environment',
  showDebug = false,
  ocrLang = 'eng+kor',
  ocrCheckPattern = JUMIN_REGEX, // null이면 패턴 검사 없이 통과
  onOcrText, // 선택: OCR 텍스트 콜백({ text })
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const photoTrackRef = useRef(null);
  const rafRef = useRef(null);

  const frameRef = useRef(null);
  const workCanvasRef = useRef(null);
  const cropCanvasRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [isAligned, setIsAligned] = useState(false);
  const [capturedDataUrl, setCapturedDataUrl] = useState(null);

  const [glareRatio, setGlareRatio] = useState(0);
  const [glareBlocked, setGlareBlocked] = useState(false);

  const [ocrLoading, setOcrLoading] = useState(false); // ★ 블랙 스피너 표시용

  const stableCountRef = useRef(0);
  const capturingRef = useRef(false);

  /* ---- media controls ---- */
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      streamRef.current = null;
    }
    photoTrackRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch {}
    }
  }, []);

  const applyProConstraints = async (track) => {
    if (!track?.getCapabilities) return;
    const caps = track.getCapabilities();
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.push({ exposureMode: 'continuous' });
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
    if (adv.length) { try { await track.applyConstraints({ advanced: adv }); } catch {} }
  };

  const startStream = useCallback(async () => {
    setReady(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      photoTrackRef.current = track;
      await applyProConstraints(track);

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      video.onloadedmetadata = async () => {
        try { await video.play(); } catch {}
        setReady(true);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(detectLoop);
      };
    } catch (e) {
      console.error('getUserMedia error:', e);
      alert('카메라 권한을 허용해 주세요.');
      closeModal();
    }
  }, [facingMode]);

  const restartStream = useCallback(async () => {
    cancelAnimationFrame(rafRef.current);
    stopStream();
    await new Promise((r) => setTimeout(r, 120));
    await startStream();
  }, [startStream, stopStream]);

  const closeModal = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    stopStream();
    setReady(false);
    setIsAligned(false);
    setCapturedDataUrl(null);
    setGlareRatio(0);
    setGlareBlocked(false);
    setOcrLoading(false);
    stableCountRef.current = 0;
    capturingRef.current = false;
    onClose?.();
  }, [onClose, stopStream]);

  useEffect(() => {
    if (!isOpen) return;
    startStream();
    const handleVis = async () => {
      if (document.hidden) return;
      const ended = !streamRef.current || streamRef.current.getTracks().some((t) => t.readyState === 'ended');
      if (!capturedDataUrl && ended) await restartStream();
      else if (!capturedDataUrl) {
        try { await videoRef.current?.play(); } catch {}
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(detectLoop);
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      document.removeEventListener('visibilitychange', handleVis);
      cancelAnimationFrame(rafRef.current);
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /* ---- canvas utils (display-size basis) ---- */
  const drawVideoToWorkCanvas = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;

    const work = (workCanvasRef.current ||= document.createElement('canvas'));
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const vRect = video.getBoundingClientRect();
    const cw = Math.max(1, Math.round(vRect.width));
    const ch = Math.max(1, Math.round(vRect.height));

    work.width = cw; work.height = ch;

    const vRatio = vw / vh;
    const cRatio = cw / ch;

    let dw, dh, dx, dy;
    if (vRatio > cRatio) { dh = ch; dw = dh * vRatio; dx = (cw - dw) / 2; dy = 0; }
    else { dw = cw; dh = dw / vRatio; dx = 0; dy = (ch - dh) / 2; }

    const ctx = work.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(video, dx, dy, dw, dh);

    return work;
  }, []);

  /* ---- capture (hi-res first, preview fallback) ---- */
  const captureCroppedHiRes = useCallback(async () => {
    const video = videoRef.current;
    const frameEl = frameRef.current;
    const track = photoTrackRef.current;
    if (!video || !frameEl || !track) return null;
    if (!('ImageCapture' in window)) return null;

    try {
      const imageCapture = new window.ImageCapture(track);
      let photoSettings = {};
      try {
        const caps = await imageCapture.getPhotoCapabilities();
        if (caps?.imageWidth?.max)  photoSettings.imageWidth  = caps.imageWidth.max;
        if (caps?.imageHeight?.max) photoSettings.imageHeight = caps.imageHeight.max;
        if (caps?.redEyeReduction?.supported) photoSettings.redEyeReduction = true;
        if (Array.isArray(caps?.fillLightMode) && caps.fillLightMode.length) {
          photoSettings.fillLightMode = caps.fillLightMode.includes('auto') ? 'auto' : caps.fillLightMode[0];
        }
      } catch {}
      const blob = await imageCapture.takePhoto(photoSettings).catch(() => imageCapture.takePhoto());
      const bitmap = await createImageBitmap(blob);

      const vw = video.videoWidth, vh = video.videoHeight;
      const vRect = video.getBoundingClientRect();
      const fRect = frameEl.getBoundingClientRect();

      const eRect = expandRectWithin(fRect, vRect);

      const cw = vRect.width, ch = vRect.height;
      const vRatio = vw / vh, cRatio = cw / ch;

      let dw, dh, dx, dy;
      if (vRatio > cRatio) { dh = ch; dw = dh * vRatio; dx = (cw - dw) / 2; dy = 0; }
      else { dw = cw; dh = dw / vRatio; dx = 0; dy = (ch - dh) / 2; }

      const srcX_v = Math.max(0, Math.round((eRect.left - vRect.left - dx) * (vw / dw)));
      const srcY_v = Math.max(0, Math.round((eRect.top  - vRect.top  - dy) * (vh / dh)));
      const srcW_v = Math.min(vw - srcX_v, Math.round(eRect.width  * (vw / dw)));
      const srcH_v = Math.min(vh - srcY_v, Math.round(eRect.height * (vh / dh)));

      const scaleX = bitmap.width  / vw;
      const scaleY = bitmap.height / vh;

      let sx = Math.round(srcX_v * scaleX);
      let sy = Math.round(srcY_v * scaleY);
      let sw = Math.round(srcW_v * scaleX);
      let sh = Math.round(srcH_v * scaleY);

      sx = Math.max(0, Math.min(sx, bitmap.width  - 1));
      sy = Math.max(0, Math.min(sy, bitmap.height - 1));
      sw = Math.max(1, Math.min(sw, bitmap.width  - sx));
      sh = Math.max(1, Math.min(sh, bitmap.height - sy));

      const crop = (cropCanvasRef.current ||= document.createElement('canvas'));
      crop.width = sw; crop.height = sh;
      const cctx = crop.getContext('2d', { alpha: false });

      // 흰 배경
      cctx.fillStyle = '#fff';
      cctx.fillRect(0, 0, sw, sh);

      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

      return crop.toDataURL('image/jpeg', 0.95);
    } catch {
      return null;
    }
  }, []);

  const captureCroppedPreview = useCallback(() => {
    const video = videoRef.current;
    const frameEl = frameRef.current;
    if (!video || !frameEl) return null;

    const work = drawVideoToWorkCanvas();
    if (!work) return null;

    const vRect = video.getBoundingClientRect();
    const fRect = frameEl.getBoundingClientRect();

    const eRect = expandRectWithin(fRect, vRect);

    const x = Math.max(0, Math.round(eRect.left - vRect.left));
    const y = Math.max(0, Math.round(eRect.top  - vRect.top));
    const w = Math.min(work.width  - x, Math.round(eRect.width));
    const h = Math.min(work.height - y, Math.round(eRect.height));
    if (w <= 0 || h <= 0) return null;

    const crop = (cropCanvasRef.current ||= document.createElement('canvas'));
    crop.width = w; crop.height = h;
    const cctx = crop.getContext('2d', { alpha: false });

    // 흰 배경
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, w, h);

    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(work, x, y, w, h, 0, 0, w, h);

    return crop.toDataURL('image/jpeg', 0.95);
  }, [drawVideoToWorkCanvas]);

  const captureBestOf = useCallback(async (n = 3) => {
    let best = null, bestSharp = -1;
    for (let i = 0; i < n; i++) {
      let d = await captureCroppedHiRes();
      if (!d) d = captureCroppedPreview();
      if (!d) continue;
      const score = d.length; // 간단한 선명도 근사(데이터 URL 길이)
      if (score > bestSharp) { bestSharp = score; best = d; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return best;
  }, [captureCroppedHiRes, captureCroppedPreview]);

  /* ---- edge helpers ---- */
  const getRGB = (imageData, w, x, y) => {
    const xi = Math.max(0, Math.min(w - 1, x | 0));
    const yi = Math.max(0, Math.min(imageData.height - 1, y | 0));
    const idx = (yi * w + xi) * 4;
    const d = imageData.data;
    return [d[idx], d[idx + 1], d[idx + 2]];
  };
  const diffRGB = (a, b) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  /* ---- glare helper ---- */
  const estimateGlare = (imageData, W, H, x, y, w, h, stepX, stepY) => {
    let hot = 0, tot = 0;
    for (let yy = y; yy < y + h; yy += stepY) {
      for (let xx = x; xx < x + w; xx += stepX) {
        const [r, g, b] = getRGB(imageData, W, xx, yy);
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const maxc = Math.max(r, g, b);
        const minc = Math.min(r, g, b);
        const delta = maxc - minc;
        if (Y >= GLARE_Y && delta <= GLARE_SAT_DELTA) hot++;
        tot++;
      }
    }
    return { ratio: tot ? hot / tot : 0, hot, tot };
  };

  /* ---- detection loop ---- */
  const detectLoop = useCallback(() => {
    if (!isOpen || !ready || capturedDataUrl || ocrLoading) return;

    const video = videoRef.current;
    const frameEl = frameRef.current;
    if (!video || !frameEl || !video.videoWidth) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    const work = drawVideoToWorkCanvas();
    if (!work) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    const vRect = video.getBoundingClientRect();
    const fRect = frameEl.getBoundingClientRect();

    // 탐지는 프레임, 캡처는 확장 프레임 기준
    const x = Math.max(0, Math.round(fRect.left - vRect.left));
    const y = Math.max(0, Math.round(fRect.top  - vRect.top));
    const w = Math.min(work.width  - x, Math.round(fRect.width));
    const h = Math.min(work.height - y, Math.round(fRect.height));

    if (w < MIN_ROI_PX || h < MIN_ROI_PX) {
      setIsAligned(false);
      setGlareBlocked(false);
      setGlareRatio(0);
      stableCountRef.current = 0;
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    const ctx = work.getContext('2d');
    const imageData = ctx.getImageData(0, 0, work.width, work.height);
    const W = work.width, H = work.height;

    const off = Math.max(2, Math.round(Math.min(w, h) * 0.012));
    const stepX = Math.max(1, Math.round(w / 180));
    const stepY = Math.max(1, Math.round(h / 140));
    const tolPx = Math.max(2, Math.round(Math.min(w, h) * TOL_PCT));
    const scanStep = Math.max(1, Math.round(tolPx / 10));

    function scanSide(getOutIn, scanLen, step) {
      let bestCov = 0, bestD = 0;
      for (let d = -tolPx; d <= tolPx; d += scanStep) {
        const { outPos, inPos } = getOutIn(d);
        let hit = 0, tot = 0;
        for (let t = 0; t < scanLen; t += step) {
          const { ax, ay, bx, by } = inPos(t);
          const { ax2, ay2, bx2, by2 } = outPos(t);
          if (ax2 >= 0 && ax2 < W && ay2 >= 0 && ay2 < H && bx >= 0 && bx < W && by >= 0 && by < H) {
            const a = getRGB(imageData, W, ax2, ay2);
            const b = getRGB(imageData, W, bx, by);
            if (diffRGB(a, b) > EDGE_DIFF) hit++;
            tot++;
          }
        }
        const cov = tot ? hit / tot : 0;
        if (cov > bestCov) { bestCov = cov; bestD = d; }
      }
      return { cov: bestCov, d: bestD };
    }

    // 상/하/좌/우 커버리지 스캔
    const topRes = scanSide(
      (d) => ({
        outPos: (t) => ({ ax2: x + t, ay2: (y + d) - off, bx2: null, by2: null }), // for bounds check
        inPos:  (t) => ({ ax: null, ay: null, bx: x + t, by: (y + d) + off })
      }),
      w, stepX
    );
    const bottomRes = scanSide(
      (d) => ({
        outPos: (t) => ({ ax2: x + t, ay2: (y + h + d) + off, bx2: null, by2: null }),
        inPos:  (t) => ({ ax: null, ay: null, bx: x + t, by: (y + h + d) - off })
      }),
      w, stepX
    );
    const leftRes = scanSide(
      (d) => ({
        outPos: (t) => ({ ax2: (x + d) - off, ay2: y + t, bx2: null, by2: null }),
        inPos:  (t) => ({ ax: null, ay: null, bx: (x + d) + off, by: y + t })
      }),
      h, stepY
    );
    const rightRes = scanSide(
      (d) => ({
        outPos: (t) => ({ ax2: (x + w + d) + off, ay2: y + t, bx2: null, by2: null }),
        inPos:  (t) => ({ ax: null, ay: null, bx: (x + w + d) - off, by: y + t })
      }),
      h, stepY
    );

    const { cov: cTop, d: dT } = topRes;
    const { cov: cBot, d: dB } = bottomRes;
    const { cov: cLft, d: dL } = leftRes;
    const { cov: cRgt, d: dR } = rightRes;

    const okAlign =
      (cTop >= SIDE_COVER_MIN) && (cBot >= SIDE_COVER_MIN) &&
      (cLft >= SIDE_COVER_MIN) && (cRgt >= SIDE_COVER_MIN) &&
      (Math.abs(dT) <= tolPx) && (Math.abs(dB) <= tolPx) &&
      (Math.abs(dL) <= tolPx) && (Math.abs(dR) <= tolPx);

    setIsAligned(okAlign);

    const glareSampleX = Math.max(2, Math.round(stepX / 2));
    const glareSampleY = Math.max(2, Math.round(stepY / 2));
    const { ratio: gRatio } = estimateGlare(imageData, W, H, x, y, w, h, glareSampleX, glareSampleY);
    setGlareRatio(gRatio);
    const glareTooHigh = gRatio > GLARE_MAX_RATIO;
    setGlareBlocked(glareTooHigh);

    if (okAlign && !glareTooHigh) {
      stableCountRef.current += 1;
    } else {
      stableCountRef.current = 0;
    }

    // 1) 네모 안에 카드가 맞으면 → 사진을 찍는다
    if (stableCountRef.current >= STABLE_NEED && !capturingRef.current) {
      capturingRef.current = true;
      (async () => {
        let shot = await captureBestOf(3); // 베스트 샷
        if (!shot) {
          capturingRef.current = false;
          stableCountRef.current = 0;
          rafRef.current = requestAnimationFrame(detectLoop);
          return;
        }

        // 2) 사진 보정 및 OCR 전환 → 3) 블랙 스피너로 화면 제어
        setOcrLoading(true);

        const enhanced = await enhanceDataURL(shot, {
          targetLongSide: 1800, sharpen: 0.45, clip: 0.005
        });
        const text = await extractTextFromDataUrl(enhanced, ocrLang);
        onOcrText?.({ text });

        // 4) 숫자6-숫자7 조건(예: 123456-1234567) 통과 시 미리보기 화면으로
        const pass = ocrCheckPattern ? ocrCheckPattern.test(text) : true;

        if (pass) {
          setCapturedDataUrl(enhanced);
          setOcrLoading(false);
          // 여기서 stream은 계속 켜둬도 되지만, 미리보기 화면에서 재촬영 가능하므로 유지
        } else {
          // 실패 시 스피너 끄고 → 다시 탐지 루프 재개
          setOcrLoading(false);
          capturingRef.current = false;
          stableCountRef.current = 0;
          rafRef.current = requestAnimationFrame(detectLoop);
        }
      })();
      return;
    }

    rafRef.current = requestAnimationFrame(detectLoop);
  }, [isOpen, ready, capturedDataUrl, ocrLoading, drawVideoToWorkCanvas, ocrLang, ocrCheckPattern, onOcrText]);

  useEffect(() => {
    if (!isOpen || !ready || capturedDataUrl || ocrLoading) return;
    stableCountRef.current = 0;
    capturingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(detectLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isOpen, ready, detectLoop, capturedDataUrl, ocrLoading]);

  const retake = async () => {
    setCapturedDataUrl(null);
    setIsAligned(false);
    setGlareRatio(0);
    setGlareBlocked(false);
    setOcrLoading(false);
    stableCountRef.current = 0;
    capturingRef.current = false;
    await restartStream();
  };

  const handleUpload = () => {
    if (!capturedDataUrl) return;
    const file = dataURLtoFile(capturedDataUrl, `idcard-${Date.now()}.jpg`); // ★ 실제 JPEG
    onUpload?.(file);
    closeModal();
  };

  if (!isOpen) return null;

  const hintText = glareBlocked
    ? '빛 반사가 강합니다.'
    : (isAligned
        ? (glareRatio > GLARE_WARN_RATIO ? '빛 반사가 강합니다.' : '초점 맞는 중… 손을 잠시 고정해 주세요.')
        : '신분증을 프레임에 맞춰주세요.');

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <button className={styles.close} onClick={closeModal} aria-label="닫기">✕</button>

      {/* 스캐닝 화면 */}
      {!capturedDataUrl && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted autoPlay />
          <div className={styles.frameWrap}>
            <div
              ref={frameRef}
              className={`${styles.frame} ${isAligned && !glareBlocked ? styles.aligned : ''}`}
              aria-hidden
              style={{ aspectRatio: `${(85.6 / 53.98).toFixed(3)}` }} // ID-1 카드 비율
            />
            <div className={styles.hintTop}>
              {hintText}
              {showDebug && (
                <div className={styles.debug}>
                  {/* 필요 시 디버그 문자열 추가 가능 */}
                </div>
              )}
            </div>
          </div>

          {/* 3) OCR 조건 검사 동안 블랙 스피너로 화면 제어 */}
          {ocrLoading && (
            <div className={styles.blackSpinnerOverlay} aria-live="polite" aria-busy="true">
              <div className={styles.spinner} />
              <p>문자 인식 중…</p>
            </div>
          )}
        </>
      )}

      {/* 4) 조건 통과 시 미리보기 + 업로드 버튼 */}
      {capturedDataUrl && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.preview} src={capturedDataUrl} alt="미리보기" />
          <div className={styles.actions}>
            <button className={styles.buttonGhost} onClick={retake}>다시 찍기</button>
            <button className={styles.buttonPrimary} onClick={handleUpload}>업로드</button>
          </div>
        </>
      )}
    </div>
  );
}
