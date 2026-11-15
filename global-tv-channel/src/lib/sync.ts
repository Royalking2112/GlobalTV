import { db } from "@/db";
import { categories, channels, countries, syncMeta, type StreamSource } from "@/db/schema";
import { sql } from "drizzle-orm";

const API = "https://iptv-org.github.io/api";

type RawChannel = {
  id: string;
  name: string;
  network: string | null;
  country: string;
  categories: string[];
  is_nsfw: boolean;
  closed: string | null;
  website: string | null;
};
type RawStream = {
  channel: string | null;
  url: string;
  quality: string | null;
  labels?: string[];
  user_agent: string | null;
  referrer: string | null;
};
type RawLogo = {
  channel: string;
  feed: string | null;
  in_use: boolean;
  width: number;
  format: string;
  url: string;
};
type RawCountry = { name: string; code: string; languages: string[]; flag: string };
type RawCategory = { id: string; name: string };

async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${API}/${name}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  return (await res.json()) as T;
}

function parseQuality(q: string | null): number {
  if (!q) return 0;
  const n = parseInt(q, 10);
  return Number.isFinite(n) ? n : 0;
}

let running: Promise<{ channels: number }> | null = null;

export function syncChannels(): Promise<{ channels: number }> {
  if (!running) {
    running = doSync().finally(() => {
      running = null;
    });
  }
  return running;
}

async function doSync() {
  const [rawChannels, rawStreams, rawLogos, rawCountries, rawCategories] = await Promise.all([
    getJson<RawChannel[]>("channels"),
    getJson<RawStream[]>("streams"),
    getJson<RawLogo[]>("logos"),
    getJson<RawCountry[]>("countries"),
    getJson<RawCategory[]>("categories"),
  ]);

  // Streams grouped by channel
  const streamMap = new Map<string, (StreamSource & { geo: boolean })[]>();
  for (const s of rawStreams) {
    if (!s.channel || !/^https?:\/\//i.test(s.url)) continue;
    const list = streamMap.get(s.channel) ?? [];
    if (list.some((x) => x.url === s.url)) continue;
    list.push({
      url: s.url,
      quality: parseQuality(s.quality),
      referrer: s.referrer,
      userAgent: s.user_agent,
      geo: (s.labels ?? []).some((l) => /geo/i.test(l)),
    });
    streamMap.set(s.channel, list);
  }

  // Best logo per channel
  const logoMap = new Map<string, RawLogo>();
  for (const l of rawLogos) {
    if (!l.in_use) continue;
    const score = (x: RawLogo) => (x.feed === null ? 10000 : 0) + (x.format === "PNG" || x.format === "SVG" ? 5000 : 0) + Math.min(x.width, 4000);
    const cur = logoMap.get(l.channel);
    if (!cur || score(l) > score(cur)) logoMap.set(l.channel, l);
  }

  const rows: (typeof channels.$inferInsert)[] = [];
  for (const c of rawChannels) {
    if (c.is_nsfw || c.closed) continue;
    const list = streamMap.get(c.id);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => {
      if (a.geo !== b.geo) return a.geo ? 1 : -1;
      const ah = a.url.startsWith("https") ? 1 : 0;
      const bh = b.url.startsWith("https") ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return b.quality - a.quality;
    });
    const top = list.slice(0, 6).map(({ url, quality, referrer, userAgent }) => ({ url, quality, referrer, userAgent }));
    rows.push({
      id: c.id,
      name: c.name,
      country: c.country,
      categories: c.categories ?? [],
      network: c.network,
      logo: logoMap.get(c.id)?.url ?? null,
      website: c.website,
      quality: Math.max(...top.map((t) => t.quality)),
      streams: top,
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(channels);
    await tx.delete(countries);
    await tx.delete(categories);
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(channels).values(rows.slice(i, i + 500));
    }
    await tx.insert(countries).values(
      rawCountries.map((c) => ({ code: c.code, name: c.name, flag: c.flag, languages: c.languages })),
    );
    await tx.insert(categories).values(rawCategories.map((c) => ({ id: c.id, name: c.name })));
    await tx
      .insert(syncMeta)
      .values({ key: "lastSync", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { value: new Date().toISOString(), updatedAt: sql`now()` },
      });
  });

  return { channels: rows.length };
}

/** Make sure the DB is populated (first run) or refresh when stale (> 24h, in background). */
export async function ensureData() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(channels);
  if (count === 0) {
    await syncChannels();
    return;
  }
  const last = await db.select().from(syncMeta).where(sql`${syncMeta.key} = 'lastSync'`);
  const t = last[0] ? Date.parse(last[0].value) : 0;
  if (Date.now() - t > 24 * 3600 * 1000) {
    syncChannels().catch(() => {});
  }
}
