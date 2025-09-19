import { loadSettings } from "./utils.js";

const pendingBatches = new Map();
const BATCH_DELAY_MS = 75;

export async function translateTextArray(texts, targetLang, opts = {}) {
  const settings = await loadSettings();
  const provider = settings.translateProvider || "libre";
  const original = (texts || []).map(t => (t ?? "").toString());
  const sanitized = sanitizeSegments(original);
  const toTranslate = [];
  const indexMap = [];
  for (let i = 0; i < sanitized.length; i++) {
    const s = (sanitized[i] || "").trim();
    if (s) { indexMap.push(i); toTranslate.push(s); }
  }
  if (!toTranslate.length) return new Array(original.length).fill("");

  const DELIM = "\n<sb>\n";
  const single = toTranslate.join(DELIM);

  let translatedSingle;
  if (provider === "libre") {
    translatedSingle = await enqueueBatch("libre" + "|" + (settings.libreEndpoint || "") + "|" + (targetLang || "en"), (merged) => translateViaLibreSingle(merged, targetLang, settings.libreEndpoint, opts?.signal), single, opts?.signal);
  } else if (provider === "deepl") {
    if (!settings.translateApiKey) throw new Error("DeepL API key missing.");
    translatedSingle = await enqueueBatch("deepl||" + (targetLang || "en"), (merged) => translateViaDeepLSingle(merged, targetLang, settings.translateApiKey, opts?.signal), single, opts?.signal);
  } else if (provider === "openai") {
    if (!settings.translateApiKey) throw new Error("OpenAI API key missing.");
    const parts = await Promise.all(
      toTranslate.map(seg => translateViaOpenAISingle(seg, targetLang, settings.translateApiKey, opts?.signal))
    );
    const outFull = new Array(original.length).fill("");
    for (let k = 0; k < indexMap.length; k++) outFull[indexMap[k]] = (parts[k] || "").trim();
    return outFull;
  } else if (provider === "gemini" || provider === "gemini-pro" || provider === "gemini-2") {
    if (!settings.translateApiKey) throw new Error("Gemini API key missing.");
    const parts = await Promise.all(
      toTranslate.map(seg => translateViaGeminiSingle(seg, targetLang, settings.translateApiKey, provider, opts?.signal))
    );
    const outFull = new Array(original.length).fill("");
    for (let k = 0; k < indexMap.length; k++) outFull[indexMap[k]] = (parts[k] || "").trim();
    return outFull;
  } else {
    return original;
  }

  let split = splitByDelim(translatedSingle);
  split = postprocessSegments(split);
  const outFull = new Array(original.length).fill("");
  for (let k = 0; k < indexMap.length; k++) {
    outFull[indexMap[k]] = split[k] || "";
  }
  if (provider === "openai") {
    for (let i = 0; i < outFull.length; i++) {
      if (sanitized[i] && !outFull[i]) {
        try {
          outFull[i] = (await translateViaOpenAISingle(sanitized[i], targetLang, settings.translateApiKey, opts?.signal)) || "";
        } catch {}
      }
    }
  }
  return outFull;
}

function sanitizeSegments(segments) {
  const NOISE_RE = /(ACLOUD|https?:\/\/|www\.|公众号|微博|\.com|\.co|\.gy)/i;
  return segments.map(s => {
    let trimmed = (s || "").replace(/\s+/g, " ").trim();
    trimmed = collapseCjkSpaces(trimmed);
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
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === " " && i > 0 && i < input.length - 1) {
      const prev = input[i-1];
      const next = input[i+1];
      if (CJK.test(prev) && CJK.test(next)) {
        continue;
      }
    }
    out += ch;
  }
  return out.trim();
}

async function enqueueBatch(key, runner, text, signal) {
  const existing = pendingBatches.get(key);
  if (existing) {
    return new Promise(resolve => {
      existing.texts.push(text);
      existing.resolvers.push(resolve);
    });
  }
  const batch = { texts: [text], resolvers: [], timer: null };
  const promise = new Promise(resolve => batch.resolvers.push(resolve));
  pendingBatches.set(key, batch);
  batch.timer = setTimeout(async () => {
    try {
      const merged = batch.texts.join("\n<sb>\n");
      const out = await runner(merged, signal);
      const arr = out.split("\n<sb>\n");
      let offset = 0;
      for (const res of batch.resolvers) {
        const piece = arr[offset] != null ? arr[offset] : out;
        offset++;
        try { res(piece); } catch {}
      }
    } catch (e) {
      for (const res of batch.resolvers) { try { res(text); } catch {} }
    } finally {
      pendingBatches.delete(key);
    }
  }, BATCH_DELAY_MS);
  return promise;
}

async function translateViaLibreSingle(text, target, endpoint, signal) {
  const tryOnce = async (url) => {
    const resp = await chrome.runtime.sendMessage({
      type: "SB_FETCH",
      requestId: "tr-" + Math.random().toString(36).slice(2),
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source: "auto", target })
      }
    });
    if (resp?.ok) {
      const json = JSON.parse(resp.body || "{}");
      return json?.translatedText || text;
    }
    throw new Error(resp?.body || resp?.error || "Translate failed");
  };

  const candidates = [];
  if (endpoint) candidates.push(endpoint);
  candidates.push("https://libretranslate.de/translate");
  candidates.push("https://translate.astian.org/translate");

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await tryOnce(candidates[i]);
    } catch (e) {
      console.warn("[SB] LibreTranslate failed at", candidates[i], ":", (e?.message||e));
      await new Promise(r => setTimeout(r, 800 * (i+1)));
    }
  }
  return text;
}

async function translateViaDeepLSingle(text, target, apiKey, signal) {
  const params = new URLSearchParams();
  params.set("auth_key", apiKey);
  params.set("text", text);
  params.set("target_lang", target.toUpperCase());
  const resp = await fetch("https://api-free.deepl.com/v2/translate", { method: "POST", body: params, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  const json = await resp.json();
  return json?.translations?.[0]?.text ?? text;
}

async function translateViaOpenAISingle(text, target, apiKey, signal) {
  const settings = await loadSettings();
  const model = settings.openaiModel || "gpt-4o-mini";
  const system = `You are a professional translator. Translate into ${target} with faithful, concise phrasing.

Rules (single input line):
- Output ONLY the translation of this line. No explanations.
- Preserve meaning and tone. Do not invent content or add filler.
- Keep polarity and imperatives accurate (e.g., 不好！快退！ → "Not good! Fall back!").
- Prefer transliteration for proper names; keep tech terms literal when unsure.
- Ignore watermarks or domains if present.`;
  const user = `${text}`;
  const requestId = "tr-openai-" + Math.random().toString(36).slice(2);
  let abortListener;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (signal) {
      abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    let json;
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
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
        }),
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      if (!r.ok) {
        const body = await r.text();
        console.warn("[SB] OpenAI translate error", r.status, (body||"").slice(0,200));
        throw new Error("direct-failed");
      }
      json = await r.json();
    } catch (_) {
      const resp2 = await chrome.runtime.sendMessage({
        type: "SB_FETCH",
        requestId,
        url: "https://api.openai.com/v1/chat/completions",
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
      });
      if (!resp2?.ok) {
        const preview = (resp2?.body || resp2?.error || "").slice(0, 200);
        console.warn("[SB] OpenAI translate error", resp2?.status, preview || "unknown");
        return text;
      }
      try { json = JSON.parse(resp2.body || "{}"); } catch { return text; }
    }
    const out = (json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "").trim();
    if (!out) {
      console.warn("[SB] OpenAI translate empty response");
      return text;
    }
    return out || text;
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
  }
}

async function translateViaGeminiSingle(text, target, apiKey, provider = "gemini", signal) {
  const modelMap = {
    "gemini": "gemini-1.5-flash-latest",
    "gemini-pro": "gemini-1.5-pro",
    "gemini-2": "gemini-2.0-flash-exp"
  };
  const model = modelMap[provider] || "gemini-1.5-flash-latest";
  
  const system = `You are a professional translator. Translate into ${target} with faithful, concise phrasing.

Rules (single input line):
- Output ONLY the translation of this line. No explanations.
- Preserve meaning and tone. Do not invent content or add filler.
- Keep polarity and imperatives accurate (e.g., 不好！快退！ → "Not good! Fall back!").
- Prefer transliteration for proper names; keep tech terms literal when unsure.
- Ignore watermarks or domains if present.`;
  const user = `${text}`;
  const requestId = "tr-gemini-" + Math.random().toString(36).slice(2);
  let abortListener;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (signal) {
      abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    let json;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${system}\n\nUser: ${user}\n\nAssistant:`
            }]
          }],
          generationConfig: {
            temperature: 0,
            topP: 0.9,
            maxOutputTokens: 1000
          }
        }),
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      if (!r.ok) {
        const body = await r.text();
        console.warn("[SB] Gemini translate error", r.status, (body||"").slice(0,200));
        throw new Error("direct-failed");
      }
      json = await r.json();
    } catch (_) {
      const resp2 = await chrome.runtime.sendMessage({
        type: "SB_FETCH",
        requestId,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `${system}\n\nUser: ${user}\n\nAssistant:`
              }]
            }],
            generationConfig: {
              temperature: 0,
              topP: 0.9,
              maxOutputTokens: 1000
            }
          })
        }
      });
      if (!resp2?.ok) {
        const preview = (resp2?.body || resp2?.error || "").slice(0, 200);
        console.warn("[SB] Gemini translate error", resp2?.status, preview || "unknown");
        return text;
      }
      try { json = JSON.parse(resp2.body || "{}"); } catch { return text; }
    }
    const out = (json?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!out) {
      console.warn("[SB] Gemini translate empty response");
      return text;
    }
    return out || text;
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
  }
}
