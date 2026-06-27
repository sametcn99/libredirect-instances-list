var CACHE_NAME = "libredirect-instances-v1"
var ASSETS_TO_CACHE = ["/", "index.html", "app.js", "app.css", "manifest.json", "icon-192x192.png", "icon-512x512.png"]

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS_TO_CACHE)
    }),
  )
})

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE_NAME
          })
          .map(function (key) {
            return caches.delete(key)
          }),
      )
    }),
  )
})

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url)

  if (url.hostname === "raw.githubusercontent.com") {
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return fetch(event.request, { cache: "no-store" })
          .then(function (response) {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone())
            }
            return response
          })
          .catch(function () {
            return caches.match(event.request)
          })
      }),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return (
        cached ||
        fetch(event.request, { cache: "no-store" }).catch(function () {
          return cached
        })
      )
    }),
  )
})
