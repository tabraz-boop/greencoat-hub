/**
 * Serves policy documents uploaded from the admin console (Netlify Blobs).
 * GET /api/policy-file?key=<policyId>/<timestamp>-<name>.docx
 * Keys are unique per upload, so responses can be cached forever.
 */
import { STORES, store } from "../lib/store.mjs";

export default async (req) => {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!/^[\w-]{1,64}\/[\w.\-()]{1,200}$/.test(key)) return new Response("Not found", { status: 404 });
  const entry = await store(STORES.files).getWithMetadata(key, { type: "arrayBuffer" }).catch(() => null);
  if (!entry?.data) return new Response("Not found", { status: 404 });
  const name = String(entry.metadata?.name || key.split("/").pop()).replace(/"/g, "");
  return new Response(entry.data, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};

export const config = { path: "/api/policy-file" };
