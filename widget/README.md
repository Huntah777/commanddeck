# Command Deck — iOS home screen widget

iOS widgets are WidgetKit: native, Swift, App Store. A PWA cannot ship one.
[Scriptable](https://scriptable.app) can — it runs JavaScript and hands the
result to WidgetKit — so `command-deck.js` is the app's day, drawn by a script
that reads the same synced state over the same API the app uses.

It **only ever reads**, and it should be given a token that can only ever read.

## Setup

**1. Make a read-only token.** In Cloudflare Pages → Settings → Environment
variables, add `READ_TOKEN`. Make it a fresh random string:

```sh
openssl rand -hex 32
```

Do **not** reuse `SYNC_TOKEN`. `READ_TOKEN` can `GET /api/state` and nothing
else — a `PUT` with it answers `403`. That is the whole point: the widget's
token lives on your phone inside a third-party scripting app, and if it leaks
you lose confidentiality, not your data.

Redeploy so the new variable is picked up.

**2. Install Scriptable** from the App Store (free).

**3. Add the script.** Scriptable → `+` → paste `command-deck.js` → name it
**Command Deck**.

**4. Run it once inside Scriptable.** It asks for your host
(`https://…pages.dev`, no trailing slash) and the read token, and stores both
in the **iOS keychain** — not in the script. The script file itself stays safe
to copy, paste and sync around.

**5. Add the widget.** Home screen → long press → `+` → Scriptable → pick a
size → tap the widget → choose the **Command Deck** script.

Lock screen works too: Settings → Wallpaper → Customise → add a Scriptable
accessory widget.

## What each size shows

| Size | Shows |
|---|---|
| `accessoryInline` | next thing and its time |
| `accessoryCircular` | habits done / scheduled |
| `accessoryRectangular` | next thing, with its window |
| small | now-or-next, habit count, progress |
| medium | now-or-next + the following 3 |
| large | now-or-next + the following 8, with lengths |

Tapping any of them opens the app.

## How it treats the network

- **ETag.** It sends `If-None-Match`, so a wake that finds nothing new costs a
  `304` rather than the whole state blob. Most wakes find nothing new.
- **Cache.** The last good state is kept on the device. Offline, it draws that
  and labels itself `OFFLINE` — a stale widget must never be mistaken for a
  quiet day. An auth failure is *never* served from cache: a revoked or
  mistyped token has to be visible.
- **Prayer times.** One Aladhan request per month per location, cached. The
  ordinary day costs nothing. If it fails, you lose the prayers and keep the
  rest of the day.
- **Refresh timing.** It asks iOS to wake it at the next moment its content
  actually changes — the next thing starting or finishing — rather than on a
  blind interval. iOS still budgets these and may be late; a widget is a
  glance, not a live timer.

## The copied logic

`itemsForDay()` reproduces `resolveBlocks` + `blockOnDay` + `blockDone` from
`index.html`. It has to: Scriptable runs one standalone file, with no build
step and no imports.

A copy nobody checks is a copy that drifts, and this one would drift silently
— the widget would just show the wrong day and give you no reason to look. So
the file marks its pure region with `PURE START` / `PURE END`, and
`tests/widget.spec.js` slices that region out and runs it in Node against the
same fixtures the app's own tests use.

**If you change how a day resolves in `index.html`, change it here too.** The
tests will not catch a change you make in only one place — they check this file
is self-consistent, not that it agrees with the app.
