import { defineConfig, devices } from '@playwright/test';
const exe = (process.env.LOCALAPPDATA + '/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe');
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:8799', launchOptions: { executablePath: exe } },
  webServer: { command: 'npx serve -p 8799 .', url: 'http://localhost:8799', reuseExistingServer: false },
  projects: [{ name: 'chromium' }],
});
