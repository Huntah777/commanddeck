import { test, expect } from '@playwright/test';
import { parseFeed, interleave, fetchShorts, shortsPlaylist, feedPlaylist, cacheKey, onRequestGet, CHANNELS, MAX_SECONDS } from '../functions/api/shorts.js';

/* Shorts — short motivational videos, five minutes at most.

   The feed comes from the speakers' own Shorts-only YouTube feeds
   (functions/api/shorts.js) and plays through the privacy-mode embed. The
   unit tests pin what gets into the feed; the page tests stub /api/shorts
   and the embed itself, which posts the same messages the real player does
   — its length, that it ended, that it can't be embedded here. */

/* ── the feed ─────────────────────────────────────────────────────── */

const entry = ({ id, title = 'A reminder', published = '2026-10-01T10:00:00+00:00', shorts = true }) => `
  <entry>
    <yt:videoId>${id}</yt:videoId>
    <title>${title}</title>
    <link rel="alternate" href="https://www.youtube.com/${shorts ? 'shorts' : 'watch?v='}${shorts ? '/' : ''}${id}"/>
    <published>${published}</published>
  </entry>`;
const feed = (...entries) => `<feed>${entries.join('')}</feed>`;

test.describe('what gets into the feed', () => {
  const CH = { id: 'UCabcdefghijklmnopqrstuv', name: 'Speaker' };

  test('only Shorts — an ordinary upload never slips into a five-minute feed', () => {
    const out = parseFeed(feed(
      entry({ id: 'aaaaaaaaaaa' }),
      entry({ id: 'bbbbbbbbbbb', shorts: false }),   // a full-length talk
    ), CH);
    expect(out.map(v => v.id)).toEqual(['aaaaaaaaaaa']);
    expect(out[0]).toMatchObject({ channel: 'Speaker', title: 'A reminder' });
  });

  test('titles come back readable', () => {
    const [v] = parseFeed(feed(entry({ id: 'aaaaaaaaaaa', title: 'Don&#39;t give up &amp; keep going &quot;now&quot;' })), CH);
    expect(v.title).toBe('Don\'t give up & keep going "now"');
  });

  test('malformed entries are dropped, not guessed at', () => {
    const out = parseFeed(feed(entry({ id: 'short' }), entry({ id: 'aaaaaaaaaaa', title: '' })), CH);
    expect(out).toEqual([]);
  });

  test('a shared channel keeps only its own speaker', () => {
    const masjid = { id: 'UCxxxxxxxxxxxxxxxxxxxxxx', name: 'Mohamad Baajour', titleMatch: /baajour/i };
    const out = parseFeed(feed(
      entry({ id: 'aaaaaaaaaaa', title: 'Ustadh Mohamad Baajour — patience' }),
      entry({ id: 'bbbbbbbbbbb', title: 'Someone else entirely' }),
    ), masjid);
    expect(out.map(v => v.id)).toEqual(['aaaaaaaaaaa']);
  });

  test('a church channel\'s notices are left out', () => {
    const church = CHANNELS.find(c => c.exclude);
    const out = parseFeed(feed(
      entry({ id: 'aaaaaaaaaaa', title: 'Check Your Thinking' }),
      entry({ id: 'bbbbbbbbbbb', title: 'Join Us For Wednesday Night Bible Study' }),
      entry({ id: 'ccccccccccc', title: '2026 JDS Fall Symposium' }),
      entry({ id: 'ddddddddddd', title: 'Unregistered thoughts' }),   // a word containing "register" is fine
    ), church);
    expect(out.map(v => v.id)).toEqual(['aaaaaaaaaaa', 'ddddddddddd']);
  });

  test('Jim Rohn has no Shorts, so his full talks are kept — flagged long', () => {
    const rohn = CHANNELS.find(c => c.name === 'Jim Rohn');
    expect(rohn.full).toBe(true);
    expect(feedPlaylist(rohn)).toBe(`UU${rohn.id.slice(2)}`);
    const out = parseFeed(feed(
      entry({ id: 'aaaaaaaaaaa', title: 'The Art of Exceptional Living', shorts: false }),
      entry({ id: 'bbbbbbbbbbb', title: 'A clip' }),               // a real Short, if one ever appears
    ), rohn);
    expect(out.map(v => [v.id, !!v.long])).toEqual([['aaaaaaaaaaa', true], ['bbbbbbbbbbb', false]]);
  });

  test('a Shorts channel still refuses an ordinary upload', () => {
    const harvey = CHANNELS.find(c => c.name === 'Steve Harvey');
    expect(feedPlaylist(harvey)).toMatch(/^UUSH/);
    expect(parseFeed(feed(entry({ id: 'aaaaaaaaaaa', title: '#motivation', shorts: false })), harvey)).toEqual([]);
  });

  test('Steve Harvey: only the motivation, not the Family Feud and kids clips', () => {
    const harvey = CHANNELS.find(c => c.name === 'Steve Harvey');
    const out = parseFeed(feed(
      entry({ id: 'aaaaaaaaaaa', title: 'Why Giving Up Is NOT an Option! #motivation #steveharvey #shorts' }),
      entry({ id: 'bbbbbbbbbbb', title: 'Kids Guess 80s Tech! #steveharvey #kids #shorts' }),
    ), harvey);
    expect(out.map(v => v.id)).toEqual(['aaaaaaaaaaa']);
  });

  test('the channels are motivational ones, each listed once by id', () => {
    const names = CHANNELS.map(c => c.name).join(' ');
    for (const n of ['Motiversity', 'T.D. Jakes', 'Mel Robbins', 'Steve Harvey', 'Jim Rohn']) expect(names).toContain(n);
    expect(names).not.toMatch(/Menk|Suleiman|Yaqeen/);
    expect(new Set(CHANNELS.map(c => c.id)).size).toBe(CHANNELS.length);
    for (const c of CHANNELS) expect(c.id).toMatch(/^UC[\w-]{22}$/);
  });

  test('reads each channel\'s Shorts-only playlist', () => {
    expect(shortsPlaylist('UCNB_OaI4524fASt8h0IL8dw')).toBe('UUSHNB_OaI4524fASt8h0IL8dw');
  });

  test('newest first, a round at a time, so one prolific channel can\'t fill it', () => {
    const a = [{ id: 'a1', published: '2026-10-05' }, { id: 'a2', published: '2026-10-04' }, { id: 'a3', published: '2026-10-03' }];
    const b = [{ id: 'b1', published: '2026-09-01' }];
    expect(interleave([a, b]).map(v => v.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  test('the same video from two feeds appears once', () => {
    const v = { id: 'dup', published: '2026-10-05' };
    expect(interleave([[v], [{ ...v }]]).map(x => x.id)).toEqual(['dup']);
  });

  test('every channel is asked, and one failing costs only that channel', async () => {
    const asked = [];
    const out = await fetchShorts(async (url) => {
      asked.push(url);
      if (url.includes(feedPlaylist(CHANNELS[0]))) throw new Error('down');
      const n = CHANNELS.findIndex(c => url.includes(feedPlaylist(c)));
      // Tagged, so a shared channel's titleMatch keeps it too.
      return new Response(feed(entry({ id: `vid${n}`.padEnd(11, 'x'), title: `${CHANNELS[n].name} on patience #motivation` })), { status: 200 });
    });
    expect(asked).toHaveLength(CHANNELS.length);
    /* Shorts-only playlists — except a speaker with no Shorts, whose uploads are read. */
    for (const c of CHANNELS) {
      expect(asked.some(u => u.includes(`playlist_id=${c.full ? 'UU' + c.id.slice(2) : 'UUSH' + c.id.slice(2)}`))).toBe(true);
    }
    expect(out.length).toBe(CHANNELS.length - 1);
  });

  test('the cache key is the channel list, so changing channels reaches people straight away', () => {
    const key = cacheKey('https://deck.example');
    for (const c of CHANNELS) expect(key).toContain(c.id);
    expect(key.startsWith('https://deck.example/api/shorts?')).toBe(true);
  });

  test('the edge copy is reused, ?refresh rebuilds it, and the browser is told not to keep one', async () => {
    /* A stand-in for the Workers edge cache and for YouTube. */
    const store = new Map();
    const realCaches = globalThis.caches, realFetch = globalThis.fetch;
    globalThis.caches = { default: {
      match: async (k) => store.get(k.url)?.clone(),
      put:   async (k, r) => { store.set(k.url, r); },
    } };
    let fetches = 0;
    globalThis.fetch = async (url) => {
      fetches++;
      const n = CHANNELS.findIndex(c => String(url).includes(feedPlaylist(c)));
      return new Response(feed(entry({ id: `vid${n}`.padEnd(11, 'x'), title: `${CHANNELS[n].name} on grit #motivation` })), { status: 200 });
    };
    const waits = [];
    const ctx = (path) => ({ request: new Request(`https://deck.example${path}`), waitUntil: (p) => waits.push(p) });
    try {
      const first = await onRequestGet(ctx('/api/shorts'));
      await Promise.all(waits);
      expect(first.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=1800');
      const afterFirst = fetches;

      await onRequestGet(ctx('/api/shorts'));                 // served from the edge copy
      expect(fetches).toBe(afterFirst);

      await onRequestGet(ctx('/api/shorts?refresh=1'));       // goes back to the channels
      expect(fetches).toBe(afterFirst * 2);
    } finally {
      globalThis.caches = realCaches; globalThis.fetch = realFetch;
    }
  });

  test('the promise is five minutes', () => {
    expect(MAX_SECONDS).toBe(300);
  });
});

/* ── the page ─────────────────────────────────────────────────────── */

/* Ids double as instructions to the stubbed player below. */
const V = {
  first:  'FIRSTaaaaaa',
  second: 'SECONDbbbbb',
  third:  'THIRDcccccc',
  long:   'LONGddddddd',   // reports 10 minutes
  locked: 'LOCKEDeeeee',   // the channel doesn't allow embedding
  ends:   'ENDSfffffff',   // finishes straight away
  talk:   'PARTSggggggg',  // a 12-minute talk: three five-minute parts
};
const short = (id, title = `Short ${id}`) => ({ id, title, channel: 'Speaker', published: '2026-10-01' });

/* A stand-in for YouTube's embed: same origin, and it speaks the player's
   postMessage protocol for the cases under test. */
const PLAYER = `<!doctype html><html><body style="background:#111"><script>
  const id = location.pathname.split('/').pop();
  const say = (m) => parent.postMessage(JSON.stringify(m), '*');
  window.addEventListener('message', () => {});
  setTimeout(() => {
    if (id.startsWith('PARTS'))  say({ event: 'infoDelivery', info: { duration: 720 } });
    else if (id.startsWith('LONG'))   say({ event: 'infoDelivery', info: { duration: 600 } });
    else if (id.startsWith('LOCKED')) say({ event: 'onError', info: 150 });
    else if (id.startsWith('ENDS'))   { say({ event: 'infoDelivery', info: { duration: 40 } }); say({ event: 'onStateChange', info: 0 }); }
    else say({ event: 'infoDelivery', info: { duration: 45, playerState: 1 } });
  }, 150);
</script></body></html>`;

test.use({ serviceWorkers: 'block' });   // routes must see the requests

async function boot(page, { shorts = [short(V.first), short(V.second), short(V.third)], status = 200 } = {}) {
  const api = { calls: 0, status, shorts, urls: [] };
  await page.route(u => new URL(u).pathname === '/api/shorts', route => {
    api.calls++;
    api.urls.push(route.request().url());
    return api.status === 200
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shorts: api.shorts }) })
      : route.fulfill({ status: api.status, body: 'nope' });
  });
  await page.route('https://www.youtube-nocookie.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PLAYER }));
  await page.route('https://i.ytimg.com/**', route => route.fulfill({ status: 404, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('madinah_v1', JSON.stringify({ habits: [], tasks: [], blocks: [], logs: {}, ui: { view: 'shorts' } }));
    localStorage.setItem('madinah_ui_local_v1', JSON.stringify({ view: 'shorts' }));
  });
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  return api;
}

const player  = (page) => page.getByTestId('short-player');
const playing = async (page) => (await player(page).getAttribute('src'))?.match(/\/embed\/([\w-]+)\?/)?.[1];

test.describe('the Motivation tab', () => {
  test('is in the navigation', async ({ page }) => {
    await boot(page);
    const select = page.getByLabel('Section');
    if (await select.isVisible()) await expect(select.locator('option', { hasText: 'Motivation' })).toHaveCount(1);
    else await expect(page.locator('nav button').filter({ hasText: /^Motivation$/ })).toBeVisible();
  });

  test('plays the first short — with sound from the start, and capped at five minutes', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('short')).toHaveCount(3);
    await expect(player(page)).toHaveCount(1);              // one player, however long the feed
    expect(await playing(page)).toBe(V.first);
    const src = await player(page).getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/');
    expect(src).toContain('mute=0');
    expect(src).toContain('end=300');
    await expect(page.getByRole('button', { name: 'Tap for sound' })).toHaveCount(0);
  });

  test('muting and unmuting never reload the player', async ({ page }) => {
    await boot(page);
    const before = await player(page).getAttribute('src');
    await page.getByRole('button', { name: 'Mute' }).click();
    await expect(page.getByRole('button', { name: 'Turn sound on' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Turn sound on' }).first().click();
    await expect(page.getByRole('button', { name: 'Mute' })).toBeVisible();
    expect(await player(page).getAttribute('src')).toBe(before);
  });

  test('Next moves to the next short, and only that one plays', async ({ page }) => {
    await boot(page);
    await expect.poll(() => playing(page)).toBe(V.first);
    await page.getByTestId('short').first().getByRole('button', { name: 'Next short' }).click();
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
    await expect(player(page)).toHaveCount(1);
  });

  test('so do the arrow keys', async ({ page }) => {
    await boot(page);
    await expect.poll(() => playing(page)).toBe(V.first);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.first);
  });

  test('anything over five minutes is dropped from the feed', async ({ page }) => {
    await boot(page, { shorts: [short(V.long, 'A long talk'), short(V.second)] });
    await expect(page.locator(`[data-testid="short"][data-id="${V.long}"]`)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
  });

  test('a long video from a speaker with no Shorts plays in five-minute parts', async ({ page }) => {
    await boot(page, { shorts: [{ ...short(V.talk, 'The Art of Exceptional Living'), long: true }, short(V.second)] });
    await expect.poll(() => playing(page)).toBe(V.talk);
    const src = () => player(page).getAttribute('src');
    expect(await src()).toMatch(/start=0&end=300/);
    await expect(page.getByTestId('short-part')).toHaveText(/Part 1 of 3 · 5 min/);   // 720s → 3 parts

    await page.getByRole('button', { name: 'Next part' }).click();
    await expect.poll(src).toMatch(/start=300&end=600/);
    await expect(page.getByTestId('short-part')).toHaveText(/Part 2 of 3/);
    await page.getByRole('button', { name: 'Next part' }).click();
    await expect.poll(src).toMatch(/start=600&end=900/);
    await expect(page.getByRole('button', { name: 'Next part' })).toHaveCount(0);      // the last part
    expect(await playing(page)).toBe(V.talk);                                           // never dropped as "too long"
    await expect(page.getByTestId('short').filter({ has: page.locator('[data-testid="short-player"]') })).toHaveCount(1);
  });

  test('fills the whole screen, over the header', async ({ page }) => {
    await boot(page);
    const vp = page.viewportSize();
    const box = await page.getByTestId('shorts').boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0 });
    expect(Math.round(box.width)).toBe(vp.width);
    expect(Math.round(box.height)).toBe(vp.height);
    /* The app's own header is underneath, not beside it. */
    const top = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, 4)?.closest('[data-testid="shorts"]') != null);
    expect(top).toBe(true);
    /* The page behind can't scroll out from under it. */
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  });

  test('a Short is a portrait column — the player is as tall as the screen', async ({ page }) => {
    await boot(page);
    const vp = page.viewportSize();
    const p = await player(page).boundingBox();
    expect(Math.round(p.height)).toBe(vp.height);
    expect(p.width).toBeLessThanOrEqual(Math.ceil(vp.height * 9 / 16) + 1);
    expect(p.width).toBeLessThanOrEqual(vp.width);
  });

  test('on-screen up and down buttons move through the feed (the player eats swipes)', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('short-position')).toHaveText('1 / 3');
    await expect(page.getByRole('button', { name: 'Previous short' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next short' }).click();
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
    await expect(page.getByTestId('short-position')).toHaveText('2 / 3');
    await page.getByRole('button', { name: 'Previous short' }).click();
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.first);
  });

  test('the back button (and Escape) leave for the app', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Back to Command Deck' }).click();
    await expect(page.getByTestId('shorts')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('madinah_v1'));
      s.ui.view = 'shorts'; localStorage.setItem('madinah_v1', JSON.stringify(s));
    });
    await page.reload();
    await expect(page.getByTestId('shorts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shorts')).toHaveCount(0);
  });

  test('a short has no parts', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('short-part')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next part' })).toHaveCount(0);
    expect(await player(page).getAttribute('src')).toMatch(/start=0&end=300/);
  });

  test('so is one whose channel does not allow it to be embedded', async ({ page }) => {
    await boot(page, { shorts: [short(V.locked), short(V.second)] });
    await expect(page.locator(`[data-testid="short"][data-id="${V.locked}"]`)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
  });

  test('when one ends, the next starts after a short countdown', async ({ page }) => {
    await boot(page, { shorts: [short(V.ends), short(V.second)] });
    await expect(page.getByTestId('short-ended')).toContainText('Next in');
    await expect.poll(() => playing(page), { timeout: 10_000 }).toBe(V.second);
  });

  test('"Stay here" holds the countdown', async ({ page }) => {
    await boot(page, { shorts: [short(V.ends), short(V.second)] });
    await page.getByRole('button', { name: 'Stay here' }).click();
    await page.waitForTimeout(4_000);
    expect(await playing(page)).toBe(V.ends);
  });

  test('a message from anything but its own player is ignored', async ({ page }) => {
    await boot(page);
    await expect.poll(() => playing(page)).toBe(V.first);
    // Same shape, wrong sender: the page itself claiming the video is an hour long.
    await page.evaluate(() => window.postMessage(JSON.stringify({ event: 'infoDelivery', info: { duration: 3600 } }), '*'));
    await page.waitForTimeout(500);
    await expect(page.getByTestId('short')).toHaveCount(3);
    expect(await playing(page)).toBe(V.first);
  });

  test('a failed load says so, and trying again recovers', async ({ page }) => {
    const api = await boot(page, { status: 502 });
    await expect(page.getByTestId('shorts-error')).toContainText('Couldn’t load the videos');
    api.status = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('short')).toHaveCount(3);
  });

  test('the refresh button rebuilds the feed from the channels', async ({ page }) => {
    const api = await boot(page);
    await expect(page.getByTestId('short')).toHaveCount(3);
    expect(api.urls.at(-1)).not.toContain('refresh');

    api.shorts = [short(V.second, 'A brand new one')];
    await page.getByTestId('shorts-refresh').click();
    await expect(page.getByTestId('short')).toHaveCount(1);
    await expect(page.getByTestId('short')).toHaveAttribute('aria-label', 'A brand new one');
    expect(api.urls.at(-1)).toContain('/api/shorts?refresh=1');
  });

  test('an empty feed is not shown as a blank screen', async ({ page }) => {
    await boot(page, { shorts: [] });
    await expect(page.getByTestId('shorts-error')).toContainText('Nothing to show');
  });
});
