import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { UnsafeWebhookUrlError } from "@/common";
import type { HostCheckOptions, WebhookUrlPolicy } from "@/types";

const BLOCKED_PORTS = new Set([
  22, 23, 25, 445, 465, 587, 993, 995, 2375, 2376, 3306, 5432, 6379, 9200, 11211, 27017,
]);

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip.toLowerCase());
  return true;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "::") return true;

  const dotted = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (dotted?.[1]) return isPrivateV4(dotted[1]);
  const hexMapped = /^::(?:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1] as string, 16);
    const lo = Number.parseInt(hexMapped[2] as string, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  if (bare.startsWith("fe80")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (bare.startsWith("ff")) return true;
  return false;
}

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
    if (opts.requireResolvable === false) return;
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

  if (!policy.allowInsecure) await assertPublicHost(url.hostname, { requireResolvable: false });
  return url;
}
