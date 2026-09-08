import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@cixtech/errors";

/**
 * Validate a tenant-supplied webhook URL before the engine will ever fetch it
 * (server-side request forgery, CX-09).
 *
 * `PUT /v1/webhook` accepted any string that satisfied JSON Schema `format: "uri"`,
 * and the dispatcher then POSTed a signed body to it from inside the engine's
 * network on a timer. `http://169.254.169.254/…` is a valid URI. So is
 * `http://127.0.0.1:5432/`. And because the dispatcher records the connection
 * error and `GET /v1/webhook/deliveries` hands it back to the tenant, a refused
 * port was distinguishable from an open one — the internal network was mappable
 * from outside without ever seeing a response body.
 *
 * Two checks, at two different times, because either alone is insufficient:
 *
 *  1. **At set time** (`assertPublicWebhookUrl`) — scheme, port, and the resolved
 *     address. Rejecting here gives the tenant an immediate, actionable 400
 *     instead of a delivery that silently dead-letters.
 *  2. **At send time** (`assertPublicHost`, called by the poster) — because DNS
 *     can change between the two. A name that resolved publicly when it was saved
 *     can resolve to 169.254.169.254 an hour later; that is DNS rebinding, and
 *     validating only at set time does nothing against it.
 */

/** The webhook URL is not somewhere this engine is willing to send a request. */
export class UnsafeWebhookUrlError extends AppError {
  readonly code = "UNSAFE_WEBHOOK_URL";
}

/** Ports that are almost never a tenant's webhook receiver and often are ours. */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 445, 465, 587, 993, 995, 2375, 2376, 3306, 5432, 6379, 9200, 11211, 27017,
]);

/**
 * Is this a literal address the engine must never dial? Loopback, link-local
 * (including the cloud metadata address), private ranges, CGNAT, multicast,
 * broadcast, and the IPv6 equivalents including v4-mapped forms.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip.toLowerCase());
  return true; // unparseable: refuse rather than guess
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  if (a === 192 && b === 0) return true; // IETF protocol assignments / test-net
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "::") return true;

  // A v4-mapped address carries a v4 address and must be judged as v4, or
  // ::ffff:169.254.169.254 walks straight past every rule below it. It arrives in
  // TWO spellings and both have to be handled: the dotted form a human writes,
  // and the hex form the WHATWG URL parser normalises it to —
  // `new URL("https://[::ffff:169.254.169.254]/").hostname` is
  // "[::ffff:a9fe:a9fe]". Matching only the dotted form is a bypass, not a
  // hypothetical: it is what the URL object actually hands you.
  const dotted = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (dotted?.[1]) return isPrivateV4(dotted[1]);
  const hexMapped = /^::(?:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1] as string, 16);
    const lo = Number.parseInt(hexMapped[2] as string, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  if (bare.startsWith("fe80")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true; // unique-local fc00::/7
  if (bare.startsWith("ff")) return true; // multicast
  return false;
}

export interface HostCheckOptions {
  /**
   * Treat a hostname that does not resolve as a failure.
   *
   * False at REGISTRATION time and true at SEND time, and the asymmetry is
   * deliberate. A tenant may well register `hooks.newco.example` before DNS has
   * propagated, and refusing that is a usability failure with no security
   * benefit: "does not resolve" is not evidence of a private target. At send time
   * the opposite holds — we are about to dial it, so an answer we cannot check is
   * an answer we must not trust.
   */
  requireResolvable?: boolean;
}

/**
 * Resolve a hostname and refuse it if ANY answer is private. Checking every
 * answer matters: a host that returns both a public and a private address would
 * otherwise pass and then be dialled on the private one.
 */
export async function assertPublicHost(
  hostname: string,
  opts: HostCheckOptions = { requireResolvable: true },
): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) {
      throw new UnsafeWebhookUrlError(`Webhook host ${hostname} is a private or loopback address`, {
        context: { host: hostname },
        exposable: true,
      });
    }
    return;
  }
  let answers: Array<{ address: string }> = [];
  try {
    answers = await lookup(bare, { all: true });
  } catch {
    answers = [];
  }
  if (answers.length === 0) {
    if (opts.requireResolvable === false) return; // registration: not yet propagated is fine
    throw new UnsafeWebhookUrlError(`Webhook host ${hostname} does not resolve`, {
      context: { host: hostname },
      exposable: true,
    });
  }
  for (const { address } of answers) {
    if (isPrivateAddress(address)) {
      throw new UnsafeWebhookUrlError(
        `Webhook host ${hostname} resolves to a private address (${address})`,
        { context: { host: hostname }, exposable: true },
      );
    }
  }
}

export interface WebhookUrlPolicy {
  /**
   * Permit `http://` and private hosts. Development only — it re-opens exactly
   * the SSRF this module exists to close, so it is a boot-time decision an
   * operator has to make, never a per-request one.
   */
  allowInsecure?: boolean;
}

/**
 * Full validation for a URL a tenant is trying to register. Throws
 * `UnsafeWebhookUrlError` (400 to the caller) rather than accepting a URL that
 * would dead-letter — or worse, succeed against something internal.
 */
export async function assertPublicWebhookUrl(
  raw: string,
  policy: WebhookUrlPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError("Webhook URL is not a valid absolute URL", { exposable: true });
  }

  if (url.protocol !== "https:" && !(policy.allowInsecure && url.protocol === "http:")) {
    throw new UnsafeWebhookUrlError(
      "Webhook URL must use https — the delivery carries a signed payload and must not cross the network in the clear",
      { context: { protocol: url.protocol }, exposable: true },
    );
  }
  if (url.username || url.password) {
    throw new UnsafeWebhookUrlError("Webhook URL must not embed credentials", { exposable: true });
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new UnsafeWebhookUrlError(`Webhook URL must not target port ${port}`, {
      context: { port },
      exposable: true,
    });
  }
  // A literal private IP is always refused; a name that simply has not propagated
  // yet is accepted here and re-checked (strictly) at send time.
  if (!policy.allowInsecure) await assertPublicHost(url.hostname, { requireResolvable: false });
  return url;
}
