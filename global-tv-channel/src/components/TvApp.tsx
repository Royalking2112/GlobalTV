"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Player, { qualityLabel, type ChannelItem } from "./Player";

type Country = { code: string; name: string; flag: string; count: number };
type Category = { id: string; name: string; count: number };
type Meta = {
  countries: Country[];
  categories: Category[];
  totals: { total: number; hd: number; fhd: number; uhd: number };
  lastSync: string | null;
};

type View = "all" | "favorites" | "recent";
const PAGE = 60;

function useLocalIds(key: string) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      setIds(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {}
  }, [key]);
  const save = useCallback(
    (next: string[]) => {
      setIds(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    },
    [key],
  );
  return [ids, save] as const;
}

function Logo({ ch, size = "md" }: { ch: ChannelItem; size?: "md" }) {
  const [bad, setBad] = useState(false);
  void size;
  if (!ch.logo || bad) {
    return (
      <span className="text-2xl font-black tracking-tight text-zinc-400">
        {ch.name
          .replace(/[^\p{L}\p{N} ]/gu, "")
          .split(" ")
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={ch.logo}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBad(true)}
      className="max-h-full max-w-full object-contain"
    />
  );
}

export default function TvApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [view, setView] = useState<View>("all");
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [quality, setQuality] = useState(0);
  const [sort, setSort] = useState<"quality" | "name">("quality");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [drawer, setDrawer] = useState(false);

  const [items, setItems] = useState<ChannelItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [current, setCurrent] = useState<ChannelItem | null>(null);
  const [favs, saveFavs] = useLocalIds("gtv:favs");
  const [recent, saveRecent] = useLocalIds("gtv:recent");

  const playerRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // Load meta (first run may need to index the worldwide catalog)
  useEffect(() => {
    fetch("/api/meta")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Failed to load");
        setMeta(j);
      })
      .catch((e) => setMetaError((e as Error).message));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const countryMap = useMemo(() => {
    const m = new Map<string, Country>();
    meta?.countries.forEach((c) => m.set(c.code, c));
    return m;
  }, [meta]);

  const buildQuery = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
      if (view === "favorites") p.set("ids", favs.length ? favs.join(",") : "none");
      if (view === "recent") p.set("ids", recent.length ? recent.join(",") : "none");
      if (country) p.set("country", country);
      if (category) p.set("category", category);
      if (quality) p.set("quality", String(quality));
      if (debounced) p.set("q", debounced);
      return p.toString();
    },
    [view, favs, recent, country, category, quality, debounced, sort],
  );

  // Reset list when filters change (not when favorites/recents change in the "all" view)
  const filterKey = [
    view,
    view === "favorites" ? favs.join(",") : "",
    country,
    category,
    quality,
    debounced,
    sort,
  ].join("|");
  const latest = useRef({ buildQuery, view, recent });
  latest.current = { buildQuery, view, recent };
  useEffect(() => {
    if (!meta) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/channels?${latest.current.buildQuery(0)}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        let list: ChannelItem[] = j.items ?? [];
        const { view: v, recent: rec } = latest.current;
        if (v === "recent") list = [...list].sort((a, b) => rec.indexOf(a.id) - rec.indexOf(b.id));
        setItems(list);
        setTotal(j.total ?? 0);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setLoading(false);
      });
    return () => ctrl.abort();
  }, [filterKey, meta]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    fetch(`/api/channels?${buildQuery(items.length)}`)
      .then((r) => r.json())
      .then((j) => {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...(j.items as ChannelItem[]).filter((x) => !seen.has(x.id))];
        });
      })
      .finally(() => setLoadingMore(false));
  }, [loading, loadingMore, items.length, total, buildQuery]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const play = (ch: ChannelItem) => {
    setCurrent(ch);
    saveRecent([ch.id, ...recent.filter((x) => x !== ch.id)].slice(0, 40));
    setTimeout(() => playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const toggleFav = (id: string) => saveFavs(favs.includes(id) ? favs.filter((x) => x !== id) : [id, ...favs]);

  const filteredCountries = useMemo(() => {
    const q = countryFilter.trim().toLowerCase();
    const list = meta?.countries ?? [];
    return q ? list.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q) : list;
  }, [meta, countryFilter]);

  const clearAll = () => {
    setCountry("");
    setCategory("");
    setQuality(0);
    setSearch("");
    setView("all");
  };

  const activeCountry = country ? countryMap.get(country) : null;
  const title =
    view === "favorites"
      ? "Your favorites"
      : view === "recent"
        ? "Recently watched"
        : activeCountry
          ? `${activeCountry.flag} ${activeCountry.name}`
          : "All channels worldwide";

  if (metaError) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-950 p-6 text-center text-white">
        <div>
          <p className="text-lg font-semibold">Couldn’t load the channel catalog</p>
          <p className="mt-1 text-sm text-zinc-400">{metaError}</p>
          <button onClick={() => location.reload()} className="mt-4 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-950 p-6 text-center text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-rose-500" />
          <div>
            <p className="text-lg font-semibold">Tuning in to the world…</p>
            <p className="mt-1 text-sm text-zinc-400">Indexing live channels from every country. The first launch can take up to a minute.</p>
          </div>
        </div>
      </div>
    );
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 pb-10">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Library</h3>
        <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-white/5 p-1">
          {(
            [
              ["all", "All"],
              ["favorites", `♥ ${favs.length}`],
              ["recent", "Recent"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-lg px-2 py-1.5 text-sm transition ${
                view === v ? "bg-rose-600 font-medium text-white" : "text-zinc-300 hover:bg-white/10"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Quality</h3>
        <div className="flex flex-wrap gap-1.5">
          {[
            [0, "Any", meta.totals.total],
            [720, "HD 720p+", meta.totals.hd],
            [1080, "Full HD", meta.totals.fhd],
            [2160, "4K", meta.totals.uhd],
          ].map(([v, label, n]) => (
            <button
              key={v as number}
              onClick={() => setQuality(v as number)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                quality === v
                  ? "border-rose-500 bg-rose-600 text-white"
                  : "border-white/10 text-zinc-300 hover:border-white/30"
              }`}
            >
              {label} <span className="opacity-60">{n}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Categories</h3>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCategory("")}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              !category ? "border-rose-500 bg-rose-600 text-white" : "border-white/10 text-zinc-300 hover:border-white/30"
            }`}
          >
            All
          </button>
          {meta.categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(category === c.id ? "" : c.id)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                category === c.id ? "border-rose-500 bg-rose-600 text-white" : "border-white/10 text-zinc-300 hover:border-white/30"
              }`}
            >
              {c.name} <span className="opacity-60">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Countries &amp; regions <span className="font-normal">({meta.countries.length})</span>
        </h3>
        <input
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          placeholder="Find a country…"
          className="mb-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-rose-500"
        />
        <ul className="max-h-[420px] space-y-0.5 overflow-y-auto pr-1">
          <li>
            <button
              onClick={() => {
                setCountry("");
                setView("all");
                setDrawer(false);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                !country ? "bg-white/10 text-white" : "text-zinc-300 hover:bg-white/5"
              }`}
            >
              <span>🌍</span>
              <span className="flex-1">Worldwide</span>
              <span className="text-xs text-zinc-500">{meta.totals.total}</span>
            </button>
          </li>
          {filteredCountries.map((c) => (
            <li key={c.code}>
              <button
                onClick={() => {
                  setCountry(c.code);
                  setView("all");
                  setDrawer(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                  country === c.code ? "bg-white/10 text-white" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span>{c.flag}</span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-zinc-500">{c.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

  const hasFilters = country || category || quality || debounced || view !== "all";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-4 py-3">
          <button
            onClick={() => setDrawer(true)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm lg:hidden"
            aria-label="Open filters"
          >
            ☰
          </button>
          <button onClick={clearAll} className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 text-lg">📺</span>
            <span className="hidden text-lg font-bold tracking-tight sm:block">
              Globe<span className="text-rose-500">TV</span>
            </span>
          </button>
          <div className="relative mx-auto w-full max-w-xl">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${meta.totals.total.toLocaleString()} live channels…`}
              className="w-full rounded-full border border-white/10 bg-white/5 py-2 pl-4 pr-10 text-sm outline-none placeholder:text-zinc-500 focus:border-rose-500"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white">
                ✕
              </button>
            )}
          </div>
          <div className="hidden text-right text-xs text-zinc-500 xl:block">
            <div>
              {meta.countries.length} countries · {meta.totals.hd.toLocaleString()} HD
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1800px]">
        <aside className="sticky top-[61px] hidden h-[calc(100vh-61px)] w-80 shrink-0 border-r border-white/10 lg:block">{sidebar}</aside>

        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/70" onClick={() => setDrawer(false)} />
            <div className="absolute inset-y-0 left-0 w-[88%] max-w-sm bg-zinc-950 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <span className="font-semibold">Browse &amp; filter</span>
                <button onClick={() => setDrawer(false)} className="rounded-lg bg-white/10 px-3 py-1 text-sm">
                  Done
                </button>
              </div>
              <div className="h-[calc(100%-53px)]">{sidebar}</div>
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          {current && (
            <div ref={playerRef} className="mb-6 scroll-mt-20">
              <Player
                channel={current}
                flag={countryMap.get(current.country)?.flag ?? "🏳️"}
                countryName={countryMap.get(current.country)?.name ?? current.country}
                fav={favs.includes(current.id)}
                onFav={() => toggleFav(current.id)}
                onClose={() => setCurrent(null)}
              />
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
              <p className="text-sm text-zinc-400">
                {loading ? "Loading…" : `${total.toLocaleString()} channel${total === 1 ? "" : "s"}`}
                {category && ` · ${meta.categories.find((c) => c.id === category)?.name}`}
                {quality > 0 && ` · ${qualityLabel(quality)}+`}
                {debounced && ` · “${debounced}”`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasFilters && (
                <button onClick={clearAll} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
                  Clear filters
                </button>
              )}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "quality" | "name")}
                className="rounded-lg border border-white/10 bg-zinc-900 px-3 py-1.5 text-sm outline-none"
                aria-label="Sort"
              >
                <option value="quality">Best quality first</option>
                <option value="name">A → Z</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-white/5" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 py-24 text-center">
              <div>
                <p className="text-4xl">📡</p>
                <p className="mt-3 font-medium">No channels found</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {view === "favorites" ? "Tap the heart on a channel to save it here." : "Try a different search or filter."}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {items.map((ch) => {
                const c = countryMap.get(ch.country);
                const ql = qualityLabel(ch.quality);
                const active = current?.id === ch.id;
                return (
                  <div
                    key={ch.id}
                    className={`group relative overflow-hidden rounded-xl border bg-zinc-900 transition hover:-translate-y-0.5 hover:border-rose-500/60 ${
                      active ? "border-rose-500 ring-2 ring-rose-500/40" : "border-white/10"
                    }`}
                  >
                    <button onClick={() => play(ch)} className="block w-full text-left">
                      <div className="relative grid aspect-[16/10] place-items-center bg-gradient-to-br from-zinc-100 to-zinc-300 p-5">
                        <Logo ch={ch} />
                        <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition group-hover:opacity-100">
                          <span className="grid h-12 w-12 place-items-center rounded-full bg-rose-600 text-xl text-white shadow-lg">▶</span>
                        </span>
                        {ql && (
                          <span
                            className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              ql === "4K" ? "bg-amber-400 text-black" : ql === "SD" ? "bg-zinc-700 text-white" : "bg-rose-600 text-white"
                            }`}
                          >
                            {ql}
                          </span>
                        )}
                        {active && (
                          <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                            ● NOW PLAYING
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <p className="truncate text-sm font-medium text-white">{ch.name}</p>
                        <p className="mt-0.5 truncate text-xs text-zinc-400">
                          {c?.flag} {c?.name ?? ch.country}
                          {ch.categories[0] ? ` · ${ch.categories[0]}` : ""}
                        </p>
                      </div>
                    </button>
                    <button
                      onClick={() => toggleFav(ch.id)}
                      aria-label="Toggle favorite"
                      className={`absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-sm backdrop-blur transition ${
                        favs.includes(ch.id) ? "bg-rose-600 text-white" : "bg-black/50 text-white opacity-0 hover:bg-black/70 group-hover:opacity-100"
                      }`}
                    >
                      {favs.includes(ch.id) ? "♥" : "♡"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div ref={sentinel} className="h-10" />
          {loadingMore && <p className="py-4 text-center text-sm text-zinc-500">Loading more…</p>}
          {!loading && items.length > 0 && items.length >= total && (
            <p className="py-6 text-center text-xs text-zinc-600">
              You’ve reached the end · Channel data by iptv-org · Streams are provided by their broadcasters
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
