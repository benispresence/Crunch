/**
 * SSRF guard for outbound fetches to admin-configured URLs (OIDC
 * discovery / JWKS / token / userinfo endpoints, and anything else that
 * lets an operator point the server at an arbitrary host).
 *
 * The threat: an admin (or someone who reaches the admin API) sets a
 * provider URL to ``http://169.254.169.254/...`` or an internal service
 * and turns the backend into a request proxy into the private network /
 * cloud metadata. We refuse non-HTTPS (except in dev) and any host that
 * resolves to a loopback / private / link-local address.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

function ipIsPrivate(ip: string): boolean {
  // Normalise IPv4-mapped IPv6 (::ffff:10.0.0.1) down to the v4 form.
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const octets = v4.split(".").map(Number);
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true;          // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  return false;
}

/**
 * Throws if ``urlStr`` is not a safe outbound target. On success returns
 * the parsed URL. Must be awaited *before* the fetch so a malicious host
 * never gets a connection.
 */
export async function assertSafeUrl(urlStr: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`invalid URL: ${urlStr}`);
  }
  // HTTPS only in production; allow http in dev so localhost IdPs work.
  if (url.protocol !== "https:" && !(config.isDev && url.protocol === "http:")) {
    throw new Error(`refusing non-HTTPS outbound URL: ${url.protocol}//`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Direct IP literal — check it without touching DNS.
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) {
      throw new Error(`refusing outbound request to private address ${host}`);
    }
    return url;
  }

  // Hostname — resolve every A/AAAA record and reject if *any* points at
  // a private range (defends against DNS rebinding picking a public
  // record now and a private one at fetch time is still possible, but
  // this closes the trivially-malicious "metadata.internal" case).
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve host: ${host}`);
  }
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new Error(
        `refusing outbound request: ${host} resolves to private address ${a.address}`,
      );
    }
  }
  return url;
}

/** fetch() wrapper that runs assertSafeUrl first. */
export async function safeFetch(
  urlStr: string,
  init?: RequestInit,
): Promise<Response> {
  await assertSafeUrl(urlStr);
  return fetch(urlStr, init);
}
