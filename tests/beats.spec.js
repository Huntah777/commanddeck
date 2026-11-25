import { test, expect } from '@playwright/test';

/* Binaural beats. What is being protected:

   One: it is actually binaural — two tones, hard left and hard right,
   exactly the beat frequency apart. Get the panning wrong and it still
   "plays", it just stops being the thing it says it is.

   Two: it keeps playing while you use the rest of the app. The engine is
   a module outside React, so a tab switch can't unmount it, and the
   header pill is the proof (and the way to stop it) from anywhere.

   Three: by default it plays straight to the speakers, the route that
   mixes underneath other audio. The media-element route is opt-in. */

const mounted = (page) =>
  page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

const boot = async (page) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await mounted(page);
};

const goTab = (page, name) =>
  page.locator('nav button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();

const play = (page) => page.getByRole('button', { name: 'Play beats' }).click();
const engine = (page) => page.evaluate(() => Beats.inspect());

/* Frequencies glide to a new value over ~50 ms rather than jumping (a
   jump is a click), so they are polled to within a hair of the target. */
const near = (page, ear, want) => async () => Math.abs((await engine(page))[ear] - want) < 0.5;

/* The header draws the pill twice — the desktop row and the phone row —
   and hides whichever doesn't fit, same as the timer pill. */
const pill = (page) => page.locator('[data-testid="beats-pill"]:visible');

test.describe('Binaural beats', () => {
  test.beforeEach(async ({ page }) => { await boot(page); await goTab(page, 'Beats'); });

  test('two tones, one per ear, exactly the beat apart', async ({ page }) => {
    await expect(page.getByTestId('beats-hz')).toHaveText('10 Hz');
    await play(page);

    await expect.poll(async () => (await engine(page)).ctxState).toBe('running');
    const e = await engine(page);
    expect(e.playing).toBe(true);
    expect(e.left).toBe(200);
    expect(e.right).toBe(210);
    expect(e.noise).toBe('on');
    await expect(page.getByTestId('beats-status')).toHaveText('Playing');
  });

  test('keeps playing on every other tab, and can be stopped from the header', async ({ page }) => {
    await play(page);
    await expect.poll(async () => (await engine(page)).ctxState).toBe('running');

    for (const tab of ['Today', 'Habits', 'Focus', 'Admin']) {
      await goTab(page, tab);
      await expect(pill(page)).toHaveCount(1);
      const e = await engine(page);
      expect(e.playing).toBe(true);
      expect(e.ctxState).toBe('running');
    }

    await pill(page).getByRole('button', { name: 'Stop binaural beats' }).click();
    await expect(page.getByTestId('beats-pill')).toHaveCount(0);
    expect((await engine(page)).playing).toBe(false);
  });

  test('presets and sliders retune what is already playing', async ({ page }) => {
    await play(page);
    await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: /^40 Hz/ }).click();
    await expect(page.getByTestId('beats-hz')).toHaveText('40 Hz');
    await expect.poll(near(page, 'right', 240)).toBe(true);

    await page.getByTestId('beats-carrier').focus();
    await page.keyboard.press('ArrowRight');   // one 5 Hz step
    await expect.poll(near(page, 'left', 205)).toBe(true);
    await expect.poll(near(page, 'right', 245)).toBe(true);

    await page.getByRole('group', { name: 'Sound bed' }).getByRole('button', { name: 'None' }).click();
    await expect.poll(async () => (await engine(page)).noise).toBe('off');
  });

  test('every preset lands on its own frequency, decimals included', async ({ page }) => {
    const presets = page.getByRole('group', { name: 'Presets' }).getByRole('button');
    await expect(presets).toHaveCount(15);
    await play(page);

    await presets.filter({ hasText: 'Schumann' }).click();
    await expect(page.getByTestId('beats-hz')).toHaveText('7.8 Hz');
    await expect(page.getByTestId('beats-use')).toHaveText('Schumann resonance');
    await expect.poll(near(page, 'right', 207.8)).toBe(true);

    await presets.filter({ hasText: 'Deep sleep' }).click();
    await expect(page.getByTestId('beats-hz')).toHaveText('1 Hz');
    await expect.poll(near(page, 'right', 201)).toBe(true);

    /* Off-preset values are named by their band instead */
    await page.getByTestId('beats-beat').focus();
    await page.keyboard.press('ArrowRight');       // 0.1 Hz step
    await expect(page.getByTestId('beats-hz')).toHaveText('1.1 Hz');
    await expect(page.getByTestId('beats-use')).toHaveText('Sleep · deep rest');
  });

  test('mixes straight to the speakers unless lock-screen mode is chosen', async ({ page }) => {
    await play(page);
    expect((await engine(page)).output).toBe('speakers');
    expect(await page.evaluate(() => navigator.mediaSession?.metadata ?? null)).toBeNull();

    const mode = page.getByRole('group', { name: 'Playback mode' });
    await mode.getByRole('button', { name: 'Lock screen' }).click();
    await expect.poll(async () => (await engine(page)).output).toBe('media-element');
    expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Calm focus · 10 Hz binaural beat');

    await mode.getByRole('button', { name: 'Mix with other audio' }).click();
    await expect.poll(async () => (await engine(page)).output).toBe('speakers');
    expect(await page.evaluate(() => navigator.mediaSession?.metadata ?? null)).toBeNull();
  });

  test('settings are remembered on this device, and kept out of the synced state', async ({ page }) => {
    await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: /^6 Hz/ }).click();
    await page.getByRole('group', { name: 'Sound bed' }).getByRole('button', { name: 'Pink' }).click();
    await page.getByRole('group', { name: 'Stop after' }).getByRole('button', { name: '30m' }).click();

    await page.reload();
    await mounted(page);
    await goTab(page, 'Beats');
    await expect(page.getByTestId('beats-hz')).toHaveText('6 Hz');
    await expect(page.getByRole('group', { name: 'Sound bed' }).getByRole('button', { name: 'Pink' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Stop after' }).getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');

    const synced = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
    expect(synced.beats).toBeUndefined();
    expect(synced.binaural).toBeUndefined();
  });
});

test.describe('Beats sleep timer', () => {
  test('stops by itself, even if the tab was frozen through the deadline', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-07-29T21:00:00') });
    await boot(page);
    await goTab(page, 'Beats');
    await page.getByRole('group', { name: 'Stop after' }).getByRole('button', { name: '15m' }).click();
    await play(page);
    await expect(page.getByTestId('beats-status')).toHaveText(/stops in 1[45]:\d\d/);

    await page.clock.fastForward('15:01');
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    await expect(page.getByTestId('beats-status')).toHaveText('Headphones on, then press play');
  });
});

/* The bed: noise, nature and hums, all synthesised. renderBed is pure, so
   it is checked directly rather than through a speaker. */
test.describe('Beats sound bed', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('every sound is a finite, level-matched loop with no seam', async ({ page }) => {
    const report = await page.evaluate(() => BED_SOUNDS.filter(s => s.secs).map(s => {
      const r = renderBed(s.id, 16000, 200);
      const stats = (x) => {
        let sum = 0, peak = 0, step = 0, finite = true;
        for (let i = 0; i < x.length; i++) {
          if (!Number.isFinite(x[i])) finite = false;
          sum += x[i] * x[i]; peak = Math.max(peak, Math.abs(x[i]));
          if (i) step += Math.abs(x[i] - x[i - 1]);
        }
        /* The jump from the last sample back to the first, against the
           typical sample-to-sample step. A cut shows up as a big ratio. */
        const seam = Math.abs(x[0] - x[x.length - 1]) / (step / (x.length - 1));
        return { rms: Math.sqrt(sum / x.length), peak, seam, finite, len: x.length };
      };
      return { id: s.id, secs: s.secs, same: r.left === r.right, L: stats(r.left), R: stats(r.right) };
    }));
    expect(report).toHaveLength(13);
    for (const s of report) {
      for (const c of [s.L, s.R]) {
        expect(c.finite, s.id).toBe(true);
        expect(c.len, s.id).toBe(s.secs * 16000);
        expect(c.peak, s.id).toBeLessThanOrEqual(0.6001);
        expect(c.rms, s.id).toBeGreaterThan(0.04);
        expect(c.rms, s.id).toBeLessThanOrEqual(0.2001);
        expect(c.seam, s.id).toBeLessThan(8);
      }
    }
    /* Hums are the same in both ears; nature and noise are not. */
    const same = Object.fromEntries(report.map(s => [s.id, s.same]));
    expect(same).toMatchObject({ drone: true, voice: true, bowl: true, rain: false, ocean: false, brown: false });
  });

  test('a hum is tuned to the tone — its partial lands on the pitch, not beside it', async ({ page }) => {
    /* Goertzel: the energy at one exact frequency. The drone is built two
       octaves under the tone, so its 4th partial IS the tone. */
    const power = await page.evaluate(() => {
      const at = (x, f, sr) => {
        const w = 2 * Math.PI * f / sr, c = 2 * Math.cos(w);
        let s1 = 0, s2 = 0;
        for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
        return s1 * s1 + s2 * s2 - c * s1 * s2;
      };
      const out = {};
      for (const carrier of [200, 250]) {
        const x = renderBed('drone', 8000, carrier).left;
        out[carrier] = { on: at(x, carrier, 8000), off: at(x, carrier + 7, 8000) };
      }
      return out;
    });
    for (const p of Object.values(power)) expect(p.on).toBeGreaterThan(p.off * 1000);
  });

  test('switching sound while playing swaps the bed; moving the pitch retunes a hum', async ({ page }) => {
    await goTab(page, 'Beats');
    await play(page);
    const bed = page.getByRole('group', { name: 'Sound bed' });
    await bed.getByRole('button', { name: 'Ocean' }).click();
    await expect.poll(async () => (await engine(page)).bed).toMatch(/^ocean@/);

    await bed.getByRole('button', { name: 'Deep drone' }).click();
    await expect.poll(async () => (await engine(page)).bed).toMatch(/^drone@\d+@200$/);
    await page.getByTestId('beats-carrier').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await engine(page)).bed).toMatch(/^drone@\d+@205$/);
  });
});
