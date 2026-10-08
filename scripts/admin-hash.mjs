// Generate the ADMIN_PASSWORD_HASH secret for the /admin panel.
//   npm run admin:hash -- "your-password-here"
// Output format (verified by src/lib/session.ts): pbkdf2$<iter>$<saltB64>$<hashB64>
// Set it with: wrangler secret put ADMIN_PASSWORD_HASH   (paste the output)
// Local dev: put it in .dev.vars.

import { pbkdf2Sync, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error(
    'Usage: npm run admin:hash -- "<password>" (minimum 12 characters)',
  );
  process.exit(1);
}

const ITERATIONS = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
console.log(
  `pbkdf2$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`,
);
