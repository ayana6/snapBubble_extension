let running = false;
let observing = false;
let processedSet = new WeakSet();
let inFlightSet = new WeakSet();
let lastSrcMap = new WeakMap();
let attemptMap = new WeakMap();
let rescanTimerId = null;
let inBatch = false;

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
          // Clear error tracker
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
          // Show help
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

function textsNeedTranslation(arr, targetLang) {
  try {
    const t = (targetLang || "en").toLowerCase();
    const hasCJK = (s) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s || "");
    if (t.startsWith('en')) {
      return (arr || []).some(hasCJK);
    }
    return false;
  } catch { return false; }
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
  processedSet = new WeakSet();
}

async function processImage(img) {
  if (!running) return;
  await loadModules();
  if (!running || processedSet.has(img) || inFlightSet.has(img)) return;
  try {
    const w0 = img.naturalWidth || img.width || 0;
    const h0 = img.naturalHeight || img.height || 0;
    const src0 = (img.currentSrc || img.src || '').slice(0, 160);
    sbLogLimited('image start', { w0, h0, src0 });
  } catch {}
  const ready = () => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return img.complete && w > 0 && h > 0;
  };
  const srcNow = img.currentSrc || img.src || "";
  const lastSrc = lastSrcMap.get(img);
  if (lastSrc && srcNow && lastSrc !== srcNow) {
    processedSet.delete?.(img);
  }
    if (!ready() || !srcNow) {
    try { img.decode && img.decode().catch(() => {}); } catch {}
    img.addEventListener && img.addEventListener("load", () => { if (running) processImage(img); }, { once: true, capture: true });
    setTimeout(() => { if (running) processImage(img); }, 800);
    return;
  }
  inFlightSet.add(img);
  try { abortMap.get(img)?.abort?.(); } catch {}
  const controller = new AbortController();
  abortMap.set(img, controller);
  const settings = await utils.loadSettings().catch(() => null);
  try { logHud('[SB][DBG] settings ' + JSON.stringify({ ocrProvider: settings?.ocrProvider, ocrEngine: settings?.ocrEngine, lang: settings?.forceOcrLang })); } catch {}
  if (!settings) {
    logHud("[ERR] settings/context unavailable. Refresh page then press Start.");
    return;
  }
  if (!utils.isLargeEnough(img, settings.minImageSize)) {
    try { sbLogLimited('skip small', null); } catch {}
    return;
  }
  lastSrcMap.set(img, srcNow);

  let drew = false;
  try {
    const src = img.currentSrc || img.src;
    if (!src) return;
    try {
      const u = new URL(src, location.href);
      const isThumb = /dn-img-page\.kakao\.com/i.test(u.hostname) || /[?&]filename=th3($|&)/i.test(u.search);
      const isAdLike = /(ad[sx]?|banner|pixel|track|analytics|doubleclick|a-ads|pubadx|omnitag|prebid|plista|bookmsg|sootoarathus|urban[-]?signal|source\.pubadx|a-ads\.com)/i.test(u.hostname + u.pathname);
      if (isThumb || isAdLike) {
        logHud('[SB][DBG] skip thumbnail ' + u.hostname);
        return;
      }
    } catch {}

    let ocrRes;
    if (settings.useAiOcr) {
      try {
        console.log('[SB] Using AI OCR for automatic detection...', { targetLang: settings.targetLanguage, provider: settings.translateProvider });
        const viaAi = await aiocr.aiOcrAndTranslate(img, { signal: controller.signal });
        console.log('[SB] AI OCR result:', { words: viaAi?.words?.length || 0, text: (viaAi?.text || '').slice(0, 100), preSegmented: viaAi?.preSegmented });
        console.log('[SB] AI OCR first word:', viaAi?.words?.[0]);
        ocrRes = viaAi || { words: [], text: "" };
        ocrRes.preSegmented = true; 
      } catch (e) {
        console.warn('[SB] AI OCR failed, falling back to regular OCR:', e?.message || e);
        const viaCanvas = await ocr.ocrImageFromElement(img, { signal: controller.signal });
        ocrRes = viaCanvas || { words: [], text: "" };
        ocrRes.preSegmented = false;
      }
    } else {
      if (src.startsWith("blob:") || src.startsWith("data:")) {
        ocrRes = await ocr.ocrImageFromElement(img, { signal: controller.signal });
      } else {
        try {
          logHud('[SB][DBG] ocrImageByUrl -> ' + src.slice(0, 160));
          ocrRes = await ocr.ocrImageByUrl(src, { signal: controller.signal });
          if ((!ocrRes?.text || !ocrRes.text.trim()) && img.__sbBackgroundHost) {
            logHud('[SB] empty OCR via URL on bg; will not attempt tab capture');
          }
          if ((!ocrRes?.text || !ocrRes.text.trim()) && (!ocrRes?.words || ocrRes.words.length === 0)) {
            ocrRes = await ocr.ocrImageFromElement(img, { signal: controller.signal });
          }
        } catch (error) {
          logHud('[SB][DBG] ocrImageByUrl failed; fallback to element');
          ocrRes = await ocr.ocrImageFromElement(img, { signal: controller.signal });
        }
      }
    }

    if (showDetailedLogs) logHud(`[OCR] words=${ocrRes.words.length}, chars=${(ocrRes.text||'').length}, text="${excerpt(ocrRes.text)}"`);
    if (showDetailedLogs) logHud(`[RAW] text="${excerpt((ocrRes.text||"").replace(/\s+/g, " ").trim())}"`);
  try {
    const isBg = !!img.__sbBackgroundHost;
    const srcNow = img.currentSrc || img.src || (isBg ? getComputedStyle(img.__sbBackgroundHost).backgroundImage : "");
    logHud(`[SRC] ${isBg ? 'bg' : 'img'} -> ${excerpt(srcNow, 160)}`);
  } catch {}

    if (!running) return;
    try { sbLogLimited('ocr done', { words: ocrRes.words.length, chars: (ocrRes.text||'').length }); } catch {}

    let texts = ocrRes.words.map(w => w.text).filter(Boolean);
    console.log('[SB] texts from OCR:', texts.slice(0, 2));
    const noiseRe = /(ACLOUD|COLA\w*|\.COM|HTTP|HTTPS|WWW|公众号|微博)/i;
    let wordRects = ocrRes.words.map((w, i) => ({
      text: texts[i], left: w.left, top: w.top, width: w.width, height: w.height
    })).filter(b => (b.width > 1 && b.height > 1 && (b.text || "").trim()))
      .filter(b => !noiseRe.test(b.text || ""))
      .sort((a,b) => a.top === b.top ? a.left - b.left : a.top - b.top);

    let boxes = [];
    if (settings.useAiOcr && ocrRes.preSegmented === true && wordRects.length > 0) {
      console.log('[SB] AI OCR wordRects:', wordRects.slice(0, 2));
      boxes = wordRects.map(b => ({ 
        left: b.left, 
        top: b.top, 
        width: b.width, 
        height: b.height, 
        text: b.text, 
        __test: TEST_MODE_RAW_OVERLAY 
      }));
      console.log('[SB] AI OCR boxes:', boxes.slice(0, 2));
    } else if (wordRects.length > 0) {
      const { groupWordRects } = await import(chrome.runtime.getURL("lib/segmentation.js"));
      const grouped = groupWordRects(wordRects);
      boxes = grouped.boxes.map(b => ({ ...b, __test: TEST_MODE_RAW_OVERLAY }));
      texts = grouped.texts;
    }

    if (!running) return;

    if (!texts.length || !running) {
      logHud("[SB] No text detected; skipping.");
      return;
    }

    let translated = texts;
    if (!TEST_MODE_RAW_OVERLAY) {
    try {
        if (ocrRes.preSegmented) {
          translated = texts;
          console.log('[SB] Using AI OCR pre-translated text');
          console.log('[SB] translated:', translated.slice(0, 2));
      } else {
        // Regular OCR, need to translate
        translated = await translate.translateTextArray(texts, settings.targetLanguage || "en", { signal: controller.signal });
      }
      } catch (e) {
        translated = texts;
      }
    try { sbLogLimited('tr done', { provider: settings.translateProvider, n: texts.length }); } catch {}
    if (showDetailedLogs) logHud(`[TR] -> "${excerpt((translated||[]).join(" "))}"`);
    if (showDetailedLogs) {
      try {
        const maxPairs = Math.min(texts.length, translated.length);
        for (let i = 0; i < maxPairs; i++) {
          const rawLine = (texts[i] || "").replace(/\s+/g, " ").trim();
          const trLine = (translated[i] || "").replace(/\s+/g, " ").trim();
          if (!rawLine && !trLine) continue;
          logHud(`[RAW] ${excerpt(rawLine, 240)}`);
          logHud(`[EN ] ${excerpt(trLine, 240)}`);
        }
      } catch {}
    }
    } else {
      logHud(`[TEST] Drawing raw text without translation`);
    }

    if (!running) return;
    // Keep it simple: draw exactly the boxes we built
    await overlay.drawTextOverlays(img, boxes, translated);
    drew = true;
    try { sbLogLimited('overlay drawn', { candidates: (boxes||[]).length }); } catch {}
  } catch (e) {
    if (e?.name === "AbortError") {
      return;
    } else {
      logHud("[ERR] " + (e?.message || e));
      try { sbLogLimited('error', e?.message || String(e)); } catch {}
    }
  }
  finally {
    inFlightSet.delete(img);
    abortMap.delete(img);
    if (drew) {
      processedSet.add(img);
      attemptMap.delete?.(img);
    } else {
      const n = (attemptMap.get(img) || 0) + 1;
      attemptMap.set(img, n);
      if (n <= 3 && running) {
        setTimeout(() => processImage(img), 600 * n);
      } else {
        processedSet.add(img);
      }
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

  logHud(`[SB] queued images: ${queue.length}`);

  // Check if batch is enabled
  if (settings.batchProcessing) {
    await processImagesInBatches(queue);
  } else {
    let dynamicConcurrency = 1;
    const maxConcurrency = Math.max(1, Math.min(settings.maxConcurrentImages || 2, 6));
    let active = 0;
    let emaMs = 800;

    async function acquireSlot() {
      while (running && active >= dynamicConcurrency) {
        await utils.sleep(20);
      }
      active++;
    }
    function releaseSlot() { active = Math.max(0, active - 1); }

    const workers = new Array(maxConcurrency).fill(0).map(async () => {
      while (running) {
        const img = queue.shift();
        if (!img) break;
      if (inBatch) { await utils.sleep(100); continue; }
      if (processedSet.has(img)) continue; 
        await acquireSlot();
        const t0 = performance.now();
        try {
          await processImage(img);
        } finally {
          const dur = performance.now() - t0;
          emaMs = emaMs * 0.8 + dur * 0.2;
          if (emaMs < 450 && dynamicConcurrency < maxConcurrency) dynamicConcurrency++;
          if (emaMs > 1500 && dynamicConcurrency > 1) dynamicConcurrency--;
          releaseSlot();
        }
        await utils.sleep(15);
      }
    });
    await Promise.all(workers);
  }
}

async function processImagesInBatches(images) {
  logHud(`[SB] Starting batch processing for ${images.length} images`);
  inBatch = true;
  const settings = await utils.loadSettings();
  
  if (settings.useAiOcr) {
    try { await processImagesInBatchesAI(images); } finally { inBatch = false; }
  } else {

    logHud(`[SB] OCR.space does not support batch processing - using individual processing`);
    try { await processImagesIndividually(images); } finally { inBatch = false; }
  }
}

async function processImagesInBatchesAI(images) {
  logHud(`[SB] Using AI OCR batch processing for ${images.length} images`);
  
  try {
    const results = await aiocr.batchRecognizeViaVision(images, { signal: null });
    
    // Draw overlays for all images
    for (let i = 0; i < results.length; i++) {
      if (!running) break;
      const result = results[i];
      if (result && result.texts && result.texts.length > 0) {
        await drawOverlaysForImage(images[i], result.texts, result.boxes);
      }
    }
    
    const totalSegments = results.reduce((sum, r) => sum + (r?.texts?.length || 0), 0);
    logHud(`[SB] AI OCR batch complete: ${totalSegments} segments from ${images.length} images`);
    
  } catch (e) {
    console.warn('[SB] AI OCR batch failed:', e);
    logHud(`[ERR] AI OCR batch failed: ${e.message}`);
  }
}

async function processImagesIndividually(images) {
  logHud(`[SB] Processing ${images.length} images individually (OCR.space limitation)`);
  
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
    logHud('[SB] No text found in any images');
    return;
  }
  
  try {
    const settings = await utils.loadSettings();
    const queue = imageResults.slice();
    const conc = Math.min(2, Math.max(1, settings.maxConcurrentImages || 2));
    let active = 0;
    let next = 0;
    await new Promise((resolve) => {
      const kick = () => {
        if (!running) return resolve();
        while (active < conc && next < queue.length) {
          const item = queue[next++];
          active++;
          (async () => {
            try {
              const translated = await translate.translateTextArray(item.texts, settings.targetLanguage);
              for (let i = 0; i < translated.length; i++) item.texts[i] = translated[i];
              await drawOverlaysForImage(item.img, item.texts, item.boxes);
            } catch (e) {
              console.warn('[SB] Image translation failed:', e);
            } finally {
              active--;
              if (next >= queue.length && active === 0) resolve();
              else kick();
            }
          })();
        }
      };
      kick();
    });
  } catch (e) {
    console.warn('[SB] Progressive translation failed:', e);
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
    processedSet.delete?.(img);
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
    logHud(`[SB] overlay drawn for image`);
  } catch (e) {
    console.warn('[SB] Overlay drawing failed:', e);
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
  document.addEventListener("load", (e) => {
    if (!running) return;
    const t = e.target;
    if (t && t.tagName === "IMG") processImage(t);
  }, true);

  const onScrollOrResize = () => scheduleViewportRescan();
  window.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });

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
  } catch {}
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
      if (processedSet.has(img) && hasOverlay && !need) continue; // avoid duplicate pass
      if (need) processImage(img);
    }
  }, 350);
}

async function start() {
  await loadModules();
  running = true;
  ensureObserver();
  clearHud();
  
  // Clear error tracker on start
  try {
    const { clearErrorTracker } = await import(chrome.runtime.getURL("lib/utils.js"));
    await clearErrorTracker();
  } catch {}
  
  const s = await utils.loadSettings();
  const mode = s.useAiOcr ? `AI(${s.aiModel})` : `ocrspace(${s.forceOcrLang||"auto"})`;
  logHud(`[SB] START • lang=${s.targetLanguage} • OCR=${mode} • key=${(s.ocrApiKey||"").slice(0,3)}*** • min=${s.minImageSize.width}x${s.minImageSize.height} • TR=${s.translateProvider}`);
  try { console.log('[SB] START clicked'); } catch {}
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
  try {
    removeAllOverlays();
  } catch {}
  scheduleViewportRescan();
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
      console.warn('[SB] Manual select module not loaded, trying direct import...');
      try {
        const base = (path) => chrome.runtime.getURL(path);
        manualSelect = await import(base("lib/manual-select.js"));
      } catch (e) {
        console.error('[SB] Failed to load manual select module:', e);
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
    console.error('[SB] Manual select toggle failed:', e);
    try { logHud('[SB] Manual select error: ' + (e?.message || e)); } catch {}
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SB_START") start();
  if (msg?.type === "SB_STOP") stop();
  if (msg?.type === "SB_RESCAN") rescan();
  if (msg?.type === "SB_MANUAL_SELECT") toggleManualSelect();
});
