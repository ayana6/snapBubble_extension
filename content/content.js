let running = false;
let observing = false;
let moRef = null;
let ioRef = null;
let mo2Ref = null;
let onScrollOrResizeRef = null;
let onLoadHandlerRef = null;
let processedSet = new Set();
let inFlightSet = new Set();
let lastSrcMap = new Map();
let attemptMap = new Map();
let rescanTimerId = null;
let inBatch = false;
let hardFailed = false;

let utils, ocr, translate, overlay, aiocr, manualSelect;

(function setupSbLogFilter(){
  try {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    console.log = function(...args){
      try {
        const s = (args && args[0] != null) ? String(args[0]) : "";
        if (/^\[SB\]\[DBG\]/.test(s)) return;
      } catch {}
      return originalLog(...args);
    };
    console.warn = function(...args){
      try {
        const s = (args && args[0] != null) ? String(args[0]) : "";
        if (/^\[SB\]\[DBG\]/.test(s)) return;
      } catch {}
      return originalWarn(...args);
    };
  } catch {}
})();

let showDetailedLogs = true;
const sbDebug = { enabled: true, perTagLimit: 30, counts: Object.create(null) };

try {
  document.addEventListener('keydown', (e) => {
    try {
      const k = (e.key || '').toLowerCase();
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;
      
      if (modifierKey && e.altKey) {
        if (k === 'l') {
          showDetailedLogs = !showDetailedLogs;
          try { logHud('[SB] detailed logs ' + (showDetailedLogs ? 'ON' : 'OFF')); } catch {}
          e.stopPropagation();
          e.preventDefault();
        } else if (k === 's') {
          e.stopPropagation();
          e.preventDefault();
          toggleManualSelect();
        } else if (k === 'd') {
          sbDebug.enabled = !sbDebug.enabled;
          try { console.info('[SB] debug', sbDebug.enabled ? 'ON' : 'OFF'); } catch {}
          e.stopPropagation();
          e.preventDefault();
        } else if (k === 'e') {
          (async () => {
            try {
              const { clearErrorTracker } = await import(chrome.runtime.getURL("lib/utils.js"));
              await clearErrorTracker();
              logHud('[SB] Error tracker cleared');
            } catch (err) {
              logHud('[SB] Failed to clear error tracker: ' + err.message);
            }
          })();
          e.stopPropagation();
          e.preventDefault();
        } else if (k === 'h') {
          showShortcutsHelp();
          e.stopPropagation();
          e.preventDefault();
        }
      }
    } catch {}
  }, true);
} catch {}

function sbLogLimited(tag, payload) {
  try {
    if (!sbDebug.enabled) return;
    const c = sbDebug.counts[tag] || 0;
    if (c >= sbDebug.perTagLimit) return;
    sbDebug.counts[tag] = c + 1;
    console.info('[SB]', tag, payload || '');
    if (sbDebug.counts[tag] === sbDebug.perTagLimit) {
      console.info('[SB]', tag, '...suppressed further');
    }
  } catch {}
}


const TEST_MODE_RAW_OVERLAY = false;
const abortMap = new Map();
function isNearViewport(el, margin = 600) {
  try {
    const host = el.__sbBackgroundHost || el;
    const r = host.getBoundingClientRect();
    const top = -margin;
    const bottom = (window.innerHeight || 800) + margin;
    const left = -margin;
    const right = (window.innerWidth || 1024) + margin;
    return !(r.bottom < top || r.top > bottom || r.right < left || r.left > right);
  } catch { return true; }
}



function hud() {
  let el = document.getElementById("sb-debug");
  if (!el) {
    el = document.createElement("div");
    el.id = "sb-debug";
    el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,.8);color:#0f0;font:12px/1.4 monospace;max-width:46vw;max-height:48vh;overflow:auto;padding:8px;border:1px solid #0f0;border-radius:6px;";
    document.documentElement.appendChild(el);
    const btn = document.createElement("button");
    btn.textContent = "▾";
    btn.title = "Collapse/Expand";
    btn.style.cssText = "position:absolute;left:6px;top:6px;background:#0f0;color:#000;border:none;border-radius:3px;padding:0 4px;cursor:pointer;font:12px monospace;";
    btn.addEventListener("click", () => {
      const collapsed = el.getAttribute("data-collapsed") === "1";
      if (collapsed) {
        el.setAttribute("data-collapsed", "0");
        el.style.maxHeight = "48vh";
        el.style.overflow = "auto";
        btn.textContent = "▾";
      } else {
        el.setAttribute("data-collapsed", "1");
        el.style.maxHeight = "22px";
        el.style.overflow = "hidden";
        btn.textContent = "▸";
      }
    });
    el.appendChild(btn);
    const logs = document.createElement("div");
    logs.className = "sb-logs";
    logs.style.marginTop = "24px";
    el.appendChild(logs);
  }
  return el;
}
function logHud(s) {
  const el = hud();
  const logs = el.querySelector('.sb-logs') || el;
  try { if (/^\[SB\]\[DBG\]/.test(String(s||""))) return; } catch {}
  const p = document.createElement("div");
  p.textContent = s;
  logs.appendChild(p);
  while (logs.childNodes.length > 200) logs.removeChild(logs.firstChild);
}

window.logHud = logHud;

function showShortcutsHelp() {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifier = isMac ? 'Cmd' : 'Ctrl';
  
  const shortcuts = [
    `${modifier}+Alt+L - Toggle detailed logs`,
    `${modifier}+Alt+S - Toggle manual select mode`,
    `${modifier}+Alt+D - Toggle debug mode`,
    `${modifier}+Alt+E - Clear error tracker`,
    `${modifier}+Alt+H - Show this help`
  ];
  
  logHud('[SB] KEYBOARD SHORTCUTS:');
  shortcuts.forEach(shortcut => logHud(`  ${shortcut}`));
  logHud('[SB] Click extension icon for Start/Stop controls');
}
function clearHud() {
  const el = hud();
  const logs = el.querySelector('.sb-logs');
  if (logs) logs.textContent = "";
}
function excerpt(str, n=140) {
  str = (str || "").replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0,n) + "…" : str;
}

function collapseCjkSpaces(input) {
  try {
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    let out = "";
    for (let i = 0; i < (input||"").length; i++) {
      const ch = input[i];
      if (ch === " " && i > 0 && i < input.length - 1) {
        const prev = input[i-1];
        const next = input[i+1];
        if (CJK.test(prev) && CJK.test(next)) continue;
      }
      out += ch;
    }
    return out.trim();
  } catch { return (input||"").trim(); }
}

async function loadModules() {
  if (utils && ocr && translate && overlay) return;
  const base = (path) => chrome.runtime.getURL(path);
  utils = await import(base("lib/utils.js"));
  ocr = await import(base("lib/ocr.js"));
  translate = await import(base("lib/translate.js"));
  overlay = await import(base("lib/overlay.js"));
  aiocr = await import(base("lib/ai_ocr.js"));
  if (!manualSelect) {
    try { manualSelect = await import(base("lib/manual-select.js")); } catch {}
  }
}

function removeAllOverlays() {
  document.querySelectorAll("canvas.sb-overlay").forEach(n => { try { n.__sbCleanup && n.__sbCleanup(); } catch {} n.remove(); });
  document.querySelectorAll(".sb-manual-overlay").forEach(n => n.remove());
  processedSet.clear();
  inFlightSet.clear();
  lastSrcMap.clear();
  attemptMap.clear();
}

function failAndStop(msg) {
  try { logHud(`[ERR] ${msg}`); } catch {}
  running = false;
}

async function processImage(img) {
  if (!running || hardFailed) return;
  await loadModules();
  if (!running || processedSet.has(img) || inFlightSet.has(img)) return;
  const ready = () => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return img.complete && w > 0 && h > 0;
  };
  const srcNow = img.currentSrc || img.src || "";
  const lastSrc = lastSrcMap.get(img);
  if (lastSrc && srcNow && lastSrc !== srcNow) {
    processedSet.delete(img);
  }
  if (!ready() || !srcNow) {
    try { img.decode && img.decode().catch(() => {}); } catch {}
    img.addEventListener && img.addEventListener("load", () => { if (running) processImage(img); }, { once: true, capture: true });
    setTimeout(() => { if (running) processImage(img); }, 400);
    return;
  }
  if (!isNearViewport(img, 700)) {
    setTimeout(() => { if (running) processImage(img); }, 500);
    return;
  }
  inFlightSet.add(img);
  try { abortMap.get(img)?.abort?.(); } catch {}
  const controller = new AbortController();
  abortMap.set(img, controller);
  const settings = await utils.loadSettings().catch(() => null);
  if (!settings) { failAndStop('settings/context unavailable'); return; }
  if (!utils.isLargeEnough(img, settings.minImageSize)) { return; }
  lastSrcMap.set(img, srcNow);

  let drew = false;
  try {
    const src = img.currentSrc || img.src;
    if (!src) return;

    let ocrRes;
    try {
      if (src.startsWith("blob:") || src.startsWith("data:")) {
        ocrRes = await ocr.ocrImageFromElement(img, { signal: controller.signal });
      } else {
        ocrRes = await ocr.ocrImageByUrl(src, { signal: controller.signal });
      }
    } catch (e) {
      hardFailed = true; failAndStop(e?.message || 'OCR failed'); return;
    }

    if (!running) return;

    const words = (ocrRes.words || []).filter(w => (w.width > 1 && w.height > 1 && (w.text||'').trim()));
    if (!words.length) { sbLogLimited('no_text', excerpt(ocrRes.text||'')); return; }
    if (settings.debugEnabled) {
      const sample = words.slice(0, 8).map(w => w.text).join(' | ');
      try { logHud(`[SB][RAW] ${excerpt(sample, 200)}`); } catch {}
    }

    (async () => {
      try {
        const tlang = settings.targetLanguage || settings.targetLang || 'en';
        const { groupWordRects } = await import(chrome.runtime.getURL("lib/segmentation.js"));
        const wordRects = words.map(w => ({ left: w.left, top: w.top, width: w.width, height: w.height, text: w.text }));
        const grouped = groupWordRects(wordRects);
        let groupedBoxes = grouped.boxes || [];
        let groupedTexts = grouped.texts || [];
        if (!settings.skipNoiseFilter) {
          const NOISE = /(chapter|episode|creative|chief|producer|executive|mount\s*heng|责编|出品|制作|监制|章|话|卷|广告)/i;
          const filtered = [];
          for (let i = 0; i < groupedTexts.length; i++) {
            const t = collapseCjkSpaces((groupedTexts[i] || '').replace(/\s+/g, ' ').trim());
            const b = groupedBoxes[i];
            const area = (b?.width||0) * (b?.height||0);
            if (!t) continue;
            if (NOISE.test(t)) continue;
            if (area < 400) continue;
            filtered.push({ t, b });
          }
          groupedBoxes = filtered.map(x=>x.b);
          groupedTexts = filtered.map(x=>x.t);
        }
        try {
          const rect = img.getBoundingClientRect();
          const scaleX = (img.naturalWidth || img.width || 1) / (rect.width || 1);
          const scaleY = (img.naturalHeight || img.height || 1) / (rect.height || 1);
          const sampleW = 48, sampleH = 48;
          const pool = (window.__sbPool ||= { c: [], i: 0 });
          function getCanvas(){ let c = pool.c[pool.i++ % 3]; if(!c){ c = document.createElement('canvas'); pool.c.push(c);} c.width=sampleW; c.height=sampleH; return c; }
          const scored = [];
          for (let i = 0; i < groupedBoxes.length; i++) {
            const b = groupedBoxes[i];
            const t = (groupedTexts[i] || '').replace(/\s+/g, '');
            if (!t) continue;
            const sx = Math.max(0, Math.floor((b.left||0) * scaleX));
            const sy = Math.max(0, Math.floor((b.top||0) * scaleY));
            const sw = Math.max(1, Math.floor((b.width||1) * scaleX));
            const sh = Math.max(1, Math.floor((b.height||1) * scaleY));
            const c = getCanvas();
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
            const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
            let sum = 0, sum2 = 0; const count = sampleW * sampleH;
            for (let p = 0; p < data.length; p += 4) {
              const l = 0.299*data[p] + 0.587*data[p+1] + 0.114*data[p+2];
              sum += l; sum2 += l*l;
            }
            const mean = sum / count; const variance = Math.max(0, (sum2 / count) - (mean*mean));
            const luma = mean/255; const flat = 1 - Math.min(1, Math.sqrt(variance)/128);
            const area = Math.max(1, (b.width||1) * (b.height||1));
            const density = t.length / area;
            const score = density * 0.6 + (luma * 0.8 + flat * 0.2) * 0.4;
            scored.push({ b, t: groupedTexts[i], score });
          }
          scored.sort((a,b)=>b.score-a.score);
          const MAX_BOXES = 12;
          const kept = scored.slice(0, MAX_BOXES);
          kept.sort((a,b)=> (a.b.top - b.b.top) || (a.b.left - b.b.left));
          groupedBoxes = kept.map(x=>x.b);
          groupedTexts = kept.map(x=>x.t);
        } catch {}

        if (settings.debugEnabled) {
          const dbg = groupedTexts.slice(0,3).map(t=>excerpt(t,80)).join(' || ');
          try { logHud(`[SB][GROUP] ${dbg}`); } catch {}
        }
        const accBoxes = [];
        const accTexts = [];
        const BATCH_SIZE = 3;
        for (let i = 0; i < groupedTexts.length; i += BATCH_SIZE) {
          if (!running) break;
          const sliceBoxes = groupedBoxes.slice(i, i + BATCH_SIZE);
          const sliceTexts = groupedTexts.slice(i, i + BATCH_SIZE);
          await new Promise(r => setTimeout(r, 75));
          let translatedSlice = [];
          try {
            translatedSlice = await translate.translateTextArray(sliceTexts, tlang, { signal: controller.signal });
          } catch (e) {
            translatedSlice = sliceTexts;
          }
          for (let j = 0; j < translatedSlice.length; j++) {
            const out = (translatedSlice[j] || sliceTexts[j]);
            accBoxes.push(sliceBoxes[j]);
            accTexts.push(out);
          }
          await overlay.drawTextOverlays(img, accBoxes, accTexts);
        }
      } catch (e) {
        const msg = e?.message || String(e || 'error');
        if (/quota_exceeded|rate limit|429/i.test(msg)) {
          try { logHud('[SB] Quota exceeded. Stopping.'); } catch {}
          stop();
        } else {
          try { logHud('[SB] Translate/group failed: ' + msg); } catch {}
        }
      }
    })();
  } catch (e) {
    if (e?.name === "AbortError") {
      return;
    } else {
      hardFailed = true; failAndStop(e?.message || String(e));
    }
  } finally {
    inFlightSet.delete(img);
    abortMap.delete(img);
    if (drew) {
      processedSet.add(img);
      attemptMap.delete(img);
    } else {
      processedSet.add(img);
    }
  }
}

async function scanAllImages() {
  await loadModules();
  const imgs = Array.from(document.querySelectorAll('.mh_comicpic img, img'));
  const bgEls = Array.from(document.querySelectorAll('[style*="background-image"], .bg-cover, .bg-image'))
    .filter(el => {
      try {
        const bg = getComputedStyle(el).backgroundImage || "";
        return /url\(\s*[^)]+\s*\)/i.test(bg);
      } catch { return false; }
    })
    .map(el => {
      const proxy = new Image();
      try {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(("|')?(.*?)(\1)\)/i);
        const url = m?.[2] || "";
        if (url) proxy.src = url;
      } catch {}
      const r = el.getBoundingClientRect();
      proxy.width = Math.max(1, Math.floor(r.width));
      proxy.height = Math.max(1, Math.floor(r.height));
      proxy.__sbBackgroundHost = el;
      return proxy;
    });
  
  const all = imgs.concat(bgEls);
  const settings = await utils.loadSettings();
  let queue = all.filter(img => !processedSet.has(img) && utils.isLargeEnough(img, settings.minImageSize));


  if (settings.batchProcessing) {
    await processImagesInBatches(queue);
  } else {
    const maxConcurrency = Math.max(1, Math.min(settings.maxConcurrentImages || 2, 6));
    for (let i = 0; i < queue.length; i += maxConcurrency) {
      const slice = queue.slice(i, i + maxConcurrency);
      await Promise.all(slice.map(img => processImage(img)));
    }
  }
}

async function processImagesInBatches(images) {
  inBatch = true;
  const settings = await utils.loadSettings();
  
  if (settings.useAiOcr) {
    try { await processImagesInBatchesAI(images); } finally { inBatch = false; }
  } else {
    try { await processImagesIndividually(images); } finally { inBatch = false; }
  }
}

async function processImagesInBatchesAI(images) {
  try {
    const results = await aiocr.batchRecognizeViaVision(images, { signal: null });
    
    for (let i = 0; i < results.length; i++) {
      if (!running) break;
      const result = results[i];
      if (result && result.texts && result.texts.length > 0) {
        await drawOverlaysForImage(images[i], result.texts, result.boxes);
      }
    }
    
  } catch (e) {
    const msg = e?.message || String(e||'error');
    if (/quota_exceeded|rate limit|429/i.test(msg)) {
      try { logHud('[SB] AI OCR quota exceeded. Stopping.'); } catch {}
      stop();
      return;
    }
    logHud(`[ERR] AI OCR batch failed: ${msg}`);
  }
}

async function processImagesIndividually(images) {
  for (const img of images) {
    processedSet.delete(img);
    inFlightSet.delete(img);
  }
  

  const { groupWordRects } = await import(chrome.runtime.getURL("lib/segmentation.js"));

  const imageResults = [];
  const ocrPromises = images.map(async (img) => {
    if (!running) return null;
    try {
      const ocrResult = await processImageForOCR(img);
      if (ocrResult && ocrResult.boxes && ocrResult.boxes.length > 0) {
        const grouped = groupWordRects(ocrResult.boxes);
        return { img: img, texts: grouped.texts, boxes: grouped.boxes };
      } 
    } catch (e) {
      console.warn('[SB] OCR failed for image:', e);
    }
    return null;
  });
  
  const results = await Promise.all(ocrPromises);
  imageResults.push(...results.filter(Boolean));
  
  if (imageResults.length === 0) {
    return;
  }
  
  try {
    const settings = await utils.loadSettings();
    const conc = Math.min(2, Math.max(1, settings.maxConcurrentImages || 2));
    
    const processImage = async (item) => {
      try {
        const translated = await translate.translateTextArray(item.texts, settings.targetLanguage);
        for (let i = 0; i < translated.length; i++) item.texts[i] = translated[i];
        await drawOverlaysForImage(item.img, item.texts, item.boxes);
      } catch (e) {
      }
    };
    
    const chunks = [];
    for (let i = 0; i < imageResults.length; i += conc) {
      chunks.push(imageResults.slice(i, i + conc));
    }
    
    for (const chunk of chunks) {
      if (!running) break;
      await Promise.all(chunk.map(processImage));
    }
  } catch (e) {
    logHud(`[ERR] Translation failed: ${e.message}`);
  }
}

async function processImageForOCR(img) {
  if (!running || processedSet.has(img) || inFlightSet.has(img)) return null;
  
  const w0 = img.naturalWidth || img.width || 0;
  const h0 = img.naturalHeight || img.height || 0;
  if (w0 < 50 || h0 < 50) return null;
  
  const srcNow = img.currentSrc || img.src || "";
  const lastSrc = lastSrcMap.get(img);
  if (lastSrc && srcNow && lastSrc !== srcNow) {
    processedSet.delete(img);
  }
  
  if (!srcNow) return null;
  
  inFlightSet.add(img);
  try {
    const controller = new AbortController();
    abortMap.set(img, controller);
    
    const settings = await utils.loadSettings();
    let ocrRes;
    
    if (settings.useAiOcr) {
      ocrRes = await aiocr.aiOcrOnly(img, { signal: controller.signal });
    } else {
      const src = img.currentSrc || img.src || "";
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        ocrRes = await ocr.ocrImageByUrl(src, { signal: controller.signal });
      } else {
        ocrRes = await ocr.ocrImageFromElement(img, { signal: controller.signal });
      }
    }
    
    if (!ocrRes?.text || !ocrRes.text.trim()) return null;
    
    const texts = ocrRes.words?.map(w => w.text).filter(Boolean) || [ocrRes.text];
    const boxes = ocrRes.words || [];
    
    return { texts, boxes };
    
  } finally {
    inFlightSet.delete(img);
    abortMap.delete(img);
    processedSet.add(img);
    lastSrcMap.set(img, srcNow);
  }
}

async function drawOverlaysForImage(img, texts, boxes) {
  if (!texts.length || !running) return;
  
  try {
    await overlay.drawTextOverlays(img, boxes, texts);
  } catch (e) {
  }
}

function ensureObserver() {
  if (observing) return;
  observing = true;
  const mo = new MutationObserver((mutations) => {
    if (!running) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.tagName === "IMG") {
            processImage(node);
          } else {
            const imgs = node.querySelectorAll?.("img");
            imgs && imgs.forEach(processImage);
          }
        }
      }
      if (m.type === "attributes" && m.target?.tagName === "IMG") {
        processImage(m.target);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
  onLoadHandlerRef = (e) => {
    if (!running) return;
    const t = e.target;
    if (t && t.tagName === "IMG") processImage(t);
  };
  document.addEventListener("load", onLoadHandlerRef, true);

  onScrollOrResizeRef = () => scheduleViewportRescan();
  window.addEventListener('scroll', onScrollOrResizeRef, { passive: true });
  window.addEventListener('resize', onScrollOrResizeRef, { passive: true });

  try {
    const io = new IntersectionObserver((entries) => {
      if (!running) return;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target.tagName === "IMG") {
          processImage(entry.target);
        }
      }
    }, { root: null, rootMargin: "400px 0px", threshold: 0.01 });
    document.querySelectorAll('img').forEach(img => io.observe(img));
    const attachIO = (node) => { if (node.tagName === 'IMG') io.observe(node); else node.querySelectorAll?.('img')?.forEach(n => io.observe(n)); };
    const mo2 = new MutationObserver((mutList) => { for (const m of mutList) { m.addedNodes && m.addedNodes.forEach(attachIO); } });
    mo2.observe(document.documentElement, { childList: true, subtree: true });
    ioRef = io;
    mo2Ref = mo2;
  } catch {}
  moRef = mo;
}

function scheduleViewportRescan() {
  if (!running) return;
  if (rescanTimerId) return;
  rescanTimerId = setTimeout(() => {
    rescanTimerId = null;
    const vpTop = -2000;
    const vpBottom = (window.innerHeight || 800) + 2000;
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.bottom < vpTop || r.top > vpBottom) continue;
      const parent = img.parentElement;
      const hasOverlay = parent?.querySelector?.('canvas.sb-overlay');
      const srcNow = img.currentSrc || img.src || "";
      const lastSrc = lastSrcMap.get(img);
      const need = (!hasOverlay) || (lastSrc && srcNow && lastSrc !== srcNow);
      if (processedSet.has(img) && hasOverlay && !need) continue;
      if (need) processImage(img);
    }
  }, 350);
}

async function start() {
  await loadModules();
  running = true;
  ensureObserver();
  clearHud();
  
  try {
    const { clearErrorTracker } = await import(chrome.runtime.getURL("lib/utils.js"));
    await clearErrorTracker();
  } catch {}
  
  const s = await utils.loadSettings();
  try { const { preloadOverlayFont } = await import(chrome.runtime.getURL("lib/overlay.js")); preloadOverlayFont(s); } catch {}
  const mode = s.useAiOcr ? `AI(${s.aiModel})` : `ocrspace(${s.forceOcrLang||"auto"})`;
  logHud(`[SB] START • lang=${s.targetLanguage} • OCR=${mode} • min=${s.minImageSize.width}x${s.minImageSize.height} • TR=${s.translateProvider}`);
  await scanAllImages();
}

function stop() {
  running = false;
  logHud("[SB] stopped.");
  try {
    for (const c of abortMap.values()) { try { c.abort(); } catch {} }
  } finally {
    abortMap.clear();
  }
  try { if (moRef) moRef.disconnect(); } catch {}
  try { if (ioRef) ioRef.disconnect(); } catch {}
  try { if (mo2Ref) mo2Ref.disconnect(); } catch {}
  try { if (onScrollOrResizeRef) { window.removeEventListener('scroll', onScrollOrResizeRef); window.removeEventListener('resize', onScrollOrResizeRef); } } catch {}
  try { if (onLoadHandlerRef) { document.removeEventListener('load', onLoadHandlerRef, true); } } catch {}
  moRef = null; ioRef = null; mo2Ref = null; onScrollOrResizeRef = null; onLoadHandlerRef = null;
  observing = false;
  if (rescanTimerId) { try { clearTimeout(rescanTimerId); } catch {} rescanTimerId = null; }
}

function rescan() {
  removeAllOverlays();
  if (!running) running = true;
  try { for (const c of abortMap.values()) { try { c.abort(); } catch {} } } finally { abortMap.clear(); }
  logHud("[SB] RESCAN");
  scanAllImages();
}

async function toggleManualSelect() {
  try {
    await loadModules();
    if (!manualSelect) {
      try {
        const base = (path) => chrome.runtime.getURL(path);
        manualSelect = await import(base("lib/manual-select.js"));
      } catch (e) {
        try { logHud('[SB] Manual select failed to load'); } catch {}
        return;
      }
    }
    
    if (manualSelect.isManualSelectActive()) {
      manualSelect.stopManualSelect();
      try { logHud('[SB] Manual select OFF'); } catch {}
    } else {
      manualSelect.startManualSelect();
      try { logHud('[SB] Manual select ON - drag to select area'); } catch {}
    }
  } catch (e) {
    try { logHud('[SB] Manual select error: ' + (e?.message || e)); } catch {}
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SB_START") start();
  if (msg?.type === "SB_STOP") stop();
  if (msg?.type === "SB_RESCAN") rescan();
  if (msg?.type === "SB_MANUAL_SELECT") toggleManualSelect();
});

window.addEventListener('beforeunload', () => {
  processedSet.clear();
  inFlightSet.clear();
  lastSrcMap.clear();
  attemptMap.clear();
});
