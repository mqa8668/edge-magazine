import { describe, expect, test } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import {
  createSessionToken,
  verifySessionToken,
  csrfToken,
  verifyCsrf,
  verifyPassword,
  readCookie,
} from "../src/lib/session";

const SECRET = "test-session-secret";

// Build a stored hash in the admin-hash.mjs format, so this also cross-checks
// the WebCrypto verify path against node's pbkdf2.
function storedHash(password: string, iterations = 100_000): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

describe("verifyPassword", () => {
  test("accepts the right password, rejects the wrong one", async () => {
    const stored = storedHash("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  test("rejects malformed stored values", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$100000$onlythree")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$a$b")).toBe(false);
  });
});

describe("session token", () => {
  test("round-trips a valid token", async () => {
    const token = await createSessionToken(SECRET);
    const s = await verifySessionToken(SECRET, token);
    expect(s).not.toBeNull();
    expect(s!.exp).toBeGreaterThan(Date.now() / 1000);
  });

  test("rejects a tampered signature", async () => {
    const token = await createSessionToken(SECRET);
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -2) + "xy";
    expect(await verifySessionToken(SECRET, parts.join("."))).toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken("other-secret", token)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const nonce = "abc";
    // exp in the past; signature will not matter because exp is checked first.
    expect(await verifySessionToken(SECRET, `1000.${nonce}.sig`)).toBeNull();
  });

  test("rejects undefined / malformed tokens", async () => {
    expect(await verifySessionToken(SECRET, undefined)).toBeNull();
    expect(await verifySessionToken(SECRET, "only.two")).toBeNull();
  });
});

describe("CSRF", () => {
  test("token verifies for its own session and fails for another", async () => {
    const token = await createSessionToken(SECRET);
    const s = (await verifySessionToken(SECRET, token))!;
    const csrf = await csrfToken(SECRET, s);
    expect(await verifyCsrf(SECRET, s, csrf)).toBe(true);
    expect(await verifyCsrf(SECRET, s, "bogus")).toBe(false);
    expect(await verifyCsrf(SECRET, s, undefined)).toBe(false);

    const other = (await verifySessionToken(SECRET, await createSessionToken(SECRET)))!;
    // A CSRF token bound to a different session must not validate here.
    expect(await verifyCsrf(SECRET, other, csrf)).toBe(false);
  });
});

describe("readCookie", () => {
  test("extracts a named cookie", () => {
    expect(readCookie("a=1; rn_admin=xyz; b=2", "rn_admin")).toBe("xyz");
    expect(readCookie("a=1", "rn_admin")).toBeUndefined();
    expect(readCookie(undefined, "rn_admin")).toBeUndefined();
  });
});
