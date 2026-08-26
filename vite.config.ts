/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "TruePad — a true one-time pad",
        short_name: "TruePad",
        description:
          "A one-time pad whose combiner satisfies all three Shannon conditions, with its entropy source graded honestly — the honest sibling of DeckBook. Watch the pad burn, hit the wall when it runs out, and see crib-dragging fail.",
        start_url: "./",
        scope: "./",
        theme_color: "#11100c",
        background_color: "#11100c",
        display: "standalone",
        orientation: "any",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"]
      }
    })
  ],
  test: {
    // Unit tests live in tests/. The Playwright specs in e2e/ (see
    // playwright.config.ts) run separately via `npm run test:e2e` and must
    // not be collected by Vitest.
    include: ["tests/**/*.test.ts"]
  }
});
