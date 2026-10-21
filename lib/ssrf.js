import dns from "node:dns/promises";
import net from "node:net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SiteCloner/1.0";

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return false;
}

/** Blocks localhost / private networks / cloud metadata endpoints (SSRF protection). */
export async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http/https URLs are allowed");
  if (process.env.ALLOW_PRIVATE === "1") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Private/internal addresses are blocked");
    return;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private/internal addresses are blocked");
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("Private/internal addresses are blocked");
  }
}

/** fetch() that validates every redirect hop. Returns { res, finalUrl }. */
export async function safeFetch(url, { timeoutMs = 20000, headers = {} } = {}) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel();
      current = new URL(loc, current).href;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("Too many redirects");
}
