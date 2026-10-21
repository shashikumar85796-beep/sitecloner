import { clearHistory, listHistory, persistent } from "../../../lib/store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const items = await listHistory();
  return Response.json({ persistent, items }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await clearHistory();
  return Response.json({ ok: true });
}
