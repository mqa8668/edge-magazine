// Uploads seed/uploads/** into an R2 bucket so /uploads/* serves real artwork.
// Mirrors the directory layout to R2 keys.
//   node scripts/upload-r2.mjs                                        (local)
//   node scripts/upload-r2.mjs --remote                               (production bucket)
// Bucket: --bucket=<name>, else $R2_BUCKET, else "edge-magazine-uploads".
// Uploads .svg with Content-Type image/svg+xml (and webp/png/jpg).
//   node scripts/upload-r2.mjs --remote --bucket=my-staging-bucket
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "seed", "uploads");
const bucketArg = process.argv.find((a) => a.startsWith("--bucket="));
const BUCKET = bucketArg
  ? bucketArg.split("=")[1]
  : process.env.R2_BUCKET || "edge-magazine-uploads";
const remote = process.argv.includes("--remote");
const scope = remote ? "--remote" : "--local";

const CT = {
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(SRC);
let n = 0;
for (const file of files) {
  const key = "uploads/" + relative(SRC, file).split("\\").join("/");
  const ext = file.slice(file.lastIndexOf("."));
  const ct = CT[ext] ?? "application/octet-stream";
  execFileSync(
    "npx",
    [
      "wrangler", "r2", "object", "put",
      `${BUCKET}/${key}`,
      "--file", file,
      "--content-type", ct,
      scope,
    ],
    { stdio: "ignore", cwd: ROOT },
  );
  n++;
  process.stdout.write(`  put ${key}\n`);
}
console.log(`Uploaded ${n} objects to R2 (${remote ? "remote" : "local"}).`);
