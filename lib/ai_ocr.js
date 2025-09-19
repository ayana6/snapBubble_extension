import { loadSettings } from "./utils.js";
import { imgElToJpegDataUrl } from "./ocr.js";

export async function aiOcrAndTranslate(img, opts = {}) {
  const settings = await loadSettings();
  const dataUrl = await imgElToJpegDataUrl(img);
  const want = settings.targetLanguage || "en";
  const provider = settings.translateProvider || "openai";
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const MAX = 1600;
  const ratio = Math.min(1, MAX / Math.max(W, H));
  const wScaled = Math.max(1, Math.floor(W * ratio));
  const hScaled = Math.max(1, Math.floor(H * ratio));
  const result = await recognizeViaVision(dataUrl, provider, settings, opts?.signal);
  // Try to parse JSON boxes first
  const items = parseVisionBoxJson(result, W, H, wScaled, hScaled);
  if (items && items.length > 0) {
    const words = items.map(it => ({
      text: (it.text || "").trim(),
      left: Math.round((it.x || 0) * W),
      top: Math.round((it.y || 0) * H),
      width: Math.max(1, Math.round((it.w || 0) * W)),
      height: Math.max(1, Math.round((it.h || 0) * H))
    })).filter(w => w.text);
    const joined = words.map(w => w.text).join(" \n");
    if (words.length) return { words, text: joined, preSegmented: true };
  }
  // Fallback: treat as a single paragraph
  const outText = (typeof result === 'string' ? result : "") || "";
  const box = { left: 0, top: 0, width: W, height: H, __display: false, text: outText };
  return { words: [{ text: outText, left: box.left, top: box.top, width: box.width, height: box.height }], text: outText };
}

async function recognizeViaVision(dataUrl, provider, settings, signal) {
  if (provider === "openai") {
    const model = settings.openaiModel || "gpt-4o-mini";
    const key = settings.translateApiKey;
    if (!key) throw new Error("OpenAI API key missing");
    const jpHint = (settings.forceOcrLang === 'jpn') ? " Reading order is vertical (top-to-bottom, right-to-left) when applicable." : "";
    const targetLang = settings.targetLanguage || "en";
    const langName = {
      'en': 'English', 'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian', 
      'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese',
      'ar': 'Arabic', 'hi': 'Hindi', 'th': 'Thai', 'vi': 'Vietnamese'
    }[targetLang] || 'English';
    
    const instruction = `You are an OCR + translation engine for images.${jpHint}

CRITICAL: You MUST translate ALL text to ${langName}. Never return original text - always translate.

Return ONLY strict JSON with this shape:
{"items":[{"x":0.0-1.0,"y":0.0-1.0,"w":0.0-1.0,"h":0.0-1.0,"text":"..."}, ...]}

Where:
- (x,y,w,h) are relative fractions of the image (origin at top-left)
- text is the ${langName} translation of the detected text (NEVER the original text)
- Segment by speech balloons / narration boxes; one entry per region in reading order
- Boxes must be TIGHT around each text region; avoid a single full-page box; avoid boxes with area > 0.6
- Return 2-20 items when multiple regions exist
- Do not include any other keys or commentary
- If a region is unreadable, omit it

REMEMBER: Always translate to ${langName}, never return original Chinese/Japanese/Korean text.`;
    const body = {
      model,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: [
          { type: "text", text: "Image follows." },
          { type: "image_url", image_url: { url: dataUrl } }
        ] }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    };
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).catch(() => null);
    if (!resp || !resp.ok) {
      const bg = await chrome.runtime.sendMessage({
        type: "SB_FETCH",
        url: "https://api.openai.com/v1/chat/completions",
        init: { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` }, body: JSON.stringify(body) }
      });
      if (!bg?.ok) return "";
      try { const j = JSON.parse(bg.body || "{}"); return (j?.choices?.[0]?.message?.content || "").trim(); } catch { return ""; }
    }
    const j = await resp.json();
    return (j?.choices?.[0]?.message?.content || "").trim();
  }
  // Gemini vision
  const model = (settings.translateProvider === "gemini" ? "gemini-1.5-flash-latest" : settings.translateProvider === "gemini-pro" ? "gemini-1.5-pro" : "gemini-2.0-flash-exp");
  const key = settings.translateApiKey;
  if (!key) throw new Error("Gemini API key missing");
  const jpHint = (settings.forceOcrLang === 'jpn') ? " Reading order is vertical (top-to-bottom, right-to-left) when applicable." : "";
  const targetLang = settings.targetLanguage || "en";
  const langName = {
    'en': 'English', 'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian', 
    'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese',
    'ar': 'Arabic', 'hi': 'Hindi', 'th': 'Thai', 'vi': 'Vietnamese'
  }[targetLang] || 'English';
  
  const instruction = `You are an OCR + translation engine for images.${jpHint}

CRITICAL: You MUST translate ALL text to ${langName}. Never return original text - always translate.

Return ONLY strict JSON with this shape:
{"items":[{"x":0.0-1.0,"y":0.0-1.0,"w":0.0-1.0,"h":0.0-1.0,"text":"..."}, ...]}

Where:
- (x,y,w,h) are relative fractions of the image (origin at top-left)
- text is the ${langName} translation of the detected text (NEVER the original text)
- Segment by speech balloons / narration boxes; one entry per region in reading order
- Boxes must be TIGHT around each text region; avoid a single full-page box; avoid boxes with area > 0.6
- Return 2-20 items when multiple regions exist
- Do not include any other keys or commentary
- If a region is unreadable, omit it

REMEMBER: Always translate to ${langName}, never return original Chinese/Japanese/Korean text.`;
  const body = {
    contents: [{ parts: [ { text: instruction }, { inline_data: { mime_type: "image/jpeg", data: dataUrl.split(',')[1] || "" } } ] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" }
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => null);
  if (!r || !r.ok) {
    const bg = await chrome.runtime.sendMessage({ type: "SB_FETCH", url, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
    if (!bg?.ok) return "";
    try { const j = JSON.parse(bg.body || "{}"); return (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim(); } catch { return ""; }
  }
  const j = await r.json();
  return (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

function parseVisionBoxJson(raw, W, H, wScaled, hScaled) {
  try {
    const j = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    if (!j || !Array.isArray(j.items)) return null;
    const list = [];
    for (const k of j.items) {
      const text = String(k.text || k.caption || "").trim();
      if (!text) continue;
      // Accept multiple key styles
      let x = num(k.x ?? k.left ?? (k.bbox?.[0]));
      let y = num(k.y ?? k.top ?? (k.bbox?.[1]));
      let w = num(k.w ?? k.width ?? (k.bbox?.[2]));
      let h = num(k.h ?? k.height ?? (k.bbox?.[3]));
      if ((x == null || y == null || w == null || h == null) && k.cx != null && k.cy != null && k.radius != null) {
        const cx = num(k.cx), cy = num(k.cy), r = num(k.radius);
        x = cx - r; y = cy - r; w = r * 2; h = r * 2;
      }
      if (x == null || y == null || w == null || h == null) continue;

      // Determine units
      let normalized;
      const maxVal = Math.max(x, y, w, h);
      if (maxVal <= 1.2) {
        // Already 0..1 fractions
        normalized = { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };
      } else if (maxVal <= 100) {
        normalized = { x: clamp01(x / 100), y: clamp01(y / 100), w: clamp01(w / 100), h: clamp01(h / 100) };
      } else {
        // Pixels; assume relative to scaled canvas size
        normalized = { x: clamp01(x / wScaled), y: clamp01(y / hScaled), w: clamp01(w / wScaled), h: clamp01(h / hScaled) };
      }
      // Drop huge single boxes
      const area = normalized.w * normalized.h;
      if (area > 0.7) continue;
      list.push({ ...normalized, text });
    }
    return list;
  } catch { return null; }
}
function clamp01(v) { v = Number(v); if (!isFinite(v)) return 0; return Math.min(1, Math.max(0, v)); }
function num(v) { v = Number(v); return isFinite(v) ? v : null; }


