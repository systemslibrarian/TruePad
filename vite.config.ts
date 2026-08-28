/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  // Multi-page build: the Browser Edition is the main product at index.html;
  // the original teaching exhibit lives at /learn (learn.html). Both share
  // one service worker so the whole app installs and runs offline.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        learn: "learn.html"
      }
    }
  },
  // The engine runs in a dedicated ES-module Web Worker (secrets never touch
  // the UI thread); build it as a module worker.
  worker: {
    format: "es"
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "TruePad 2 — authenticated one-time pad",
        short_name: "TruePad",
        description:
          "Authenticated one-time-pad handling with explicit one-time state — the frozen TruePad 2 protocol, running entirely in your browser. No backend, no accounts, no sync.",
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
