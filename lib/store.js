// Activity history. Uses Upstash Redis (Vercel Marketplace) via REST when configured,
// otherwise an in-memory list (temporary - resets when the serverless instance restarts).

const KEY = "sitecloner:history";
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const persistent = Boolean(URL_ && TOKEN);

const mem = (globalThis.__scHistory ||= []);

async function cmd(args) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export async function addHistory(entry) {
  try {
    if (persistent) {
      await cmd(["LPUSH", KEY, JSON.stringify(entry)]);
      await cmd(["LTRIM", KEY, "0", "299"]);
    } else {
      mem.unshift(entry);
      mem.length = Math.min(mem.length, 200);
    }
  } catch (e) {
    console.error("history write failed", e);
  }
}

export async function listHistory() {
  try {
    if (persistent) {
      const rows = await cmd(["LRANGE", KEY, "0", "99"]);
      return rows.map((x) => JSON.parse(x));
    }
  } catch (e) {
    console.error("history read failed", e);
  }
  return persistent ? [] : mem.slice(0, 100);
}

export async function clearHistory() {
  if (persistent) await cmd(["DEL", KEY]);
  else mem.length = 0;
}
