import crypto from "node:crypto";
import { Cloner } from "../../../lib/cloner.js";
import { assertPublic } from "../../../lib/ssrf.js";
import { addHistory } from "../../../lib/store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby max (fluid compute). Keep CLONE_MAX_SECONDS below this.

const clamp = (n, lo, hi, d) => {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (body.confirm !== true) {
    return Response.json(
      { error: "Please confirm you have permission to copy this website." },
      { status: 400 }
    );
  }

  let target;
  try {
    let raw = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    target = new URL(raw);
    target.hash = "";
    await assertPublic(target.href);
  } catch (e) {
    return Response.json({ error: e.message || "Invalid URL" }, { status: 400 });
  }

  const hardMaxPages = Number(process.env.CLONE_MAX_PAGES) || 100;
  const opts = {
    url: target.href,
    depth: clamp(body.depth, 0, 3, 1),
    maxPages: clamp(body.maxPages, 1, hardMaxPages, 25),
    stripJs: Boolean(body.stripJs),
    external: body.external !== false,
    sitemap: Boolean(body.sitemap),
    renderJs: Boolean(body.renderJs),
  };

  const enc = new TextEncoder();
  let cloner = null;
  let cancelled = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj) => {
        if (cancelled) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          cancelled = true;
        }
      };

      (async () => {
        const entry = {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          url: opts.url,
          host: target.host,
          options: {
            depth: opts.depth, maxPages: opts.maxPages, stripJs: opts.stripJs,
            external: opts.external, sitemap: opts.sitemap, renderJs: opts.renderJs,
          },
          permissionConfirmed: true,
        };
        try {
          send({ t: "start", id: entry.id, url: opts.url, host: target.host });
          cloner = new Cloner(opts, send);
          const stats = await cloner.run();
          Object.assign(entry, {
            status: cancelled ? "stopped" : stats.truncated ? "partial" : "ok",
            pages: stats.pages, files: stats.files, bytes: stats.bytes,
            ms: stats.ms, failed: stats.failedCount,
          });
          send({ t: "done", id: entry.id, stats });
        } catch (e) {
          Object.assign(entry, {
            status: "error", error: String(e.message || e).slice(0, 200),
            pages: cloner?.cloned || 0, files: cloner?.files || 0, bytes: cloner?.bytes || 0,
            ms: 0, failed: cloner?.failed.length || 0,
          });
          send({ t: "error", message: entry.error });
        } finally {
          await addHistory(entry);
          try { controller.close(); } catch { /* already closed */ }
        }
      })();
    },
    cancel() {
      cancelled = true;
      if (cloner) cloner.deadline = 0; // stop crawling when the browser disconnects / user clicks Stop
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
