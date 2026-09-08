import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing and TOTP, both on Node's built-in crypto.
 *
 * scrypt rather than Argon2id, and that is a trade worth naming: Argon2id is the
 * better primitive, but every Node binding for it is a native module. A native
 * dependency in the image that holds the signing key is a supply-chain and
 * build-reproducibility cost, and scrypt — memory-hard, in the standard library,
 * no compilation — is a defensible choice at these parameters. If Argon2id
 * becomes a requirement, `verifyPassword` already dispatches on the stored
 * algorithm prefix, so both can coexist during a rehash-on-login migration.
 */

// N=2^16, r=8, p=1 → ~64 MiB and ~100ms per hash on a modern core. Tuned to make
// offline cracking expensive without making a login feel slow.
const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
// scrypt's default maxmem (32 MiB) is below what these parameters need, so it
// must be raised explicitly or every hash throws.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so parameters can change. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time password check.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupted row
 * must fail closed as "wrong password", not surface as a 500 that tells the
 * caller their password was probably right.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with parameters weaker than the current ones. */
export function needsRehash(stored: string): boolean {
  const [algo, n, r, p] = stored.split("$");
  return algo !== "scrypt" || Number(n) < SCRYPT_N || Number(r) < SCRYPT_R || Number(p) < SCRYPT_P;
}

/** A URL-safe secret. Used for session tokens, CSRF tokens and recovery codes. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/**
 * SHA-256, hex. What gets stored for anything the server only ever needs to
 * RECOGNISE rather than reproduce: session tokens, CSRF tokens, API keys.
 *
 * Not scrypt, deliberately. These are 256-bit random values, not passwords —
 * there is no dictionary to attack, so a slow hash buys nothing and would add
 * ~100ms to every authenticated request.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** Constant-time comparison of two hex digests. */
export function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/**
 * Accept the previous and next step as well as the current one.
 *
 * ±1 step is ~90 seconds of tolerance, which covers ordinary clock drift between
 * a phone and a server. Widening it further trades real security for a problem
 * better solved by running NTP.
 */
const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — the encoding authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.toUpperCase().replace(/=+$/, "")) {
    const idx = BASE32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit TOTP secret, base32 as the enrolment URI needs it. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** The 6-digit code for one time step. */
export function totpCode(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const currentTotpStep = (now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

export interface TotpResult {
  ok: boolean;
  /** The step the code matched. Store it — a code must not be usable twice. */
  step?: number;
}

/**
 * Verify a code against the accepted window, refusing any step at or before
 * `lastStep`.
 *
 * That replay guard is the part people leave out. Without it a code stays valid
 * for its whole 30-second window, so anyone who observes one — over the
 * shoulder, in a phishing proxy, in a log — can reuse it until it expires.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { now?: Date; lastStep?: number | null } = {},
): TotpResult {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false };

  const current = currentTotpStep(opts.now);
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const step = current + drift;
    if (opts.lastStep != null && step <= opts.lastStep) continue;
    const expected = totpCode(secretBase32, step);
    if (tokensMatch(expected, cleaned)) return { ok: true, step };
  }
  return { ok: false };
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpEnrolmentUri(secret: string, account: string, issuer = "cixtech"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes: the way back in when the authenticator is lost.
 *
 * Grouped as `xxxx-xxxx-xxxx` because these get written down and typed back, and
 * an unbroken string of 12 characters is copied wrong far more often.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 12; j++) raw += alphabet[randomInt(alphabet.length)];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}
