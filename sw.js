"use strict";
/* ============================================================================
 * sw.js — service worker: installable app + offline from cache.
 *
 * STRATEGY (deliberately simple and safe):
 *   • Install: pre-cache the app shell (each file individually, so one miss
 *     can't fail the whole install).
 *   • Fetch (same-origin GETs only): NETWORK-FIRST, falling back to cache.
 *     Fresh deploys are picked up immediately when online; offline, the last
 *     good shell + predictions keep the game fully playable (guest state
 *     lives in localStorage anyway).
 *   • Never caches POSTs, never touches other origins, no push, no sync —
 *     nothing beyond basic install/offline.
 * ========================================================================== */

const CACHE = "called-it-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./predictions.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(u)))   // best-effort per file
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // never intercept writes
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) =>
          hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
      )
  );
});
