/**
 * Shared Netlify Blobs helpers for the Greencoat functions.
 * Lives outside netlify/functions/ so Netlify does not deploy it as an endpoint;
 * functions import it relatively and the bundler includes it.
 */
import { getStore } from "@netlify/blobs";

// Store names — keep in sync with AGENTS.md "Netlify Blobs stores"
export const STORES = {
  config:   "gc_portal_config", // portal_data, admin_auth, session_secret
  acks:     "gc_acks",          // <staffKey> → { staffName, acks[], records{}, updatedAt }
  activity: "gc_activity",      // <staffKey> → { staffName, entries[], updatedAt }
  pins:     "gc_pins",          // <staffKey> → { staffName, hash, salt, setAt, setBy, failCount, lockedUntil }
};

// Same join key as localStorage: gc_acks_<staffKey>
export const staffKeyOf = (name) => String(name || "").trim().replace(/\s+/g, "_");

export const store = (name) => getStore({ name, consistency: "strong" });

export async function readJSON(storeName, key) {
  return store(storeName).get(key, { type: "json" }).catch(() => null);
}

/**
 * Read-modify-write with optimistic concurrency (etag / if-match), so two
 * requests landing at the same time can't silently overwrite each other.
 * `mutate(current)` receives the current value (or null) and returns the new
 * value, or `undefined` to leave the blob untouched.
 */
export async function updateJSON(storeName, key, mutate, retries = 6) {
  const s = store(storeName);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const existing = await s.getWithMetadata(key, { type: "json" }).catch(() => null);
    const current = existing ? existing.data : null;
    const next = await mutate(current);
    if (next === undefined) return current;
    // No etag (e.g. local dev server) → plain write; production returns etags on reads.
    const cond = !existing ? { onlyIfNew: true } : existing.etag ? { onlyIfMatch: existing.etag } : {};
    const res = await s.setJSON(key, next, cond);
    if (res?.modified !== false) return next;
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1) + Math.random() * 60));
  }
  throw new Error(`Could not save ${storeName}/${key} — too many concurrent updates`);
}

/** Staff list configured by the admin (null when the admin has never saved config). */
export async function getConfiguredStaff() {
  const portal = await readJSON(STORES.config, "portal_data");
  return Array.isArray(portal?.staff) && portal.staff.length ? portal.staff : null;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function cors(response, methods = "GET, POST, OPTIONS") {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  r.headers.set("Access-Control-Allow-Methods", methods);
  return r;
}
