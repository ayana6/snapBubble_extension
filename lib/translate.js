import { loadSettings, trackError, shouldStopProcessing } from "./utils.js";

export async function translateTextArray(texts, targetLang, opts = {}) {
  const settings = await loadSettings();
  const provider = settings.translateProvider || "openai";
  const original = (texts || []).map(t => (t ?? "").toString());
  const sanitized = sanitizeSegments(original);
  const toTranslate = [];
  const indexMap = [];
  for (let i = 0; i < sanitized.length; i++) {
    const s = (sanitized[i] || "").trim();
    if (s) { indexMap.push(i); toTranslate.push(s); }
  }
  if (!toTranslate.length) return new Array(original.length).fill("");
  
  const shouldStop = await shouldStopProcessing("quota_exceeded", provider);
  if (shouldStop) {
    const errorMsg = `[ERR] ${provider.toUpperCase()} quota exceeded - stopping processing. Check API key/billing.`;
    console.warn(errorMsg);
    try {
      if (typeof window !== 'undefined' && window.logHud) {
        window.logHud(errorMsg);
      }
    } catch {}
    return original;
  }
  
  const DELIM = "\n<sb>\n";
  const single = toTranslate.join(DELIM);
  const tokenEstimate = single.length; // rough char count proxy
  const MAX_PER_CALL = 5000; // smaller chunks for faster responses
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
  
  if (provider === "openai") {
    if (!settings.translateApiKey) throw new Error("OpenAI API key missing.");
    const perChunk = [];
    let next = 0; let active = 0;
    await new Promise((resolve) => {
      const run = () => {
        while (active < 2 && next < chunks.length) {
          const k = next++; active++;
          translateViaOpenAIBatch(chunks[k].text, targetLang, settings.translateApiKey, opts?.signal)
            .then(out => perChunk[k] = out)
            .catch(() => perChunk[k] = "")
            .finally(() => { active--; (next >= chunks.length && active === 0) ? resolve() : run(); });
        }
      };
      run();
    });
    let split = [];
    for (let k = 0; k < perChunk.length; k++) split = split.concat(splitByDelim(perChunk[k]));
    split = postprocessSegments(split);
    const outFull = new Array(original.length).fill("");
    for (let k = 0; k < indexMap.length; k++) outFull[indexMap[k]] = (split[k] || "");
    return outFull;
  } else if (provider === "gemini" || provider === "gemini-pro" || provider === "gemini-2") {
    if (!settings.translateApiKey) throw new Error("Gemini API key missing.");
    const perChunk = [];
    let next = 0; let active = 0;
    await new Promise((resolve) => {
      const run = () => {
        while (active < 2 && next < chunks.length) {
          const k = next++; active++;
          translateViaGeminiBatch(chunks[k].text, targetLang, settings.translateApiKey, provider, opts?.signal)
            .then(out => perChunk[k] = out)
            .catch(() => perChunk[k] = "")
            .finally(() => { active--; (next >= chunks.length && active === 0) ? resolve() : run(); });
        }
      };
      run();
    });
    let split = [];
    for (let k = 0; k < perChunk.length; k++) split = split.concat(splitByDelim(perChunk[k]));
    split = postprocessSegments(split);
    const outFull = new Array(original.length).fill("");
    for (let k = 0; k < indexMap.length; k++) outFull[indexMap[k]] = (split[k] || "");
    return outFull;
  } else if (provider === "deepl") {
    if (!settings.translateApiKey) throw new Error("DeepL API key missing.");
    const parts = await Promise.all(
      toTranslate.map(seg => translateViaDeepLSingle(seg, targetLang, settings.translateApiKey, opts?.signal))
    );
    const outFull = new Array(original.length).fill("");
    for (let k = 0; k < indexMap.length; k++) outFull[indexMap[k]] = (parts[k] || "").trim();
    return outFull;
  } else {
    return original;
  }
  
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

async function translateViaDeepLSingle(text, target, apiKey, signal) {
  const params = new URLSearchParams();
  params.set("auth_key", apiKey);
  params.set("text", text);
  params.set("target_lang", target.toUpperCase());
  try {
    const resp = await fetch("https://api-free.deepl.com/v2/translate", { method: "POST", body: params, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const json = await resp.json();
    return json?.translations?.[0]?.text ?? text;
  } catch (_) {
    const requestId = "tr-deepl-" + Math.random().toString(36).slice(2);
    let abortListener;
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (signal) {
        abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      const resp2 = await chrome.runtime.sendMessage({
        type: "SB_FETCH",
        requestId,
        url: "https://api-free.deepl.com/v2/translate",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString()
        }
      });
      if (!resp2?.ok) return text;
      const json = JSON.parse(resp2.body || "{}");
      const t = (json?.translations && json.translations[0]?.text) || text;
      return t;
    } finally {
      if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
    }
  }
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
    "gemini": "gemini-2.5-flash",
    "gemini-pro": "gemini-1.5-pro",
    "gemini-2": "gemini-2.0-flash-exp",
    "gemini-2.5-flash": "gemini-2.5-flash"
  };
  const model = modelMap[provider] || "gemini-2.5-flash";
  
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

async function translateViaOpenAIBatch(text, target, apiKey, signal) {
  const settings = await loadSettings();
  const model = settings.openaiModel || "gpt-4o-mini";
  const system = `You are a professional translator.

Translate EACH segment separated by <sb> into ${target}.
Return ONLY the translations joined with the exact delimiter \n<sb>\n, same order, one per input segment. No numbering or commentary.`;
  const user = `${text}`;
  const requestId = "tr-openai-batch-" + Math.random().toString(36).slice(2);
  let abortListener;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (signal) {
      abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
      signal.addEventListener("abort", abortListener, { once: true });
    }
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
        throw new Error("direct-failed:" + r.status + ":" + (body||"").slice(0,200));
      }
      const json = await r.json();
      return (json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "").trim();
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
      if (!resp2?.ok) return text;
      try { const json = JSON.parse(resp2.body || "{}"); return (json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "").trim(); } catch { return text; }
    }
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
  }
}

async function translateViaGeminiBatch(text, target, apiKey, provider = "gemini", signal) {
  const modelMap = {
    "gemini": "gemini-2.5-flash",
    "gemini-pro": "gemini-1.5-pro",
    "gemini-2": "gemini-2.0-flash-exp",
    "gemini-2.5-flash": "gemini-2.5-flash"
  };
  const model = modelMap[provider] || "gemini-2.5-flash";
  const instruction = `You are a professional translator. Translate EACH segment separated by <sb> into ${target}.

Return ONLY the translations joined with the exact delimiter \n<sb>\n, same order, one per input segment. No numbering or commentary. Keep responses concise.`;
  const body = {
    contents: [{ parts: [ { text: instruction + "\n\nSegments:\n" + text } ] }],
    generationConfig: { temperature: 0 }
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestId = "tr-gemini-batch-" + Math.random().toString(36).slice(2);
  let abortListener;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (signal) {
      abortListener = () => { try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} };
      signal.addEventListener("abort", abortListener, { once: true });
    }
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) {
        const t = await r.text();
        const errorMsg = `direct-failed:${r.status}:${(t||"").slice(0,200)}`;
        
        // Track quota exceeded errors
        if (r.status === 429 || (t && t.includes("quota"))) {
          await trackError("quota_exceeded", errorMsg, provider);
          const hudMsg = `[ERR] ${provider.toUpperCase()} quota exceeded (${r.status}). Check billing/limits.`;
          console.warn(hudMsg);
          try {
            if (typeof window !== 'undefined' && window.logHud) {
              window.logHud(hudMsg);
            }
          } catch {}
        }
        
        throw new Error(errorMsg);
      }
      const j = await r.json();
      return (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    } catch (_) {
      const resp2 = await chrome.runtime.sendMessage({ type: "SB_FETCH", requestId, url, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
      if (!resp2?.ok) {
        // Track quota exceeded errors from background fetch
        if (resp2?.status === 429 || (resp2?.body && resp2.body.includes("quota"))) {
          await trackError("quota_exceeded", `background-failed:${resp2.status}:${resp2.body?.slice(0,200) || ""}`, provider);
          const hudMsg = `[ERR] ${provider.toUpperCase()} quota exceeded (${resp2.status}). Check billing/limits.`;
          console.warn(hudMsg);
          try {
            if (typeof window !== 'undefined' && window.logHud) {
              window.logHud(hudMsg);
            }
          } catch {}
        }
        return text;
      }
      try { const j = JSON.parse(resp2.body || "{}"); return (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim(); } catch { return text; }
    }
  } finally {
    if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
  }
}
