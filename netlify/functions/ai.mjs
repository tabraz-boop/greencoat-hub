/**
 * Netlify AI proxy — securely calls Gemini using your environment variable.
 * POST /api/ai
 */

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return cors(new Response(null));
  }
  if (req.method !== "POST") {
    return cors(json({ error: "Method not allowed" }, 405));
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return cors(json({ error: "Server error: Missing GEMINI_API_KEY in Netlify." }, 500));
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
    // Primary exhausted (429) or unavailable (503) → auto-rotate to fallback
    const modelsToTry = [
      'gemini-2.0-flash-lite',   // Primary: fastest, most cost-efficient
      'gemini-2.5-flash',        // Secondary: stable
      'gemini-2.5-pro',          // Last resort: most capable
    ];

    let reply = null;

    for (const model of modelsToTry) {
      try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 20000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysText }] },
          contents: contents,
          generationConfig: config
        })
      });
      clearTimeout(tId);

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
                  break;
                }
              }
            } catch(e) { continue; } // Malformed JSON — try next model
          } else {
            reply = raw || '(no response)';
            break;
          }
        } else if (resp.status === 429 || resp.status === 503) {
          console.warn(`Model ${model} returned ${resp.status} — trying next model...`);
          continue;
        }
      } catch(e) { continue; } // Network error — try next model
    }

    if (!reply) {
      // Let the client fall back to its own policy-specific offline quiz questions
      throw new Error('AI quiz generation unavailable — please try again shortly.');
    }

    return cors(json({ ok: true, reply }));

  } catch (err) {
    console.error("AI error:", err);
    return cors(json({ error: err.message }, 500));
  }
};

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
  r.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return r;
}

export const config = { path: "/api/ai", timeout: 26 };
