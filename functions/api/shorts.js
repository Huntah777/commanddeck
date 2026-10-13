/* ============================================================
   Madinah · Command Deck — /api/shorts
   ------------------------------------------------------------
   GET /api/shorts → the latest short motivational videos, newest first.

   Same approach as For The Ummah's short lectures (fortheummah/shared/
   lectures.ts): YouTube's public per-channel feeds, no API key, videos
   embedded rather than re-hosted, so the speakers' own channels keep the
   views. The difference is the length. This reads each channel's
   SHORTS-ONLY uploads playlist (the channel id with UC → UUSH), so every
   entry is a YouTube Short — three minutes at most — and the page skips
   anything the player reports as longer than MAX_SECONDS anyway.

   Public data, no credentials, so no SYNC_TOKEN. Cached at the edge for
   30 minutes so YouTube's feeds are fetched rarely.
   ============================================================ */

/* Channel ids, not handles: a handle can point at a look-alike channel.
   These are the ones For The Ummah checked against YouTube's verified
   badge. `titleMatch` is for a shared channel (a masjid's): keep only that
   speaker's videos. Add or remove channels here. */
export const CHANNELS = [
  { id: 'UCNB_OaI4524fASt8h0IL8dw', name: 'Mufti Menk' },
  { id: 'UCtm8rtofLSnaIBi3noB0INg', name: 'Omar Suleiman' },
  { id: 'UC34dxKHa9n9ggxz4m7bztfA', name: 'Belal Assaad' },
  { id: 'UC3vHW2h22WE-pNi5WJtRIjg', name: 'Yaqeen Institute' },
  { id: 'UCWsdcrre0WbCWML_PnuzoAg', name: 'Assim al-Hakeem' },
  { id: 'UCa9qP2KdOiWsBzWe6YD2ILw', name: 'Mohamad Baajour', titleMatch: /baajour/i },
];

/* Five minutes. Shorts are capped well under this; it is the promise the
   section makes, enforced again by the page once a video reports its length. */
export const MAX_SECONDS = 300;

const TTL = 1800;

/* A channel's uploads playlist is UU + the channel id without its UC; the
   Shorts-only one is UUSH. */
export const shortsPlaylist = (channelId) => `UUSH${channelId.slice(2)}`;

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/* One feed → [{ id, title, channel, published }]. Anything that is not a
   /shorts/ link is dropped: if YouTube ever answers the Shorts playlist with
   ordinary uploads, a forty-minute talk must not slip into a five-minute feed. */
export function parseFeed(xml, ch) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id        = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1];
    const title     = /<title>([^<]*)<\/title>/.exec(e)?.[1];
    const published = /<published>([^<]+)<\/published>/.exec(e)?.[1] || '';
    const link      = /<link rel="alternate" href="([^"]+)"/.exec(e)?.[1] || '';
    if (!id || !/^[\w-]{11}$/.test(id) || !title) continue;
    if (!link.includes('/shorts/')) continue;
    if (ch.titleMatch && !ch.titleMatch.test(decode(title))) continue;
    out.push({ id, title: decode(title), channel: ch.name, published });
  }
  return out;
}

/* Newest first, a round at a time across channels, so one prolific channel
   can't fill the whole feed. */
export function interleave(lists) {
  const sorted = lists.map(l => [...l].sort((a, b) => b.published.localeCompare(a.published)));
  const out = [], seen = new Set();
  for (let i = 0; sorted.some(l => i < l.length); i++) {
    const round = sorted.map(l => l[i]).filter(Boolean).sort((a, b) => b.published.localeCompare(a.published));
    for (const v of round) if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  return out;
}

/* One channel failing (renamed, rate-limited, gone) costs that channel, not the feed. */
export async function fetchShorts(fetchFn = fetch) {
  const lists = await Promise.all(CHANNELS.map(async (ch) => {
    try {
      const r = await fetchFn(`https://www.youtube.com/feeds/videos.xml?playlist_id=${shortsPlaylist(ch.id)}`);
      return r.ok ? parseFeed(await r.text(), ch) : [];
    } catch { return []; }
  }));
  return interleave(lists);
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL('/api/shorts', request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const shorts = await fetchShorts();
  const res = new Response(JSON.stringify({ shorts, maxSeconds: MAX_SECONDS, fetchedAt: Date.now() }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${TTL}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
  /* An empty result is an outage, not an answer worth keeping for half an hour. */
  if (shorts.length) waitUntil(cache.put(key, res.clone()));
  return res;
}
