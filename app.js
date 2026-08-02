/**
 * @fileoverview LibRedirect Instances List - Frontend application for browsing,
 * filtering, searching, and health-checking LibRedirect service instances across
 * multiple network types (Clearnet, Tor, I2P, Loki).
 *
 * Features:
 *   - Fetches service instance data from a remote JSON endpoint
 *   - Real-time instance reachability checking via HTTP GET (no-cors) requests
 *   - Multi-network filtering via pill toggle buttons (clearnet, tor, i2p, loki)
 *   - Full-text search with highlighted matches
 *   - Per-service and per-URL favorites (persisted in localStorage)
 *   - Global "Hide Unavailable", "Collapse All", "Favorites only" controls
 *   - Accessible <details>/<summary> service sections
 *   - Live stats bar (services / total / shown / favorites)
 *
 * @module libredirect-instances
 */

;(function () {
  "use strict"

  // =========================================================================
  // CONSTANTS
  // =========================================================================

  /** @constant {string} */
  var NETWORKS_URL = "https://raw.githubusercontent.com/libredirect/instances/refs/heads/main/networks.json"
  /** @constant {string} */
  var DATA_URL = "https://raw.githubusercontent.com/libredirect/instances/main/data.json"
  /** @constant {string[]} */
  var ALLOWED_SCHEMES = ["https:", "http:"]

  /** @type {Record<string, string>} */
  var NETWORK_LABELS = { clearnet: "Clearnet", tor: "Tor", i2p: "I2P", loki: "Loki" }
  /** @type {string[]} */
  var NETWORK_ORDER = ["clearnet", "tor", "i2p", "loki"]
  /** @type {string[]} */
  var SKIP_TLDS = ["onion", "i2p", "loki"]

  /** @constant {number} */
  var CHECK_TIMEOUT_MS = 6000
  /** @constant {number} */
  var CONCURRENCY = 16

  /** @constant {number} */
  var BADGE_REACHABLE = 1
  /** @constant {number} */
  var BADGE_UNREACHABLE = 0
  /** @constant {number} */
  var BADGE_SKIP = -1

  // =========================================================================
  // PLATFORM MAPPING
  // =========================================================================

  /** @constant {Record<string, string[]>} */
  var PLATFORM_MAPPING = {
    YouTube: [
      "Invidious",
      "Materialious",
      "Piped",
      "Piped-Material",
      "Poke",
      "CloudTube",
      "LightTube",
      "Tubo",
      "FreeTube",
      "Yattee",
      "FreeTube PWA",
      "ViewTube",
      "ytify",
    ],
    "YT Music": ["ytify", "Hyperpipe", "Invidious", "FreeTube"],
    Twitter: ["Nitter"],
    ChatGPT: ["DuckDuckGo AI Chat", "Lumo by Proton"],
    Bluesky: ["Skyview", "Skylib"],
    Reddit: ["Libreddit", "Redlib", "Teddit", "Eddrit", "Troddit"],
    Tumblr: ["Priviblur"],
    Twitch: ["SafeTwitch", "Twineo"],
    TikTok: ["ProxiTok", "Offtiktok"],
    Instagram: ["kittygram", "Proxigram"],
    IMDb: ["libremdb"],
    Bilibili: ["MikuInvidious"],
    Pixiv: ["PixivFE", "LiteXiv", "Vixipy", "Pixiv Viewer"],
    Fandom: ["BreezeWiki", "Phantom"],
    Imgur: ["rimgo"],
    Pinterest: ["Binternet", "Painterest"],
    SoundCloud: ["Tubo", "soundcloak"],
    Bandcamp: ["Tent"],
    "Tekstowo.pl": ["TekstoLibre"],
    Genius: ["Dumb", "Intellectual"],
    Medium: ["Scribe", "LibMedium", "Small", "Freedium"],
    Quora: ["Quetre"],
    GitHub: ["Gothub"],
    GitLab: ["Laboratory"],
    "Stack Overflow": ["AnonymousOverflow"],
    Reuters: ["Neuters"],
    Snopes: ["Suds"],
    iFunny: ["UNfunny"],
    Tenor: ["Soprano"],
    KnowYourMeme: ["MeMe"],
    "Urban Dictionary": ["Rural Dictionary"],
    Goodreads: ["BiblioReads"],
    "Wolfram Alpha": ["WolfreeAlpha"],
    Instructables: ["Structables", "Destructables", "Indestructables"],
    Wikipedia: ["Wikiless", "Wikimore"],
    "Wayback Machine": ["Wayback Classic"],
    Pastebin: ["Pasted"],
    Search: ["SearXNG", "SearX", "Whoogle", "LibreY", "4get", "Websurfx"],
    Translate: ["SimplyTranslate", "Mozhi", "LibreTranslate", "Translite", "Lingva", "Mezzo"],
    Maps: ["OpenStreetMap", "OSM"],
    Meet: ["Jitsi"],
    "Send Files": ["Send"],
    "Paste Text": ["PrivateBin", "Pasted", "Pasty"],
    Office: ["CryptPad"],
    "Ultimate Guitar": ["Freetar", "Ultimate Tab"],
    "Baidu Tieba": ["Rat Aint Tieba"],
    Threads: ["Shoelace"],
    DeviantArt: ["SkunkyArt"],
    GeeksforGeeks: ["NerdsforNerds", "Ducks for Ducks"],
    Coub: ["Koub"],
    Chefkoch: ["GoCook"],
  }

  /**
   * Normalize alternative front-end name for matching.
   * @param {string} name
   * @returns {string}
   */
  function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "")
  }

  /** @type {Record<string, string[]>} */
  var serviceToPlatforms = {}

  // Populate service-to-platform mapping index
  for (var platform in PLATFORM_MAPPING) {
    if (PLATFORM_MAPPING.hasOwnProperty(platform)) {
      var frontends = PLATFORM_MAPPING[platform]
      for (var j = 0; j < frontends.length; j++) {
        var norm = normalizeName(frontends[j])
        if (!serviceToPlatforms[norm]) {
          serviceToPlatforms[norm] = []
        }
        if (serviceToPlatforms[norm].indexOf(platform) === -1) {
          serviceToPlatforms[norm].push(platform)
        }
      }
    }
  }

  // =========================================================================
  // DOM REFERENCES
  // =========================================================================

  var instancesContainer = document.getElementById("instances")
  var loadingEl = instancesContainer ? instancesContainer.querySelector(".loading-state") : null

  var searchInput = document.getElementById("search")
  var netFiltersEl = document.getElementById("net-filters")
  var checkAllBtn = document.getElementById("check-all")
  var hideUnavailBtn = document.getElementById("hide-unavail")
  var toggleCollapseBtn = document.getElementById("toggle-collapse")
  var favOnlyBtn = document.getElementById("fav-only")
  var clearFavsBtn = document.getElementById("clear-favs")
  var clearDataBtn = document.getElementById("clear-data")
  var toastEl = document.getElementById("toast")
  var toolbarEl = document.querySelector(".toolbar")
  var toolbarToggleBtn = document.getElementById("toolbar-toggle")

  var statServices = document.getElementById("stat-services")
  var statTotal = document.getElementById("stat-total")
  var statShown = document.getElementById("stat-shown")
  var statFavs = document.getElementById("stat-favs")
  var healthStatEl = document.getElementById("health-stat")
  var healthStatWrap = document.getElementById("health-stat-wrap")
  var healthSep = document.getElementById("health-sep")

  /** Pill buttons keyed by network name. */
  var netPills = {}
  if (netFiltersEl) {
    var pills = netFiltersEl.querySelectorAll("[data-net]")
    for (var i = 0; i < pills.length; i++) {
      netPills[pills[i].getAttribute("data-net")] = pills[i]
    }
  }

  // =========================================================================
  // STORAGE KEYS
  // =========================================================================

  var FAV_STORAGE_KEY = "libredirect_favorites"
  var FILTER_STORAGE_KEY = "libredirect_network_filters"
  var TOOLBAR_STORAGE_KEY = "libredirect_toolbar_collapsed"
  var FAV_SVC_KEY = "svc_"
  var FAV_URL_KEY = "url_"

  // =========================================================================
  // APPLICATION STATE
  // =========================================================================

  /** @type {?AllData} */
  var allData = null
  /** @type {HealthResults} */
  var healthResults = {}
  /** @type {PendingChecks} */
  var pendingChecks = {}
  /** @type {Favorites} */
  var favorites = { services: {}, urls: {} }

  /** Active network filters keyed by network name. */
  var activeNets = { clearnet: true, tor: true, i2p: true, loki: true }
  /** When true, only favorited services/URLs are rendered. */
  var favOnly = false
  /** When true, instances marked unreachable are hidden. */
  var hideUnavail = false
  /** Per-service open state for <details> sections. Default closed. */
  var sectionOpen = {}
  /** True while a global health check is running. */
  var checkRunning = false
  /** Services currently undergoing a per-service health check. Value is the live progress string ("done/total"). */
  var checkingServices = {}
  /** When true, the mobile toolbar (search + buttons) is collapsed. */
  var toolbarCollapsed = false

  /** Render-time counters, surfaced to the stats bar. */
  var renderStats = { services: 0, total: 0, shown: 0 }

  // =========================================================================
  // PERSISTENCE: FAVORITES
  // =========================================================================

  function loadFavorites() {
    try {
      var raw = localStorage.getItem(FAV_STORAGE_KEY)
      if (raw) favorites = JSON.parse(raw)
      if (!favorites.services) favorites.services = {}
      if (!favorites.urls) favorites.urls = {}
    } catch (e) {
      favorites = { services: {}, urls: {} }
    }
  }

  function saveFavorites() {
    try {
      var hasFav = false
      for (var k in favorites.services) {
        hasFav = true
        break
      }
      if (!hasFav) {
        for (var u in favorites.urls) {
          hasFav = true
          break
        }
      }
      if (hasFav) localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(favorites))
      else localStorage.removeItem(FAV_STORAGE_KEY)
    } catch (e) {}
  }

  // =========================================================================
  // PERSISTENCE: NETWORK FILTERS
  // =========================================================================

  function loadFilters() {
    try {
      var raw = localStorage.getItem(FILTER_STORAGE_KEY)
      if (raw) {
        var saved = JSON.parse(raw)
        for (var key in saved) {
          if (netPills[key]) {
            activeNets[key] = !!saved[key]
          }
        }
      }
      syncPillClasses()
    } catch (e) {}
  }

  function saveFilters() {
    try {
      var state = {}
      var allDefault = true
      for (var key in activeNets) {
        state[key] = activeNets[key]
        if (!state[key]) allDefault = false
      }
      if (allDefault) localStorage.removeItem(FILTER_STORAGE_KEY)
      else localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state))
    } catch (e) {}
  }

  /** Reflect {@link activeNets} into the pill buttons' `active` class. */
  function syncPillClasses() {
    for (var key in netPills) {
      if (activeNets[key]) netPills[key].classList.add("active")
      else netPills[key].classList.remove("active")
    }
  }

  // =========================================================================
  // PERSISTENCE: TOOLBAR COLLAPSE STATE
  // =========================================================================

  function loadToolbarState() {
    try {
      toolbarCollapsed = localStorage.getItem(TOOLBAR_STORAGE_KEY) === "1"
    } catch (e) {
      toolbarCollapsed = false
    }
    updateToolbarUI()
  }

  function saveToolbarState() {
    try {
      if (toolbarCollapsed) localStorage.setItem(TOOLBAR_STORAGE_KEY, "1")
      else localStorage.removeItem(TOOLBAR_STORAGE_KEY)
    } catch (e) {}
  }

  function updateToolbarUI() {
    if (!toolbarEl) return
    if (toolbarCollapsed) toolbarEl.classList.add("collapsed")
    else toolbarEl.classList.remove("collapsed")
    if (toolbarToggleBtn) toolbarToggleBtn.setAttribute("aria-expanded", String(!toolbarCollapsed))
  }

  // =========================================================================
  // FAVORITES LOGIC
  // =========================================================================

  function toggleFavService(name) {
    var key = FAV_SVC_KEY + name
    if (favorites.services[key]) delete favorites.services[key]
    else favorites.services[key] = true
    saveFavorites()
    refresh()
  }

  function toggleFavUrl(url) {
    var key = FAV_URL_KEY + url
    if (favorites.urls[key]) delete favorites.urls[key]
    else favorites.urls[key] = true
    saveFavorites()
    refresh()
  }

  function isFavService(name) {
    return !!favorites.services[FAV_SVC_KEY + name]
  }

  function isFavUrl(url) {
    return !!favorites.urls[FAV_URL_KEY + url]
  }

  function countFavorites() {
    var n = 0
    for (var k in favorites.services) n++
    for (var u in favorites.urls) n++
    return n
  }

  // =========================================================================
  // URL VALIDATION
  // =========================================================================

  function isAllowedUrl(url) {
    try {
      var parsed = new URL(url)
      if (ALLOWED_SCHEMES.indexOf(parsed.protocol) === -1) return false
      if (parsed.hostname.length === 0) return false
      return true
    } catch (e) {
      return false
    }
  }

  function isCheckableUrl(url) {
    if (!isAllowedUrl(url)) return false
    try {
      var host = new URL(url).hostname.toLowerCase()
      for (var i = 0; i < SKIP_TLDS.length; i++) {
        if (host.endsWith("." + SKIP_TLDS[i])) return false
      }
      return true
    } catch (e) {
      return false
    }
  }

  // =========================================================================
  // HEALTH CHECK LOGIC
  // =========================================================================

  /**
   * Check whether a single instance URL is reachable. Deduplicates concurrent
   * checks for the same URL and caches the result in {@link healthResults}.
   * @param {string} url
   * @returns {Promise<number>}
   */
  function checkUrlReachable(url) {
    if (pendingChecks[url]) return pendingChecks[url]
    if (healthResults.hasOwnProperty(url)) return Promise.resolve(healthResults[url])

    if (!isCheckableUrl(url)) {
      healthResults[url] = BADGE_SKIP
      var skipP = Promise.resolve(BADGE_SKIP)
      pendingChecks[url] = skipP
      skipP.then(function () {
        delete pendingChecks[url]
      })
      return skipP
    }

    var promise = new Promise(function (resolve) {
      var controller = new AbortController()
      var settled = false

      var timeoutId = setTimeout(function () {
        if (!settled) {
          settled = true
          controller.abort()
          healthResults[url] = BADGE_UNREACHABLE
          resolve(BADGE_UNREACHABLE)
        }
      }, CHECK_TIMEOUT_MS)

      fetch(url, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      })
        .then(function () {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            healthResults[url] = BADGE_REACHABLE
            resolve(BADGE_REACHABLE)
          }
        })
        .catch(function () {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            healthResults[url] = BADGE_UNREACHABLE
            resolve(BADGE_UNREACHABLE)
          }
        })
    })

    pendingChecks[url] = promise
    promise.then(function () {
      delete pendingChecks[url]
    })
    return promise
  }

  function getServiceUrls(serviceName) {
    var urls = []
    var service = allData[serviceName]
    if (!service) return urls
    for (var n = 0; n < NETWORK_ORDER.length; n++) {
      var net = NETWORK_ORDER[n]
      var netUrls = service[net]
      if (!netUrls) continue
      for (var u = 0; u < netUrls.length; u++) {
        if (isAllowedUrl(netUrls[u])) urls.push(netUrls[u])
      }
    }
    return urls
  }

  function collectCheckableUrls(urlSource) {
    var seen = {}
    var result = []
    for (var i = 0; i < urlSource.length; i++) {
      var url = urlSource[i]
      if (!seen[url]) {
        seen[url] = true
        result.push(url)
      }
    }
    return result
  }

  function getAllUncheckedUrls() {
    var all = []
    if (!allData) return collectCheckableUrls(all)
    var services = Object.keys(allData)
    for (var s = 0; s < services.length; s++) {
      var svcUrls = getServiceUrls(services[s])
      for (var u = 0; u < svcUrls.length; u++) {
        if (!healthResults.hasOwnProperty(svcUrls[u]) && !pendingChecks[svcUrls[u]]) {
          all.push(svcUrls[u])
        }
      }
    }
    return collectCheckableUrls(all)
  }

  /**
   * Return the subset of a service's instance URLs that have not yet been
   * health-checked (no cached result and no in-flight promise).
   * @param {string} serviceName
   * @returns {string[]}
   */
  function getUncheckedServiceUrls(serviceName) {
    var urls = getServiceUrls(serviceName)
    var unchecked = []
    for (var i = 0; i < urls.length; i++) {
      if (!healthResults.hasOwnProperty(urls[i]) && !pendingChecks[urls[i]]) {
        unchecked.push(urls[i])
      }
    }
    return collectCheckableUrls(unchecked)
  }

  /**
   * Run health checks against a list of URLs with limited concurrency.
   * @param {string[]} urls
   * @param {(function(number, number): void)=} onProgress
   * @returns {Promise<void>}
   */
  function runCheck(urls, onProgress) {
    if (urls.length === 0) {
      if (onProgress) onProgress(0, 0)
      return Promise.resolve()
    }
    var index = 0
    var completed = 0
    var total = urls.length

    function next() {
      if (index >= urls.length) return Promise.resolve()
      var url = urls[index++]
      return checkUrlReachable(url).then(function () {
        completed++
        if (onProgress) onProgress(completed, total)
        return next()
      })
    }

    var workers = []
    for (var i = 0; i < Math.min(CONCURRENCY, urls.length); i++) workers.push(next())
    return Promise.all(workers)
  }

  // =========================================================================
  // HIGH-LEVEL CHECK ENTRY POINTS
  // =========================================================================

  /** Check a single URL, then refresh the affected UI. */
  function startCheckSingle(url) {
    if (!allData || checkRunning) return
    checkUrlReachable(url).then(function () {
      refresh()
      updateHealthSummary()
      updateGlobalControls()
    })
  }

  /**
   * Run a health check for every unchecked URL belonging to a single
   * service (category). Updates the service's health label live and the
   * per-service "Check" button state. Idempotent: ignored if a check is
   * already running for this service or a global check is in progress.
   * @param {string} serviceName
   */
  function startCheckService(serviceName) {
    if (!allData || checkRunning || checkingServices[serviceName]) return
    var urls = getUncheckedServiceUrls(serviceName)
    if (urls.length === 0) {
      refresh()
      updateHealthSummary()
      updateGlobalControls()
      return
    }
    checkingServices[serviceName] = "0/" + urls.length
    setSvcCheckUI(serviceName)

    runCheck(urls, function (done, total) {
      checkingServices[serviceName] = done + "/" + total
      setSvcCheckUI(serviceName)
    }).then(function () {
      delete checkingServices[serviceName]
      updateHealthSummary()
      updateGlobalControls()
      refresh()
    })
  }

  /**
   * Sync a service's "Check" button and health label to the current
   * {@link checkingServices} entry. Looks up elements by id so it survives
   * re-renders.
   * @param {string} serviceName
   */
  function setSvcCheckUI(serviceName) {
    var progress = checkingServices[serviceName]
    var btn = document.getElementById("svc-check-" + serviceName)
    if (btn) {
      btn.disabled = !!progress
      btn.textContent = progress ? "Checking…" : "Check"
    }
    var health = document.getElementById("svc-health-" + serviceName)
    if (health && progress) {
      health.textContent = progress
      health.classList.add("partial")
    }
  }

  /** Kick off a global health check for every unchecked URL. */
  function startCheckAll() {
    if (!allData || checkRunning) return
    var urls = getAllUncheckedUrls()
    var cached = Object.keys(healthResults).length

    checkRunning = true
    checkAllBtn.disabled = true
    var label = checkAllBtn.textContent
    checkAllBtn.textContent = "Checking…"

    showHealthProgress(0, urls.length, cached)

    runCheck(urls, function (done, total) {
      showHealthProgress(done, total, cached)
      refresh()
    }).then(function () {
      checkRunning = false
      checkAllBtn.disabled = false
      checkAllBtn.textContent = label
      updateGlobalControls()
      updateHealthSummary()
      refresh()
    })
  }

  // =========================================================================
  // HEALTH SUMMARY & GLOBAL CONTROLS
  // =========================================================================

  function showHealthProgress(done, total, cached) {
    if (!healthStatWrap) return
    healthStatWrap.style.display = ""
    if (healthSep) healthSep.style.display = ""
    var text = "Checking " + done + "/" + total
    if (cached > 0) text += " (cached: " + cached + ")"
    if (healthStatEl) healthStatEl.textContent = text
  }

  function updateHealthSummary() {
    var reachable = 0,
      unreachable = 0,
      skipped = 0
    for (var k in healthResults) {
      if (healthResults[k] === BADGE_REACHABLE) reachable++
      else if (healthResults[k] === BADGE_UNREACHABLE) unreachable++
      else if (healthResults[k] === BADGE_SKIP) skipped++
    }
    var hasResults = reachable + unreachable > 0
    if (healthStatWrap) healthStatWrap.style.display = hasResults ? "" : "none"
    if (healthSep) healthSep.style.display = hasResults ? "" : "none"
    if (healthStatEl) {
      var text = reachable + " up · " + unreachable + " down"
      if (skipped > 0) text += " · " + skipped + " skipped"
      healthStatEl.textContent = text
    }
  }

  function updateGlobalControls() {
    if (!hideUnavailBtn) return
    var hasResults = false
    for (var k in healthResults) {
      if (healthResults[k] !== BADGE_SKIP) {
        hasResults = true
        break
      }
    }
    hideUnavailBtn.disabled = !hasResults
    hideUnavailBtn.textContent = hideUnavail ? "Show Unavailable" : "Hide Unavailable"
  }

  function updateStats() {
    if (statServices) statServices.textContent = renderStats.services
    if (statTotal) statTotal.textContent = renderStats.total
    if (statShown) statShown.textContent = renderStats.shown
    if (statFavs) statFavs.textContent = countFavorites()
  }

  /**
   * Sync the "Collapse All" / "Expand All" button label to the current
   * open state across all service sections. Label reflects the action that
   * would happen on click: "Collapse All" when any section is open,
   * "Expand All" when all are closed.
   */
  function updateCollapseBtn() {
    if (!toggleCollapseBtn || !allData) return
    var anyOpen = false
    var services = Object.keys(allData)
    for (var i = 0; i < services.length; i++) {
      if (sectionOpen[services[i]] === true) {
        anyOpen = true
        break
      }
    }
    toggleCollapseBtn.textContent = anyOpen ? "Collapse All" : "Expand All"
  }

  function updateClearFavsBtn() {
    if (clearFavsBtn) clearFavsBtn.disabled = countFavorites() === 0
  }

  // =========================================================================
  // RENDERING HELPERS
  // =========================================================================

  /**
   * Create a text node (or a fragment with <mark> highlights) for a given
   * search filter. Uses createTextNode so no HTML injection is possible.
   */
  function highlightMatch(text, lowerFilter) {
    if (!lowerFilter) return document.createTextNode(text)
    var lower = text.toLowerCase()
    var idx = lower.indexOf(lowerFilter)
    if (idx === -1) return document.createTextNode(text)
    var frag = document.createDocumentFragment()
    var start = 0
    while (idx !== -1) {
      if (idx > start) frag.appendChild(document.createTextNode(text.substring(start, idx)))
      var mark = document.createElement("mark")
      mark.textContent = text.substring(idx, idx + lowerFilter.length)
      frag.appendChild(mark)
      start = idx + lowerFilter.length
      idx = lower.indexOf(lowerFilter, start)
    }
    if (start < text.length) frag.appendChild(document.createTextNode(text.substring(start)))
    return frag
  }

  /**
   * Build a status-dot span reflecting a health-check result (or pending).
   * @param {string} url
   * @returns {HTMLSpanElement}
   */
  function renderStatusDot(url) {
    var dot = document.createElement("span")
    dot.className = "status-dot"
    if (pendingChecks[url]) {
      dot.classList.add("checking")
      dot.title = "Checking…"
    } else if (healthResults.hasOwnProperty(url)) {
      var r = healthResults[url]
      if (r === BADGE_REACHABLE) {
        dot.classList.add("up")
        dot.title = "Reachable"
      } else if (r === BADGE_UNREACHABLE) {
        dot.classList.add("down")
        dot.title = "Unavailable"
      } else {
        dot.classList.add("skip")
        dot.title = "Cannot check from browser (" + buildSkipLabel() + ")"
      }
    } else {
      dot.title = "Not checked yet"
    }
    return dot
  }

  // =========================================================================
  // RENDERING: MAIN
  // =========================================================================

  /**
   * Build and insert the full instance list DOM from scratch. Produces
   * <details class="service-group"> sections with .instance rows matching
   * the CSS layout. All text is inserted via createTextNode / textContent;
   * anchor hrefs are validated through isAllowedUrl.
   */
  function renderInstances(data, filterText, nets) {
    var services = Object.keys(data)
    services.sort(function (a, b) {
      var aFav = isFavService(a) ? 1 : 0
      var bFav = isFavService(b) ? 1 : 0
      if (aFav !== bFav) return bFav - aFav
      if (a < b) return -1
      if (a > b) return 1
      return 0
    })

    var fragment = document.createDocumentFragment()
    var lowerFilter = filterText.toLowerCase()
    var svcCount = 0
    var totalCount = 0
    var shownCount = 0

    for (var s = 0; s < services.length; s++) {
      var serviceName = services[s]
      var service = data[serviceName]
      var normSvc = normalizeName(serviceName)
      var matchedPlats = serviceToPlatforms[normSvc] || []
      var platString = matchedPlats.join(", ")

      // Gather visible instances across active networks.
      var rows = []
      for (var ni = 0; ni < NETWORK_ORDER.length; ni++) {
        var net = NETWORK_ORDER[ni]
        if (!nets[net]) continue
        var netUrls = service[net]
        if (!netUrls) continue
        for (var u = 0; u < netUrls.length; u++) {
          var url = netUrls[u]
          totalCount++
          if (
            lowerFilter !== "" &&
            serviceName.toLowerCase().indexOf(lowerFilter) === -1 &&
            url.toLowerCase().indexOf(lowerFilter) === -1 &&
            platString.toLowerCase().indexOf(lowerFilter) === -1
          ) {
            continue
          }
          if (favOnly && !isFavUrl(url) && !isFavService(serviceName)) continue
          if (hideUnavail && healthResults[url] === BADGE_UNREACHABLE) continue
          rows.push({ url: url, net: net })
        }
      }

      if (rows.length === 0) continue

      // Favorites first within a service.
      rows.sort(function (a, b) {
        var af = isFavUrl(a.url) ? 1 : 0
        var bf = isFavUrl(b.url) ? 1 : 0
        return bf - af
      })

      svcCount++
      shownCount += rows.length

      var isOpen = sectionOpen[serviceName] === true
      var group = document.createElement("details")
      group.className = "service-group"
      if (isOpen) group.setAttribute("open", "")
      if (isFavService(serviceName)) group.classList.add("is-fav-group")
      group.setAttribute("aria-label", serviceName + " instances")

      // Preserve / sync open state across re-renders.
      ;(function (sn) {
        group.addEventListener("toggle", function () {
          sectionOpen[sn] = group.hasAttribute("open")
          updateCollapseBtn()
        })
      })(serviceName)

      var summary = document.createElement("summary")

      // Service-level favorite toggle.
      var favBtn = document.createElement("button")
      favBtn.type = "button"
      favBtn.className = "fav-btn" + (isFavService(serviceName) ? " active" : "")
      favBtn.title = isFavService(serviceName) ? "Remove from favorites" : "Add to favorites"
      favBtn.textContent = isFavService(serviceName) ? "\u2605" : "\u2606"
      favBtn.addEventListener(
        "click",
        (function (sn) {
          return function (e) {
            e.preventDefault()
            e.stopPropagation()
            toggleFavService(sn)
          }
        })(serviceName),
      )
      summary.appendChild(favBtn)

      if (matchedPlats.length > 0) {
        var platSpan = document.createElement("span")
        platSpan.className = "svc-platform"
        platSpan.appendChild(highlightMatch(platString, lowerFilter))
        summary.appendChild(platSpan)
      }

      var nameSpan = document.createElement("span")
      nameSpan.className = "svc-name"
      nameSpan.appendChild(highlightMatch(serviceName, lowerFilter))
      summary.appendChild(nameSpan)

      var meta = document.createElement("span")
      meta.className = "svc-meta"
      var reachable = 0,
        checked = 0
      for (var ri = 0; ri < rows.length; ri++) {
        if (healthResults.hasOwnProperty(rows[ri].url)) {
          if (healthResults[rows[ri].url] !== BADGE_SKIP) checked++
          if (healthResults[rows[ri].url] === BADGE_REACHABLE) reachable++
        }
      }
      meta.appendChild(document.createTextNode(String(rows.length)))
      var sep = document.createElement("span")
      sep.className = "sep"
      sep.textContent = "·"
      meta.appendChild(sep)
      var health = document.createElement("span")
      health.className = "svc-health"
      health.id = "svc-health-" + serviceName
      var checking = checkingServices[serviceName]
      if (checking) {
        health.textContent = checking
        health.classList.add("partial")
      } else if (checked > 0) {
        health.textContent = reachable + "/" + checked
        if (reachable < checked) health.classList.add("partial")
      } else {
        health.textContent = "—"
        health.classList.add("partial")
      }
      meta.appendChild(health)
      summary.appendChild(meta)

      // Per-service "Check" button (checks all of this category's URLs).
      var svcCheckBtn = document.createElement("button")
      svcCheckBtn.type = "button"
      svcCheckBtn.className = "act-btn"
      svcCheckBtn.id = "svc-check-" + serviceName
      svcCheckBtn.setAttribute("data-action", "check-service")
      svcCheckBtn.title = "Check availability for " + serviceName
      svcCheckBtn.textContent = checking ? "Checking…" : "Check"
      if (checking) svcCheckBtn.disabled = true
      svcCheckBtn.addEventListener(
        "click",
        (function (sn) {
          return function (e) {
            e.preventDefault()
            e.stopPropagation()
            startCheckService(sn)
          }
        })(serviceName),
      )
      summary.appendChild(svcCheckBtn)

      group.appendChild(summary)

      var body = document.createElement("div")
      body.className = "service-body"

      for (var vi = 0; vi < rows.length; vi++) {
        var row = rows[vi]
        var inst = document.createElement("div")
        inst.className = "instance"
        if (isFavUrl(row.url)) inst.classList.add("is-fav")

        // URL-level favorite toggle
        var urlFav = document.createElement("button")
        urlFav.type = "button"
        urlFav.className = "fav-btn" + (isFavUrl(row.url) ? " active" : "")
        urlFav.title = isFavUrl(row.url) ? "Remove from favorites" : "Add to favorites"
        urlFav.textContent = isFavUrl(row.url) ? "\u2605" : "\u2606"
        urlFav.addEventListener(
          "click",
          (function (u) {
            return function (e) {
              e.preventDefault()
              e.stopPropagation()
              toggleFavUrl(u)
            }
          })(row.url),
        )
        inst.appendChild(urlFav)

        inst.appendChild(renderStatusDot(row.url))

        if (isAllowedUrl(row.url)) {
          var a = document.createElement("a")
          a.className = "inst-url"
          a.href = row.url
          a.rel = "noopener noreferrer"
          a.target = "_blank"
          a.appendChild(highlightMatch(row.url, lowerFilter))
          inst.appendChild(a)
        } else {
          var code = document.createElement("code")
          code.className = "inst-url"
          code.appendChild(highlightMatch(row.url, lowerFilter))
          inst.appendChild(code)
        }

        var badge = document.createElement("span")
        badge.className = "net-badge " + row.net
        badge.textContent = NETWORK_LABELS[row.net] || row.net
        inst.appendChild(badge)

        var actBtn = document.createElement("button")
        actBtn.type = "button"
        actBtn.className = "act-btn"
        actBtn.setAttribute("data-action", "check")
        actBtn.title = "Check this instance"
        actBtn.textContent = "\u21bb"
        actBtn.addEventListener(
          "click",
          (function (u) {
            return function (e) {
              e.preventDefault()
              e.stopPropagation()
              startCheckSingle(u)
            }
          })(row.url),
        )
        inst.appendChild(actBtn)

        body.appendChild(inst)
      }

      group.appendChild(body)
      fragment.appendChild(group)
    }

    // Empty state when nothing matches.
    if (svcCount === 0) {
      var empty = document.createElement("div")
      empty.className = "msg-state"
      var title = document.createElement("p")
      title.className = "msg-title"
      title.textContent = favOnly ? "No favorite instances yet" : "No instances match your filters"
      empty.appendChild(title)
      var hint = document.createElement("p")
      hint.textContent = favOnly ? "Star a service or URL to pin it here." : "Try a different search or enable more networks."
      empty.appendChild(hint)
      fragment.appendChild(empty)
    }

    instancesContainer.replaceChildren(fragment)
    renderStats.services = svcCount
    renderStats.total = totalCount
    renderStats.shown = shownCount
    updateStats()
  }

  function getActiveNetworks() {
    return activeNets
  }

  // =========================================================================
  // REFRESH & DEBOUNCE
  // =========================================================================

  var debounceTimer = null

  function refresh() {
    if (!allData) return
    renderInstances(allData, searchInput.value, getActiveNetworks())
    updateClearFavsBtn()
    updateCollapseBtn()
  }

  function debouncedRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(function () {
      debounceTimer = null
      refresh()
    }, 200)
  }

  // =========================================================================
  // TOAST
  // =========================================================================

  var toastTimer = null
  function showToast(msg) {
    if (!toastEl) return
    toastEl.textContent = msg
    toastEl.classList.add("show")
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show")
    }, 2200)
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================

  // Search input: debounced re-render on each keystroke
  searchInput.addEventListener("input", debouncedRefresh)

  // Network filter pills: toggle active class, persist, re-render
  for (var key in netPills) {
    ;(function (k) {
      netPills[k].addEventListener("click", function () {
        activeNets[k] = !activeNets[k]
        if (activeNets[k]) netPills[k].classList.add("active")
        else netPills[k].classList.remove("active")
        saveFilters()
        refresh()
      })
    })(key)
  }

  // "Check Availability" - global health check
  checkAllBtn.addEventListener("click", startCheckAll)

  // "Hide Unavailable" / "Show Unavailable" - global toggle
  hideUnavailBtn.addEventListener("click", function () {
    hideUnavail = !hideUnavail
    updateGlobalControls()
    refresh()
  })

  // "Collapse All" / "Expand All" - toggles every section (default collapsed)
  toggleCollapseBtn.addEventListener("click", function () {
    if (!allData) return
    var anyOpen = false
    var services = Object.keys(allData)
    for (var i = 0; i < services.length; i++) {
      if (sectionOpen[services[i]] === true) {
        anyOpen = true
        break
      }
    }
    var newState = !anyOpen
    for (var j = 0; j < services.length; j++) sectionOpen[services[j]] = newState
    refresh()
  })

  // "★ Favorites" pill - show only favorites
  favOnlyBtn.addEventListener("click", function () {
    favOnly = !favOnly
    if (favOnly) favOnlyBtn.classList.add("active")
    else favOnlyBtn.classList.remove("active")
    refresh()
  })

  // "Toolbar toggle" (mobile) - collapse/expand the search + buttons bar
  if (toolbarToggleBtn) {
    toolbarToggleBtn.addEventListener("click", function () {
      toolbarCollapsed = !toolbarCollapsed
      updateToolbarUI()
      saveToolbarState()
    })
  }

  // "Clear Favorites"
  clearFavsBtn.addEventListener("click", function () {
    if (!confirm("Clear all favorites?")) return
    favorites = { services: {}, urls: {} }
    saveFavorites()
    updateClearFavsBtn()
    refresh()
    showToast("Favorites cleared")
  })

  // "Clear All Local Data"
  clearDataBtn.addEventListener("click", function () {
    if (!confirm("Clear all saved data? This includes favorites and filter preferences.")) return
    favorites = { services: {}, urls: {} }
    for (var k in activeNets) activeNets[k] = true
    syncPillClasses()
    favOnly = false
    if (favOnlyBtn) favOnlyBtn.classList.remove("active")
    hideUnavail = false
    localStorage.removeItem(FAV_STORAGE_KEY)
    localStorage.removeItem(FILTER_STORAGE_KEY)
    toolbarCollapsed = false
    localStorage.removeItem(TOOLBAR_STORAGE_KEY)
    updateToolbarUI()
    updateClearFavsBtn()
    updateGlobalControls()
    refresh()
    showToast("Local data cleared")
  })

  // Keyboard: "/" focuses search, "Esc" clears it
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== searchInput) {
      e.preventDefault()
      searchInput.focus()
    } else if (e.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = ""
      refresh()
      searchInput.blur()
    }
  })

  // =========================================================================
  // DATA FETCH & INITIALIZATION
  // =========================================================================

  var fetchController = new AbortController()

  /**
   * Build the skip-TLD message string (e.g. "Tor/I2P/Loki") from the current
   * NETWORK_LABELS, excluding the "clearnet" entry.
   */
  function buildSkipLabel() {
    var labels = []
    for (var i = 0; i < NETWORK_ORDER.length; i++) {
      if (NETWORK_ORDER[i] !== "clearnet") {
        labels.push(NETWORK_LABELS[NETWORK_ORDER[i]] || NETWORK_ORDER[i])
      }
    }
    return labels.join("/")
  }

  /**
   * Apply network definitions from a parsed networks.json response.
   * Updates NETWORK_LABELS, NETWORK_ORDER, and SKIP_TLDS.
   */
  function applyNetworks(networks) {
    var labels = {}
    var order = []
    var tlds = []
    var keys = Object.keys(networks)
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      var def = networks[key]
      labels[key] = def.name || key
      order.push(key)
      if (key !== "clearnet" && def.tld) tlds.push(def.tld)
    }
    if (order.length > 0) {
      NETWORK_ORDER = order
      NETWORK_LABELS = labels
      SKIP_TLDS = tlds
      // Extend activeNets for any new network keys (default on).
      for (var j = 0; j < order.length; j++) {
        if (!(order[j] in activeNets)) activeNets[order[j]] = true
      }
    }
  }

  window.addEventListener("beforeunload", function () {
    fetchController.abort()
  })

  // =========================================================================
  // SCROLL PARALLAX EFFECT
  // =========================================================================

  var headerHeight = 0
  var toolbarHeight = 0

  function updateHeights() {
    var header = document.querySelector(".app-header")
    var toolbar = document.querySelector(".toolbar")
    headerHeight = header ? header.offsetHeight : 54
    toolbarHeight = toolbar ? toolbar.offsetHeight : 112
  }

  function updateScrollParallax() {
    var y = window.scrollY
    var header = document.querySelector(".app-header")
    var toolbar = document.querySelector(".toolbar")

    if (header) {
      var headerTrans = -Math.min(y * 0.5, headerHeight)
      var headerOpacity = Math.max(0, 1 - y / headerHeight)
      header.style.transform = "translate3d(0, " + headerTrans + "px, 0)"
      header.style.opacity = headerOpacity
      header.style.pointerEvents = headerOpacity < 0.1 ? "none" : "auto"
    }

    if (toolbar) {
      var maxToolbarTrans = headerHeight + toolbarHeight
      var toolbarTrans = -Math.min(y * 0.8, maxToolbarTrans)
      var toolbarOpacity = Math.max(0, 1 - y / maxToolbarTrans)
      toolbar.style.transform = "translate3d(0, " + toolbarTrans + "px, 0)"
      toolbar.style.opacity = toolbarOpacity
      toolbar.style.pointerEvents = toolbarOpacity < 0.1 ? "none" : "auto"
    }
  }

  function initScrollParallax() {
    updateHeights()
    window.addEventListener("resize", function () {
      updateHeights()
      updateScrollParallax()
    })

    var ticking = false
    window.addEventListener("scroll", function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          updateScrollParallax()
          ticking = false
        })
        ticking = true
      }
    })

    // Run once on init
    updateScrollParallax()
  }

  loadFavorites()
  loadFilters()
  syncPillClasses()
  loadToolbarState()
  updateClearFavsBtn()
  updateGlobalControls()
  updateHealthSummary()
  initScrollParallax()

  fetch(NETWORKS_URL, { signal: fetchController.signal })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status)
      return response.json()
    })
    .then(function (networks) {
      applyNetworks(networks)
      syncPillClasses()
      return fetch(DATA_URL, { signal: fetchController.signal })
    })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status)
      return response.json()
    })
    .then(function (data) {
      allData = data
      if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl)
      loadingEl = null
      instancesContainer.removeAttribute("aria-busy")
      refresh()
    })
    .catch(function (err) {
      instancesContainer.innerHTML = ""
      var wrap = document.createElement("div")
      wrap.className = "msg-state"
      var title = document.createElement("p")
      title.className = "msg-title"
      title.setAttribute("role", "alert")
      title.textContent = "Failed to load instances"
      wrap.appendChild(title)
      var msg = document.createElement("p")
      msg.textContent = err.message
      wrap.appendChild(msg)
      instancesContainer.appendChild(wrap)
      instancesContainer.removeAttribute("aria-busy")
    })
})()
