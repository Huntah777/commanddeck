import { defineConfig, devices } from '@playwright/test';

/* Throwaway: drives the chromium build that is actually installed (1248), on a
   port that isn't fortheummah's (8788). Delete after use. */
const exe = 'C:/Users/AMali/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:8799', trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: exe } } },
    { name: 'Mobile Safari', use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium', launchOptions: { executablePath: exe } } },
  ],
  webServer: { command: 'npx serve -p 8799 .', url: 'http://localhost:8799', reuseExistingServer: false, timeout: 30_000 },
});
