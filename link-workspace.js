/**
 * Link opener.
 *
 * The upstream LibRedirect config supplies service target patterns and frontend
 * metadata. The instances list supplies the actual instance hosts. This file
 * joins the two without requiring a backend or a build step. Opening a link
 * always hands off to a new browser tab.
 */
;(function () {
  "use strict"

  var CONFIG_URL = "https://raw.githubusercontent.com/libredirect/browser_extension/master/src/config.json"
  var NETWORK_ORDER = ["clearnet", "tor", "i2p", "loki"]
  var NETWORK_LABELS = { clearnet: "Clearnet", tor: "Tor", i2p: "I2P", loki: "Loki" }

  // data.json (instance hosts) occasionally uses a different key than
  // config.json (frontend metadata) for the same live frontend, e.g. an
  // upstream rename or casing drift between the two independent sources.
  // Without this, the frontend never matches its real service group and
  // shows up instead as a stray, ungrouped entry with no name/adapter.
  var DATA_KEY_ALIASES = {
    translite: "transLite",
    poketube: "poke",
  }
  var ALIASED_DATA_KEYS = {}
  Object.keys(DATA_KEY_ALIASES).forEach(function (id) {
    ALIASED_DATA_KEYS[DATA_KEY_ALIASES[id]] = true
  })

  function dataKeyFor(frontendId) {
    return DATA_KEY_ALIASES[frontendId] || frontendId
  }

  var data = window.__libredirectInstancesData || null
  var config = null
  var catalog = []
  var serviceIndex = {}
  var frontendIndex = {}
  var initialized = false

  var sourceInput = document.getElementById("link-source")
  var serviceSelect = document.getElementById("link-service")
  var frontendSelect = document.getElementById("link-frontend")
  var networkSelect = document.getElementById("link-network")
  var instanceSelect = document.getElementById("link-instance")
  var openButton = document.getElementById("link-open")
  var hintEl = document.getElementById("link-open-hint")
  var redirectOverlayCopy = document.getElementById("redirect-overlay-copy")

  var autoRedirectHandled = false
  var autoRedirectQuery = null

  function readQueryOverrides() {
    var params
    try {
      params = new URLSearchParams(window.location.search)
    } catch (e) {
      return null
    }
    if (!params.has("url")) return null
    return {
      url: params.get("url") || "",
      frontend: params.get("frontend") || "",
      network: params.get("network") || "",
      instance: params.get("instance") || "",
    }
  }

  // Checked synchronously, before any fetch resolves, so the overlay can cover
  // the list immediately and avoid a flash of the full page before redirecting.
  autoRedirectQuery = readQueryOverrides()

  // The redirect-pending class is normally set by an inline script at the top
  // of <body>, synchronously, before the rest of the page is even parsed.
  // These are defensive re-applications for this module's own lifecycle.
  function showRedirectOverlay(message) {
    document.documentElement.classList.add("redirect-pending")
    if (redirectOverlayCopy) redirectOverlayCopy.textContent = message || ""
  }

  function hideRedirectOverlay() {
    document.documentElement.classList.remove("redirect-pending")
  }

  if (autoRedirectQuery) showRedirectOverlay(autoRedirectQuery.url)

  function makeEl(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function replaceChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  function parseHttpUrl(value) {
    try {
      var parsed = new URL(String(value || "").trim())
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
      if (!parsed.hostname) return null
      return parsed
    } catch (e) {
      return null
    }
  }

  function cleanBase(value) {
    return String(value || "").replace(/\/+$/, "")
  }

  function appendPath(base, path, search, hash) {
    var result = cleanBase(base) + (path || "")
    if (search) result += search
    if (hash) result += hash
    return result
  }

  function option(select, value, label) {
    var item = document.createElement("option")
    item.value = value
    item.textContent = label
    select.appendChild(item)
  }

  function hasInstances(frontendId) {
    var key = dataKeyFor(frontendId)
    if (!data || !data[key]) return false
    for (var i = 0; i < NETWORK_ORDER.length; i++) {
      var urls = data[key][NETWORK_ORDER[i]]
      if (Array.isArray(urls) && urls.length > 0) return true
    }
    return false
  }

  function getInstances(frontendId, network) {
    var key = dataKeyFor(frontendId)
    if (!data || !data[key]) return []
    var urls = data[key][network]
    return Array.isArray(urls) ? urls.slice() : []
  }

  function getFrontend(serviceId, frontendId) {
    var service = serviceIndex[serviceId]
    if (!service) return null
    for (var i = 0; i < service.frontends.length; i++) {
      if (service.frontends[i].id === frontendId) return service.frontends[i]
    }
    return null
  }

  function getServiceFrontends(serviceId) {
    var service = serviceIndex[serviceId]
    return service ? service.frontends : []
  }

  function buildCatalog() {
    catalog = []
    serviceIndex = {}
    frontendIndex = {}
    if (!config || !config.services || !data) return

    var serviceNames = Object.keys(config.services)
    for (var i = 0; i < serviceNames.length; i++) {
      var serviceId = serviceNames[i]
      var source = config.services[serviceId]
      var service = {
        id: serviceId,
        label: source.name || serviceId,
        targets: Array.isArray(source.targets) ? source.targets.slice() : [],
        defaultFrontend: source.options && source.options.frontend ? source.options.frontend : "",
        frontends: [],
      }
      var frontendNames = source.frontends ? Object.keys(source.frontends) : []
      for (var j = 0; j < frontendNames.length; j++) {
        var frontendId = frontendNames[j]
        var frontend = source.frontends[frontendId]
        if (!hasInstances(frontendId)) continue
        var item = {
          id: frontendId,
          label: frontend.name || frontendId,
          serviceId: serviceId,
        }
        service.frontends.push(item)
        frontendIndex[frontendId] = item
      }
      if (service.frontends.length > 0) {
        serviceIndex[serviceId] = service
        catalog.push(service)
      }
    }

    // Keep every frontend from the live instances data selectable even when
    // the upstream config uses a newer/different key. Such entries use the
    // safe generic path/query adapter until a service-specific rule is added.
    var dataFrontends = Object.keys(data)
    for (var k = 0; k < dataFrontends.length; k++) {
      var dataFrontendId = dataFrontends[k]
      // Already reachable under its canonical config id via DATA_KEY_ALIASES
      // above; skip so it doesn't also show up as a second, ungrouped entry.
      if (ALIASED_DATA_KEYS[dataFrontendId]) continue
      if (!hasInstances(dataFrontendId) || frontendIndex[dataFrontendId]) continue
      var syntheticServiceId = "frontend:" + dataFrontendId
      var syntheticFrontend = {
        id: dataFrontendId,
        label: dataFrontendId,
        serviceId: syntheticServiceId,
      }
      var syntheticService = {
        id: syntheticServiceId,
        label: dataFrontendId,
        targets: [],
        defaultFrontend: dataFrontendId,
        frontends: [syntheticFrontend],
      }
      serviceIndex[syntheticServiceId] = syntheticService
      catalog.push(syntheticService)
      frontendIndex[dataFrontendId] = syntheticFrontend
    }
  }

  function matchesService(service, parsed) {
    for (var i = 0; i < service.targets.length; i++) {
      try {
        if (new RegExp(service.targets[i]).test(parsed.href)) return true
      } catch (e) {}
    }
    return false
  }

  function detectService(parsed) {
    if (!parsed || !config || !config.services) return ""
    for (var i = 0; i < catalog.length; i++) {
      if (matchesService(catalog[i], parsed)) return catalog[i].id
    }
    return ""
  }

  function chooseNetwork(frontendId, preferred) {
    if (preferred && getInstances(frontendId, preferred).length > 0) return preferred
    for (var i = 0; i < NETWORK_ORDER.length; i++) {
      if (getInstances(frontendId, NETWORK_ORDER[i]).length > 0) return NETWORK_ORDER[i]
    }
    return ""
  }

  function chooseFrontend(serviceId, preferred) {
    var frontends = getServiceFrontends(serviceId)
    if (preferred) {
      for (var i = 0; i < frontends.length; i++) {
        if (frontends[i].id === preferred) return preferred
      }
    }
    var service = serviceIndex[serviceId]
    if (service && service.defaultFrontend && hasInstances(service.defaultFrontend)) return service.defaultFrontend
    return frontends.length > 0 ? frontends[0].id : ""
  }

  function frontendLabel(frontendId) {
    return frontendIndex[frontendId] ? frontendIndex[frontendId].label : frontendId
  }

  function serviceLabel(serviceId) {
    return serviceIndex[serviceId] ? serviceIndex[serviceId].label : serviceId
  }

  function selectedInstance() {
    var values = getInstances(frontendSelect.value, networkSelect.value)
    return instanceSelect.value || values[0] || ""
  }

  function setHint(message, isError) {
    if (!hintEl) return
    hintEl.textContent = message
    if (isError) hintEl.classList.add("is-error")
    else hintEl.classList.remove("is-error")
  }

  function populateServices(selected) {
    replaceChildren(serviceSelect)
    option(serviceSelect, "", "Choose service…")
    for (var i = 0; i < catalog.length; i++) {
      option(serviceSelect, catalog[i].id, catalog[i].label)
    }
    serviceSelect.disabled = false
    if (selected && serviceIndex[selected]) serviceSelect.value = selected
  }

  function populateFrontends(selected) {
    replaceChildren(frontendSelect)
    option(frontendSelect, "", "Choose front-end…")
    var frontends = getServiceFrontends(serviceSelect.value)
    for (var i = 0; i < frontends.length; i++) {
      option(frontendSelect, frontends[i].id, frontends[i].label)
    }
    var next = chooseFrontend(serviceSelect.value, selected)
    frontendSelect.value = next
    frontendSelect.disabled = frontends.length === 0
  }

  function populateNetworks(selected) {
    replaceChildren(networkSelect)
    var frontendId = frontendSelect.value
    for (var i = 0; i < NETWORK_ORDER.length; i++) {
      var network = NETWORK_ORDER[i]
      var count = getInstances(frontendId, network).length
      if (count === 0) continue
      var label = NETWORK_LABELS[network] + " · " + count
      option(networkSelect, network, label)
    }
    var next = chooseNetwork(frontendId, selected)
    networkSelect.value = next
    networkSelect.disabled = !next
  }

  function populateInstances(selected) {
    replaceChildren(instanceSelect)
    var values = getInstances(frontendSelect.value, networkSelect.value)
    option(instanceSelect, "", values.length > 0 ? "Recommended instance" : "No instance available")
    for (var i = 0; i < values.length; i++) option(instanceSelect, values[i], values[i].replace(/^https?:\/\//, ""))
    instanceSelect.value = selected && values.indexOf(selected) >= 0 ? selected : ""
    instanceSelect.disabled = values.length === 0
  }

  function updateComposerState() {
    var parsed = parseHttpUrl(sourceInput.value)
    var serviceId = serviceSelect.value
    var frontendId = frontendSelect.value
    var network = networkSelect.value
    var ready = !!parsed && !!serviceId && !!frontendId && !!network && getInstances(frontendId, network).length > 0
    openButton.disabled = !ready
    if (!parsed) {
      if (sourceInput.value.trim()) setHint("Enter a valid http or https link.", true)
      else setHint("Paste a supported source link to choose an instance.", false)
      return
    }
    if (!serviceId) {
      setHint("Service could not be detected. Choose one manually.", true)
      return
    }
    if (!frontendId) {
      setHint(serviceLabel(serviceId) + " has no listed frontend instance yet.", true)
      return
    }
    setHint(frontendLabel(frontendId) + " will open in a new browser tab.", false)
  }

  function syncComposer(serviceId, frontendId, network, instance) {
    populateServices(serviceId)
    populateFrontends(frontendId)
    populateNetworks(network)
    populateInstances(instance)
    updateComposerState()
  }

  function handleSourceInput() {
    var parsed = parseHttpUrl(sourceInput.value)
    var detected = detectService(parsed)
    populateServices(detected)
    populateFrontends("")
    populateNetworks("")
    populateInstances("")
    updateComposerState()
  }

  function stripTracking(url) {
    ;["si", "ref_src", "ref_url", "s", "t"].forEach(function (key) {
      url.searchParams.delete(key)
    })
  }

  // Builds an OSM-style "#map=zoom/lat/lon" hash from a Google Maps URL, or
  // "#" when no map centre is present in the source link.
  function osmMapHash(url) {
    var m = /@(-?\d[0-9.]*),(-?\d[0-9.]*),(\d{1,2})[.z]/.exec(url.pathname)
    var lat, lon, zoom
    if (m) {
      lat = m[1]
      lon = m[2]
      zoom = m[3]
    } else if (url.searchParams.has("center")) {
      var center = url.searchParams.get("center").split(",")
      lat = center[0]
      lon = center[1]
      zoom = url.searchParams.get("zoom") || "17"
    }
    if (zoom && lat && lon) return "#map=" + zoom + "/" + lat + "/" + lon
    return "#"
  }

  function buildTarget(frontendId, sourceUrl, instanceBase) {
    var url = parseHttpUrl(sourceUrl)
    if (!url || !instanceBase) return ""
    var base = cleanBase(instanceBase)
    stripTracking(url)

    switch (frontendId) {
      case "invidious":
        if (url.hostname === "youtu.be" || (url.hostname.indexOf("youtube.com") >= 0 && url.pathname.indexOf("/live/") === 0)) {
          var videoId = url.pathname.split("/").filter(Boolean).pop()
          return base + "/watch?v=" + encodeURIComponent(videoId) + (url.search ? "&" + url.search.substring(1) : "")
        }
        return appendPath(base, url.pathname, url.search, url.hash)

      case "nitter": {
        // Image/video CDN hosts (pbs./video.twimg.com) proxy through Nitter's
        // own /pic route, which expects the trailing "id.format?extra" chunk
        // URL-encoded as a single opaque suffix rather than a normal query.
        var nitterMediaHost = url.hostname.split(".")[0]
        if (nitterMediaHost === "pbs" || nitterMediaHost === "video") {
          var picMatch = /(.*)\?format=(.*)&(.*)/.exec(url.search)
          if (picMatch) {
            return base + "/pic" + url.pathname + encodeURIComponent(picMatch[1] + "." + picMatch[2] + "?" + picMatch[3])
          }
          return base + "/pic" + url.pathname + url.search
        }
        if (url.pathname.split("/").indexOf("tweets") >= 0) {
          return base + url.pathname.replace("/tweets", "") + url.search
        }
        if (url.hostname === "t.co") return base + "/t.co" + url.pathname
        return base + url.pathname + url.search + "#m"
      }

      case "priviblur": {
        if (url.hostname === "www.tumblr.com") return appendPath(base, url.pathname, url.search, url.hash)
        if (url.hostname.indexOf("assets") === 0) return appendPath(base + "/tblr/assets", url.pathname, url.search, url.hash)
        if (url.hostname.indexOf("static") === 0) return appendPath(base + "/tblr/static", url.pathname, url.search, url.hash)
        var media = /^([0-9]+)\.media\.tumblr\.com/.exec(url.hostname)
        if (media) return appendPath(base + "/tblr/media/" + media[1], url.pathname, url.search, url.hash)
        var blog = /^(?:www\.)?([a-z\d-]+)\.tumblr\.com/.exec(url.hostname)
        if (blog) {
          var blogPath = url.pathname.indexOf("/post") === 0 ? url.pathname.substring(5) : url.pathname
          return appendPath(base + "/" + blog[1], blogPath, url.search, url.hash)
        }
        return appendPath(base, url.pathname, url.search, url.hash)
      }

      case "safetwitch":
      case "twineo":
        if (url.hostname.indexOf("clips.") === 0) return appendPath(base + "/clip", url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "rimgo":
        if (url.hostname.indexOf("stack.") >= 0) return appendPath(base + "/stack", url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "binternet":
        if (url.hostname === "i.pinimg.com") return base + "/image_proxy.php?url=" + encodeURIComponent(url.href)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "painterest":
        if (url.hostname === "i.pinimg.com") return base + "/_/proxy?url=" + encodeURIComponent(url.href)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "pinless":
        if (url.hostname === "i.pinimg.com") return base + "/image?url=" + encodeURIComponent(url.href)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "redlib":
      case "libreddit":
        if (url.hostname === "i.redd.it") return appendPath(base + "/img", url.pathname, "", "")
        return appendPath(base, url.pathname, url.search, url.hash)

      case "scribe":
      case "small":
      case "libMedium":
      case "freedium": {
        var medium = /^(?:link|cdn-images-\d+|(.+))\.medium\.com/.exec(url.hostname)
        if (medium && medium[1]) return appendPath(base + "/@" + medium[1], url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)
      }

      case "searx":
      case "searxng": {
        var q = url.searchParams.get("q") || url.searchParams.get("query") || url.searchParams.get("search_query")
        return q ? base + "/search?q=" + encodeURIComponent(q) : base
      }

      case "whoogle":
      case "websurfx":
        return base + "/search" + url.search

      case "4get": {
        var query = url.searchParams.get("q")
        return query ? base + "/web?s=" + encodeURIComponent(query) : base
      }

      case "librey":
        return base + "/search.php" + url.search

      case "wikiless":
      case "wikimore": {
        var hostParts = url.hostname.split(".")
        if (frontendId === "wikimore" && hostParts.length > 2 && hostParts[0] !== "www") {
          return appendPath(base + "/wiki/" + hostParts[0], url.pathname, url.search, url.hash)
        }
        if (frontendId === "wikiless" && hostParts.length > 2 && hostParts[0] !== "www") url.searchParams.set("lang", hostParts[0])
        return appendPath(base, url.pathname, url.search, url.hash)
      }

      case "breezeWiki":
      case "phantom": {
        var wiki = /^([a-z\d-]+)\.(?:fandom|wikia)\.com/.exec(url.hostname)
        if (wiki && wiki[1] !== "www") return appendPath(base + "/" + wiki[1], url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)
      }

      case "gothub":
        if (url.hostname === "gist.github.com") return appendPath(base + "/gist", url.pathname, url.search, url.hash)
        if (url.hostname === "raw.githubusercontent.com") return appendPath(base + "/raw", url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)

      case "laboratory": {
        // Laboratory proxies arbitrary GitLab hosts, so the source hostname
        // has to travel as the first path segment (instance/gitlab.com/…).
        var labPath = url.pathname === "/" ? "" : url.pathname
        return appendPath(base + "/" + url.hostname, labPath, url.search, url.hash)
      }

      case "tent": {
        if (url.hostname === "bandcamp.com" && url.pathname === "/search") {
          return base + "/search.php?query=" + encodeURIComponent(url.searchParams.get("q") || "")
        }
        if (url.hostname.indexOf(".bandcamp.com") > 0) {
          var artistMatch = /^(.*)\.bandcamp\.com$/.exec(url.hostname)
          var artist = artistMatch ? artistMatch[1] : ""
          if (url.pathname === "/" || url.pathname === "/music") {
            return base + "/artist.php?name=" + encodeURIComponent(artist)
          }
          var releaseMatch = /^\/([^/]+)\/([^/]+)/.exec(url.pathname)
          if (releaseMatch) {
            return (
              base +
              "/release.php?artist=" +
              encodeURIComponent(artist) +
              "&type=" +
              encodeURIComponent(releaseMatch[1]) +
              "&name=" +
              encodeURIComponent(releaseMatch[2])
            )
          }
        }
        if (url.hostname === "f4.bcbits.com") {
          var imageMatch = /\/img\/(.*)/.exec(url.pathname)
          if (imageMatch) return base + "/image.php?file=" + imageMatch[1]
        }
        if (url.hostname === "t4.bcbits.com") {
          var streamMatch = /\/stream\/([^/]+)\/([^/]+)\/([^/]+)/.exec(url.pathname)
          if (streamMatch) {
            var token = url.searchParams.get("token") || ""
            return (
              base +
              "/audio.php/?directory=" +
              streamMatch[1] +
              "&format=" +
              streamMatch[2] +
              "&file=" +
              streamMatch[3] +
              "&token=" +
              encodeURIComponent(token)
            )
          }
        }
        return appendPath(base, url.pathname, url.search, url.hash)
      }

      case "osm": {
        var placeMatch = /\/place\/(.*?)\//.exec(url.pathname)
        if (placeMatch) return base + "/search?query=" + placeMatch[1] + osmMapHash(url)

        if (url.searchParams.has("ll")) {
          var llParts = url.searchParams.get("ll").split(",")
          return base + "/search?query=" + llParts[0] + "%2C" + llParts[1]
        }
        if (url.searchParams.has("viewpoint")) {
          var vpParts = url.searchParams.get("viewpoint").split(",")
          return base + "/search?query=" + vpParts[0] + "%2C" + vpParts[1]
        }

        var mapsQuery = url.searchParams.get("q") || url.searchParams.get("query")
        if (mapsQuery) return base + "/search?query=" + encodeURIComponent(mapsQuery) + osmMapHash(url) + "&layers=mapnik"

        // Directions and embed links need geocoding a free-text address,
        // which upstream does via a live call to Nominatim. This app makes
        // no outbound requests beyond the chosen instance itself, so those
        // two cases fall back to a plain passthrough instead.
        if (url.pathname.indexOf("/dir") >= 0 || url.pathname.indexOf("/embed") >= 0) {
          return appendPath(base, url.pathname, url.search, url.hash)
        }

        return base + "/" + osmMapHash(url) + "&layers=mapnik"
      }

      case "skyview":
        return url.pathname === "/" ? base : base + "?url=" + encodeURIComponent(url.href)

      case "libreTranslate":
        return base + "/?" + url.search.substring(1).replace(/(^|&)sl=/, "$1source=").replace(/(^|&)tl=/, "$1target=").replace(/(^|&)text=/, "$1q=")

      case "simplyTranslate":
      case "translite":
        return base + "/" + url.search

      case "mozhi":
        // Mozhi has no URL-based deep-link support; always land on the instance root.
        return base

      case "anonymousOverflow":
        if (url.hostname === "stackoverflow.com" && url.pathname.indexOf("/a/") === 0) {
          var answer = /\/a\/(\d+)/.exec(url.pathname)
          if (answer) return base + "/questions/" + answer[1] + url.search
        }
        return appendPath(base, url.pathname, url.search, url.hash)

      case "mikuInvidious":
        if (url.hostname === "space.bilibili.com") return appendPath(base + "/space", url.pathname, url.search, url.hash)
        return appendPath(base, url.pathname, url.search, url.hash)

      default:
        return appendPath(base, url.pathname, url.search, url.hash)
    }
  }

  function validateTarget(target) {
    var parsed = parseHttpUrl(target)
    return parsed ? parsed.href : ""
  }

  function openExternal(target) {
    var parsed = parseHttpUrl(target)
    if (!parsed) return
    window.open(parsed.href, "_blank", "noopener,noreferrer")
  }

  var REDIRECT_REASON_MESSAGES = {
    "invalid-url": "The url parameter is not a valid http or https link.",
    "no-frontend": "Service could not be detected from the link. Choose a front-end manually.",
    "no-network": "No reachable network found for this front-end. Choose manually.",
    "no-instance": "No instance available for this selection. Choose manually.",
    "bad-target": "This adapter could not produce a valid target URL. Choose manually.",
  }

  // Resolves a ?url=&frontend=&network=&instance= query into a redirect target,
  // reusing the same recommendation logic as the composer. `frontend`, `network`,
  // and `instance` are optional overrides: each is only honored when it names a
  // real, reachable option; otherwise the recommended pick is used instead.
  function resolveAutoRedirect(query) {
    var parsed = parseHttpUrl(query.url)
    if (!parsed) return { ok: false, reason: "invalid-url", serviceId: "", frontendId: "", network: "", instanceBase: "" }

    var serviceId = detectService(parsed)

    var frontendId = ""
    if (query.frontend && frontendIndex[query.frontend]) {
      frontendId = query.frontend
      if (!serviceId) serviceId = frontendIndex[query.frontend].serviceId
    } else if (serviceId) {
      frontendId = chooseFrontend(serviceId, "")
    }
    if (!frontendId) return { ok: false, reason: "no-frontend", serviceId: serviceId, frontendId: "", network: "", instanceBase: "" }

    var network = ""
    if (query.network && getInstances(frontendId, query.network).length > 0) {
      network = query.network
    } else {
      network = chooseNetwork(frontendId, "")
    }
    if (!network) return { ok: false, reason: "no-network", serviceId: serviceId, frontendId: frontendId, network: "", instanceBase: "" }

    var instances = getInstances(frontendId, network)
    var instanceBase = ""
    if (query.instance && instances.indexOf(query.instance) >= 0) {
      instanceBase = query.instance
    } else {
      instanceBase = instances[0] || ""
    }
    if (!instanceBase) return { ok: false, reason: "no-instance", serviceId: serviceId, frontendId: frontendId, network: network, instanceBase: "" }

    var target = validateTarget(buildTarget(frontendId, parsed.href, instanceBase))
    if (!target) return { ok: false, reason: "bad-target", serviceId: serviceId, frontendId: frontendId, network: network, instanceBase: instanceBase }

    return { ok: true, target: target, serviceId: serviceId, frontendId: frontendId, network: network, instanceBase: instanceBase }
  }

  function maybeAutoRedirect() {
    if (autoRedirectHandled) return
    if (!autoRedirectQuery) return
    autoRedirectHandled = true

    var result = resolveAutoRedirect(autoRedirectQuery)
    if (result.ok) {
      window.location.replace(result.target)
      return
    }

    hideRedirectOverlay()
    sourceInput.value = autoRedirectQuery.url
    syncComposer(result.serviceId, result.frontendId, result.network, result.instanceBase)
    setHint(REDIRECT_REASON_MESSAGES[result.reason] || "Could not auto-redirect. Choose an instance manually.", true)
    sourceInput.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  function openFromComposer() {
    var parsed = parseHttpUrl(sourceInput.value)
    var serviceId = serviceSelect.value
    var frontendId = frontendSelect.value
    var network = networkSelect.value
    var instance = selectedInstance()
    if (!parsed || !serviceId || !frontendId || !network || !instance) return
    var target = validateTarget(buildTarget(frontendId, parsed.href, instance))
    if (!target) {
      setHint("This adapter could not produce a valid target URL.", true)
      return
    }
    openExternal(target)
  }

  function openDirectInstance(frontendId, instance) {
    var frontend = frontendIndex[frontendId]
    var target = validateTarget(instance)
    if (!frontend || !target) return
    openExternal(target)
  }

  function handleClick(event) {
    var target = event.target
    while (target && target !== document && !target.getAttribute("data-action")) {
      target = target.parentNode
    }
    if (!target || target === document) return

    var openAction = target.getAttribute("data-action")
    if (openAction === "open") {
      event.preventDefault()
      openDirectInstance(target.getAttribute("data-open-service"), target.getAttribute("data-open-url"))
    }
  }

  function bindUI() {
    if (initialized) return
    initialized = true
    sourceInput.addEventListener("input", handleSourceInput)
    serviceSelect.addEventListener("change", function () {
      populateFrontends("")
      populateNetworks("")
      populateInstances("")
      updateComposerState()
    })
    frontendSelect.addEventListener("change", function () {
      populateNetworks("")
      populateInstances("")
      updateComposerState()
    })
    networkSelect.addEventListener("change", function () {
      populateInstances("")
      updateComposerState()
    })
    instanceSelect.addEventListener("change", updateComposerState)
    openButton.addEventListener("click", openFromComposer)
    document.addEventListener("click", handleClick)
    populateServices("")
    populateFrontends("")
    populateNetworks("")
    populateInstances("")
    updateComposerState()
  }

  function initialize() {
    if (!data || !config) return
    buildCatalog()
    bindUI()
    maybeAutoRedirect()
  }

  window.addEventListener("libredirect-instances-ready", function (event) {
    data = event.detail
    initialize()
  })

  fetch(CONFIG_URL)
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status)
      return response.json()
    })
    .then(function (value) {
      config = value
      initialize()
    })
    .catch(function () {
      config = { services: {} }
      setHint("Service detection data could not be loaded. Instance rows remain available with generic path handling.", true)
      if (data) {
        buildCatalog()
        bindUI()
        maybeAutoRedirect()
      }
    })

  initialize()
})()
