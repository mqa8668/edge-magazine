import type { Context } from "hono";
import type { AppEnv } from "../env";
import { IMMUTABLE_CACHE } from "../lib/images";

// Serve /uploads/* from R2 (tech-spec §8). Keys are stored under the same
// relative path the pipeline used (e.g. uploads/posts/cover.webp).
export async function uploadsRoute(c: Context<AppEnv>) {
  // R2 key = the request path without the leading slash (e.g.
  // /uploads/posts/x/cover.svg -> uploads/posts/x/cover.svg). Decode percent
  // escapes so keys with spaces resolve.
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/+/, ""));

  const object = await c.env.UPLOADS.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Content-hashed keys are immutable (tech-spec §8).
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }

  return new Response(object.body, { headers });
}
