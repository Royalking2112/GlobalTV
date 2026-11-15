import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureData } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    await ensureData();
    const [countryRows, categoryRows, totals, last] = await Promise.all([
      db.execute(sql`
        select c.code, c.name, c.flag, count(ch.id)::int as count
        from countries c join channels ch on ch.country = c.code
        group by c.code, c.name, c.flag
        order by c.name`),
      db.execute(sql`
        select cat.id, cat.name, count(*)::int as count
        from channels ch, jsonb_array_elements_text(ch.categories) as x(cid)
        join categories cat on cat.id = x.cid
        group by cat.id, cat.name
        order by count(*) desc`),
      db.execute(sql`
        select count(*)::int as total,
          count(*) filter (where quality >= 720)::int as hd,
          count(*) filter (where quality >= 1080)::int as fhd,
          count(*) filter (where quality >= 2160)::int as uhd
        from channels`),
      db.execute(sql`select value from sync_meta where key = 'lastSync'`),
    ]);
    return Response.json({
      countries: countryRows.rows,
      categories: categoryRows.rows,
      totals: totals.rows[0],
      lastSync: (last.rows[0] as { value?: string } | undefined)?.value ?? null,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
