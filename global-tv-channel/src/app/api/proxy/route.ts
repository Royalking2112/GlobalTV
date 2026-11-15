import { lookup } from "node:dns/promises";
import net from "node:net";

export const dynamic = "force-dynamic";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function assertPublic(u: URL) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("blocked host");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked host");
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("blocked host");
}

function proxied(target: string, ref: string | null, ua: string | null) {
  const p = new URLSearchParams({ u: target });
  if (ref) p.set("r", ref);
  if (ua) p.set("a", ua);
  return `/api/proxy?${p.toString()}`;
}

function rewritePlaylist(text: string, base: string, ref: string | null, ua: string | null) {
  const abs = (s: string) => {
    try {
      return proxied(new URL(s, base).toString(), ref, ua);
    } catch {
      return s;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${abs(uri)}"`);
      return abs(t);
    })
    .join("\n");
}

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const target = sp.get("u");
  const ref = sp.get("r");
  const ua = sp.get("a");
  if (!target) return new Response("missing url", { status: 400 });

  let url: URL;
  try {
    url = new URL(target);
    await assertPublic(url);
  } catch {
    return new Response("blocked", { status: 400 });
  }

  const headers: Record<string, string> = {
    "User-Agent": ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    Accept: "*/*",
  };
  if (ref) {
    headers.Referer = ref;
    try {
      headers.Origin = new URL(ref).origin;
    } catch {}
  }
  const range = req.headers.get("range");
  if (range) headers.Range = range;

  try {
    const upstream = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      return new Response("upstream " + upstream.status, { status: 502, headers: CORS });
    }
    const finalUrl = upstream.url || url.toString();
    // Validate redirect target too
    try {
      await assertPublic(new URL(finalUrl));
    } catch {
      return new Response("blocked", { status: 400 });
    }
    const ct = upstream.headers.get("content-type") ?? "";
    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search);
    if (looksPlaylist) {
      const text = await upstream.text();
      if (text.trimStart().startsWith("#EXTM3U")) {
        return new Response(rewritePlaylist(text, finalUrl, ref, ua), {
          headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
        });
      }
      return new Response(text, { headers: { ...CORS, "Content-Type": ct || "text/plain" } });
    }
    const out = new Headers(CORS);
    if (ct) out.set("Content-Type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) out.set("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) out.set("Content-Range", cr);
    out.set("Cache-Control", "public, max-age=30");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return new Response("fetch failed", { status: 502, headers: CORS });
  }
}
