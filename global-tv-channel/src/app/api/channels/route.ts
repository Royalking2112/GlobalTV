import { db } from "@/db";
import { channels } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { ensureData } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    await ensureData();
    const sp = new URL(req.url).searchParams;
    const country = sp.get("country");
    const category = sp.get("category");
    const q = sp.get("q")?.trim();
    const minQuality = parseInt(sp.get("quality") ?? "0", 10) || 0;
    const sort = sp.get("sort") ?? "quality";
    const ids = sp.get("ids")?.split(",").filter(Boolean).slice(0, 200);
    const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "60", 10) || 60, 1), 200);
    const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);

    const conds: SQL[] = [];
    if (ids && ids.length) conds.push(inArray(channels.id, ids));
    if (country) conds.push(eq(channels.country, country.toUpperCase()));
    if (category) conds.push(sql`${channels.categories} @> ${JSON.stringify([category])}::jsonb`);
    if (minQuality > 0) conds.push(gte(channels.quality, minQuality));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(channels.name, like), ilike(channels.network, like))!);
    }
    const where = conds.length ? and(...conds) : undefined;

    const order =
      sort === "name"
        ? [asc(channels.name)]
        : [desc(channels.quality), asc(channels.name)];

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(channels)
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(channels).where(where),
    ]);

    return Response.json({ total, items: rows });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
