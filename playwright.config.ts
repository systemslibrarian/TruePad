import { defineConfig, devices } from "@playwright/test";

// Override with TRUEPAD_E2E_PORT to run several checkouts side by side
// without attaching to another checkout's dev server.
const PORT = Number(process.env.TRUEPAD_E2E_PORT ?? 5179);

// End-to-end specs drive the REAL exhibit in a real Chromium against the
// BUILT bundle: the webServer builds dist/ and serves it with `vite preview`,
// so what the suite exercises is what upload-pages-artifact ships (base "./",
// minified, service worker). Unit tests live in tests/ and run under Vitest;
// the two never collect each other's files.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite build --logLevel error && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    // Never attach to a server we did not start: another checkout's server on
    // the same port would silently green-light different code.
    reuseExistingServer: false,
    timeout: 120_000
  }
});
