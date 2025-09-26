
import { loadSettings, trackError, shouldStopProcessing } from "./utils.js";

const ocrCache = new Map();
const cacheLimit = 200;
const originInFlight = new Map();
const maxPerOrigin = 2;
let lastShotDataUrl = null;
let lastShotTs = 0;
let captureInFlight = null;
const __sbCaptureInfo = new WeakMap();

async function sendMessageWithTimeout(payload, timeoutMs = 15000) {
  return await Promise.race([
    (async () => {
      try { return await chrome.runtime.sendMessage(payload); } catch (e) { return { ok: false, error: String(e || 'sendMessage failed') }; }
    })(),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs))
  ]);
}

function cacheGet(key) { return ocrCache.get(key); }
function cacheSet(key, value) {
  if (ocrCache.has(key)) ocrCache.delete(key);
  ocrCache.set(key, value);
  if (ocrCache.size > cacheLimit) {
    const firstKey = ocrCache.keys().next().value;
    if (firstKey !== undefined) ocrCache.delete(firstKey);
  }
}

export async function imgElToJpegDataUrl(img) {
  if (img.decode) { try { await img.decode(); } catch(e) {} }
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  if (!W || !H) throw new Error("Image not loaded yet");

  const MAX = 1600;
  const ratio = Math.min(1, MAX / Math.max(W, H));
  const w = Math.max(1, Math.floor(W * ratio));
  const h = Math.max(1, Math.floor(H * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  
  
  try {
    if (img.__sbBackgroundHost) {
      const host = img.__sbBackgroundHost;
      const src = img.src || "";
      if (src) {
        const im = await new Promise((resolve, reject) => {
          const x = new Image();
          x.onload = () => resolve(x);
          x.onerror = reject;
          x.src = src;
        });
        ctx.drawImage(im, 0, 0, w, h);
      }
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
  } catch (e) {
  }

  try {
    const result = canvas.toDataURL("image/jpeg", 0.85);
    try { __sbCaptureInfo.set(img, { mode: "natural", canvasW: w, canvasH: h, baseW: W, baseH: H }); } catch {}
    return result;
  } catch (e) {
    const url = img.currentSrc || img.src;
    if (!url) throw e;
    try {
      const du = await dataUrlFromUrlViaBackground(url);
      try { __sbCaptureInfo.set(img, { mode: "natural", canvasW: w, canvasH: h, baseW: W, baseH: H }); } catch {}
      return du;
    } catch (e2) {
      return await dataUrlFromTabCaptureForElement(img);
    }
  }
}

async function dataUrlFromUrlViaBackground(imageUrl) {
  const resp = await sendMessageWithTimeout({
    type: "SB_FETCH",
    url: imageUrl,
    init: { method: "GET", credentials: "include", mode: "cors", referrer: location.href, referrerPolicy: "strict-origin-when-cross-origin" },
    returnType: "arrayBuffer"
  }, 15000);
  if (!resp?.ok || !resp?.bodyB64) {
    throw new Error(`bg fetch failed status=${resp?.status ?? 'n/a'} err=${resp?.error ?? ''}`);
  }
  const b64 = resp.bodyB64;
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const type = (resp.contentType && typeof resp.contentType === 'string') ? resp.contentType.split(';')[0] : 'image/jpeg';
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    const MAX = 1600;
    const ratio = Math.min(1, MAX / Math.max(W, H));
    const w = Math.max(1, Math.floor(W * ratio));
    const h = Math.max(1, Math.floor(H * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    try { } catch {}
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function dataUrlFromTabCaptureForElement(img) {
  async function getScreenshot() {
    const now = Date.now();
    if (lastShotDataUrl && (now - lastShotTs) < 900) return lastShotDataUrl;
    if (captureInFlight) return await captureInFlight;
    captureInFlight = (async () => {
      const maxAttempts = 3;
      let attempt = 0;
      let lastErr = null;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          let resp = await chrome.runtime.sendMessage({ type: "SB_CAPTURE", format: 'png', quality: 100 });
          if (!resp?.ok) {
            await new Promise(r => setTimeout(r, 300));
            resp = await chrome.runtime.sendMessage({ type: "SB_CAPTURE", format: 'jpeg', quality: 95 });
          }
          if (resp?.ok && resp?.dataUrl) {
            lastShotDataUrl = resp.dataUrl;
            lastShotTs = Date.now();
            return lastShotDataUrl;
          }
          lastErr = new Error(resp?.error || 'unknown error');
        } catch (e) {
          lastErr = e;
        }
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
      throw new Error(`tab capture failed: ${lastErr?.message || 'unknown error'}`);
    })();
    try { return await captureInFlight; } finally { captureInFlight = null; }
  }
  const shotUrl = await getScreenshot();
  const screenshot = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = shotUrl;
  });
  const hostEl = img.__sbBackgroundHost || img;
  const r = hostEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const sx = Math.max(0, Math.floor(r.left * dpr));
  const sy = Math.max(0, Math.floor(r.top * dpr));
  const sW = Math.max(1, Math.floor(r.width * dpr));
  const sH = Math.max(1, Math.floor(r.height * dpr));
  const MAX = 1600;
  const ratio = Math.min(1, MAX / Math.max(sW, sH));
  const w = Math.max(1, Math.floor(sW * ratio));
  const h = Math.max(1, Math.floor(sH * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(screenshot, sx, sy, sW, sH, 0, 0, w, h);
  try { } catch {}
  const out = canvas.toDataURL('image/jpeg', 0.9);
  try { __sbCaptureInfo.set(img, { mode: "display", canvasW: w, canvasH: h, cssW: r.width, cssH: r.height }); } catch {}
  return out;
}

async function hashDataUrl(dataUrl) {
  try {
    const bytes = atob(dataUrl.split(",")[1] || "");
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i += 97) { 
      h ^= bytes.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return "du:" + h.toString(16);
  } catch {
    return "du:" + (dataUrl.length >>> 0).toString(16);
  }
}

export async function ocrImageFromElement(img, opts = {}) {
  const settings = await loadSettings();
  
  const shouldStop = await shouldStopProcessing("ocr_failed", "ocrspace");
  if (shouldStop) {
    const errorMsg = `[ERR] OCR service failed repeatedly - stopping processing. Check API key/limits.`;
    console.warn(errorMsg);
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(errorMsg);
      }
    } catch {}
    return { words: [], text: "" };
  }
  
  const dataUrl = await imgElToJpegDataUrl(img);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const MAX = 1600;
  const ratio = Math.min(1, MAX / Math.max(W, H));
  const w = Math.max(1, Math.floor(W * ratio));
  const h = Math.max(1, Math.floor(H * ratio));
  const ci = __sbCaptureInfo.get(img);
  let scaleBackX = 1, scaleBackY = 1, coordsAreDisplay = false;
  if (ci && ci.mode === 'display') {
    const cssW = Math.max(1, ci.cssW || (img.getBoundingClientRect().width || 1));
    const cssH = Math.max(1, ci.cssH || (img.getBoundingClientRect().height || 1));
    scaleBackX = cssW / Math.max(1, ci.canvasW || w);
    scaleBackY = cssH / Math.max(1, ci.canvasH || h);
    coordsAreDisplay = true;
  } else if (ci && ci.mode === 'natural') {
    scaleBackX = Math.max(1, ci.baseW || W) / Math.max(1, ci.canvasW || w);
    scaleBackY = Math.max(1, ci.baseH || H) / Math.max(1, ci.canvasH || h);
  } else {
    scaleBackX = W > 0 ? (W / w) : 1;
    scaleBackY = H > 0 ? (H / h) : 1;
  }
  const cacheKey = await hashDataUrl(dataUrl);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const viaOcrSpace = await ocrSpaceBase64(dataUrl, settings, opts?.signal);
    if ((viaOcrSpace?.text || "").trim()) {
      if (Array.isArray(viaOcrSpace.words)) {
        for (const wobj of viaOcrSpace.words) {
          if (!wobj) continue;
          if (scaleBackX !== 1 || scaleBackY !== 1) {
            wobj.left = Math.round((wobj.left || 0) * scaleBackX);
            wobj.top = Math.round((wobj.top || 0) * scaleBackY);
            wobj.width = Math.round((wobj.width || 0) * scaleBackX);
            wobj.height = Math.round((wobj.height || 0) * scaleBackY);
          }
          if (coordsAreDisplay) { try { wobj.__display = true; } catch {} }
        }
      }
      if (coordsAreDisplay) { try { viaOcrSpace.__display = true; } catch {} }
      cacheSet(cacheKey, viaOcrSpace);
      return viaOcrSpace;
    }
  } catch (e) {
    await trackError("ocr_failed", `OCR.Space failed: ${e?.message || e}`, "ocrspace");
    const msg = sanitizeOcrError(String(e?.message || e));
    const hudMsg = `[ERR] OCR failed: ${msg}`;
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(hudMsg);
      }
    } catch {}
  }
  return { words: [], text: "" };
}

export async function ocrImageByUrl(imageUrl, opts = {}) {
  const settings = await loadSettings();
  
  const shouldStop = await shouldStopProcessing("ocr_failed", "ocrspace");
  if (shouldStop) {
    const errorMsg = `[ERR] OCR service failed repeatedly - stopping processing. Check API key/limits.`;
    console.warn(errorMsg);
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(errorMsg);
      }
    } catch {}
    return { words: [], text: "" };
  }
  
  const cacheKey = "url:" + imageUrl;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const bg = await sendMessageWithTimeout({
      type: "SB_OCR_URL",
      url: imageUrl,
      engine: settings.ocrEngine || "1",
      language: settings.forceOcrLang || "",
      apiKey: settings.ocrApiKey || ""
    }, 25000);
    if (bg?.ok && bg?.result) {
      const parsed = parseOcrSpace(bg.result);
      cacheSet(cacheKey, parsed);
      return parsed;
    }
  } catch (e) {
    // Track OCR errors
    await trackError("ocr_failed", `OCR URL worker failed: ${e?.message || e}`, "ocrspace");
    const hudMsg = `[ERR] OCR URL failed: ${sanitizeOcrError(String(e?.message || e))}`;
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(hudMsg);
      }
    } catch {}
  }
  try {
    const resp = await sendMessageWithTimeout({
      type: "SB_FETCH",
      url: imageUrl,
      init: { method: "GET" },
      returnType: "arrayBuffer"
    }, 25000);
    if (resp?.ok && resp?.bodyB64) {
      const byteChars = atob(resp.bodyB64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const type = (resp.contentType && typeof resp.contentType === 'string') ? resp.contentType.split(';')[0] : 'image/jpeg';
      const blob = new Blob([bytes], { type });
      const localUrl = URL.createObjectURL(blob);
      try {
        const im = await new Promise((resolve, reject) => {
          const x = new Image();
          x.onload = () => resolve(x);
          x.onerror = reject;
          x.src = localUrl;
        });
        const dataUrl = await imgElToJpegDataUrl(im);
        const via = await ocrSpaceBase64(dataUrl, settings, opts?.signal);
        try {
          const W = im.naturalWidth || im.width || 0;
          const H = im.naturalHeight || im.height || 0;
          const MAX = 1600;
          const ratio = Math.min(1, MAX / Math.max(W, H));
          const w = Math.max(1, Math.floor(W * ratio));
          const h = Math.max(1, Math.floor(H * ratio));
          const scaleBackX = W > 0 ? (W / w) : 1;
          const scaleBackY = H > 0 ? (H / h) : 1;
          if (Array.isArray(via?.words) && (scaleBackX !== 1 || scaleBackY !== 1)) {
            for (const wobj of via.words) {
              if (!wobj) continue;
              wobj.left = Math.round((wobj.left || 0) * scaleBackX);
              wobj.top = Math.round((wobj.top || 0) * scaleBackY);
              wobj.width = Math.round((wobj.width || 0) * scaleBackX);
              wobj.height = Math.round((wobj.height || 0) * scaleBackY);
            }
          }
          via.__naturalWidth = W;
          via.__naturalHeight = H;
        } catch {}
        cacheSet(cacheKey, via);
        return via;
      } finally {
        URL.revokeObjectURL(localUrl);
      }
    }
  } catch {}

  return { words: [], text: "" };
}

async function ocrSpaceBase64(dataUrl, settings, signal) {
  const form = new FormData();
  form.set("base64Image", dataUrl);
  form.set("isOverlayRequired", "true");
  form.set("OCREngine", settings.ocrEngine || "1");
  form.set("isTable", "false");
  form.set("detectOrientation", "true");
  form.set("scale", "true");
  if (settings.forceOcrLang) form.set("language", settings.forceOcrLang);
  const headers = settings.ocrApiKey ? { "apikey": settings.ocrApiKey } : {};
  const origin = "ocr.space";
  while ((originInFlight.get(origin) || 0) >= maxPerOrigin) {
    await new Promise(r => setTimeout(r, 30));
  }
  originInFlight.set(origin, (originInFlight.get(origin) || 0) + 1);
  const requestId = "ocr-" + Math.random().toString(36).slice(2);
  let abortListener;
  try {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (signal) {
      abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    const resp = await sendMessageWithTimeout({
      type: "SB_FETCH",
      requestId,
      url: "https://api.ocr.space/parse/image",
      init: { method: "POST", headers, mode: "cors", cache: "no-store" },
      formFields: { base64Image: dataUrl, isOverlayRequired: "true", OCREngine: settings.ocrEngine || "1", isTable: "false", detectOrientation: "true", scale: "true", ...(settings.forceOcrLang ? { language: settings.forceOcrLang } : {}) }
    }, 20000);
    if (!resp?.ok) {
      throw new Error(resp?.body || resp?.error || "OCR API error");
    }
    const json = JSON.parse(resp.body || "{}");
    return parseOcrSpace(json);
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
    originInFlight.set(origin, Math.max(0, (originInFlight.get(origin) || 1) - 1));
  }
}

function parseOcrSpace(json) {
  if (json?.IsErroredOnProcessing) {
    const raw = Array.isArray(json?.ErrorMessage) ? json.ErrorMessage.join("; ") : (json?.ErrorMessage || json?.ErrorDetails || "Unknown OCR error");
    const msg = sanitizeOcrError(String(raw||''));
    throw new Error("OCR.Space error: " + msg);
  }
  if (!json?.ParsedResults?.length) {
    const code = json?.OCRExitCode != null ? String(json.OCRExitCode) : "?";
    throw new Error("OCR.Space: no ParsedResults (ExitCode=" + code + ")");
  }
  const out = { words: [], text: "" };
  const pr = json.ParsedResults[0];
  out.text = pr?.ParsedText || "";
  const lines = pr?.TextOverlay?.Lines || [];
  for (const line of lines) {
    for (const w of (line.Words || [])) {
      out.words.push({
        text: w?.WordText || "",
        left: w?.Left || 0,
        top: w?.Top || 0,
        width: w?.Width || 0,
        height: w?.Height || 0
      });
    }
  }
  return out;
}

export async function batchOcrImages(images, opts = {}) {
  const settings = await loadSettings();
  const results = [];
  
  const shouldStop = await shouldStopProcessing("ocr_failed", "ocrspace");
  if (shouldStop) {
    const errorMsg = `[ERR] OCR service failed repeatedly - stopping batch processing. Check API key/limits.`;
    console.warn(errorMsg);
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(errorMsg);
      }
    } catch {}
    return images.map(() => ({ words: [], text: "" }));
  }
  
  const batchSize = 3;
  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    const batchPromises = batch.map(async (img) => {
      try {
        const dataUrl = await imgElToJpegDataUrl(img);
        const W = img.naturalWidth || img.width;
        const H = img.naturalHeight || img.height;
        const MAX = 1600;
        const ratio = Math.min(1, MAX / Math.max(W, H));
        const w = Math.max(1, Math.floor(W * ratio));
        const h = Math.max(1, Math.floor(H * ratio));
        const scaleBackX = W > 0 ? (W / w) : 1;
        const scaleBackY = H > 0 ? (H / h) : 1;
        const cacheKey = await hashDataUrl(dataUrl);
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
        
        const viaOcrSpace = await ocrSpaceBase64(dataUrl, settings, opts?.signal);
        if ((viaOcrSpace?.text || "").trim()) {
          if (Array.isArray(viaOcrSpace.words) && (scaleBackX !== 1 || scaleBackY !== 1)) {
            for (const wobj of viaOcrSpace.words) {
              if (!wobj) continue;
              wobj.left = Math.round((wobj.left || 0) * scaleBackX);
              wobj.top = Math.round((wobj.top || 0) * scaleBackY);
              wobj.width = Math.round((wobj.width || 0) * scaleBackX);
              wobj.height = Math.round((wobj.height || 0) * scaleBackY);
            }
          }
          cacheSet(cacheKey, viaOcrSpace);
          return viaOcrSpace;
        }
        return { words: [], text: "" };
      } catch (e) {
        // Track OCR errors
        await trackError("ocr_failed", `Batch OCR failed: ${e?.message || e}`, "ocrspace");
        const hudMsg = `[ERR] Batch OCR failed: ${e?.message || e}`;
        try {
          if (typeof window !== 'undefined' && window.logHud) {
            window.logHud(hudMsg);
          }
        } catch {}
        return { words: [], text: "" };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    if (i + batchSize < images.length) {
      await new Promise(resolve => setTimeout(resolve, 50)); 
    }
  }
  
  return results;
}

function sanitizeOcrError(msg) {
  try {
    const lower = String(msg || '').toLowerCase();
    if (lower.includes('please contact administrator')) {
      return 'Service issue. Try again shortly or get help on Discord: https://discord.gg/vckeW3cXxS';
    }
    if (lower.includes('timeout')) {
      return 'timeout';
    }
    return msg;
  } catch { return msg; }
}
