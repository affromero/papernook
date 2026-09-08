// Private documents live in IndexedDB. HTTP caches contain only a generic reader.
const SHELL_CACHE = "papernook-shell-__OFFLINE_VERSION__";
const STATIC_CACHE = "papernook-static-v1";
const PREFIX = "papernook-";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/offline/precache.json", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Offline reader manifest unavailable");
      const manifest = await response.json();
      if (`papernook-shell-${manifest.version}` !== SHELL_CACHE)
        throw new Error(
          "Offline reader changed during installation. Reload to retry.",
        );
      const stage = await caches.open(SHELL_CACHE);
      try {
        for (let start = 0; start < manifest.urls.length; start += 8) {
          await Promise.all(
            manifest.urls.slice(start, start + 8).map(async (url) => {
              if (
                typeof url !== "string" ||
                !url.startsWith("/offline/") ||
                url.includes("..")
              )
                throw new Error("Invalid offline asset");
              const asset = await fetch(url, { cache: "reload" });
              if (!asset.ok) throw new Error(`Missing offline asset: ${url}`);
              await stage.put(url, asset);
            }),
          );
        }
      } catch (error) {
        await caches.delete(SHELL_CACHE);
        throw error;
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (
          name.startsWith(PREFIX) &&
          name !== SHELL_CACHE &&
          name !== STATIC_CACHE
        )
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "OFFLINE_READY") return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      event.ports[0]?.postMessage({
        ready: Boolean(await cache.match("/offline/index.html")),
      });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
    return;
  if (url.pathname.startsWith("/offline/")) {
    event.respondWith(
      (async () =>
        (await (await caches.open(SHELL_CACHE)).match(url.pathname)) ??
        fetch(request))(),
    );
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, {
            signal: AbortSignal.timeout(6000),
          });
          if (response.status < 500) return response;
        } catch {
          /* Explicit downloads are the offline fallback. */
        }
        const shell = await (
          await caches.open(SHELL_CACHE)
        ).match("/offline/index.html");
        if (!shell)
          return new Response(
            "Offline reader is not downloaded. Connect and reopen Papernook.",
            { status: 503, headers: { "Content-Type": "text/plain" } },
          );
        return Response.redirect(
          `${self.location.origin}/offline/index.html?return=${encodeURIComponent(url.pathname + url.search)}`,
          302,
        );
      })(),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put(request, response.clone());
          return response;
        } catch {
          return (await cache.match(request)) ?? Response.error();
        }
      })(),
    );
  }
});
