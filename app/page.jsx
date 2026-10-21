"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zip } from "fflate";

const TEXT_EXT = new Set(["html", "htm", "css", "js", "mjs", "json", "svg", "txt", "xml", "md", "map", "webmanifest"]);
const IMG_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", avif: "image/avif", bmp: "image/bmp",
};
const NO_COMPRESS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "woff", "woff2", "mp4", "webm", "mp3", "zip", "pdf"]);
const LS_KEY = "sitecloner-history";

const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const extOf = (p) => {
  const i = p.lastIndexOf(".");
  return i > 0 ? p.slice(i + 1).toLowerCase() : "";
};
const iconFor = (name) => {
  const e = extOf(name);
  if (e === "html" || e === "htm") return "🌐";
  if (e === "css") return "🎨";
  if (e === "js" || e === "mjs") return "📜";
  if (IMG_MIME[e] || e === "svg") return "🖼️";
  if (["woff", "woff2", "ttf", "otf", "eot"].includes(e)) return "🔤";
  if (["mp4", "webm", "mp3", "ogg"].includes(e)) return "🎞️";
  return "📄";
};

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [], count: 0 };
  for (const [path, bytes] of files) {
    const parts = path.split("/");
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [], count: 0 });
      node = node.dirs.get(parts[i]);
      node.count++;
    }
    node.files.push({ name: parts[parts.length - 1], path, size: bytes.length });
  }
  return root;
}

function Folder({ node, depth, selected, onSelect, forceOpen }) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) =>
    a.name === "index.html" ? -1 : b.name === "index.html" ? 1 : a.name.localeCompare(b.name)
  );
  return (
    <ul className="tree">
      {dirs.map(([name, child]) => (
        <li key={name}>
          <details open={forceOpen || depth < 1}>
            <summary>
              📁 {name}
              <span className="dim">{child.count} files</span>
            </summary>
            <Folder node={child} depth={depth + 1} selected={selected} onSelect={onSelect} forceOpen={forceOpen} />
          </details>
        </li>
      ))}
      {files.map((f) => (
        <li key={f.path}>
          <button className={"file" + (selected === f.path ? " sel" : "")} onClick={() => onSelect(f.path)}>
            <span>{iconFor(f.name)} {f.name}</span>
            <span className="dim">{fmt(f.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Preview({ path, bytes }) {
  const ext = extOf(path);
  const imgUrl = useMemo(
    () => (bytes && IMG_MIME[ext] ? URL.createObjectURL(new Blob([bytes], { type: IMG_MIME[ext] })) : null),
    [path, bytes, ext]
  );
  useEffect(() => () => { if (imgUrl) URL.revokeObjectURL(imgUrl); }, [imgUrl]);

  if (!bytes) return <div className="empty">Select a file to preview it.</div>;
  return (
    <>
      <div className="pathbar">{path} · {fmt(bytes.length)}</div>
      {imgUrl ? (
        <img className="pimg" src={imgUrl} alt={path} />
      ) : TEXT_EXT.has(ext) ? (
        <pre className="code">
          {new TextDecoder().decode(bytes.subarray(0, 200000))}
          {bytes.length > 200000 ? "\n… (preview truncated, full file is in the ZIP)" : ""}
        </pre>
      ) : (
        <p className="dim">Binary file — included in the ZIP.</p>
      )}
    </>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [opts, setOpts] = useState({ depth: 1, maxPages: 25, stripJs: false, external: true, sitemap: false, renderJs: false });
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState({ pages: 0, files: 0, bytes: 0 });
  const [done, setDone] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);
  const [hist, setHist] = useState({ items: [], persistent: true });

  const filesRef = useRef(new Map());
  const ctrlRef = useRef(null);
  const hostRef = useRef("site");
  const timerRef = useRef(null);
  const countersRef = useRef({ pages: 0, files: 0, bytes: 0 });

  const bump = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setStats({ ...countersRef.current });
      setTick((t) => t + 1);
    }, 200);
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/history", { cache: "no-store" });
      const j = await r.json();
      if (j.persistent) return setHist({ items: j.items, persistent: true });
    } catch { /* fall back to local */ }
    try {
      setHist({ items: JSON.parse(localStorage.getItem(LS_KEY) || "[]"), persistent: false });
    } catch {
      setHist({ items: [], persistent: false });
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function start(e) {
    e?.preventDefault();
    if (running || !url.trim()) return;
    setError(""); setDone(null); setSelected(null); setFilter("");
    filesRef.current = new Map();
    countersRef.current = { pages: 0, files: 0, bytes: 0 };
    setStats({ pages: 0, files: 0, bytes: 0 });
    setRunning(true);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      const norm = /^https?:\/\//i.test(url.trim()) ? url.trim() : "https://" + url.trim();
      try { hostRef.current = new URL(norm).host.replace(/[^\w.-]/g, "_"); } catch { hostRef.current = "site"; }

      const res = await fetch("/api/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: norm, confirm, ...opts }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.t === "file") {
          const bytes = b64ToBytes(ev.b64);
          filesRef.current.set(ev.path, bytes);
          countersRef.current.files = filesRef.current.size;
          countersRef.current.bytes += bytes.length;
          bump();
        } else if (ev.t === "page") {
          countersRef.current.pages = ev.pages;
        } else if (ev.t === "done") {
          setDone(ev.stats);
        } else if (ev.t === "error") {
          setError(ev.message);
        }
      };
      for (;;) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) handle(JSON.parse(line));
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message || "Something went wrong");
    } finally {
      setRunning(false);
      setStats({ ...countersRef.current });
      setTick((t) => t + 1);
      // keep a local copy of the log too (used when no database is connected)
      try {
        const local = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
        local.unshift({
          id: String(Date.now()), at: new Date().toISOString(), url, host: hostRef.current,
          pages: countersRef.current.pages, files: countersRef.current.files,
          bytes: countersRef.current.bytes, status: "ok", options: opts,
        });
        localStorage.setItem(LS_KEY, JSON.stringify(local.slice(0, 100)));
      } catch { /* ignore */ }
      loadHistory();
    }
  }

  function stop() { ctrlRef.current?.abort(); }

  function downloadZip() {
    const root = hostRef.current + "/";
    const obj = {};
    for (const [p, b] of filesRef.current) obj[root + p] = [b, { level: NO_COMPRESS.has(extOf(p)) ? 0 : 6 }];
    zip(obj, (err, data) => {
      if (err) return setError("ZIP failed: " + err.message);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
      a.download = `${hostRef.current}-clone-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    });
  }

  async function clearHist() {
    if (!confirmClear()) return;
    try { await fetch("/api/history", { method: "DELETE" }); } catch { /* ignore */ }
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    loadHistory();
  }
  const confirmClear = () => window.confirm("Delete all activity history?");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = [...filesRef.current.entries()];
    return q ? all.filter(([p]) => p.toLowerCase().includes(q)) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, filter]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const hasFiles = filesRef.current.size > 0;

  return (
    <main className="wrap">
      <h1>SiteCloner</h1>
      <p className="sub">Paste a website URL → see the folder structure → download everything as a ZIP.</p>

      <form className="card" onSubmit={start}>
        <div className="row">
          <input className="url" type="text" inputMode="url" placeholder="https://example.com" value={url}
            onChange={(e) => setUrl(e.target.value)} disabled={running} autoFocus />
          {!running ? (
            <button className="btn" type="submit" disabled={!url.trim() || !confirm}>Clone website</button>
          ) : (
            <button className="btn ghost" type="button" onClick={stop}>Stop</button>
          )}
        </div>
        <div className="opts">
          <label>Depth
            <select value={opts.depth} onChange={(e) => setOpts({ ...opts, depth: +e.target.value })} disabled={running}>
              <option value={0}>0 (only this page)</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>Max pages
            <input type="number" min={1} max={100} value={opts.maxPages}
              onChange={(e) => setOpts({ ...opts, maxPages: +e.target.value })} disabled={running} />
          </label>
          <label><input type="checkbox" checked={opts.external} onChange={(e) => setOpts({ ...opts, external: e.target.checked })} /> Include CDN / external assets</label>
          <label><input type="checkbox" checked={opts.sitemap} onChange={(e) => setOpts({ ...opts, sitemap: e.target.checked })} /> Use sitemap.xml</label>
          <label><input type="checkbox" checked={opts.stripJs} onChange={(e) => setOpts({ ...opts, stripJs: e.target.checked })} /> Remove JavaScript</label>
          <label title="Needs BROWSERLESS_TOKEN on the server"><input type="checkbox" checked={opts.renderJs} onChange={(e) => setOpts({ ...opts, renderJs: e.target.checked })} /> Render JS (React/Next sites)</label>
        </div>
        <label className="consent">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I own this website or have permission to copy it. (This confirmation is saved in the activity log.)</span>
        </label>
      </form>

      {error && <div className="err">{error}</div>}

      {(running || hasFiles) && (
        <section className="card">
          {running && <div className="bar"><i /></div>}
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="chips" style={{ margin: 0 }}>
              <span className="chip">Pages <b>{stats.pages}</b></span>
              <span className="chip">Files <b>{stats.files}</b></span>
              <span className="chip">Size <b>{fmt(stats.bytes)}</b></span>
              {done && <span className="chip">Time <b>{(done.ms / 1000).toFixed(1)}s</b></span>}
              {done && done.failedCount > 0 && <span className="chip">Failed <b className="bad">{done.failedCount}</b></span>}
              {done?.truncated && <span className="chip"><b className="warn">Partial (limit reached)</b></span>}
            </div>
            <div className="row">
              <input type="text" placeholder="Search files…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: "7px 10px" }} />
              <button className="btn" onClick={downloadZip} disabled={!hasFiles}>⬇ Download ZIP</button>
            </div>
          </div>

          <div className="grid">
            <div className="pane">
              {filtered.length ? (
                <Folder node={tree} depth={0} selected={selected} onSelect={setSelected} forceOpen={Boolean(filter.trim())} />
              ) : (
                <div className="empty">{running ? "Fetching files…" : "No files match."}</div>
              )}
            </div>
            <div className="pane">
              <Preview path={selected || ""} bytes={selected ? filesRef.current.get(selected) : null} />
            </div>
          </div>

          {done?.failed?.length > 0 && (
            <details className="fails">
              <summary>{done.failedCount} file(s) could not be downloaded</summary>
              <ul>{done.failed.map((f, i) => <li key={i}>{f.url} — {f.reason}</li>)}</ul>
            </details>
          )}
        </section>
      )}

      <section className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Activity log</h2>
          {hist.items.length > 0 && <button className="btn ghost sm" onClick={clearHist}>Clear</button>}
        </div>
        {!hist.persistent && (
          <div className="note">
            Database not connected — history is saved only in this browser. Add Upstash Redis from the Vercel
            Marketplace to keep a permanent log (see README).
          </div>
        )}
        {hist.items.length === 0 ? (
          <div className="empty">No clones yet.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>When</th><th>Website</th><th>Pages</th><th>Files</th><th>Size</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {hist.items.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.at).toLocaleString()}</td>
                    <td>{h.url}</td>
                    <td>{h.pages ?? "-"}</td>
                    <td>{h.files ?? "-"}</td>
                    <td>{h.bytes != null ? fmt(h.bytes) : "-"}</td>
                    <td className={h.status === "ok" ? "ok" : h.status === "error" ? "bad" : "warn"}>{h.status}</td>
                    <td>
                      <button className="btn ghost sm" onClick={() => { setUrl(h.url); if (h.options) setOpts({ ...opts, ...h.options }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        Re-clone
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
