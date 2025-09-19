import { loadSettings } from "./utils.js";

const imageElementToCanvas = new WeakMap();
const textMeasureCache = new Map();
function measureCached(ctx, text) {
  const key = ctx.font + "\u0001" + text;
  const cached = textMeasureCache.get(key);
  if (cached != null) return cached;
  const w = ctx.measureText(text).width;
  if (textMeasureCache.size > 2000) textMeasureCache.clear();
  textMeasureCache.set(key, w);
  return w;
}

export function ensureOverlayCanvas(img) {
  const parent = img.__sbBackgroundHost || img.parentElement;
  if (!parent) return null;
  const cs = getComputedStyle(parent);
  if (cs.position === "static") parent.style.position = "relative";

  let canvas = imageElementToCanvas.get(img);
  if (!canvas || !canvas.isConnected) {
    canvas = document.createElement("canvas");
    canvas.className = "sb-overlay";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "2147483647";

    const positionCanvas = () => {
      const ir = img.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      const left = Math.floor(ir.left - pr.left);
      const top = Math.floor(ir.top - pr.top);
      const targetW = Math.max(1, Math.floor(ir.width));
      const targetH = Math.max(1, Math.floor(ir.height));
      if (canvas.width !== targetW) canvas.width = targetW; // changing width clears canvas, so guard
      if (canvas.height !== targetH) canvas.height = targetH; // guard to avoid wiping drawings unnecessarily
      canvas.style.width = ir.width + "px";
      canvas.style.height = ir.height + "px";
      canvas.style.left = left + "px";
      canvas.style.top = top + "px";
    };

    positionCanvas();
    parent.appendChild(canvas);

    const ro = new ResizeObserver(positionCanvas);
    ro.observe(img);
    window.addEventListener("scroll", positionCanvas, { passive: true });

    imageElementToCanvas.set(img, canvas);
  } else {
    // Ensure canvas remains aligned even if called after layout changes
    const ir = img.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    const left = Math.floor(ir.left - pr.left);
    const top = Math.floor(ir.top - pr.top);
    const targetW = Math.max(1, Math.floor(ir.width));
    const targetH = Math.max(1, Math.floor(ir.height));
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    canvas.style.width = ir.width + "px";
    canvas.style.height = ir.height + "px";
    canvas.style.left = left + "px";
    canvas.style.top = top + "px";
  }
  return canvas;
}

export async function drawTextOverlays(img, boxes, translatedTexts) {
  console.log('[SB] drawTextOverlays called:', { 
    boxesCount: boxes?.length || 0, 
    translatedTextsCount: translatedTexts?.length || 0,
    imgSrc: img?.src?.slice(0, 50) || 'no src',
    firstBox: boxes?.[0]
  });
  
  const canvas = ensureOverlayCanvas(img);
  if (!canvas) {
    console.warn('[SB] ensureOverlayCanvas returned null!');
    return;
  }
  
  console.log('[SB] Canvas created:', { 
    width: canvas.width, 
    height: canvas.height,
    style: { left: canvas.style.left, top: canvas.style.top, position: canvas.style.position, zIndex: canvas.style.zIndex }
  });

  const settings = await loadSettings();
  // Force-load preferred font if a CSS URL is provided
  try {
    if (settings.overlay?.fontCssUrl) {
      if (!document.querySelector(`link[data-sb-font="1"][href="${settings.overlay.fontCssUrl}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = settings.overlay.fontCssUrl;
        l.setAttribute('data-sb-font', '1');
        document.head.appendChild(l);
      }
    }
  } catch {}
  const ctx = canvas.getContext("2d");

  const rect = (img.__sbBackgroundHost || img).getBoundingClientRect();
  // If any box is explicitly in display space, scale from display size; otherwise from natural size
  const hasDisplay = (boxes || []).some(b => b.__display === true);
  const baseW = hasDisplay ? rect.width : (img.naturalWidth || rect.width);
  const baseH = hasDisplay ? rect.height : (img.naturalHeight || rect.height);
  const scaleX = rect.width / baseW;
  const scaleY = rect.height / baseH;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "top";
  // Use user-selected font settings if available, otherwise fall back to overlay defaults
  const fontSize = settings.textSize || settings.overlay.fontSizePx;
  const fontFamily = settings.fontFamily || settings.overlay.fontFamily;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = "source-over";

  boxes.forEach((b, i) => {
    const inDisplaySpace = b.__display === true;
    const x = Math.floor(inDisplaySpace ? (b.x ?? b.left ?? 0) : ((b.x ?? b.left ?? 0) * scaleX));
    const y = Math.floor(inDisplaySpace ? (b.y ?? b.top ?? 0) : ((b.y ?? b.top ?? 0) * scaleY));
    const originalW = Math.floor(inDisplaySpace ? (b.w ?? b.width ?? 0) : ((b.w ?? b.width ?? 0) * scaleX));
    const originalH = Math.floor(inDisplaySpace ? (b.h ?? b.height ?? 0) : ((b.h ?? b.height ?? 0) * scaleY));
    const text = translatedTexts?.[i] || b.text || "";

    if ((originalW <= 1 || originalH <= 1) || !text.trim()) return;

    // Calculate text size to fit inside the bubble; constrain width + auto line wrap
    // Prefer tighter wrapping for tall/narrow bubbles (vertical JP)
    const bubbleAspect = originalW / Math.max(1, originalH);
    const widthFactor = bubbleAspect < 0.75 ? 0.8 : 0.92;
    const maxWidth = Math.max(8, Math.floor(originalW * widthFactor) - 2 * settings.overlay.padding);
    const lines = wrapTextCached(ctx, text, maxWidth);
    
    // Calculate the actual text dimensions
    let textWidth = 0;
    for (const line of lines) {
      const lineWidth = measureCached(ctx, line);
      textWidth = Math.max(textWidth, lineWidth);
    }
    
    // Calculate background rectangle size based on the actual font size in use
    const textHeight = lines.length * (fontSize * settings.overlay.lineHeight);
    const bgWidth = Math.min(Math.ceil(textWidth + 2 * settings.overlay.padding), originalW);
    const bgHeight = Math.min(Math.ceil(textHeight + 2 * settings.overlay.padding), originalH);
    
    // Center the background rectangle within the original box if it's smaller
    const bgX = x + Math.max(0, (originalW - bgWidth) / 2);
    const bgY = y + Math.max(0, (originalH - bgHeight) / 2);

    // Test mode: green box to validate placement
    const isTest = b.__test === true;
    ctx.fillStyle = isTest ? `rgba(0,128,0,${settings.overlay.backgroundAlpha})` : `rgba(255,255,255,${settings.overlay.backgroundAlpha})`;
    ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
    // Draw a border only in test mode; otherwise no border
    if (isTest) {
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 2;
      ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
    }

    ctx.fillStyle = isTest ? "#fff" : "#000";
    let yy = Math.floor(bgY + settings.overlay.padding);
    const step = Math.ceil(fontSize * settings.overlay.lineHeight);
    for (const line of lines) {
      if (yy > bgY + bgHeight - step) break;
      ctx.fillText(line, bgX + settings.overlay.padding, yy);
      yy += step;
    }
  });

  ctx.fillStyle = "rgba(255,0,255,0.85)";
  ctx.font = "10px monospace";
  ctx.fillText("SB overlay", 4, 4);
}

function wrapTextCached(ctx, text, maxWidth) {
  const words = (text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (measureCached(ctx, test) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
