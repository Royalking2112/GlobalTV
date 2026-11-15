"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type Hls from "hls.js";
import type { StreamSource } from "@/db/schema";

export type ChannelItem = {
  id: string;
  name: string;
  country: string;
  categories: string[];
  network: string | null;
  logo: string | null;
  website: string | null;
  quality: number;
  streams: StreamSource[];
};

type Attempt = { url: string; mode: "direct" | "proxy"; stream: number; quality: number };

function proxyUrl(s: StreamSource) {
  const p = new URLSearchParams({ u: s.url });
  if (s.referrer) p.set("r", s.referrer);
  if (s.userAgent) p.set("a", s.userAgent);
  return `/api/proxy?${p.toString()}`;
}

export function qualityLabel(q: number) {
  if (q >= 2160) return "4K";
  if (q >= 1080) return "FHD";
  if (q >= 720) return "HD";
  if (q > 0) return "SD";
  return "";
}

type Status =
  | { state: "loading"; attempt: number }
  | { state: "playing"; attempt: number }
  | { state: "error" };

export default function Player({
  channel,
  flag,
  countryName,
  fav,
  onFav,
  onClose,
}: {
  channel: ChannelItem;
  flag: string;
  countryName: string;
  fav: boolean;
  onFav: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [startStream, setStartStream] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [status, setStatus] = useState<Status>({ state: "loading", attempt: 0 });
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([]);
  const [level, setLevel] = useState(-1);

  const attempts = useMemo<Attempt[]>(() => {
    const out: Attempt[] = [];
    channel.streams.forEach((s, i) => {
      const needsProxy = !s.url.startsWith("https") || !!s.referrer || !!s.userAgent;
      if (!needsProxy) out.push({ url: s.url, mode: "direct", stream: i, quality: s.quality });
      out.push({ url: proxyUrl(s), mode: "proxy", stream: i, quality: s.quality });
    });
    return out;
  }, [channel]);

  // Reset when channel changes
  useEffect(() => {
    setStartStream(0);
    setRetryKey(0);
  }, [channel.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLevels([]);
    setLevel(-1);

    const teardown = () => {
      if (timer) clearTimeout(timer);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute("src");
      video.load();
    };

    const first = Math.max(
      0,
      attempts.findIndex((a) => a.stream === startStream),
    );

    const run = async (i: number) => {
      if (cancelled) return;
      if (i >= attempts.length) {
        setStatus({ state: "error" });
        return;
      }
      teardown();
      setStatus({ state: "loading", attempt: i });
      const a = attempts[i];
      const next = () => run(i + 1);
      const ok = () => {
        if (timer) clearTimeout(timer);
        if (!cancelled) setStatus({ state: "playing", attempt: i });
      };
      timer = setTimeout(next, 16000);

      const { default: HlsLib } = await import("hls.js");
      if (cancelled) return;

      if (HlsLib.isSupported()) {
        const hls = new HlsLib({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 30,
          capLevelToPlayerSize: false,
          startLevel: -1,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 2,
        });
        hlsRef.current = hls;
        hls.on(HlsLib.Events.MANIFEST_PARSED, (_e, data) => {
          if (cancelled) return;
          setLevels(
            data.levels
              .map((l) => ({ height: l.height, bitrate: l.bitrate }))
              .filter((l) => l.height > 0 || l.bitrate > 0),
          );
          video.play().catch(() => {});
        });
        hls.on(HlsLib.Events.FRAG_BUFFERED, ok);
        hls.on(HlsLib.Events.ERROR, (_e, data) => {
          if (!data.fatal || cancelled) return;
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && !(hls as unknown as { _rec?: boolean })._rec) {
            (hls as unknown as { _rec?: boolean })._rec = true;
            hls.recoverMediaError();
            return;
          }
          next();
        });
        hls.loadSource(a.url);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = a.url;
        video.onloadeddata = ok;
        video.onerror = next;
        video.play().catch(() => {});
      } else {
        setStatus({ state: "error" });
      }
    };

    run(first);
    return () => {
      cancelled = true;
      teardown();
    };
  }, [attempts, startStream, retryKey]);

  const changeLevel = (l: number) => {
    setLevel(l);
    if (hlsRef.current) hlsRef.current.currentLevel = l;
  };

  const activeStream = status.state === "error" ? startStream : attempts[status.attempt]?.stream ?? startStream;
  const activeAttempt = status.state === "error" ? null : attempts[status.attempt];

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/50">
      <div className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          className="h-full w-full bg-black"
          controls
          playsInline
          autoPlay
        />
        {status.state === "loading" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/60">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-rose-500" />
              <p className="text-sm text-zinc-300">
                Connecting to {channel.name}…
                <span className="block text-xs text-zinc-500">
                  source {(attempts[status.attempt]?.stream ?? 0) + 1} of {channel.streams.length}
                  {attempts[status.attempt]?.mode === "proxy" ? " · relay" : ""}
                </span>
              </p>
            </div>
          </div>
        )}
        {status.state === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center">
            <div className="max-w-sm">
              <p className="text-lg font-semibold text-white">This stream is offline right now</p>
              <p className="mt-1 text-sm text-zinc-400">
                All {channel.streams.length} known source{channel.streams.length > 1 ? "s" : ""} failed. It may be geo-blocked or temporarily
                down.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  onClick={() => setRetryKey((k) => k + 1)}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
                >
                  Retry
                </button>
                {channel.website && (
                  <a
                    href={channel.website}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
                  >
                    Official site ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-white p-1">
          {channel.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={channel.logo} alt="" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-lg font-bold text-zinc-700">{channel.name.slice(0, 2)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-white">{channel.name}</h2>
          <p className="truncate text-sm text-zinc-400">
            {flag} {countryName}
            {channel.network ? ` · ${channel.network}` : ""}
            {channel.categories.length ? ` · ${channel.categories.join(", ")}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {status.state === "playing" && (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> LIVE
              {activeAttempt?.quality ? ` · ${activeAttempt.quality}p` : ""}
            </span>
          )}
          {levels.length > 1 && (
            <select
              value={level}
              onChange={(e) => changeLevel(parseInt(e.target.value, 10))}
              className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-sm text-white outline-none"
              aria-label="Video quality"
            >
              <option value={-1}>Auto quality</option>
              {levels
                .map((l, i) => ({ ...l, i }))
                .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)
                .map((l) => (
                  <option key={l.i} value={l.i}>
                    {l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps`}
                  </option>
                ))}
            </select>
          )}
          {channel.streams.length > 1 && (
            <select
              value={activeStream}
              onChange={(e) => setStartStream(parseInt(e.target.value, 10))}
              className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-sm text-white outline-none"
              aria-label="Source"
            >
              {channel.streams.map((s, i) => (
                <option key={i} value={i}>
                  Source {i + 1}
                  {s.quality ? ` (${s.quality}p)` : ""}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={onFav}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              fav ? "bg-rose-600 text-white" : "bg-white/10 text-white hover:bg-white/20"
            }`}
          >
            {fav ? "♥ Saved" : "♡ Save"}
          </button>
          <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20">
            Close
          </button>
        </div>
      </div>
    </section>
  );
}
