/**
 * Auth helpers: hashed PINs/passwords (scrypt), signed staff session tokens (HMAC),
 * and the admin password check shared by admin-data.mjs.
 */
import crypto from "node:crypto";
import { STORES, store, readJSON } from "./store.mjs";

const DEFAULT_ADMIN_PASSWORD = "greencoat2026"; // only used until ADMIN_PASSWORD is set or changed in the console
export const TOKEN_TTL_MS = 24 * 3600 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(secret), salt, 32).toString("hex");
  return { hash, salt };
}

export function verifySecret(secret, record) {
  if (!record?.hash || !record?.salt) return false;
  const a = Buffer.from(crypto.scryptSync(String(secret), record.salt, 32).toString("hex"));
  const b = Buffer.from(record.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── Signing secret ────────────────────────────────────────────────────
// Prefer SESSION_SECRET from the Netlify env; otherwise generate one once and keep it in Blobs,
// so the portal works without any extra setup.
let cachedSecret = null;
async function getSigningSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  const s = store(STORES.config);
  let rec = await s.get("session_secret", { type: "json" }).catch(() => null);
  if (!rec?.secret) {
    await s.setJSON("session_secret", { secret: crypto.randomBytes(32).toString("hex"), createdAt: new Date().toISOString() }, { onlyIfNew: true });
    rec = await s.get("session_secret", { type: "json" });
  }
  cachedSecret = rec.secret;
  return cachedSecret;
}

export async function signStaffToken({ staffName, staffKey, pinVersion }) {
  const now = Date.now();
  const payload = b64url(JSON.stringify({ n: staffName, k: staffKey, v: pinVersion || "", iat: now, exp: now + TOKEN_TTL_MS }));
  const sig = b64url(crypto.createHmac("sha256", await getSigningSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Verifies a staff token and that it was issued for the staff member's current PIN
 * (an admin PIN reset invalidates existing sessions). Returns { staffName, staffKey } or null.
 */
export async function verifyStaffToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", await getSigningSecret()).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data?.k || !data?.exp || Date.now() > data.exp) return null;
  const pin = await readJSON(STORES.pins, data.k);
  if (!pin || (pin.setAt || "") !== data.v) return null;
  return { staffName: data.n, staffKey: data.k };
}

// ── Admin password ────────────────────────────────────────────────────
// Valid if it matches ADMIN_PASSWORD (Netlify env — always works, so the owner can recover access),
// or the password set from the admin console (stored hashed in Blobs). The built-in default only
// works while neither exists.
export async function checkAdminPassword(password) {
  if (!password) return { ok: false };
  const envPass = process.env.ADMIN_PASSWORD || "";
  const stored = await readJSON(STORES.config, "admin_auth");
  if (envPass && safeEqual(password, envPass)) return { ok: true, usingDefault: false };
  if (stored?.hash && verifySecret(password, stored)) return { ok: true, usingDefault: false };
  if (!envPass && !stored?.hash && safeEqual(password, DEFAULT_ADMIN_PASSWORD)) return { ok: true, usingDefault: true };
  return { ok: false };
}

export function bearer(req) {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}
