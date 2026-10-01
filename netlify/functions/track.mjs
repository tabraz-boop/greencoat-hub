/**
 * Netlify track proxy — staff PIN login + acknowledgement/activity records in Netlify Blobs.
 * POST /api/track   Body: { action, staffName?, pin?, token?, data? }
 *
 * Public actions:
 *   pin_status   — { staffName } → { hasPin, lockedUntil }
 *   login        — { staffName, pin } → { token }
 *   set_pin      — { staffName, pin, enrolCode | token } create first PIN (needs the enrolment code
 *                  from the admin console) or change PIN (needs a valid session token)
 *
 * Staff actions (require a valid session token from login/set_pin):
 *   ack          — record one policy acknowledgement with server timestamp + quiz result
 *   sync_acks    — upload acks recorded on this device (merge only — never removes)
 *   log_activity — append an activity entry (aichat, quiz, read, milestone, summary)
 *   get_acks     — read back acks + per-policy records (for a new device)
 */
import { STORES, staffKeyOf, readJSON, updateJSON, getConfiguredStaff, json, cors } from "../lib/store.mjs";
import { hashSecret, verifySecret, signStaffToken, verifyStaffToken, checkEnrolCode } from "../lib/auth.mjs";

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const ACK_METHODS = new Set(["quiz", "offline_quiz", "direct", "device"]);
const ACTIVITY_TYPES = new Set(["aichat", "quiz", "read", "milestone", "summary"]);
const isPin = (p) => typeof p === "string" && /^\d{4}$/.test(p);
const str = (v, max) => (v === undefined || v === null ? null : String(v).slice(0, max));
const int = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

export default async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null), "POST, OPTIONS");
  if (req.method !== "POST") return cors(json({ error: "Method not allowed" }, 405), "POST, OPTIONS");

  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ── Public: PIN login ───────────────────────────────────────────────
    if (action === "pin_status" || action === "login" || action === "set_pin") {
      const staffName = typeof body.staffName === "string" ? body.staffName.trim() : "";
      if (!staffName || staffName.length > 80) return reply({ error: "Missing staffName" }, 400);
      const staff = await getConfiguredStaff();
      if (staff && !staff.includes(staffName)) return reply({ error: "This name is not on the current staff list. Please ask your manager." }, 403);
      const staffKey = staffKeyOf(staffName);
      const pinRec = await readJSON(STORES.pins, staffKey);

      if (action === "pin_status") {
        return reply({ ok: true, hasPin: !!pinRec?.hash, lockedUntil: lockedUntil(pinRec) });
      }

      if (action === "login") {
        if (!isPin(body.pin)) return reply({ error: "Enter your 4-digit PIN" }, 400);
        if (!pinRec?.hash) return reply({ error: "No PIN set yet", needsSetup: true }, 409);
        const lock = lockedUntil(pinRec);
        if (lock) return reply({ error: "Too many attempts", lockedUntil: lock }, 429);
        if (!verifySecret(body.pin, pinRec)) {
          const updated = await updateJSON(STORES.pins, staffKey, (cur) => {
            if (!cur) return undefined;
            const failCount = (cur.failCount || 0) + 1;
            return { ...cur, failCount, lockedUntil: failCount >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : cur.lockedUntil || null };
          });
          const fails = updated?.failCount || 0;
          if (fails >= MAX_FAILS) return reply({ error: "Too many attempts", lockedUntil: updated.lockedUntil }, 429);
          return reply({ error: "Incorrect PIN", attemptsLeft: MAX_FAILS - fails }, 401);
        }
        if (pinRec.failCount || pinRec.lockedUntil) {
          await updateJSON(STORES.pins, staffKey, (cur) => (cur ? { ...cur, failCount: 0, lockedUntil: null } : undefined));
        }
        const token = await signStaffToken({ staffName, staffKey, pinVersion: pinRec.setAt });
        return reply({ ok: true, token, staffName });
      }

      // set_pin: first-time setup (no PIN yet) or change (needs a valid session for this person)
      if (!isPin(body.pin)) return reply({ error: "PIN must be exactly 4 digits" }, 400);
      if (pinRec?.hash) {
        const session = await verifyStaffToken(body.token);
        if (!session || session.staffKey !== staffKey) return reply({ error: "Please log in with your current PIN first" }, 401);
      } else if (!(await checkEnrolCode(body.enrolCode))) {
        return reply({ error: body.enrolCode ? "That enrolment code isn't right — please check it with your manager." : "Enter the enrolment code from your manager to create your PIN.", needsEnrolCode: true }, 403);
      }
      const setAt = new Date().toISOString();
      const saved = await updateJSON(STORES.pins, staffKey, (cur) => {
        // Someone else created a PIN for this name between our read and write — refuse.
        if (cur?.hash && !pinRec?.hash) return undefined;
        return { staffName, ...hashSecret(body.pin), setAt, setBy: "self", failCount: 0, lockedUntil: null };
      });
      if (saved?.setAt !== setAt) return reply({ error: "A PIN was just set for this name. Please log in with it." }, 409);
      const token = await signStaffToken({ staffName, staffKey, pinVersion: setAt });
      return reply({ ok: true, token, staffName });
    }

    // ── Staff actions: need a valid session ─────────────────────────────
    const session = await verifyStaffToken(body.token);
    if (!session) return reply({ error: "Session expired — please log in again", needsLogin: true }, 401);
    const { staffName, staffKey } = session;
    const data = body.data || {};
    const now = new Date().toISOString();

    if (action === "ack") {
      const policyId = str(data.policyId, 64);
      if (!policyId) return reply({ error: "Missing policyId" }, 400);
      const method = ACK_METHODS.has(data.method) ? data.method : "direct";
      // Is this an acknowledgement of an out-of-date version (e.g. a tab opened before the admin
      // published a new version that staff must re-read)? Then record it as stale.
      const portal = await readJSON(STORES.config, "portal_data");
      const pol = Array.isArray(portal?.policies) ? portal.policies.find((p) => p && p.id === policyId) : null;
      const curVer = pol ? int(pol.version) || 1 : null;
      const reqVer = pol?.reackRequiredFrom ? int(pol.reackVersion) || curVer : null;
      const ackVer = int(data.policyVersion) || 1;
      const stale = reqVer !== null && ackVer < reqVer;
      const clientAt = typeof data.ackedAt === "string" && !isNaN(Date.parse(data.ackedAt)) && Date.parse(data.ackedAt) <= Date.now() + 300000 ? new Date(data.ackedAt).toISOString() : null;
      const saved = await updateJSON(STORES.acks, staffKey, (cur) => {
        const next = normaliseAcks(cur, staffName);
        const prev = next.records[policyId];
        // Never let a stale acknowledgement replace a current one
        if (stale && prev && !prev.legacy && !prev.stale && (int(prev.policyVersion) || 1) >= reqVer) return undefined;
        // Re-acknowledgement (e.g. after the policy was updated): keep the earlier record in history.
        // Ignore an immediate duplicate (an outbox retry of a request the server already processed).
        const duplicate = prev && !prev.legacy && (prev.policyVersion ?? null) === int(data.policyVersion) && Date.now() - Date.parse(prev.at || 0) < 120000;
        if (!duplicate) {
          const history = prev && !prev.legacy ? [...(prev.history || []), { at: prev.at, method: prev.method, score: prev.score, total: prev.total, policyVersion: prev.policyVersion ?? null }].slice(-10) : prev?.history;
          next.records[policyId] = {
            at: now,
            method,
            score: int(data.score),
            total: int(data.total),
            policyTitle: str(data.policyTitle, 200),
            policyAdopted: str(data.policyAdopted, 40),
            policyVersion: ackVer,
            ...(clientAt ? { deviceAt: clientAt } : {}),
            ...(stale ? { stale: true } : {}),
            ...(prev?.legacy ? { deviceDate: prev.at } : {}),
            ...(history?.length ? { history } : {}),
          };
        }
        if (!next.acks.includes(policyId)) next.acks.push(policyId);
        next.updatedAt = now;
        return next;
      });
      return reply({ ok: true, record: saved.records[policyId], stale, currentVersion: curVer });
    }

    if (action === "sync_acks") {
      const ids = Array.isArray(data.acks) ? data.acks.map((x) => str(x, 64)).filter(Boolean).slice(0, 500) : null;
      if (!ids) return reply({ error: "Missing acks array" }, 400);
      const dates = data.dates && typeof data.dates === "object" ? data.dates : {};
      const titles = data.titles && typeof data.titles === "object" ? data.titles : {};
      const saved = await updateJSON(STORES.acks, staffKey, (cur) => {
        const next = normaliseAcks(cur, staffName);
        let changed = !cur;
        for (const id of ids) {
          if (!next.acks.includes(id)) { next.acks.push(id); changed = true; }
          if (!next.records[id]) {
            // Recorded on the device before server sync worked — keep the device's own date.
            next.records[id] = { at: parseDeviceDate(dates[id]), method: "device", legacy: true, policyTitle: str(titles[id], 200), syncedAt: now };
            changed = true;
          }
        }
        if (!changed) return undefined;
        next.updatedAt = now;
        return next;
      });
      return reply({ ok: true, acks: saved.acks, records: saved.records });
    }

    if (action === "get_acks") {
      const cur = normaliseAcks(await readJSON(STORES.acks, staffKey), staffName);
      return reply({ ok: true, acks: cur.acks, records: cur.records });
    }

    if (action === "log_activity") {
      const type = ACTIVITY_TYPES.has(data.activityType) ? data.activityType : null;
      if (!type) return reply({ error: "Missing activityType" }, 400);
      await updateJSON(STORES.activity, staffKey, (cur) => {
        const entries = Array.isArray(cur?.entries) ? cur.entries : [];
        entries.push({
          type,
          key: str(data.key, 200),
          value: type === "quiz" ? quizValue(data.value) : str(data.value, 1000),
          policyId: str(data.policyId, 64),
          policyTitle: str(data.policyTitle, 200),
          timestamp: now,
        });
        return { staffName, entries: entries.slice(-500), updatedAt: now };
      });
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("track error:", err);
    return reply({ error: "Server error — your progress is saved on this device and will sync later." }, 500);
  }
};

function reply(data, status = 200) {
  return cors(json(data, status), "POST, OPTIONS");
}

function lockedUntil(pinRec) {
  return pinRec?.lockedUntil && Date.parse(pinRec.lockedUntil) > Date.now() ? pinRec.lockedUntil : null;
}

/** Quiz results are rendered in the admin console: keep only numbers/booleans. */
function quizValue(v) {
  let o = null;
  try { o = typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const score = int(o.score), total = int(o.total);
  if (score === null || total === null) return null;
  return JSON.stringify({ score, total, pct: int(o.pct) ?? (total ? Math.round((score / total) * 100) : 0), passed: o.passed === true });
}

/** Accepts the legacy { staffName, acks[], updatedAt } shape and adds per-policy records. */
function normaliseAcks(cur, staffName) {
  const acks = Array.isArray(cur?.acks) ? [...cur.acks] : [];
  const records = cur?.records && typeof cur.records === "object" ? { ...cur.records } : {};
  for (const id of acks) if (!records[id]) records[id] = { at: cur?.updatedAt || null, method: "device", legacy: true };
  return { staffName: cur?.staffName || staffName, acks, records, updatedAt: cur?.updatedAt || null };
}

/** Device dates were saved with toLocaleDateString('en-GB') → "dd/mm/yyyy". */
function parseDeviceDate(v) {
  const m = typeof v === "string" && v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 23, 59, 59));
  return isNaN(d) ? null : d.toISOString();
}

export const config = { path: "/api/track" };
