/**
 * Netlify AI proxy — securely calls Gemini using your environment variable.
 * POST /api/ai            — chat / quiz generation
 * GET  /api/ai?action=status — is the key valid, which models will be used (no quota used)
 */

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return cors(new Response(null));
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (req.method === "GET" && new URL(req.url).searchParams.get("action") === "status") {
    return cors(json(await aiStatus(apiKey)));
  }
  if (req.method !== "POST") {
    return cors(json({ error: "Method not allowed" }, 405));
  }

  if (!apiKey) {
    return cors(json({ error: "The AI assistant isn't set up: GEMINI_API_KEY is missing in Netlify.", code: 'AI_KEY_MISSING' }, 500));
  }

  try {
    const body = await req.json();
    const messages = body.messages || [];
    if (!messages.length) {
      return cors(json({ error: "Missing messages in request" }, 400));
    }

    // Format chat history for Google API
    const contents = messages.map(m => ({
      role: (m.role === 'assistant' || m.role === 'bot') ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // ── THE RESTORED "GOD PROMPT" ───────────────────────────────────
    let sysText = `You are the expert compliance and training assistant for Greencoat Nursery CIC in England.
CRITICAL RULES YOU MUST NEVER BREAK:
1. NO PLACEHOLDERS: NEVER use placeholders like "[insert name]" or "[Name]". 
2. EXACT EXTRACTION: If asked for specific personnel (like the DSL, Manager, or SENCo), extract the EXACT names from the provided policy text below. 
3. MISSING CONTEXT: If the names are NOT in the text below, or if no policy text is provided, DO NOT GUESS. Explicitly reply: "I don't have that information right now. Please open the relevant document (e.g., the Safeguarding Policy) so I can find the exact names for you."
4. EYFS RATIOS (STRICT LAW): 
   - Under 2 years old: 1:3
   - 2-year-olds: 1:5 (Do NOT use 1:4).
   - 3-year-olds and over: 1:8 (or 1:13 if an Early Years Teacher/Level 6 is present).
   - Mixed age math: Calculate proportionally. Do NOT apply the youngest ratio to older children.
5. Base all procedural answers strictly on the specific nursery policy text provided below.`;
    if (body.currentPolicy) {
      sysText += `\n\nThe user is currently looking at the policy titled: "${body.currentPolicy}".`;
    }
    if (body.policyText && body.policyText.trim().length > 50) {
      sysText += `\n\n=== FULL EXACT POLICY TEXT ===\n${body.policyText.slice(0, body.jsonMode ? 20000 : 8000)}\n==============================`;
    }
    if (body.policyCatalog && body.policyCatalog.trim().length > 10) {
      sysText += `\n\nNo specific policy document is currently open. However, here is a catalog of all 118 Greencoat Nursery CIC policies with their descriptions. Use this to answer general questions, provide summaries, and point the user to the relevant policy. After answering, always suggest they open the full policy for complete details.\n\n=== POLICY CATALOG ===\n${body.policyCatalog}\n======================`;
    }
    // Quiz-specific system rules
    if (body.jsonMode) {
      sysText += `\n\nQUIZ GENERATION RULES — follow these exactly:\n0. CRITICAL: Generate questions ONLY about the specific policy named in the user prompt. NEVER use generic safeguarding, ratio or EYFS questions unless the policy is specifically about safeguarding or EYFS ratios. Each question must only be answerable from the provided policy text — if you cannot find the answer in the policy text, do not ask that question.\n1. Generate realistic scenario-based questions (e.g. "A parent asks you to...") not just definition recall.\n2. All questions must be directly and exclusively answerable from the policy text provided — not from general knowledge.\n3. Include at least one question about staff responsibilities under this specific policy and one about what to do in a situation described in this policy.\n4. Distractors (wrong answers) must be plausible but clearly incorrect to someone who has read the policy.\n5. EYFS staff-to-child ratio rules must be respected in any scenario questions.\n6. If the user prompt contains "RETRY" or a numeric seed, you MUST generate COMPLETELY DIFFERENT questions and scenarios — do not reuse any question, scenario or wording from previous attempts.\n7. Return ONLY valid JSON matching the required schema. No markdown, no preamble.`;
    }

    // ── Generation config ───────────────────────────────────────────
    // Dynamic temperature: quiz needs variety (0.45), chat needs accuracy (0.27)
    const config = {
      temperature: body.jsonMode ? 0.45 : 0.27,
      maxOutputTokens: body.jsonMode ? 1024 : 2000
    };

    if (body.jsonMode) {
      config.responseMimeType = "application/json";
      config.responseSchema = {
        type: "OBJECT",
        properties: {
          questions: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                question:    { type: "STRING" },
                options:     { type: "ARRAY", items: { type: "STRING" } },
                correct:     { type: "INTEGER" },
                explanation: { type: "STRING" }
              },
              required: ["question", "options", "correct", "explanation"]
            }
          }
        },
        required: ["questions"]
      };
    }

    // ── Waterfall model rotation ─────────────────────────────────────
    // Preferred order (cheap/fast first), filtered to the models this key can actually use.
    // 429 / 5xx / timeout → next model. 404 (retired model) → skipped and remembered.
    // Invalid key → stop immediately with a clear message for the admin.
    const modelsToTry = await getModelsToTry(apiKey);
    if (modelsToTry.keyError) {
      return cors(json({ error: KEY_ERROR_MSG, code: 'AI_KEY_INVALID' }, 502));
    }

    let reply = null;
    let usedModel = null;
    let sawRateLimit = false;
    const deadline = Date.now() + 24000;

    for (const model of modelsToTry) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      try {
      const url = `${GEMINI_BASE}/models/${model}:generateContent`;
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), Math.min(15000, remaining));
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: ctrl.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysText }] },
          contents: contents,
          generationConfig: config
        })
      });
      clearTimeout(tId);

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          if (isKeyError(resp.status, errBody)) {
            return cors(json({ error: KEY_ERROR_MSG, code: 'AI_KEY_INVALID' }, 502));
          }
          if (resp.status === 404) deadModels.add(model);
          if (resp.status === 429) sawRateLimit = true;
          console.warn(`Model ${model} returned ${resp.status} — trying next model...`);
          continue;
        }
        if (resp.ok) {
          const data = await resp.json();
          let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

          if (body.jsonMode && raw) {
            // Strip markdown wrappers if model added them despite instructions
            raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            try {
              const parsed = JSON.parse(raw);
              const qs = parsed?.questions || (Array.isArray(parsed) ? parsed : null);
              if (qs && qs.length >= 3) {
                const valid = [];
                for (const q of qs) {
                  let correctIdx = q.correct;
                  // Coerce string to integer — Gemini sometimes ignores the schema type
                  if (typeof correctIdx === 'string') correctIdx = parseInt(correctIdx, 10);
                  if (q.question && Array.isArray(q.options) && q.options.length >= 3 &&
                      typeof correctIdx === 'number' && !isNaN(correctIdx) &&
                      correctIdx >= 0 && correctIdx < q.options.length && q.explanation) {
                    q.correct = correctIdx;
                    valid.push(q);
                  }
                }
                if (valid.length >= 3) {
                  reply = JSON.stringify({ questions: valid.slice(0, 3) });
                  usedModel = model;
                  break;
                }
              }
            } catch(e) { continue; } // Malformed JSON — try next model
          } else if (raw) {
            reply = raw;
            usedModel = model;
            break;
          }
        }
      } catch(e) { continue; } // Network error / timeout — try next model
    }

    if (!reply) {
      // The client falls back to its own policy-specific offline quiz questions
      const msg = sawRateLimit
        ? 'The AI assistant is busy right now (free-tier limit reached). Please try again in a minute.'
        : 'The AI assistant is unavailable right now — please try again shortly.';
      return cors(json({ error: msg, code: sawRateLimit ? 'AI_BUSY' : 'AI_UNAVAILABLE' }, 503));
    }

    return cors(json({ ok: true, reply, model: usedModel }));

  } catch (err) {
    console.error("AI error:", err);
    return cors(json({ error: 'AI request failed — please try again.' }, 500));
  }
};

// ── Model discovery ───────────────────────────────────────────────────
// Google renames and retires Gemini models regularly (e.g. gemini-3.1-flash-lite-preview was shut
// down). Instead of hardcoding one list, keep a preferred order and intersect it with the models the
// key can actually call (ListModels — free, no generation quota). Override with GEMINI_MODELS="a,b,c".
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_PREFERENCE = [
  'gemini-3.1-flash-lite',     // Primary: fastest, most cost-efficient (GA successor of 3.1-flash-lite-preview)
  'gemini-flash-lite-latest',  // Google's alias for the current Flash-Lite
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',          // More capable fallbacks
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash-lite',     // Legacy — only for keys that still have 2.5 access
  'gemini-2.5-flash',
];
const MAX_MODELS_PER_REQUEST = 3;
const KEY_ERROR_MSG = 'The AI service key is invalid or has expired. An administrator needs to update GEMINI_API_KEY in Netlify (Site configuration → Environment variables) and redeploy.';
const deadModels = new Set();
let modelCache = null; // { at, names: string[] }

async function listAvailableModels(apiKey) {
  if (modelCache && Date.now() - modelCache.at < 3600000) return modelCache;
  const names = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
      headers: { 'x-goog-api-key': apiKey }, signal: ctrl.signal,
    }).finally(() => clearTimeout(tId));
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      if (isKeyError(resp.status, errBody)) return { keyError: true };
      throw new Error(`ListModels ${resp.status}`);
    }
    const data = await resp.json();
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) names.push(String(m.name).replace(/^models\//, ''));
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  modelCache = { at: Date.now(), names };
  return modelCache;
}

async function getModelsToTry(apiKey) {
  const preferred = (process.env.GEMINI_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = preferred.length ? preferred : MODEL_PREFERENCE;
  let available = null;
  try {
    const found = await listAvailableModels(apiKey);
    if (found.keyError) return { keyError: true };
    available = found.names;
  } catch (e) {
    console.warn('Model discovery failed — using preferred list as-is:', e.message);
  }
  let list = available ? order.filter(m => available.includes(m)) : [...order];
  if (available && list.length < MAX_MODELS_PER_REQUEST) {
    // Future-proofing: if Google renamed everything, fall back to any current text Flash model.
    const extra = available
      .filter(m => /^gemini-.*flash/.test(m) && !/image|tts|live|audio|transcribe|embed|omni|computer|preview/.test(m))
      .sort().reverse();
    for (const m of extra) if (!list.includes(m)) list.push(m);
  }
  list = list.filter(m => !deadModels.has(m)).slice(0, MAX_MODELS_PER_REQUEST);
  return list.length ? list : order.slice(0, MAX_MODELS_PER_REQUEST);
}

function isKeyError(status, bodyText) {
  if (status === 401 || status === 403) return true;
  return status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(bodyText || '');
}

async function aiStatus(apiKey) {
  if (!apiKey) return { ok: false, keyConfigured: false, message: 'GEMINI_API_KEY is not set in Netlify.' };
  try {
    const list = await getModelsToTry(apiKey);
    if (list.keyError) return { ok: false, keyConfigured: true, keyValid: false, message: KEY_ERROR_MSG };
    return { ok: true, keyConfigured: true, keyValid: true, models: list };
  } catch (e) {
    return { ok: false, keyConfigured: true, message: 'Could not reach Google AI: ' + e.message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return r;
}

export const config = { path: "/api/ai", timeout: 26 };
