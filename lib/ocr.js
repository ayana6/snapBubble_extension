import { loadSettings } from "./utils.js";

const ocrCache = new Map();
const cacheLimit = 200;
const originInFlight = new Map();
const maxPerOrigin = 2;
let lastShotDataUrl = null;
let lastShotTs = 0;
let captureInFlight = null;

function cacheGet(key) { return ocrCache.get(key); }
function cacheSet(key, value) {
  if (ocrCache.has(key)) ocrCache.delete(key);
  ocrCache.set(key, value);
  if (ocrCache.size > cacheLimit) {
    const firstKey = ocrCache.keys().next().value;
    if (firstKey !== undefined) ocrCache.delete(firstKey);
  }
}

async function ensureTesseract(langHint) {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/tesseract.js@v5.0.2/dist/tesseract.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.documentElement.appendChild(s);
  });
  try {
    const w = await window.Tesseract.createWorker();
    await w.loadLanguage(langHint || "eng");
    await w.terminate();
  } catch {}
  return window.Tesseract;
}

export async function imgElToJpegDataUrl(img) {
  try { console.log('[SB][DBG] imgElToJpegDataUrl:start', { naturalW: img.naturalWidth, naturalH: img.naturalHeight, width: img.width, height: img.height, isBg: !!img.__sbBackgroundHost }); } catch {}
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
  try { console.log('[SB][DBG] imgElToJpegDataUrl:canvas', { W, H, MAX, ratio, w, h }); } catch {}
  
  
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
  try { console.warn('[SB][DBG] imgElToJpegDataUrl:drawImage failed, fallback path', e?.message || e); } catch {}
  }

  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const c = 1.01;
    for (let i = 0; i < d.length; i += 4) {
      let Y = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      Y = (Y - 128) * c + 128;
      d[i] = d[i+1] = d[i+2] = Math.max(0, Math.min(255, Y));
    }
    ctx.putImageData(imgData, 0, 0);
  } catch {}

  try {
    const result = canvas.toDataURL("image/jpeg", 0.9);
    try { console.log('[SB][DBG] imgElToJpegDataUrl:toDataURL ok', { len: result?.length || 0 }); } catch {}
    return result;
  } catch (e) {
    const url = img.currentSrc || img.src;
    if (!url) throw e;
    try {
      try { console.warn('[SB][DBG] imgElToJpegDataUrl:toDataURL tainted, using background fetch', url.slice(0, 160)); } catch {}
      return await dataUrlFromUrlViaBackground(url);
    } catch (e2) {
      try { console.warn('[SB][DBG] imgElToJpegDataUrl:bg fetch failed, using tab capture'); } catch {}
      return await dataUrlFromTabCaptureForElement(img);
    }
  }
}

async function dataUrlFromUrlViaBackground(imageUrl) {
  const resp = await chrome.runtime.sendMessage({
    type: "SB_FETCH",
    url: imageUrl,
    init: { method: "GET", credentials: "include", mode: "cors", referrer: location.href, referrerPolicy: "strict-origin-when-cross-origin" },
    returnType: "arrayBuffer"
  });
  if (!resp?.ok || !resp?.bodyB64) {
    try { console.warn('[SB][DBG] dataUrlFromUrlViaBackground:fetch failed', { status: resp?.status, err: resp?.error }); } catch {}
    throw new Error(`bg fetch failed status=${resp?.status ?? 'n/a'} err=${resp?.error ?? ''}`);
  }
  try { console.log('[SB][DBG] dataUrlFromUrlViaBackground:fetch ok', { status: resp?.status, ct: resp?.contentType, b64len: resp?.bodyB64?.length || 0 }); } catch {}
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
    try {
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;
      const c = 1.02;
      for (let i = 0; i < d.length; i += 4) {
        let Y = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        Y = (Y - 128) * c + 128;
        d[i] = d[i+1] = d[i+2] = Math.max(0, Math.min(255, Y));
      }
      ctx.putImageData(imgData, 0, 0);
    } catch {}
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function dataUrlFromTabCaptureForElement(img) {
  try { console.log('[SB][DBG] tabCapture:start'); } catch {}
  async function getScreenshot() {
    const now = Date.now();
    if (lastShotDataUrl && (now - lastShotTs) < 900) return lastShotDataUrl;
    if (captureInFlight) return await captureInFlight;
    // Retry with small backoff to handle transient capture failures or restricted pages
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
            try { console.log('[SB][DBG] tabCapture:ok', { attempt, len: resp.dataUrl?.length || 0 }); } catch {}
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
  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const c = 1.02;
    for (let i = 0; i < d.length; i += 4) {
      let Y = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      Y = (Y - 128) * c + 128;
      d[i] = d[i+1] = d[i+2] = Math.max(0, Math.min(255, Y));
    }
    ctx.putImageData(imgData, 0, 0);
  } catch {}
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function hashDataUrl(dataUrl) {
  try {
    const bytes = atob(dataUrl.split(",")[1] || "");
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i += 97) { // sample stride for speed
      h ^= bytes.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return "du:" + h.toString(16);
  } catch {
    return "du:" + (dataUrl.length >>> 0).toString(16);
  }
}

export async function ocrImageFromElement(img, opts = {}) {
  try { console.log('[SB][DBG] ocrImageFromElement:start'); } catch {}
  const settings = await loadSettings();
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
  try {
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
      try { console.log('[SB][DBG] ocrImageFromElement:ok', { words: viaOcrSpace?.words?.length || 0, chars: (viaOcrSpace?.text || '').length }); } catch {}
      return viaOcrSpace;
    }
  } catch (e) {
    try { console.warn('[SB] OCR.Space direct failed on element:', (e?.message||e)); } catch {}
  }
  if (settings.ocrProvider !== "tesseract") {
    return { words: [], text: "" };
  }
  const langMap = { chs: "chi_sim", jpn: "jpn", kor: "kor", "": "eng" };
  const lang = langMap[settings.forceOcrLang] || "eng";
  const Tesseract = await ensureTesseract(lang);
  const res = await Tesseract.recognize(dataUrl, lang, { logger: m => (m.status && console.log("[Tess]", m.status, m.progress||"")) });
  const words = (res?.data?.words || []).map(w => ({
    text: w.text || "",
    left: w.bbox?.x0 || 0,
    top: w.bbox?.y0 || 0,
    width: (w.bbox?.x1||0) - (w.bbox?.x0||0),
    height: (w.bbox?.y1||0) - (w.bbox?.y0||0),
  }));
  const out = { words, text: res?.data?.text || "" };
  cacheSet(cacheKey, out);
  return out;
}

export async function ocrImageByUrl(imageUrl, opts = {}) {
  try { console.log('[SB][DBG] ocrImageByUrl:start', imageUrl); } catch {}
  const settings = await loadSettings();
  const cacheKey = "url:" + imageUrl;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    try { console.log('[SB][DBG] ocrImageByUrl:SB_OCR_URL attempt'); } catch {}
    const bg = await chrome.runtime.sendMessage({
      type: "SB_OCR_URL",
      url: imageUrl,
      engine: settings.ocrEngine || "1",
      language: settings.forceOcrLang || "",
      apiKey: settings.ocrApiKey || ""
    });
    if (bg?.ok && bg?.result) {
      const parsed = parseOcrSpace(bg.result);
      cacheSet(cacheKey, parsed);
      try { console.log('[SB][DBG] ocrImageByUrl:SB_OCR_URL ok', { words: parsed?.words?.length || 0, chars: (parsed?.text || '').length }); } catch {}
      return parsed;
    }
    if (!bg?.ok) {
      console.warn('[SB][OCR_URL] worker OCR failed', bg?.status, (bg?.error||'').slice?.(0,200));
    }
  } catch (e) {
    console.warn('[SB][OCR_URL] worker OCR exception', e?.message || e);
  }
  try {
    try { console.log('[SB][DBG] ocrImageByUrl:SB_FETCH image bytes'); } catch {}
    const resp = await chrome.runtime.sendMessage({
      type: "SB_FETCH",
      url: imageUrl,
      init: { method: "GET" },
      returnType: "arrayBuffer"
    });
    if (!resp?.ok) {
      console.warn('[SB][OCR] bg fetch failed', resp?.status, (resp?.error||'').slice?.(0,200));
    }
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
        try { console.log('[SB][DBG] ocrImageByUrl:calling ocrSpaceBase64', { dataUrlLen: dataUrl?.length || 0 }); } catch {}
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
        try { console.log('[SB][DBG] ocrImageByUrl:ok', { words: via?.words?.length || 0, chars: (via?.text || '').length }); } catch {}
        return via;
      } finally {
        URL.revokeObjectURL(localUrl);
      }
    }
  } catch {}

  try {
    let pageUrl;
    try { pageUrl = new URL(location.href); } catch {}
    const targetUrl = new URL(imageUrl, location.href);
    const sameRegistrable = pageUrl && (pageUrl.hostname.split('.').slice(-2).join('.') === targetUrl.hostname.split('.').slice(-2).join('.'));
    if (sameRegistrable) {
      try { console.log('[SB][DBG] ocrImageByUrl:MAIN fetch fallback'); } catch {}
      const r = await chrome.runtime.sendMessage({ type: 'SB_MAIN_FETCH', url: imageUrl });
      if (r?.ok && r?.dataUrl) {
        const via = await ocrSpaceBase64(r.dataUrl, settings, opts?.signal);
        cacheSet(cacheKey, via);
        try { console.log('[SB][DBG] ocrImageByUrl:MAIN ok', { words: via?.words?.length || 0, chars: (via?.text || '').length }); } catch {}
        return via;
      }
    }
  } catch (e) {
    try { console.warn('[SB][DBG] MAIN fetch fallback failed', e?.message || e); } catch {}
  }

  return { words: [], text: "" };
}

async function ocrSpaceBase64(dataUrl, settings, signal) {
  try { console.log('[SB][DBG] ocrSpaceBase64:start', { engine: settings.ocrEngine, lang: settings.forceOcrLang, hasKey: !!settings.ocrApiKey, dataUrlLen: (dataUrl||'').length }); } catch {}
  
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
    try {
      const direct = await fetch("https://api.ocr.space/parse/image", { method: "POST", headers, body: form, signal });
      if (!direct.ok) throw new Error("HTTP " + direct.status);
      const json = await direct.json();
      try { console.log('[SB][DBG] ocrSpaceBase64:direct ok'); } catch {}
      return parseOcrSpace(json);
    } catch (e) {
      try { console.warn('[SB][DBG] ocrSpaceBase64:direct failed, fallback SB_FETCH', e?.message || e); } catch {}
      const resp2 = await chrome.runtime.sendMessage({
        type: "SB_FETCH",
        requestId,
        url: "https://api.ocr.space/parse/image",
        init: { method: "POST", headers },
        formFields: { base64Image: dataUrl, isOverlayRequired: "true", OCREngine: settings.ocrEngine || "1", isTable: "false", detectOrientation: "true", scale: "true", ...(settings.forceOcrLang ? { language: settings.forceOcrLang } : {}) }
      });
      if (!resp2?.ok) throw new Error(resp2?.body || resp2?.error || "OCR API error");
      let json2;
      try { json2 = JSON.parse(resp2.body || "{}"); } catch { throw new Error("OCR API invalid JSON"); }
      try { console.log('[SB][DBG] ocrSpaceBase64:SB_FETCH ok'); } catch {}
      return parseOcrSpace(json2);
    }
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
    originInFlight.set(origin, Math.max(0, (originInFlight.get(origin) || 1) - 1));
  }
}

function parseOcrSpace(json) {
  try { console.log('[SB][DBG] parseOcrSpace:start'); } catch {}
  if (json?.IsErroredOnProcessing) {
    const msg = Array.isArray(json?.ErrorMessage) ? json.ErrorMessage.join("; ") : (json?.ErrorMessage || json?.ErrorDetails || "Unknown OCR error");
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
  try { console.log('[SB][DBG] parseOcrSpace:done', { words: out.words.length, chars: out.text.length }); } catch {}
  return out;
}
