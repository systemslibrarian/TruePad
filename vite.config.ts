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
        learn: "learn.html",
        // A static explanation of the online delivery feature, reachable from
        // the transfer screens and the Security page. No script: it is a
        // document, and the engine has no business on it.
        onlineDelivery: "online-delivery.html"
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
        name: "TruePad — private one-time-pad messaging",
        short_name: "TruePad",
        // THE SAME SENTENCE THE FRONT DOOR USES, and for the same reason.
        //
        // This previously opened "Send messages only you and one other person can
        // read." — an UNCONDITIONAL confidentiality promise, in the one surface a
        // person sees while deciding to install. TruePad's secrecy claim is
        // conditional on the one-time-pad premises holding, and every other
        // surface says so; the install manifest was the only place that did not,
        // and nothing tested it.
        description:
          "An educational system for authenticated one-time-pad messaging with one other person, running entirely in your browser — no backend, no accounts, no sync.",
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
