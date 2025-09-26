

import { loadSettings, trackError, shouldStopProcessing } from "./utils.js";

let translateQueue = Promise.resolve();
const keyCooldown = new Map(); 
let lastGeminiCallTs = 0;
function getGeminiRpm(settings) {
  const model = (settings.geminiModel || 'gemini-2.0-flash-lite').toLowerCase();
  const tier1 = !!settings.geminiTier1;
  const freeRpmMap = { 'gemini-2.5-flash': 10, 'gemini-2.0-flash': 15, 'gemini-2.0-flash-lite': 30 };
  const tier1RpmMap = { 'gemini-2.5-flash': 1000, 'gemini-2.0-flash': 2000, 'gemini-2.0-flash-lite': 4000 };
  const rpm = (tier1 ? tier1RpmMap[model] : freeRpmMap[model]) || (tier1 ? 1000 : 10);
  return Math.max(1, Math.floor(rpm * 0.8));
}
async function scheduleGeminiCall(settings, key) {
  const rpm = getGeminiRpm(settings);
  const minInterval = Math.ceil(60000 / rpm);
  const now = Date.now();
  const keyReady = Math.max(0, (keyCooldown.get(key) || 0) - now);
  const sinceLast = now - lastGeminiCallTs;
  const wait = Math.max(0, minInterval - sinceLast, keyReady);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeminiCallTs = Date.now();
}

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => t = setTimeout(() => rej(new Error('translate timeout')), ms));
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

const TRANSLATE_TIMEOUT_MS = 45000;

export async function translateTextArray(texts, targetLang, opts = {}) {
  const settings = await loadSettings();
  const provider = settings.translateProvider || "gemini";
  const providerKeys = Array.isArray(settings.translateApiKeys) && settings.translateApiKeys.length ? settings.translateApiKeys : (settings.translateApiKey ? [settings.translateApiKey] : []);
  const original = (texts || []).map(t => (t ?? "").toString());
  const sanitized = sanitizeSegments(original);
  const debug = !!settings.debugEnabled;
  const dbg = (m) => { try { if (!debug) return; if (typeof window !== 'undefined' && window.logHud) window.logHud(`[SB][TR_DBG] ${m}`); else console.info('[SB][TR_DBG]', m); } catch {} };
  const cjkRatio = (s) => {
    try { const t = String(s||''); if (!t) return 0; const cjk = t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0; return cjk / t.length; } catch { return 0; }
  };
  const toTranslate = [];
  const indexMap = [];
  const MAX_SEGMENT = 800; 
  for (let i = 0; i < sanitized.length; i++) {
    const s = (sanitized[i] || "").trim();
    if (!s) continue;
    if (s.length <= MAX_SEGMENT) {
      indexMap.push(i); toTranslate.push(s);
    } else {
      const parts = splitLongSegment(s, MAX_SEGMENT);
      for (const p of parts) { indexMap.push(i); toTranslate.push(p); }
    }
  }
  if (!toTranslate.length) return new Array(original.length).fill("");

  const shouldStop = await shouldStopProcessing("quota_exceeded", provider);
  if (shouldStop) {
    try { if (typeof window !== 'undefined' && window.logHud) window.logHud(`[ERR] ${provider.toUpperCase()} quota exceeded`); } catch {}
    return original;
  }

  const DELIM = "\n<sb>\n";
  const single = toTranslate.join(DELIM);
  const tokenEstimate = single.length;
  const MAX_PER_CALL = 1800;
  const chunks = [];
  if (tokenEstimate > MAX_PER_CALL) {
    let acc = ""; let accIdx = [];
    for (let i = 0; i < toTranslate.length; i++) {
      const seg = (i === 0 ? toTranslate[i] : DELIM + toTranslate[i]);
      if ((acc + seg).length > MAX_PER_CALL && accIdx.length) {
        chunks.push({ text: acc, idx: accIdx.slice() });
        acc = toTranslate[i]; accIdx = [i];
      } else {
        acc = acc ? acc + DELIM + toTranslate[i] : toTranslate[i];
        accIdx.push(i);
      }
    }
    if (accIdx.length) chunks.push({ text: acc, idx: accIdx.slice() });
  } else {
    chunks.push({ text: single, idx: toTranslate.map((_,i)=>i) });
  }

  const doProvider = async () => {
    if (provider === "openai") {
      if (!providerKeys.length) throw new Error("OpenAI API key missing.");
      const perChunk = [];
      for (let k = 0; k < chunks.length; k++) {
        const out = await tryWithKeyFailover(providerKeys, (key) => withTimeout(translateViaOpenAIBatch(chunks[k].text, targetLang, key, opts?.signal), TRANSLATE_TIMEOUT_MS));
        perChunk[k] = out;
      }
      let split = [];
      for (let k = 0; k < perChunk.length; k++) split = split.concat(splitByDelim(perChunk[k]));
      split = postprocessSegments(split);
      if (!split.length || split.every(s => !String(s||"").trim())) {
        dbg(`openai blank output; returning original for ${indexMap.length} segments`);
        const outFull = new Array(original.length).fill("");
        for (let k = 0; k < indexMap.length; k++) {
          const idx = indexMap[k];
          const src = original[idx] || "";
          outFull[idx] = outFull[idx] ? (outFull[idx] + " " + src) : src;
        }
        return outFull.map(s => s.trim());
      }
      const outFull = new Array(original.length).fill("");
      for (let k = 0; k < indexMap.length; k++) {
        const idx = indexMap[k];
        const piece = (split[k] || "").trim();
        outFull[idx] = outFull[idx] ? (outFull[idx] + " " + piece) : piece;
      }
      try { if (debug) { const sample = outFull.filter(Boolean).slice(0,2).map(s=>s.slice(0,60)); dbg(`openai out sample: ${JSON.stringify(sample)} | cjkRatios=${outFull.slice(0,2).map(s=>cjkRatio(s).toFixed(2)).join(',')}`); } } catch {}
      return outFull.map(s => s.trim());
    } else if (provider.startsWith("gemini")) {
      if (!providerKeys.length) throw new Error("Gemini API key missing.");
      const perChunk = [];
      for (let k = 0; k < chunks.length; k++) {
        const out = await tryWithKeyFailover(providerKeys, (key) => withTimeout(translateViaGeminiBatch(chunks[k].text, targetLang, key, provider, opts?.signal), TRANSLATE_TIMEOUT_MS));
        perChunk[k] = out;
      }
      let split = [];
      for (let k = 0; k < perChunk.length; k++) split = split.concat(splitByDelim(perChunk[k]));
      split = postprocessSegments(split);
      if (!split.length || split.every(s => !String(s||"").trim())) {
        dbg(`gemini blank output; returning original for ${indexMap.length} segments`);
        const outFull = new Array(original.length).fill("");
        for (let k = 0; k < indexMap.length; k++) {
          const idx = indexMap[k];
          const src = original[idx] || "";
          outFull[idx] = outFull[idx] ? (outFull[idx] + " " + src) : src;
        }
        return outFull.map(s => s.trim());
      }
      const outFull = new Array(original.length).fill("");
      for (let k = 0; k < indexMap.length; k++) {
        const idx = indexMap[k];
        const piece = (split[k] || "").trim();
        outFull[idx] = outFull[idx] ? (outFull[idx] + " " + piece) : piece;
      }
      try { if (debug) { const sample = outFull.filter(Boolean).slice(0,2).map(s=>s.slice(0,60)); dbg(`gemini out sample: ${JSON.stringify(sample)} | cjkRatios=${outFull.slice(0,2).map(s=>cjkRatio(s).toFixed(2)).join(',')}`); } } catch {}
      return outFull.map(s => s.trim());
    } else if (provider === "deepl") {
      if (!settings.translateApiKey) throw new Error("DeepL API key missing.");
      const parts = [];
      for (let i = 0; i < toTranslate.length; i++) {
        const out = await withTimeout(translateViaDeepLSingle(toTranslate[i], targetLang, settings.translateApiKey, opts?.signal), TRANSLATE_TIMEOUT_MS).catch(()=>toTranslate[i]);
        parts.push(out);
      }
      const outFull = new Array(original.length).fill("");
      for (let k = 0; k < indexMap.length; k++) {
        const idx = indexMap[k];
        const piece = (parts[k] || "").trim();
        outFull[idx] = outFull[idx] ? (outFull[idx] + " " + piece) : piece;
      }
      try { if (debug) { const sample = outFull.filter(Boolean).slice(0,2).map(s=>s.slice(0,60)); dbg(`deepl out sample: ${JSON.stringify(sample)} | cjkRatios=${outFull.slice(0,2).map(s=>cjkRatio(s).toFixed(2)).join(',')}`); } } catch {}
      return outFull.map(s => s.trim());
    } else {
      return original;
    }
  };

  // Run provider directly for lower latency (allow concurrent translations)
  try {
    const res = await doProvider();
    try {
      if (debug) {
        const ratios = (res||[]).map(s=>cjkRatio(s));
        const bad = ratios.reduce((n,r)=> n + (r>0.3?1:0), 0);
        if (bad) dbg(`cjk-echo segments count=${bad}/${ratios.length}`);
      }
    } catch {}
    return res;
  } catch (e) {
    const msg = e?.message || String(e||'');
    dbg(`translate error: ${msg}`);
    if (/quota_exceeded/i.test(msg)) {
      try { if (typeof window !== 'undefined' && window.logHud) window.logHud('[SB] Translation quota exceeded. Stopping.'); } catch {}
      await trackError('quota_exceeded', 'translation quota exceeded', provider);
      return original;
    }
    throw e;
  }
}

async function tryWithKeyFailover(keys, fn) {
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      try {
        const out = await fn(key);
        if (typeof out === 'string') return out;
        return String(out || "");
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || "").toLowerCase();
        try { console.info('[SB][TR_DBG] key fail', { attempt: i+1, msg }); } catch {}
        if (/timeout|timed out|network|fetch|502|503|504/.test(msg) && attempts < 2) {
          await new Promise(r => setTimeout(r, 500 * attempts));
          continue;
        }
        if (/quota|rate limit|429|key invalid|unauthorized/.test(msg)) break;
        break;
      }
    }
  }
  if (lastErr) throw lastErr;
  return "";
}

function splitLongSegment(s, limit) {
  const out = [];
  let rest = s;
  const SEP = /[。！？!?.\n\r]/g;
  while (rest.length > limit) {
    const slice = rest.slice(0, limit + 100); 
    let cut = slice.lastIndexOf("\n");
    if (cut < limit * 0.6) {
      let found = -1; SEP.lastIndex = 0;
      let m; while ((m = SEP.exec(slice)) !== null) { if (m.index >= limit * 0.6) found = m.index + m[0].length; }
      if (found > 0) cut = found;
    }
    if (cut < limit * 0.6) cut = limit; 
    out.push(slice.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
function sanitizeSegments(segments) {
  const NOISE_RE = getNoiseRegex();
  return segments.map(s => {
    let trimmed = collapseCjkSpaces((s || "").replace(/\s+/g, " ").trim());
    if (!trimmed) return "";
    if (NOISE_RE.test(trimmed)) return "";
    if (/^[^\p{L}\p{N}]+$/u.test(trimmed)) return "";
    return trimmed;
  });
}

function splitByDelim(text) {
  if (typeof text !== "string") return [""];
  return text.split(/\s*<sb>\s*/g);
}

function postprocessSegments(arr) {
  return (arr || []).map(s => (s || "").replace(/\s*<sb>\s*/g, " ").trim());
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

function getNoiseRegex() {
  return /(ACLOUD|chapter|episode|creative|chief|producer|executive|mount\s*heng|https?:\/\/|www\.|公众号|微博|出品|制作|监制|章|话|卷|广告|\.com|\.co|\.gy)/i;
}

async function translateViaDeepLSingle(text, target, apiKey, signal) {
  const params = new URLSearchParams();
  params.set("auth_key", apiKey);
  params.set("text", text);
  params.set("target_lang", target.toUpperCase());
  
  const { makeApiRequest, createRequestId, parseJsonResponse } = await import("./api-helper.js");
  
  try {
    const resp = await makeApiRequest("https://api-free.deepl.com/v2/translate", {
      requestId: createRequestId("tr-deepl"),
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      }
    }, signal);
    
    const json = parseJsonResponse(resp);
    return (json?.translations && json.translations[0]?.text) || text;
  } catch {
    return text;
  }
}


async function translateViaOpenAIBatch(text, target, apiKey, signal) {
  const settings = await loadSettings();
  const model = settings.openaiModel || "gpt-4o-mini";
  const system = `You are a professional translator.

Translate EACH segment separated by <sb> into ${target}.
Return ONLY the translations joined with the exact delimiter \n<sb>\n, same order, one per input segment. No numbering or commentary.`;
  const user = `${text}`;
  
  const { makeApiRequest, createRequestId, parseJsonResponse } = await import("./api-helper.js");
  
  const resp = await makeApiRequest("https://api.openai.com/v1/chat/completions", {
    requestId: createRequestId("tr-openai-batch"),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    }
  }, signal);
  const json = parseJsonResponse(resp);
  if (json?.error) {
    const msg = String(json.error?.message || "openai error");
    if (/rate limit|quota/i.test(msg)) throw new Error("quota_exceeded");
    throw new Error(msg);
  }
  const out = (json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "").trim();
  if (!out) throw new Error("translate_failed");
  return out;
}

async function translateViaGeminiBatch(text, target, apiKey, provider = "gemini", signal) {
  const settings = await loadSettings();
  const configured = (settings.geminiModel || '').toLowerCase();
  const modelMap = {
    "gemini": configured || "gemini-2.5-flash",
    "gemini-pro": "gemini-1.5-pro",
    "gemini-2": configured || "gemini-2.0-flash-exp",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.0-flash": "gemini-2.0-flash",
    "gemini-2.0-flash-lite": "gemini-2.0-flash-lite"
  };
  const model = modelMap[provider] || configured || "gemini-2.5-flash";
  const langName = ({
    'en': 'English','fr':'French','es':'Spanish','de':'German','it':'Italian','pt':'Portuguese','ru':'Russian','ja':'Japanese','ko':'Korean','zh':'Chinese','ar':'Arabic','hi':'Hindi','th':'Thai','vi':'Vietnamese'
  }[String(target||'en').toLowerCase()] || target || 'English');
  const instruction = `You are a professional translator.

Translate EACH segment separated by <sb> into ${langName}.

CRITICAL:
- Output ONLY ${langName}. Do not echo the source language.
- Join outputs with the exact delimiter \n<sb>\n, same order.
- No numbering or commentary.`;
  const body = {
    contents: [{ parts: [ { text: instruction + "\n\nSegments:\n" + text } ] }],
    generationConfig: { temperature: 0, responseMimeType: "text/plain" }
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const { makeApiRequest, createRequestId, parseJsonResponse } = await import("./api-helper.js");
  
  // rate-limit per RPM and per key
  await scheduleGeminiCall(settings, apiKey);
  const resp = await makeApiRequest(url, {
    requestId: createRequestId("tr-gemini-batch"),
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  }, signal);
  // Track quota exceeded errors from background fetch
  if (resp?.status === 429 || (resp?.body && /quota|rate limit|too many/i.test(resp.body))) {
    await trackError("quota_exceeded", `background-failed:${resp.status}:${resp.body?.slice(0,200) || ""}`, provider);
    try { if (typeof window !== 'undefined' && window.logHud) window.logHud(`[ERR] ${provider.toUpperCase()} quota exceeded (${resp.status})`); } catch {}
    try {
      const ra = (() => { try { const h = (resp.headers||[]).find(x=>String(x[0]).toLowerCase()==='retry-after'); return h && Number(h[1]) } catch{return 0} })();
      if (ra && apiKey) keyCooldown.set(apiKey, Date.now() + ra*1000);
    } catch {}
    throw new Error("quota_exceeded");
  }
  const j = parseJsonResponse(resp);
  const out = (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  if (!out) throw new Error("translate_failed");
  return out;
}
