/**
 * Netlify admin-data proxy — reads compliance data from Netlify Blobs.
 * GET  /api/admin-data?action=config         — load saved portal config (public)
 * POST /api/admin-data?action=config         — save portal config (admin)
 * GET  /api/admin-data?action=overview       — full compliance overview (admin)
 * GET  /api/admin-data?action=staff-detail   — single staff detail (admin)
 */

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "greencoat2026";

export default async (req, context) => {
  if (req.method === "OPTIONS") return cors(new Response(null));

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "overview";

  // PUBLIC: load portal config
  if (req.method === "GET" && action === "config") {
    try {
      const store = getStore("gc_portal_config");
      const data = await store.get("portal_data", { type: "json" }).catch(() => null);
      return cors(json({ ok: true, data }));
    } catch (err) {
      return cors(json({ ok: false, data: null }));
    }
  }

  // Require admin password for all other actions
  const auth = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (auth !== ADMIN_PASSWORD) return cors(json({ error: "Unauthorised" }, 401));

  try {
    // ADMIN SAVE: update live portal config
    if (req.method === "POST" && action === "config") {
      const body = await req.json();
      const store = getStore("gc_portal_config");
      await store.setJSON("portal_data", body);
      return cors(json({ ok: true }));
    }

    // OVERVIEW: all staff compliance data
    if (action === "overview") {
      const acksStore = getStore("gc_acks");
      const actStore  = getStore("gc_activity");
      const { blobs: ackBlobs } = await acksStore.list().catch(() => ({ blobs: [] }));
      const { blobs: actBlobs } = await actStore.list().catch(() => ({ blobs: [] }));
      const staffMap = {};

      for (const blob of ackBlobs) {
        const d = await acksStore.get(blob.key, { type: "json" }).catch(() => null);
        if (!d) continue;
        staffMap[blob.key] = staffMap[blob.key] || { staffKey: blob.key, name: d.staffName || blob.key.replace(/_/g," "), acks: [], activity: [] };
        staffMap[blob.key].acks = d.acks || [];
      }
      for (const blob of actBlobs) {
        const d = await actStore.get(blob.key, { type: "json" }).catch(() => null);
        if (!d) continue;
        staffMap[blob.key] = staffMap[blob.key] || { staffKey: blob.key, name: d.staffName || blob.key.replace(/_/g," "), acks: [], activity: [] };
        staffMap[blob.key].activity = d.entries || [];
      }

      const staff = Object.values(staffMap).map(s => ({
        staffKey: s.staffKey,
        name: s.name,
        acknowledged: s.acks,
        acknowledgedCount: s.acks.length,
        aiChatCount: s.activity.filter(e => e.type === "aichat").length,
        quizCount:   s.activity.filter(e => e.type === "quiz").length,
        recentAiChats: s.activity.filter(e => e.type === "aichat").slice(-5).reverse(),
        recentQuizzes: s.activity.filter(e => e.type === "quiz").slice(-5).reverse(),
        activity: s.activity,
      }));

      return cors(json({ ok: true, generatedAt: new Date().toISOString(), staff }));
    }

    // STAFF DETAIL
    if (action === "staff-detail") {
      const staffKey = url.searchParams.get("staff");
      if (!staffKey) return cors(json({ error: "Missing staff param" }, 400));
      const acksStore = getStore("gc_acks");
      const actStore  = getStore("gc_activity");
      const acksData  = await acksStore.get(staffKey, { type: "json" }).catch(() => null);
      const actData   = await actStore.get(staffKey,  { type: "json" }).catch(() => null);
      return cors(json({
        ok: true, staffKey,
        acks:    acksData?.acks || [],
        reads:   (actData?.entries || []).filter(e => e.type === "read"),
        quizzes: (actData?.entries || []).filter(e => e.type === "quiz"),
        aiChats: (actData?.entries || []).filter(e => e.type === "aichat"),
      }));
    }

    return cors(json({ error: "Unknown action" }, 400));
  } catch (err) {
    console.error("admin-data error:", err);
    return cors(json({ error: err.message }, 500));
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return r;
}

export const config = { path: "/api/admin-data" };
