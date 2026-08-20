/* ──────────────────────────────────────────────────────────────────
   Command Deck — iOS home screen widget

   iOS widgets are WidgetKit: native, Swift, App Store. A PWA cannot
   ship one, and no amount of manifest will change that. Scriptable can
   — it runs this file and hands the result to WidgetKit — so this is
   the app's day, drawn by a script that reads the same synced state
   over the same API the app itself uses.

   It only ever READS, and it is meant to be given a token that can only
   ever read (READ_TOKEN, see functions/api/state.js). Its token lives
   on the phone, in a scripting app; with a token that could also write,
   a leak would cost every habit, task and log in one PUT.

   ── Setup ─────────────────────────────────────────────────────────
     1. Install Scriptable (free, App Store).
     2. Set READ_TOKEN in Cloudflare Pages → Settings → Environment
        variables. Make it a fresh random string — NOT your SYNC_TOKEN.
     3. New script in Scriptable, paste this file, name it "Command Deck".
     4. Run it once inside Scriptable. It asks for the host and the read
        token and stores both in the iOS keychain, not in this file —
        so the script itself stays safe to copy, paste and sync.
     5. Home screen → long press → + → Scriptable → pick a size →
        choose the "Command Deck" script.

   Widget parameter (optional): "small" | "medium" | "large" forces a
   layout when previewing. Lock screen sizes work too.

   ── Mirrored logic ────────────────────────────────────────────────
   itemsForDay() below reproduces resolveBlocks + blockOnDay +
   blockDone from index.html. Those three decide what is on a day and
   whether it is done; if they change there, change them here. It is a
   deliberate copy rather than an import: this file has to run standalone
   inside another app, with no build step and no network but the API.
   ────────────────────────────────────────────────────────────────── */

const KEY_HOST  = 'commanddeck.host';
const KEY_TOKEN = 'commanddeck.readToken';

const PILLARS = {
  deen:      '#10b981',
  tech:      '#22d3ee',
  combat:    '#ef4444',
  strategy:  '#f59e0b',
  character: '#a78bfa',
};
const INK   = '#0a0a0b';
const BONE  = '#f4f3ee';
const MUTED = '#9a9788';
const SALAH_COLOUR   = '#10b981';
const SALAH_DURATION = 20;           /* minutes of the day a prayer takes */
const SALAH_KEYS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/* ===== PURE START =====================================================
   Everything between these markers is plain data-in, data-out with no
   Scriptable globals in it — which is what lets tests/widget.spec.js
   slice this region out of the file and run it in Node. That matters
   more than it looks: itemsForDay below is a hand copy of the app's
   own rules, and a copy nobody checks is a copy that drifts.
   ===================================================================== */
/* ── Small helpers ───────────────────────────────────────────────── */

const pad2  = (n) => String(n).padStart(2, '0');
const dayKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toHM  = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
const minsOf = (d) => d.getHours() * 60 + d.getMinutes();

const durLabel = (mins) => {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
};

/* Aladhan gives "HH:MM (TZ)". Clamped into the day for the same reason
   the app clamps it: an offset is a nudge, and one that spilled past
   midnight would move a prayer to the wrong date. */
const salahMinutes = (raw, offset) => {
  if (!raw) return null;
  const [h, m] = String(raw).split(' ')[0].split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m + (Number(offset) || 0)));
};


/* ── The day ─────────────────────────────────────────────────────── */

/* MIRRORS resolveBlocks + blockOnDay + blockDone in index.html. A habit
   block reads its title off the habit and its done state off the habit's
   tick; a task block off the task; anything else is itself, ticked under
   its own id. */
function itemsForDay(state, dKey, dow) {
  const habits = state.habits || [];
  const tasks  = state.tasks  || [];
  const lists  = state.lists  || [];
  const log    = (state.logs || {})[dKey] || {};
  const colourOf = (pillar) => PILLARS[pillar] || PILLARS.deen;
  const out = [];

  for (const b of state.blocks || []) {
    if (!b) continue;
    let it = null;

    if (b.habitId) {
      const h = habits.find(x => x.id === b.habitId);
      if (!h) continue;                       /* habit deleted — the block is a ghost */
      it = { id: b.id, title: h.name, icon: h.icon || null, colour: colourOf(h.pillar),
             start: b.start, end: b.end, date: null,
             every: Array.isArray(h.days) ? h.days : [], done: !!log[h.id] };
    } else if (b.taskId) {
      const t = tasks.find(x => x.id === b.taskId);
      if (!t) continue;
      const list = lists.find(l => l.id === t.listId);
      it = { id: b.id, title: t.title, icon: null, colour: list?.color || MUTED,
             start: b.start, end: b.end, date: b.date || t.due || null,
             every: [], done: !!t.done };     /* a task happens once — never recurring */
    } else {
      it = { id: b.id, title: b.title, icon: null, colour: colourOf(b.pillar),
             start: b.start, end: b.end, date: b.date || null,
             every: b.every || [], done: !!log[b.id] };
    }

    const onDay = it.date ? it.date === dKey : (it.every || []).includes(dow);
    if (onDay && it.title) out.push(it);
  }
  return out;
}

/* Habits scheduled today, whether or not they have a slot on the
   calendar — the count under the widget is about the day, not about
   what happens to have been given a time. */
function habitTally(state, dKey, dow) {
  const log = (state.logs || {})[dKey] || {};
  const due = (state.habits || []).filter(h => (h.days || []).includes(dow));
  return { done: due.filter(h => log[h.id]).length, total: due.length };
}

/* When this widget's content next changes: the next thing to start, or
   the next thing to end. Asking iOS to wake at that moment spends the
   refresh budget on the moments that matter instead of on a blind
   interval that is usually early and sometimes hours late. */
function nextChangeAt(items, now, nowMin) {
  const marks = [];
  for (const it of items) {
    if (it.start > nowMin) marks.push(it.start);
    if (it.end   > nowMin && it.end > it.start) marks.push(it.end);
  }
  const at = new Date(now);
  if (!marks.length) { at.setHours(24, 0, 1, 0); return at; }   /* nothing left — just after midnight */
  at.setHours(0, Math.min(...marks), 5, 0);
  /* Never sooner than five minutes: iOS budgets these, and burning the
     budget on the minute either side of a boundary buys nothing. */
  const floor = new Date(now.getTime() + 5 * 60 * 1000);
  return at < floor ? floor : at;
}

/* ===== PURE END ======================================================= */

/* ── Cache ───────────────────────────────────────────────────────── */

const fm       = FileManager.local();
const cacheDir = fm.joinPath(fm.cacheDirectory(), 'command-deck');
if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir, true);

function readCache(name) {
  const p = fm.joinPath(cacheDir, name);
  if (!fm.fileExists(p)) return null;
  try { return JSON.parse(fm.readString(p)); } catch { return null; }
}
function writeCache(name, value) {
  try { fm.writeString(fm.joinPath(cacheDir, name), JSON.stringify(value)); } catch {}
}

/* ── Config, kept in the keychain rather than in this file ───────── */

const configured = () => Keychain.contains(KEY_HOST) && Keychain.contains(KEY_TOKEN);

async function promptForConfig() {
  const a = new Alert();
  a.title = 'Command Deck widget';
  a.message = 'Where the app lives, and a READ-ONLY token (READ_TOKEN in '
            + 'your Cloudflare Pages settings — not SYNC_TOKEN).';
  a.addTextField('https://your-app.pages.dev', Keychain.contains(KEY_HOST) ? Keychain.get(KEY_HOST) : '');
  a.addSecureTextField('read token', '');
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if (await a.presentAlert() !== 0) return false;

  const host  = (a.textFieldValue(0) || '').trim().replace(/\/+$/, '');
  const token = (a.textFieldValue(1) || '').trim();
  if (!host || !token) return false;
  Keychain.set(KEY_HOST, host);
  Keychain.set(KEY_TOKEN, token);
  return true;
}

/* ── The API ─────────────────────────────────────────────────────── */

const headerOf = (req, name) => {
  const h = req.response?.headers || {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : null;
};

/* The app's own ETag, used the way the app uses it: a wake that finds
   nothing new costs a 304 rather than the whole blob. Which matters
   more here than in the app — the widget wakes on iOS's schedule, not
   on yours, and most of those wakes will find nothing changed. */
async function loadState() {
  const host  = Keychain.get(KEY_HOST);
  const token = Keychain.get(KEY_TOKEN);
  const cached = readCache('state.json');

  const req = new Request(`${host}/api/state`);
  req.timeoutInterval = 15;
  req.headers = {
    Authorization: `Bearer ${token}`,
    ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
  };

  let body;
  try {
    body = await req.loadString();
  } catch (e) {
    /* Offline, or the request timed out. Yesterday's answer beats an
       error card — but say it is old, so a stale widget is never
       mistaken for a quiet day. */
    if (cached?.state) return { state: cached.state, stale: true };
    throw new Error('No connection, and nothing cached yet.');
  }

  const status = req.response?.statusCode ?? 0;
  if (status === 304 && cached?.state) return { state: cached.state, stale: false };
  /* Auth failures are never served from cache: a token that has been
     revoked or mistyped has to be visible, not papered over. */
  if (status === 401) throw new Error('Token rejected. Check READ_TOKEN.');
  if (status === 403) throw new Error('That token cannot read this.');
  if (status !== 200) {
    if (cached?.state) return { state: cached.state, stale: true };
    throw new Error(`Server said ${status}.`);
  }

  let state;
  try { state = JSON.parse(body); }
  catch { throw new Error('The server sent something unreadable.'); }

  writeCache('state.json', { etag: headerOf(req, 'etag'), state });
  return { state, stale: false };
}

/* One request a month, cached by month and location, so the ordinary
   day costs nothing. A failure here loses the prayers and keeps the
   rest of the day rather than failing the whole widget. */
async function loadSalah(state, dKey) {
  const ui  = state?.ui || {};
  const loc = ui.salahLoc;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return [];

  const [y, mo] = dKey.split('-');
  const method  = ui.salahMethod ?? 3;
  const school  = ui.salahSchool ?? 0;
  const name = `salah_${y}-${mo}_${loc.lat.toFixed(3)}_${loc.lon.toFixed(3)}_m${method}_s${school}.json`;

  let days = readCache(name);
  if (!days) {
    try {
      const r = new Request(
        `https://api.aladhan.com/v1/calendar/${y}/${Number(mo)}`
        + `?latitude=${loc.lat}&longitude=${loc.lon}&method=${method}&school=${school}`);
      r.timeoutInterval = 15;
      const payload = await r.loadJSON();
      days = {};
      for (const e of payload?.data || []) {
        const [d, m, yy] = String(e?.date?.gregorian?.date || '').split('-');
        if (yy && m && d && e?.timings) days[`${yy}-${m}-${d}`] = e.timings;
      }
      if (!Object.keys(days).length) return [];
      writeCache(name, days);
    } catch { return []; }
  }

  const timings = days[dKey];
  if (!timings) return [];
  const log = (state.logs || {})[dKey] || {};
  return SALAH_KEYS.map(key => {
    const start = salahMinutes(timings[key], ui.salahOffsets?.[key] || 0);
    if (start == null) return null;
    return {
      id: `salah-${key}`, title: key, icon: '☽', colour: SALAH_COLOUR,
      start, end: start + SALAH_DURATION, done: !!log[`salah-${key}`],
    };
  }).filter(Boolean);
}

/* ── Drawing ─────────────────────────────────────────────────────── */

const txt = (parent, s, { size = 12, colour = BONE, bold = false, lines = 1, dim = 1 } = {}) => {
  const t = parent.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = new Color(colour, dim);
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.8;
  return t;
};

function dot(stack, colour, size = 7) {
  const s = stack.addStack();
  s.size = new Size(size, size);
  s.cornerRadius = size / 2;
  s.backgroundColor = new Color(colour);
  return s;
}

/* One line of the day: ● 13:10  Dhuhr */
function itemRow(widget, it, { size = 12, showDur = false } = {}) {
  const row = widget.addStack();
  row.centerAlignContent();
  row.spacing = 6;

  dot(row, it.done ? MUTED : it.colour, size * 0.55);

  txt(row, toHM(it.start), { size: size - 1, colour: MUTED });

  const label = it.icon ? `${it.icon} ${it.title}` : it.title;
  txt(row, label, { size, colour: it.done ? MUTED : BONE, bold: !it.done, dim: it.done ? 0.6 : 1 });

  if (showDur) {
    row.addSpacer();
    txt(row, durLabel(it.end > it.start ? it.end - it.start : (1440 - it.start) + it.end),
        { size: size - 2, colour: MUTED });
  }
  return row;
}

function progressBar(widget, done, total, width) {
  const track = widget.addStack();
  track.size = new Size(width, 4);
  track.cornerRadius = 2;
  track.backgroundColor = new Color(BONE, 0.14);
  if (total > 0 && done > 0) {
    const fill = track.addStack();
    fill.size = new Size(Math.max(4, Math.round(width * (done / total))), 4);
    fill.cornerRadius = 2;
    fill.backgroundColor = new Color(SALAH_COLOUR);
  }
}

function shell(host) {
  const w = new ListWidget();
  w.backgroundColor = new Color(INK);
  w.setPadding(12, 14, 12, 14);
  if (host) w.url = host;
  return w;
}

function errorWidget(message, host) {
  const w = shell(host);
  txt(w, 'COMMAND DECK', { size: 9, colour: MUTED, bold: true });
  w.addSpacer(6);
  txt(w, message, { size: 12, colour: BONE, lines: 4 });
  w.addSpacer();
  txt(w, 'Open Scriptable and run this script to set it up.', { size: 9, colour: MUTED, lines: 2 });
  return w;
}

function buildWidget({ family, items, tally, now, nowMin, stale, host }) {
  const w = shell(host);

  const open   = items.filter(i => !i.done);
  const live   = open.filter(i => i.start <= nowMin && nowMin < (i.end > i.start ? i.end : 1440));
  const ahead  = open.filter(i => i.start > nowMin).sort((a, b) => a.start - b.start);
  const focus  = live[0] || ahead[0] || null;

  /* Lock screen: one line, no room for anything but the answer. */
  if (family === 'accessoryInline') {
    w.addText(focus ? `${toHM(focus.start)} ${focus.title}` : `${tally.done}/${tally.total} done`);
    return w;
  }
  if (family === 'accessoryCircular' || family === 'accessoryRectangular') {
    w.backgroundColor = new Color(INK, 0);
    w.addAccessoryWidgetBackground = true;
    if (family === 'accessoryCircular') {
      txt(w, `${tally.done}/${tally.total}`, { size: 15, bold: true });
      txt(w, 'habits', { size: 9, colour: MUTED });
      return w;
    }
    txt(w, focus ? focus.title : 'Nothing left', { size: 13, bold: true });
    txt(w, focus ? `${toHM(focus.start)}–${toHM(focus.end)}` : `${tally.done}/${tally.total} habits done`,
        { size: 11, colour: MUTED });
    return w;
  }

  /* Header */
  const head = w.addStack();
  head.centerAlignContent();
  txt(head, 'COMMAND DECK', { size: 8, colour: MUTED, bold: true });
  head.addSpacer();
  txt(head, stale ? 'OFFLINE' : toHM(nowMin), { size: 8, colour: stale ? '#f59e0b' : MUTED, bold: true });
  w.addSpacer(family === 'small' ? 6 : 8);

  /* What is happening, or what is next */
  if (focus) {
    txt(w, live.length ? 'NOW' : 'NEXT', { size: 8, colour: focus.colour, bold: true });
    w.addSpacer(2);
    txt(w, focus.icon ? `${focus.icon} ${focus.title}` : focus.title,
        { size: family === 'small' ? 15 : 17, bold: true, lines: 2 });
    txt(w, `${toHM(focus.start)}–${toHM(focus.end)}`, { size: 11, colour: MUTED });
  } else {
    txt(w, 'Nothing booked left today', { size: family === 'small' ? 13 : 15, bold: true, lines: 2 });
  }

  /* The rest of what is coming */
  const room = family === 'large' ? 8 : family === 'medium' ? 3 : 0;
  const rest = ahead.filter(i => i !== focus).slice(0, room);
  if (rest.length) {
    w.addSpacer(8);
    for (const it of rest) {
      itemRow(w, it, { size: family === 'large' ? 13 : 12, showDur: family === 'large' });
      w.addSpacer(family === 'large' ? 5 : 3);
    }
  }

  w.addSpacer();

  /* The day, in one number */
  const foot = w.addStack();
  foot.centerAlignContent();
  txt(foot, tally.total ? `${tally.done} / ${tally.total} HABITS` : 'NO HABITS TODAY',
      { size: 8, colour: MUTED, bold: true });
  foot.addSpacer();
  if (open.length) txt(foot, `${open.length} LEFT`, { size: 8, colour: MUTED, bold: true });
  if (tally.total) {
    w.addSpacer(4);
    progressBar(w, tally.done, tally.total, family === 'small' ? 130 : family === 'medium' ? 300 : 300);
  }
  return w;
}

/* ── Run ─────────────────────────────────────────────────────────── */

const family = args.widgetParameter || config.widgetFamily || 'medium';

if (!config.runsInWidget) {
  /* Run inside Scriptable to configure, or to re-configure. */
  const ok = configured() ? true : await promptForConfig();
  if (!ok) { Script.complete(); throw new Error('Not configured.'); }
  if (configured()) {
    const a = new Alert();
    a.title = 'Command Deck';
    a.message = `Configured for ${Keychain.get(KEY_HOST)}.`;
    a.addAction('Preview widget');
    a.addAction('Change host / token');
    a.addCancelAction('Done');
    const choice = await a.presentAlert();
    if (choice === 1) await promptForConfig();
  }
}

let widget;
const host = Keychain.contains(KEY_HOST) ? Keychain.get(KEY_HOST) : null;

if (!configured()) {
  widget = errorWidget('Not set up yet.', host);
} else {
  try {
    const { state, stale } = await loadState();
    const now    = new Date();
    const dKey   = dayKeyOf(now);
    const dow    = now.getDay();
    const nowMin = minsOf(now);

    const items = [...itemsForDay(state, dKey, dow), ...await loadSalah(state, dKey)]
      .sort((a, b) => a.start - b.start);
    const tally = habitTally(state, dKey, dow);

    widget = buildWidget({ family, items, tally, now, nowMin, stale, host });
    widget.refreshAfterDate = nextChangeAt(items, now, nowMin);
  } catch (e) {
    widget = errorWidget(String(e?.message || e), host);
    widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  }
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  if (family === 'small') await widget.presentSmall();
  else if (family === 'large') await widget.presentLarge();
  else await widget.presentMedium();
}
Script.complete();
