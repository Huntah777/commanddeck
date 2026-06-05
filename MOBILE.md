# Command Deck · Mobile

## What was built

Command Deck is now a **Progressive Web App (PWA)** — meaning it can be installed directly to the home screen of any Android or iOS device and behaves like a native app.

---

## How to install

**Android (Chrome)**
1. Open the app URL in Chrome
2. Tap the banner that appears at the bottom — "Add Command Deck to Home Screen"
3. Or: tap the three-dot menu in the top right → "Add to Home Screen"

**iPhone / iPad (Safari)**
1. Open the app URL in Safari (not Chrome)
2. Tap the Share button (the box with an arrow at the bottom of the screen)
3. Scroll down and tap "Add to Home Screen"
4. Confirm the name and tap Add

The app icon — the teal and amber 8-pointed star — will appear on your home screen exactly like any other app.

---

## What it feels like once installed

- **No browser chrome.** The address bar, back button, and tab bar all disappear. The app fills the entire screen edge-to-edge.
- **Status bar blends in.** On iOS, the time and battery indicator sit over the dark header rather than on a separate white bar. On Android, the status bar turns the same near-black as the app.
- **Works offline.** The app loads instantly even with no internet connection. All your habits, tasks, and schedule are available. If you have D1 sync enabled it will show "OFFLINE" and queue changes until you're back online.
- **Feels fast.** All the core files — the app itself, the Islamic star icon, and the JavaScript libraries it depends on — are stored on your device after the first visit. Nothing needs to download again.

---

## The icon

The 8-pointed star from `command-deck-icon.svg` is used throughout:
- **Browser tab** — the SVG renders as the favicon
- **Home screen** — three sizes are generated (180px for iPhone, 192px for Android, 512px for Android's high-res splash and adaptive icon)
- **Android's adaptive icon** — the icon's dark full-bleed background makes it naturally compatible with Android's circular/squircle icon shapes without any white padding

---

## What's next: notifications + widgets

### Notifications (Phase 2)
The groundwork for push notifications is in place — the service worker already has a push event handler. The remaining step is generating a VAPID key pair and wiring up a small Cloudflare Worker to send reminders (Fajr, evening adhkar, habit check-in, etc.) on a schedule. This is free.

### Home screen widgets (Phase 3)
Widgets — the small panels you can place on the Android or iOS home screen showing today's habit streak, completion percentage, or next prayer time — require a native app wrapper. The path is:

- **Android** (free): Wrap the app in Capacitor, then write a small native Android widget in Java/Kotlin that reads from shared storage the web layer writes to. The result is an APK you can install directly or publish to Google Play ($25 one-time).
- **iOS** ($99/year): Same Capacitor wrapper, but the widget is written in Swift using WidgetKit. Requires an Apple Developer account to run on a real device.

Both platforms can display live data from the app (streak, today's completion %, next salah) without the user needing to open it.

---

## File summary

| File | Purpose |
|------|---------|
| `manifest.json` | Tells browsers the app's name, icon, and how to display it when installed |
| `sw.js` | Service worker — caches the app for offline use, handles push notifications |
| `_headers` | Cloudflare Pages config — ensures the service worker file is always fresh |
| `icons/icon-192.png` | Android home screen icon |
| `icons/icon-512.png` | Android splash screen / adaptive icon |
| `icons/apple-touch-icon.png` | iPhone / iPad home screen icon |
| `vendor/react.min.js` | React library (now local, was CDN) |
| `vendor/react-dom.min.js` | React DOM renderer (now local, was CDN) |
| `vendor/babel.min.js` | JSX compiler (now local, was CDN) |
