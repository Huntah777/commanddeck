import { test, expect } from '@playwright/test';
import { parseFeed, interleave, fetchShorts, shortsPlaylist, CHANNELS, MAX_SECONDS } from '../functions/api/shorts.js';

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

  test('the channels are motivational ones, each listed once by id', () => {
    const names = CHANNELS.map(c => c.name).join(' ');
    for (const n of ['Motiversity', 'T.D. Jakes', 'Mel Robbins']) expect(names).toContain(n);
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
      if (url.includes(shortsPlaylist(CHANNELS[0].id))) throw new Error('down');
      const n = CHANNELS.findIndex(c => url.includes(shortsPlaylist(c.id)));
      // Named after the speaker, so a shared channel's titleMatch keeps it too.
      return new Response(feed(entry({ id: `vid${n}`.padEnd(11, 'x'), title: `${CHANNELS[n].name} on patience` })), { status: 200 });
    });
    expect(asked).toHaveLength(CHANNELS.length);
    expect(asked.every(u => u.includes('playlist_id=UUSH'))).toBe(true);
    expect(out.length).toBe(CHANNELS.length - 1);
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
};
const short = (id, title = `Short ${id}`) => ({ id, title, channel: 'Speaker', published: '2026-10-01' });

/* A stand-in for YouTube's embed: same origin, and it speaks the player's
   postMessage protocol for the cases under test. */
const PLAYER = `<!doctype html><html><body style="background:#111"><script>
  const id = location.pathname.split('/').pop();
  const say = (m) => parent.postMessage(JSON.stringify(m), '*');
  window.addEventListener('message', () => {});
  setTimeout(() => {
    if (id.startsWith('LONG'))   say({ event: 'infoDelivery', info: { duration: 600 } });
    else if (id.startsWith('LOCKED')) say({ event: 'onError', info: 150 });
    else if (id.startsWith('ENDS'))   { say({ event: 'infoDelivery', info: { duration: 40 } }); say({ event: 'onStateChange', info: 0 }); }
    else say({ event: 'infoDelivery', info: { duration: 45, playerState: 1 } });
  }, 150);
</script></body></html>`;

test.use({ serviceWorkers: 'block' });   // routes must see the requests

async function boot(page, { shorts = [short(V.first), short(V.second), short(V.third)], status = 200 } = {}) {
  const api = { calls: 0, status, shorts };
  await page.route('**/api/shorts', route => {
    api.calls++;
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

test.describe('the Shorts tab', () => {
  test('is in the navigation', async ({ page }) => {
    await boot(page);
    const select = page.getByLabel('Section');
    if (await select.isVisible()) await expect(select.locator('option', { hasText: 'Shorts' })).toHaveCount(1);
    else await expect(page.locator('nav button').filter({ hasText: /^Shorts$/ })).toBeVisible();
  });

  test('plays the first short — muted, so the browser will let it autoplay, and capped at five minutes', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('short')).toHaveCount(3);
    await expect(player(page)).toHaveCount(1);              // one player, however long the feed
    expect(await playing(page)).toBe(V.first);
    const src = await player(page).getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/');
    expect(src).toContain('mute=1');
    expect(src).toContain('end=300');
  });

  test('one tap turns the sound on', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tap for sound' }).click();
    await expect(player(page)).toHaveAttribute('src', /mute=0/);
    await expect(page.getByRole('button', { name: 'Mute' })).toBeVisible();
  });

  test('Next moves to the next short, and only that one plays', async ({ page }) => {
    await boot(page);
    await expect.poll(() => playing(page)).toBe(V.first);
    await page.getByTestId('short').first().getByRole('button', { name: 'Next ↓' }).click();
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
    await expect(page.getByTestId('shorts-error')).toContainText('Couldn’t load shorts');
    api.status = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('short')).toHaveCount(3);
  });

  test('an empty feed is not shown as a blank screen', async ({ page }) => {
    await boot(page, { shorts: [] });
    await expect(page.getByTestId('shorts-error')).toContainText('Nothing to show');
  });
});
