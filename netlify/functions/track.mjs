/**
 * Netlify track proxy — persists staff acknowledgements and activity to Netlify Blobs.
 * POST /api/track
 * Body: { action, staffName, data }
 *
 * Actions:
 *   sync_acks    — save full acknowledged policy ID array for a staff member
 *   log_activity — append a single activity entry (aichat, quiz, read) to staff log
 */

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method === "OPTIONS") return cors(new Response(null));
  if (req.method !== "POST") return cors(json({ error: "Method not allowed" }, 405));

  try {
    const body = await req.json();
    const { action, staffName, data } = body;

    if (!staffName || typeof staffName !== "string") {
      return cors(json({ error: "Missing staffName" }, 400));
    }

    // Sanitise key — match localStorage pattern
    const staffKey = staffName.replace(/\s+/g, "_");

    // ── sync_acks: staff has acknowledged one or more policies ───────────────
    if (action === "sync_acks") {
      if (!Array.isArray(data?.acks)) return cors(json({ error: "Missing acks array" }, 400));
      const store = getStore("gc_acks");
      await store.setJSON(staffKey, {
        staffName,
        acks: data.acks,
        updatedAt: new Date().toISOString(),
      });
      return cors(json({ ok: true }));
    }

    // ── log_activity: single activity entry (aichat, quiz, read, milestone) ──
    if (action === "log_activity") {
      if (!data?.activityType) return cors(json({ error: "Missing activityType" }, 400));
      const store = getStore("gc_activity");
      // Read existing, append, save
      const existing = await store.get(staffKey, { type: "json" }).catch(() => null);
      const log = Array.isArray(existing?.entries) ? existing.entries : [];
      log.push({
        type: data.activityType,
        key: data.key || null,
        value: data.value || null,
        policyId: data.policyId || null,
        policyTitle: data.policyTitle || null,
        timestamp: new Date().toISOString(),
      });
      // Keep last 500 entries per staff member
      const trimmed = log.slice(-500);
      await store.setJSON(staffKey, {
        staffName,
        entries: trimmed,
        updatedAt: new Date().toISOString(),
      });
      return cors(json({ ok: true }));
    }

    // ── get_acks: staff portal reads back acks from Blobs on login ──────────────
    if (action === "get_acks") {
      const store = getStore("gc_acks");
      const existing = await store.get(staffKey, { type: "json" }).catch(() => null);
      return cors(json({ ok: true, acks: existing?.acks || [] }));
    }

        return cors(json({ error: "Unknown action" }, 400));
  } catch (err) {
    console.error("track error:", err);
    return cors(json({ error: err.message }, 500));
  }
};

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

export const config = { path: "/api/track" };
