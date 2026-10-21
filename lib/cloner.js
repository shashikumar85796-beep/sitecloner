import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { safeFetch } from "./ssrf.js";

const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp"]);
const FONT = new Set(["woff", "woff2", "ttf", "otf", "eot"]);
const MEDIA = new Set(["mp4", "webm", "mp3", "ogg", "wav", "m4a", "mov"]);
const DOWNLOAD = new Set(["pdf", "zip", "rar", "7z", "docx", "xlsx", "pptx", "apk", "csv"]);
const SKIP = /^(data:|javascript:|mailto:|tel:|#|blob:|about:)/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])(.*?)\1/gi;

const CTYPE_EXT = {
  "text/css": "css", "text/javascript": "js", "application/javascript": "js",
  "application/x-javascript": "js", "image/png": "png", "image/jpeg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "font/woff2": "woff2",
  "font/woff": "woff", "application/font-woff": "woff", "application/font-woff2": "woff2",
  "font/ttf": "ttf", "font/otf": "otf", "application/json": "json", "video/mp4": "mp4",
  "audio/mpeg": "mp3", "application/pdf": "pdf",
};

const clean = (s) => s.replace(/[^\w.\-@+() ]+/g, "_").replace(/\s+/g, "_").slice(0, 100);
const hash = (s) => crypto.createHash("md5").update(s).digest("hex").slice(0, 6);
const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};
const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/** Relative path from file `from` to file `to` (both POSIX, relative to the zip root). */
export function rel(from, to) {
  const f = from.split("/").slice(0, -1);
  const t = to.split("/");
  let i = 0;
  while (i < f.length && i < t.length - 1 && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill(".."), ...t.slice(i)].join("/");
}

function decode(buf, ctype = "") {
  const m =
    /charset=([\w-]+)/i.exec(ctype) ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"));
  try {
    return new TextDecoder(m ? m[1] : "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export class Cloner {
  constructor(opts, emit) {
    this.o = {
      depth: 1, maxPages: 25, stripJs: false, external: true, sitemap: false, renderJs: false,
      ...opts,
    };
    this.emit = emit;
    this.start = new URL(this.o.url);
    this.start.hash = "";
    this.host = this.start.host;
    this.pages = new Map();   // page url -> local path
    this.assets = new Map();  // asset url -> Promise<{path} | null>
    this.used = new Set();    // local paths already taken
    this.tasks = new Set();
    this.failed = [];
    this.files = 0;
    this.bytes = 0;
    this.cloned = 0;
    this.truncated = false;
    this.sem = { n: 0, q: [] };
    this.deadline = Date.now() + (Number(process.env.CLONE_MAX_SECONDS) || 270) * 1000;
    this.maxFile = 8 * 1024 * 1024;
    this.maxTotal = (Number(process.env.CLONE_MAX_MB) || 120) * 1024 * 1024;
  }

  // ---------- plumbing ----------
  async limit(fn) {
    while (this.sem.n >= 8) await new Promise((r) => this.sem.q.push(r));
    this.sem.n++;
    try {
      return await fn();
    } finally {
      this.sem.n--;
      const r = this.sem.q.shift();
      if (r) r();
    }
  }

  track(p) {
    const t = p
      .catch((e) => this.failed.push({ url: "(css)", reason: String(e.message || e).slice(0, 80) }))
      .finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  async fetchBuf(url, silent = false) {
    if (Date.now() > this.deadline) {
      this.truncated = true;
      return null;
    }
    return this.limit(async () => {
      const fail = (reason) => {
        if (!silent) this.failed.push({ url, reason });
        return null;
      };
      try {
        const { res, finalUrl } = await safeFetch(url, { timeoutMs: 20000 });
        if (!res.ok) { res.body?.cancel(); return fail(`HTTP ${res.status}`); }
        const len = Number(res.headers.get("content-length") || 0);
        if (len > this.maxFile) { res.body?.cancel(); return fail("file too large (>8MB)"); }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > this.maxFile) return fail("file too large (>8MB)");
        return { buf, ctype: (res.headers.get("content-type") || "").toLowerCase(), finalUrl };
      } catch (e) {
        return fail(String(e.message || e).slice(0, 80));
      }
    });
  }

  emitFile(p, buf) {
    if (this.bytes + buf.length > this.maxTotal) {
      this.truncated = true;
      this.failed.push({ url: p, reason: "total size cap reached" });
      return false;
    }
    this.bytes += buf.length;
    this.files++;
    this.emit({ t: "file", path: p, size: buf.length, b64: buf.toString("base64") });
    return true;
  }

  uniq(p, key) {
    if (!this.used.has(p)) { this.used.add(p); return p; }
    const e = extOf(p);
    const stem = e ? p.slice(0, -(e.length + 1)) : p;
    let c = `${stem}-${hash(key)}${e ? "." + e : ""}`;
    let n = 1;
    while (this.used.has(c)) c = `${stem}-${hash(key)}${n++}${e ? "." + e : ""}`;
    this.used.add(c);
    return c;
  }

  // ---------- local path layout (css/ js/ images/ fonts/ media/ assets/ + pages) ----------
  pagePath(url) {
    if (this.pages.has(url)) return this.pages.get(url);
    const u = new URL(url);
    const p = safeDecode(u.pathname);
    const segs = p.split("/").filter(Boolean).map(clean);
    if (p.endsWith("/") || segs.length === 0) {
      segs.push("index.html");
    } else {
      const last = segs[segs.length - 1];
      const e = extOf(last);
      if (e === "html" || e === "htm") { /* keep */ }
      else if (e) segs[segs.length - 1] = last.slice(0, -(e.length + 1)) + ".html";
      else segs[segs.length - 1] = last + ".html";
    }
    let out = segs.join("/");
    if (u.search) out = out.replace(/\.html$/, `-${hash(u.search)}.html`);
    out = this.uniq(out, url);
    this.pages.set(url, out);
    return out;
  }

  assetPath(url, ctype, isCss) {
    const u = new URL(url);
    let name = clean(safeDecode(u.pathname.split("/").filter(Boolean).pop() || ""));
    let ext = extOf(name);
    const ct = ctype.split(";")[0].trim();
    if (isCss && ext !== "css") { name = (name || "style") + ".css"; ext = "css"; }
    else if (!ext) {
      const g = CTYPE_EXT[ct] || "";
      name = (name || "file") + (g ? "." + g : "");
      ext = g;
    } else if (!name) name = "file";
    let folder = "assets";
    if (ext === "css") folder = "css";
    else if (ext === "js" || ext === "mjs") folder = "js";
    else if (IMG.has(ext)) folder = "images";
    else if (FONT.has(ext)) folder = "fonts";
    else if (MEDIA.has(ext)) folder = "media";
    return this.uniq(`${folder}/${name}`, url);
  }

  // ---------- assets ----------
  getAsset(url) {
    let p = this.assets.get(url);
    if (!p) {
      p = this.loadAsset(url);
      this.assets.set(url, p);
    }
    return p;
  }

  async loadAsset(url) {
    if (this.o.external === false && new URL(url).host !== this.host) return null;
    const r = await this.fetchBuf(url);
    if (!r) return null;
    const isCss = r.ctype.includes("text/css") || extOf(new URL(url).pathname) === "css";
    const local = this.assetPath(url, r.ctype, isCss);
    if (isCss) {
      // Path is known now, so CSS import cycles cannot deadlock; the body is finished in the background.
      this.track(
        (async () => {
          const css = await this.rewriteCss(decode(r.buf, r.ctype), r.finalUrl || url, local);
          this.emitFile(local, Buffer.from(css, "utf8"));
        })()
      );
    } else {
      this.emitFile(local, r.buf);
    }
    return { path: local };
  }

  async rewriteCss(css, base, cssLocal) {
    const refs = new Set();
    css.replace(CSS_URL, (m, q, ref) => { refs.add(ref.trim()); return m; });
    css.replace(CSS_IMPORT, (m, q, ref) => { refs.add(ref.trim()); return m; });
    const resolved = new Map();
    await Promise.all(
      [...refs].map(async (ref) => {
        if (!ref || SKIP.test(ref)) return;
        let abs;
        try {
          const u = new URL(ref, base);
          if (!/^https?:$/.test(u.protocol)) return;
          u.hash = "";
          abs = u.href;
        } catch { return; }
        const r = await this.getAsset(abs);
        if (r) resolved.set(ref, rel(cssLocal, r.path));
      })
    );
    css = css.replace(CSS_URL, (m, q, ref) => {
      const v = resolved.get(ref.trim());
      return v ? `url(${q}${v}${q})` : m;
    });
    css = css.replace(CSS_IMPORT, (m, q, ref) => {
      const v = resolved.get(ref.trim());
      return v ? `@import ${q}${v}${q}` : m;
    });
    return css;
  }

  // ---------- pages ----------
  async getHtml(url) {
    if (this.o.renderJs && process.env.BROWSERLESS_TOKEN) {
      try {
        const base = process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io";
        const r = await fetch(`${base}/content?token=${encodeURIComponent(process.env.BROWSERLESS_TOKEN)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, gotoOptions: { waitUntil: "networkidle2", timeout: 30000 } }),
          signal: AbortSignal.timeout(60000),
        });
        if (r.ok) return { text: await r.text(), finalUrl: url };
        this.failed.push({ url, reason: `render HTTP ${r.status} (fell back to plain fetch)` });
      } catch (e) {
        this.failed.push({ url, reason: "render: " + String(e.message).slice(0, 60) });
      }
    }
    const r = await this.fetchBuf(url);
    if (!r) return null;
    if (!r.ctype.includes("html") && !r.ctype.includes("xml")) {
      this.failed.push({ url, reason: `not HTML (${r.ctype.split(";")[0] || "unknown"})` });
      return null;
    }
    return { text: decode(r.buf, r.ctype), finalUrl: r.finalUrl };
  }

  async clonePage(url, depth, queue) {
    const got = await this.getHtml(url);
    if (!got) return;
    const finalUrl = got.finalUrl;

    if (depth === 0) {
      // Start URL may redirect (http->https, apex->www). Follow the real host.
      const fu = new URL(finalUrl);
      fu.hash = "";
      this.host = fu.host;
      this.pages.set(fu.href, "index.html");
    }

    const local = this.pagePath(url);
    const $ = cheerio.load(got.text);

    let base = finalUrl;
    const bh = $("base[href]").attr("href");
    try { if (bh) base = new URL(bh, finalUrl).href; } catch { /* ignore */ }
    $("base").remove();
    $("meta[charset]").remove();
    $("meta[http-equiv]").each((_, el) => {
      if (($(el).attr("http-equiv") || "").toLowerCase() === "content-type") $(el).remove();
    });
    $("head").prepend('<meta charset="utf-8">');
    $("[integrity]").removeAttr("integrity");
    $("[crossorigin]").removeAttr("crossorigin");

    if (this.o.stripJs) {
      $("script").remove();
      $('link[rel="modulepreload"]').remove();
    }

    const ops = [];
    const toAbs = (ref) => {
      ref = (ref || "").trim();
      if (!ref || SKIP.test(ref)) return null;
      try {
        const u = new URL(ref, base);
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = "";
        return u.href;
      } catch { return null; }
    };
    const assetOp = (el, attr) => {
      const a = toAbs($(el).attr(attr));
      if (!a) return;
      ops.push(async () => {
        const r = await this.getAsset(a);
        $(el).attr(attr, r ? rel(local, r.path) : a);
      });
    };
    const addAttr = (sel, attr) => $(sel).each((_, el) => assetOp(el, attr));

    addAttr("img[src], source[src], video[src], audio[src], track[src], embed[src]", "src");
    if (!this.o.stripJs) addAttr("script[src]", "src");
    addAttr("video[poster]", "poster");
    addAttr("img[data-src]", "data-src");
    addAttr("img[data-lazy-src]", "data-lazy-src");

    $("link[href]").each((_, el) => {
      const r = ($(el).attr("rel") || "").toLowerCase();
      if (!/(stylesheet|icon|preload|manifest|modulepreload)/.test(r)) return;
      assetOp(el, "href");
    });

    $("img[srcset], source[srcset]").each((_, el) => {
      const v = $(el).attr("srcset");
      ops.push(async () => {
        const out = [];
        for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
          const [u0, ...rest] = part.split(/\s+/);
          const a = toAbs(u0);
          if (!a) { out.push(part); continue; }
          const r = await this.getAsset(a);
          out.push([r ? rel(local, r.path) : a, ...rest].join(" "));
        }
        $(el).attr("srcset", out.join(", "));
      });
    });

    $("style").each((_, el) => {
      const txt = $(el).html();
      if (!txt || !/url\(|@import/i.test(txt)) return;
      ops.push(async () => { $(el).html(await this.rewriteCss(txt, base, local)); });
    });
    $("[style]").each((_, el) => {
      const txt = $(el).attr("style");
      if (!txt || !/url\(/i.test(txt)) return;
      ops.push(async () => { $(el).attr("style", await this.rewriteCss(txt, base, local)); });
    });

    // links: same-site pages become relative local links; everything else stays absolute
    $("a[href], area[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href || SKIP.test(href)) return;
      let u;
      try { u = new URL(href, base); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      const hash = u.hash;
      u.hash = "";
      const abs = u.href;
      if (u.host !== this.host) { $(el).attr("href", abs + hash); return; }
      const ext = extOf(u.pathname.split("/").pop() || "");
      if (DOWNLOAD.has(ext) || IMG.has(ext)) {
        ops.push(async () => {
          const r = await this.getAsset(abs);
          $(el).attr("href", (r ? rel(local, r.path) : abs) + hash);
        });
        return;
      }
      if (!this.pages.has(abs) && depth < this.o.depth && this.pages.size < this.o.maxPages) {
        this.pagePath(abs);
        queue.push({ url: abs, depth: depth + 1 });
      }
      $(el).attr("href", (this.pages.has(abs) ? rel(local, this.pages.get(abs)) : abs) + hash);
    });

    $("form[action]").each((_, el) => {
      const a = toAbs($(el).attr("action"));
      if (a) $(el).attr("action", a);
    });

    await Promise.all(ops.map((f) => f()));
    this.emitFile(local, Buffer.from($.html(), "utf8"));
    this.cloned++;
    this.emit({ t: "page", url, path: local, pages: this.cloned });
  }

  async loadSitemap(queue) {
    const r = await this.fetchBuf(new URL("/sitemap.xml", this.start).href, true);
    if (!r) return;
    const locs = [...decode(r.buf, r.ctype).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    for (const l of locs) {
      if (this.pages.size >= this.o.maxPages) break;
      try {
        const u = new URL(l);
        u.hash = "";
        if (u.host !== this.host || u.pathname.endsWith(".xml")) continue;
        if (!this.pages.has(u.href)) {
          this.pagePath(u.href);
          queue.push({ url: u.href, depth: 1 });
        }
      } catch { /* ignore bad loc */ }
    }
  }

  async run() {
    const t0 = Date.now();
    const startUrl = this.start.href;
    this.used.add("index.html");
    this.pages.set(startUrl, "index.html");
    const queue = [{ url: startUrl, depth: 0 }];
    if (this.o.sitemap) await this.loadSitemap(queue);

    while (queue.length) {
      if (Date.now() > this.deadline) { this.truncated = true; break; }
      const batch = queue.splice(0, 3);
      await Promise.all(batch.map((it) => this.clonePage(it.url, it.depth, queue)));
    }
    while (this.tasks.size) await Promise.all([...this.tasks]);

    const ms = Date.now() - t0;
    this.emitFile(
      "clone-report.json",
      Buffer.from(
        JSON.stringify(
          {
            source: startUrl,
            clonedAt: new Date().toISOString(),
            options: { ...this.o, url: undefined },
            pages: [...this.pages.entries()].map(([u, p]) => ({ url: u, file: p })),
            files: this.files,
            bytes: this.bytes,
            truncated: this.truncated,
            failed: this.failed,
          },
          null,
          2
        )
      )
    );
    this.emitFile(
      "README-DEPLOY.txt",
      Buffer.from(
        [
          `Static copy of ${startUrl}`,
          "",
          "Open index.html in a browser to view it offline.",
          "",
          "Deploy to Vercel:",
          "  1) Install the CLI:  npm i -g vercel",
          "  2) In this folder run:  vercel --prod",
          "",
          "Folders: css/  js/  images/  fonts/  media/  assets/  (pages are .html files / sub-folders)",
          "See clone-report.json for the page map and any files that failed to download.",
          "",
          "Limits: server-side logic, forms, logins and API data are NOT copied - only the front-end.",
        ].join("\n")
      )
    );

    return {
      pages: this.cloned,
      files: this.files,
      bytes: this.bytes,
      ms,
      truncated: this.truncated,
      failedCount: this.failed.length,
      failed: this.failed.slice(0, 50),
    };
  }
}
