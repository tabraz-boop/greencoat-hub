/**
 * Netlify admin-data proxy — portal config + compliance records in Netlify Blobs.
 * GET  /api/admin-data?action=config         — load saved portal config (public, used by staff portal)
 * POST /api/admin-data?action=login          — check admin password → { ok, usingDefault }
 * POST /api/admin-data?action=config         — save portal config (admin)
 * POST /api/admin-data?action=change_password— store a new admin password, hashed (admin)
 * GET  /api/admin-data?action=overview       — every staff member's acks + per-policy records (admin)
 * GET  /api/admin-data?action=staff-detail&staff=<staffKey> — one staff member's full record (admin)
 * GET  /api/admin-data?action=pins           — which staff have a PIN set (never the PIN itself) (admin)
 * POST /api/admin-data?action=reset_pin      — { staffName } clear a PIN so they create a new one (admin)
 * POST /api/admin-data?action=set_pin        — { staffName, pin } set a temporary PIN (admin)
 *
 * Admin actions need `Authorization: Bearer <admin password>`.
 */
import { STORES, store, staffKeyOf, readJSON, updateJSON, json, cors } from "../lib/store.mjs";
import { checkAdminPassword, hashSecret, bearer } from "../lib/auth.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null));

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "overview";

  try {
    // PUBLIC: load portal config (policies, staff list, settings)
    if (req.method === "GET" && action === "config") {
      const data = await readJSON(STORES.config, "portal_data");
      return cors(json({ ok: true, data }));
    }

    const auth = await checkAdminPassword(bearer(req));
    if (!auth.ok) return cors(json({ error: "Unauthorised" }, 401));

    if (action === "login") {
      return cors(json({ ok: true, usingDefault: !!auth.usingDefault }));
    }

    if (req.method === "POST" && action === "config") {
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.policies) || !Array.isArray(body.staff)) {
        return cors(json({ error: "Config must include policies[] and staff[]" }, 400));
      }
      const policies = body.policies.filter((p) => p && typeof p.id === "string" && typeof p.title === "string");
      const staff = [...new Set(body.staff.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
      if (!policies.length) return cors(json({ error: "Refusing to save an empty policy list" }, 400));
      await store(STORES.config).setJSON("portal_data", {
        policies, staff, config: body.config && typeof body.config === "object" ? body.config : {}, updatedAt: new Date().toISOString(),
      });
      return cors(json({ ok: true, policies: policies.length, staff: staff.length }));
    }

    if (req.method === "POST" && action === "change_password") {
      const body = await req.json().catch(() => ({}));
      const pw = typeof body.newPassword === "string" ? body.newPassword : "";
      if (pw.length < 8) return cors(json({ error: "Password must be at least 8 characters" }, 400));
      await store(STORES.config).setJSON("admin_auth", { ...hashSecret(pw), changedAt: new Date().toISOString() });
      return cors(json({ ok: true }));
    }

    if (action === "overview") {
      const portal = await readJSON(STORES.config, "portal_data");
      const [acksMap, actMap, pinMap] = await Promise.all([readAll(STORES.acks), readAll(STORES.activity), readAll(STORES.pins)]);
      // Everyone on the staff list appears (even with zero progress), plus anyone with records.
      const keys = new Map();
      for (const name of portal?.staff || []) keys.set(staffKeyOf(name), name);
      for (const [k, v] of [...Object.entries(acksMap), ...Object.entries(actMap)]) if (!keys.has(k)) keys.set(k, v?.staffName || k.replace(/_/g, " "));

      const staff = [...keys.entries()].map(([staffKey, name]) => {
        const a = acksMap[staffKey] || {};
        const entries = Array.isArray(actMap[staffKey]?.entries) ? actMap[staffKey].entries : [];
        const acks = Array.isArray(a.acks) ? a.acks : [];
        const records = a.records && typeof a.records === "object" ? a.records : {};
        const quizzes = entries.filter((e) => e.type === "quiz");
        const lastAt = [a.updatedAt, entries.at(-1)?.timestamp].filter(Boolean).sort().at(-1) || null;
        return {
          staffKey,
          name,
          active: !portal?.staff || portal.staff.includes(name),
          acknowledged: acks,
          acknowledgedCount: acks.length,
          records,
          lastActivityAt: lastAt,
          hasPin: !!pinMap[staffKey]?.hash,
          aiChatCount: entries.filter((e) => e.type === "aichat").length,
          quizCount: quizzes.length,
          recentAiChats: entries.filter((e) => e.type === "aichat").slice(-50).reverse(),
          recentQuizzes: quizzes.slice(-20).reverse(),
        };
      });
      return cors(json({ ok: true, generatedAt: new Date().toISOString(), staff }));
    }

    if (action === "staff-detail") {
      const staffKey = url.searchParams.get("staff");
      if (!staffKey) return cors(json({ error: "Missing staff param" }, 400));
      const [acksData, actData] = await Promise.all([readJSON(STORES.acks, staffKey), readJSON(STORES.activity, staffKey)]);
      const entries = actData?.entries || [];
      return cors(json({
        ok: true,
        staffKey,
        acks: acksData?.acks || [],
        records: acksData?.records || {},
        reads: entries.filter((e) => e.type === "read"),
        quizzes: entries.filter((e) => e.type === "quiz"),
        aiChats: entries.filter((e) => e.type === "aichat"),
      }));
    }

    if (action === "pins") {
      const pinMap = await readAll(STORES.pins);
      return cors(json({
        ok: true,
        pins: Object.entries(pinMap).map(([staffKey, p]) => ({
          staffKey, staffName: p?.staffName || staffKey.replace(/_/g, " "), hasPin: !!p?.hash, setAt: p?.setAt || null, setBy: p?.setBy || null,
          locked: !!(p?.lockedUntil && Date.parse(p.lockedUntil) > Date.now()),
        })),
      }));
    }

    if (req.method === "POST" && (action === "reset_pin" || action === "set_pin")) {
      const body = await req.json().catch(() => ({}));
      const staffName = typeof body.staffName === "string" ? body.staffName.trim() : "";
      if (!staffName) return cors(json({ error: "Missing staffName" }, 400));
      const staffKey = staffKeyOf(staffName);
      if (action === "reset_pin") {
        await store(STORES.pins).delete(staffKey);
        return cors(json({ ok: true }));
      }
      if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) return cors(json({ error: "PIN must be exactly 4 digits" }, 400));
      await updateJSON(STORES.pins, staffKey, () => ({ staffName, ...hashSecret(body.pin), setAt: new Date().toISOString(), setBy: "admin", failCount: 0, lockedUntil: null }));
      return cors(json({ ok: true }));
    }

    return cors(json({ error: "Unknown action" }, 400));
  } catch (err) {
    console.error("admin-data error:", err);
    return cors(json({ error: err.message }, 500));
  }
};

async function readAll(storeName) {
  const s = store(storeName);
  const { blobs } = await s.list().catch(() => ({ blobs: [] }));
  const entries = await Promise.all(blobs.map(async (b) => [b.key, await s.get(b.key, { type: "json" }).catch(() => null)]));
  return Object.fromEntries(entries.filter(([, v]) => v));
}

export const config = { path: "/api/admin-data" };
