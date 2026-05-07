/**
 * @fileoverview LibRedirect Instances List - Frontend application for browsing,
 * filtering, searching, and health-checking LibRedirect service instances across
 * multiple network types (Clearnet, Tor, I2P, Loki).
 *
 * Features:
 *   - Fetches service instance data from a remote JSON endpoint
 *   - Real-time instance reachability checking via HTTP HEAD-like requests
 *   - Multi-network filtering (clearnet, tor, i2p, loki)
 *   - Full-text search with highlighted matches
 *   - Per-service and per-URL favorites (persisted in localStorage)
 *   - Hide/show unreachable instances per service
 *   - Collapsible service sections with accessible markup
 *
 * @module libredirect-instances
 */

(function () {
    "use strict";

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    /**
     * Remote URL from which the network definitions are fetched (name + TLD
     * for each supported network type).
     * @constant {string}
     */
    var NETWORKS_URL = "https://raw.githubusercontent.com/libredirect/instances/refs/heads/main/networks.json";

    /**
     * Remote URL from which the service instance catalog is fetched.
     * @constant {string}
     */
    var DATA_URL = "https://raw.githubusercontent.com/libredirect/instances/main/data.json";

    /**
     * Allowed URL protocols. Only "https:" and "http:" are permitted; any other
     * scheme (e.g. `javascript:`, `data:`, `ftp:`) is rejected to prevent
     * XSS / protocol-level attacks.
     * @constant {string[]}
     */
    var ALLOWED_SCHEMES = ["https:", "http:"];

    /**
     * Human-readable labels for each supported network type.
     * Populated dynamically from {@link NETWORKS_URL} with hardcoded fallback.
     * @type {Record<string, string>}
     */
    var NETWORK_LABELS = {
        clearnet: "Clearnet",
        tor: "Tor",
        i2p: "I2P",
        loki: "Loki"
    };

    /**
     * Ordered list of network keys used for consistent rendering order.
     * Populated dynamically from {@link NETWORKS_URL} with hardcoded fallback.
     * @type {string[]}
     */
    var NETWORK_ORDER = ["clearnet", "tor", "i2p", "loki"];

    /**
     * TLD suffixes for networks that cannot be health-checked from a standard
     * browser (e.g. `.onion`, `.i2p`, `.loki`).  Populated dynamically from
     * {@link NETWORKS_URL} with hardcoded fallback.
     * @type {string[]}
     */
    var SKIP_TLDS = ["onion", "i2p", "loki"];

    /**
     * Maximum time (in milliseconds) to wait for a single instance health check
     * before timing out.
     * @constant {number}
     */
    var CHECK_TIMEOUT_MS = 6000;

    /**
     * Maximum number of concurrent health-check requests.  Bounded to avoid
     * overwhelming the browser's connection pool or the target servers.
     * @constant {number}
     */
    var CONCURRENCY = 16;

    /**
     * Badge value indicating the instance was successfully contacted.
     * @constant {1}
     */
    var BADGE_REACHABLE = 1;

    /**
     * Badge value indicating the instance could not be contacted.
     * @constant {0}
     */
    var BADGE_UNREACHABLE = 0;

    /**
     * Badge value indicating the instance was skipped because it cannot be
     * checked from a browser (e.g. .onion, .i2p, .loki domains require
     * special proxy software).
     * @constant {-1}
     */
    var BADGE_SKIP = -1;

    // =========================================================================
    // TYPE DEFINITIONS
    // =========================================================================

    /**
     * Possible health-check result badge value.
     * @typedef {1|0|-1} BadgeResult
     */

    /**
     * Map from instance URL to its last known health-check result.
     * @typedef {Record<string, BadgeResult>} HealthResults
     */

    /**
     * Map from service name to boolean indicating whether its unavailable
     * instances are currently hidden.
     * @typedef {Record<string, boolean>} HideByService
     */

    /**
     * Map from service name to boolean indicating whether its section is
     * currently expanded in the UI.
     * @typedef {Record<string, boolean>} ExpandedSections
     */

    /**
     * Map from URL to a pending Promise that resolves to its health-check
     * result.  Used to coalesce duplicate concurrent checks.
     * @typedef {Record<string, Promise<BadgeResult>>} PendingChecks
     */

    /**
     * Map from service name to boolean indicating whether a per-service
     * health check is currently in progress.
     * @typedef {Record<string, boolean>} CheckingServices
     */

    /**
     * Per-service instance data as returned by the remote JSON endpoint.
     * Each key is a network type (clearnet/tor/i2p/loki) mapped to an array
     * of instance URLs for that network.
     * @typedef {Record<string, string[]>} ServiceInstances
     */

    /**
     * Complete catalog of all services and their instances.
     * @typedef {Record<string, ServiceInstances>} AllData
     */

    /**
     * Object tracking which network filters are currently active (enabled).
     * @typedef {Record<string, boolean>} ActiveNetworks
     */

    /**
     * Return value for {@link countMatches}.
     * @typedef {{matched: number, afterHide: number}} MatchCounts
     */

    /**
     * Favorites store shape persisted in localStorage.
     * @typedef {{services: Record<string, boolean>, urls: Record<string, boolean>}} Favorites
     */

    // =========================================================================
    // DOM REFERENCES
    // =========================================================================

    /**
     * Container element where service instance sections are rendered.
     * @type {HTMLElement}
     */
    var instancesContainer = document.getElementById("instances");

    /**
     * Loading indicator element removed once data is fetched.
     * @type {HTMLElement}
     */
    var loadingEl = document.getElementById("loading");

    /**
     * Search / filter input field.
     * @type {HTMLInputElement}
     */
    var searchInput = document.getElementById("search");

    /**
     * Network filter checkboxes keyed by network name.
     * @type {Record<string, HTMLInputElement>}
     */
    var filterCheckboxes = {
        clearnet: document.getElementById("filter-clearnet"),
        tor: document.getElementById("filter-tor"),
        i2p: document.getElementById("filter-i2p"),
        loki: document.getElementById("filter-loki")
    };

    /**
     * "Check All" button to run health checks against every instance.
     * @type {HTMLButtonElement}
     */
    var checkAllBtn = document.getElementById("check-all");

    /**
     * Toggle button to hide/show all currently unreachable instances.
     * @type {HTMLButtonElement}
     */
    var hideAllBtn = document.getElementById("hide-all");

    /**
     * Status bar element showing global health-check summary.
     * @type {HTMLElement}
     */
    var healthStatusEl = document.getElementById("health-status");

    /**
     * Button to clear all saved favorites.
     * @type {HTMLButtonElement}
     */
    var clearFavsBtn = document.getElementById("clear-favs");

    /**
     * Button to clear all persisted data (favorites + filters).
     * @type {HTMLButtonElement}
     */
    var clearAllDataBtn = document.getElementById("clear-all-data");

    // =========================================================================
    // STORAGE KEYS
    // =========================================================================

    /** @constant {string} */
    var FAV_STORAGE_KEY = "libredirect_favorites";
    /** @constant {string} */
    var FILTER_STORAGE_KEY = "libredirect_network_filters";
    /** @constant {string} Prefix for service-level favorite keys. */
    var FAV_SVC_KEY = "svc_";
    /** @constant {string} Prefix for URL-level favorite keys. */
    var FAV_URL_KEY = "url_";

    // =========================================================================
    // APPLICATION STATE
    // =========================================================================

    /**
     * Loaded instance catalog, or `null` before the initial fetch completes.
     * @type {?AllData}
     */
    var allData = null;

    /**
     * Accumulated health-check results keyed by instance URL.
     * @type {HealthResults}
     */
    var healthResults = {};

    /**
     * Per-service health-check-in-progress flags.
     * @type {CheckingServices}
     */
    var checkingServices = {};

    /**
     * Per-service "hide unavailable" toggle state.
     * @type {HideByService}
     */
    var hideByService = {};

    /**
     * Per-service section expand / collapse state.
     * @type {ExpandedSections}
     */
    var expandedSections = {};

    /**
     * In-flight health-check promises keyed by URL for deduplication.
     * @type {PendingChecks}
     */
    var pendingChecks = {};

    /**
     * Count of services currently undergoing a health check.
     * Used to coordinate global UI controls.
     * @type {number}
     */
    var checkInProgressCount = 0;

    /**
     * Favorites store (service-level and URL-level).
     * @type {Favorites}
     */
    var favorites = { services: {}, urls: {} };

    // =========================================================================
    // PERSISTENCE: FAVORITES
    // =========================================================================

    /**
     * Load the favorites store from {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage|localStorage}.
     * On any parse or integrity failure the store is reset to an empty state
     * to prevent cascading errors.
     *
     * Safety: catches all exceptions so a corrupted localStorage entry cannot
     * break the application.
     *
     * @returns {void}
     */
    function loadFavorites() {
        try {
            var raw = localStorage.getItem(FAV_STORAGE_KEY);
            if (raw) favorites = JSON.parse(raw);
            if (!favorites.services) favorites.services = {};
            if (!favorites.urls) favorites.urls = {};
        } catch (e) {
            favorites = { services: {}, urls: {} };
        }
    }

    /**
     * Persist the current favorites store to localStorage.
     * If there are no favorites the key is removed entirely to keep storage
     * clean.
     *
     * @returns {void}
     */
    function saveFavorites() {
        try {
            var hasFav = false;
            for (var k in favorites.services) { hasFav = true; break; }
            if (!hasFav) { for (var u in favorites.urls) { hasFav = true; break; } }
            if (hasFav) {
                localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(favorites));
            } else {
                localStorage.removeItem(FAV_STORAGE_KEY);
            }
        } catch (e) { }
    }

    // =========================================================================
    // PERSISTENCE: NETWORK FILTERS
    // =========================================================================

    /**
     * Restore network filter checkbox states from localStorage and sync them
     * to the DOM.
     *
     * @returns {void}
     */
    function loadFilters() {
        try {
            var raw = localStorage.getItem(FILTER_STORAGE_KEY);
            if (raw) {
                var saved = JSON.parse(raw);
                for (var key in saved) {
                    if (filterCheckboxes[key]) {
                        filterCheckboxes[key].checked = !!saved[key];
                    }
                }
            }
        } catch (e) { }
    }

    /**
     * Persist the current network filter checkbox states to localStorage.
     * If all filters are enabled (the default), the key is removed to
     * minimise stored data.
     *
     * @returns {void}
     */
    function saveFilters() {
        try {
            var state = {};
            var allDefault = true;
            for (var key in filterCheckboxes) {
                state[key] = filterCheckboxes[key].checked;
                if (!state[key]) allDefault = false;
            }
            if (allDefault) {
                localStorage.removeItem(FILTER_STORAGE_KEY);
            } else {
                localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
            }
        } catch (e) { }
    }

    // =========================================================================
    // FAVORITES LOGIC
    // =========================================================================

    /**
     * Toggle a service's favorite status on or off.
     *
     * @param {string} name - Service name (e.g. "youtube", "reddit").
     * @returns {void}
     */
    function toggleFavService(name) {
        var key = FAV_SVC_KEY + name;
        if (favorites.services[key]) {
            delete favorites.services[key];
        } else {
            favorites.services[key] = true;
        }
        saveFavorites();
        updateClearFavsBtn();
        updateClearAllDataBtn();
        refresh();
    }

    /**
     * Toggle a specific instance URL's favorite status on or off.
     *
     * @param {string} url - Full instance URL.
     * @returns {void}
     */
    function toggleFavUrl(url) {
        var key = FAV_URL_KEY + url;
        if (favorites.urls[key]) {
            delete favorites.urls[key];
        } else {
            favorites.urls[key] = true;
        }
        saveFavorites();
        updateClearFavsBtn();
        updateClearAllDataBtn();
        refresh();
    }

    /**
     * Test whether a service is currently favorited.
     *
     * @param {string} name - Service name.
     * @returns {boolean} `true` if the service is a favorite.
     */
    function isFavService(name) {
        return !!favorites.services[FAV_SVC_KEY + name];
    }

    /**
     * Test whether a specific instance URL is currently favorited.
     *
     * @param {string} url - Full instance URL.
     * @returns {boolean} `true` if the URL is a favorite.
     */
    function isFavUrl(url) {
        return !!favorites.urls[FAV_URL_KEY + url];
    }

    // =========================================================================
    // UI STATE HELPERS
    // =========================================================================

    /**
     * Enable or disable the "Clear Favorites" button based on whether any
     * favorites exist.
     *
     * @returns {void}
     */
    function updateClearFavsBtn() {
        var hasFav = false;
        for (var k in favorites.services) { hasFav = true; break; }
        if (!hasFav) {
            for (var u in favorites.urls) { hasFav = true; break; }
        }
        clearFavsBtn.disabled = !hasFav;
    }

    /**
     * Enable or disable the "Clear All Data" button based on whether any
     * persistent data exists in localStorage.
     *
     * @returns {void}
     */
    function updateClearAllDataBtn() {
        var hasData = !!localStorage.getItem(FAV_STORAGE_KEY) || !!localStorage.getItem(FILTER_STORAGE_KEY);
        clearAllDataBtn.disabled = !hasData;
    }

    // =========================================================================
    // RENDERING HELPERS
    // =========================================================================

    /**
     * Create a text node (or a fragment with `<mark>` highlights) for a given
     * search filter.  Used to highlight matching substrings in service names
     * and instance URLs.
     *
     * **No HTML injection is possible** — `document.createTextNode` is used to
     * set all user-controlled text, so `<` and `>` characters are escaped by
     * the browser.
     *
     * @param {string} text - The full text to display.
     * @param {string} lowerFilter - Lowercased search term, or empty string to
     *   skip highlighting.
     * @returns {DocumentFragment|Text} A text node if no filter is active, or a
     *   fragment containing text nodes and `<mark>` elements for matched
     *   portions.
     */
    function highlightMatch(text, lowerFilter) {
        if (!lowerFilter) return document.createTextNode(text);
        var lower = text.toLowerCase();
        var idx = lower.indexOf(lowerFilter);
        if (idx === -1) return document.createTextNode(text);
        var frag = document.createDocumentFragment();
        var start = 0;
        while (idx !== -1) {
            if (idx > start) frag.appendChild(document.createTextNode(text.substring(start, idx)));
            var mark = document.createElement("mark");
            mark.textContent = text.substring(idx, idx + lowerFilter.length);
            frag.appendChild(mark);
            start = idx + lowerFilter.length;
            idx = lower.indexOf(lowerFilter, start);
        }
        if (start < text.length) frag.appendChild(document.createTextNode(text.substring(start)));
        return frag;
    }

    // =========================================================================
    // URL VALIDATION
    // =========================================================================

    /**
     * Validate that a URL uses an allowed scheme and has a non-empty hostname.
     * This is a defense-in-depth check: only `https:` and `http:` URLs pass.
     *
     * @param {string} url - The URL string to validate.
     * @returns {boolean} `true` if the URL is safe to use as a hyperlink or
     *   for health-check requests.
     */
    function isAllowedUrl(url) {
        try {
            var parsed = new URL(url);
            if (ALLOWED_SCHEMES.indexOf(parsed.protocol) === -1) return false;
            if (parsed.hostname.length === 0) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Determine whether a URL is eligible for a browser-based reachability
     * check.  Special-network domains (e.g. `.onion`, `.i2p`, `.loki`) are
     * excluded because the browser cannot resolve them without proxy software.
     * The exclusion list is built dynamically from {@link NETWORKS_URL}.
     *
     * @param {string} url - The URL to test.
     * @returns {boolean} `true` if the instance can be health-checked from a
     *   standard browser.
     */
    function isCheckableUrl(url) {
        if (!isAllowedUrl(url)) return false;
        try {
            var host = new URL(url).hostname.toLowerCase();
            for (var i = 0; i < SKIP_TLDS.length; i++) {
                if (host.endsWith("." + SKIP_TLDS[i])) return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // =========================================================================
    // HEALTH CHECK LOGIC
    // =========================================================================

    /**
     * Check whether a single instance URL is reachable.
     *
     * Uses a `GET` request with `mode: "no-cors"` so that cross-origin
     * responses are handled cleanly (the browser will see a successful opaque
     * response even if CORS headers are absent).  A {@link CHECK_TIMEOUT_MS}
     * timeout is enforced via `AbortController`.
     *
     * **Deduplication**: if a check for this URL is already in flight the
     * existing promise is returned so callers share the same result.
     *
     * @param {string} url - The instance URL to check.
     * @returns {Promise<BadgeResult>} Resolves to `BADGE_REACHABLE`,
     *   `BADGE_UNREACHABLE`, or `BADGE_SKIP`.
     */
    function checkUrlReachable(url) {
        if (pendingChecks[url]) return pendingChecks[url];
        if (healthResults.hasOwnProperty(url)) {
            return Promise.resolve(healthResults[url]);
        }

        if (!isCheckableUrl(url)) {
            healthResults[url] = BADGE_SKIP;
            var skipP = Promise.resolve(BADGE_SKIP);
            pendingChecks[url] = skipP;
            skipP.then(function () { delete pendingChecks[url]; });
            return skipP;
        }

        var promise = new Promise(function (resolve) {
            var controller = new AbortController();
            var settled = false;

            var timeoutId = setTimeout(function () {
                if (!settled) {
                    settled = true;
                    controller.abort();
                    healthResults[url] = BADGE_UNREACHABLE;
                    resolve(BADGE_UNREACHABLE);
                }
            }, CHECK_TIMEOUT_MS);

            fetch(url, {
                method: "GET",
                mode: "no-cors",
                cache: "no-store",
                redirect: "follow",
                signal: controller.signal
            }).then(function () {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    healthResults[url] = BADGE_REACHABLE;
                    resolve(BADGE_REACHABLE);
                }
            }).catch(function () {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    healthResults[url] = BADGE_UNREACHABLE;
                    resolve(BADGE_UNREACHABLE);
                }
            });
        });

        pendingChecks[url] = promise;
        promise.then(function () { delete pendingChecks[url]; });
        return promise;
    }

    /**
     * Collect all allowed instance URLs for a given service across all
     * network types, in the order defined by {@link NETWORK_ORDER}.
     *
     * @param {string} serviceName - Service key in {@link allData}.
     * @returns {string[]} Flat array of instance URLs (may be empty if the
     *   service is not found or has no valid URLs).
     */
    function getServiceUrls(serviceName) {
        var urls = [];
        var service = allData[serviceName];
        if (!service) return urls;
        for (var n = 0; n < NETWORK_ORDER.length; n++) {
            var net = NETWORK_ORDER[n];
            var netUrls = service[net];
            if (!netUrls) continue;
            for (var u = 0; u < netUrls.length; u++) {
                if (isAllowedUrl(netUrls[u])) {
                    urls.push(netUrls[u]);
                }
            }
        }
        return urls;
    }

    /**
     * Deduplicate an array of URLs in insertion order, preserving only the
     * first occurrence of each unique URL.
     *
     * @param {string[]} urlSource - Array potentially containing duplicates.
     * @returns {string[]} Deduplicated copy.
     */
    function collectCheckableUrls(urlSource) {
        var seen = {};
        var result = [];
        for (var i = 0; i < urlSource.length; i++) {
            var url = urlSource[i];
            if (!seen[url]) {
                seen[url] = true;
                result.push(url);
            }
        }
        return result;
    }

    /**
     * Return the subset of a service's instance URLs that have not yet been
     * checked (no cached result and no in-flight promise).
     *
     * @param {string} serviceName - Service key.
     * @returns {string[]} Deduplicated array of unchecked URLs.
     */
    function getUncheckedServiceUrls(serviceName) {
        var urls = getServiceUrls(serviceName);
        var unchecked = [];
        for (var i = 0; i < urls.length; i++) {
            if (!healthResults.hasOwnProperty(urls[i]) && !pendingChecks[urls[i]]) {
                unchecked.push(urls[i]);
            }
        }
        return collectCheckableUrls(unchecked);
    }

    /**
     * Return every instance URL across all services that has not yet been
     * health-checked.  Useful for the global "Check All" feature.
     *
     * @returns {string[]} Deduplicated array of unchecked URLs across all
     *   services.
     */
    function getAllUncheckedUrls() {
        var all = [];
        var services = Object.keys(allData);
        for (var s = 0; s < services.length; s++) {
            var svcUrls = getServiceUrls(services[s]);
            for (var u = 0; u < svcUrls.length; u++) {
                if (!healthResults.hasOwnProperty(svcUrls[u]) && !pendingChecks[svcUrls[u]]) {
                    all.push(svcUrls[u]);
                }
            }
        }
        return collectCheckableUrls(all);
    }

    /**
     * Run health checks against a list of URLs with limited concurrency.
     *
     * The first {@link CONCURRENCY} checks are started simultaneously; each
     * worker chains the next URL from the list via sequential `.then()` calls.
     * An optional progress callback is invoked after each individual check
     * completes.
     *
     * @param {string[]} urls - URLs to check.
     * @param {(function(number, number): void)=} onProgress - Called with
     *   `(completedCount, totalCount)` after each URL resolves.
     * @returns {Promise<void>} Resolves when **all** URLs have been checked
     *   (regardless of individual success/failure).
     */
    function runCheck(urls, onProgress) {
        if (urls.length === 0) {
            if (onProgress) onProgress(0, 0);
            return Promise.resolve();
        }

        var index = 0;
        var completed = 0;
        var total = urls.length;

        function next() {
            if (index >= urls.length) return Promise.resolve();
            var url = urls[index++];
            return checkUrlReachable(url).then(function () {
                completed++;
                if (onProgress) onProgress(completed, total);
                return next();
            });
        }

        var workers = [];
        for (var i = 0; i < Math.min(CONCURRENCY, urls.length); i++) {
            workers.push(next());
        }
        return Promise.all(workers);
    }

    // =========================================================================
    // HIGH-LEVEL CHECK ENTRY POINTS
    // =========================================================================

    /**
     * Kick off a health check for every unchecked URL of a single service.
     * Updates the per-service status element and triggers a UI refresh when
     * all checks finish.  Idempotent: if a check is already in progress for
     * this service the call is silently ignored.
     *
     * @param {string} serviceName - Service to check.
     * @returns {void}
     */
    function startCheckService(serviceName) {
        if (checkingServices[serviceName] || !allData) return;
        checkingServices[serviceName] = true;
        checkInProgressCount++;
        updateGlobalControls();

        var urls = getUncheckedServiceUrls(serviceName);
        var skipped = getServiceUrls(serviceName).length - urls.length;

        var statusEl = document.getElementById("svc-status-" + serviceName);
        if (statusEl) {
            statusEl.textContent = urls.length === 0 ? (skipped > 0 ? "Already checked" : "No URLs to check") : "Checking 0/" + urls.length;
        }

        runCheck(urls, function (done, total) {
            if (statusEl) statusEl.textContent = "Checking " + done + "/" + total;
        }).then(function () {
            delete checkingServices[serviceName];
            checkInProgressCount--;
            updateGlobalControls();
            updateServiceStatus(serviceName);
            if (checkInProgressCount === 0) {
                updateAllServiceStatuses();
                updateHealthSummary();
            }
            refresh();
        });
    }

    /**
     * Kick off a global health check for every unchecked URL across all
     * services.  Disables the "Check All" button while running.
     *
     * @returns {void}
     */
    function startCheckAll() {
        if (!allData) return;
        var urls = getAllUncheckedUrls();
        var cached = Object.keys(healthResults).length;
        var skippedCount = 0;
        var services = Object.keys(allData);
        for (var i = 0; i < services.length; i++) {
            var svcUrls = getServiceUrls(services[i]);
            for (var u = 0; u < svcUrls.length; u++) {
                if (healthResults[svcUrls[u]] === BADGE_SKIP) skippedCount++;
            }
        }
        healthStatusEl.textContent = "Checking 0/" + urls.length + (cached > 0 ? " (cached: " + cached + ")" : "") + (skippedCount > 0 ? " | " + skippedCount + " skipped (" + buildSkipLabel() + ")" : "");

        checkAllBtn.disabled = true;
        checkInProgressCount++;

        runCheck(urls, function (done, total) {
            healthStatusEl.textContent = "Checking " + done + "/" + total;
        }).then(function () {
            checkAllBtn.disabled = false;
            checkInProgressCount--;
            updateGlobalControls();
            updateAllServiceStatuses();
            refresh();
            updateHealthSummary();
        });
    }

    // =========================================================================
    // HEALTH SUMMARY & STATUS
    // =========================================================================

    /**
     * Update the global health summary bar with counts of reachable,
     * unreachable, and skipped instances.
     *
     * @returns {void}
     */
    function updateHealthSummary() {
        var reachable = 0;
        var unreachable = 0;
        var skipped = 0;
        for (var k in healthResults) {
            if (healthResults[k] === BADGE_REACHABLE) reachable++;
            else if (healthResults[k] === BADGE_UNREACHABLE) unreachable++;
            else if (healthResults[k] === BADGE_SKIP) skipped++;
        }
        var text = "Available: " + reachable + " | Unavailable: " + unreachable;
        if (skipped > 0) text += " | Skipped: " + skipped;
        healthStatusEl.textContent = text;
    }

    /**
     * Update the per-service status label showing how many of that service's
     * instances have been checked and how many are reachable.
     *
     * @param {string} serviceName - Service to update.
     * @returns {void}
     */
    function updateServiceStatus(serviceName) {
        var statusEl = document.getElementById("svc-status-" + serviceName);
        if (!statusEl) return;
        var urls = getServiceUrls(serviceName);
        var checked = 0;
        var reachable = 0;
        for (var i = 0; i < urls.length; i++) {
            if (healthResults.hasOwnProperty(urls[i])) {
                if (healthResults[urls[i]] !== BADGE_SKIP) checked++;
                if (healthResults[urls[i]] === BADGE_REACHABLE) reachable++;
            }
        }
        if (checked === 0) {
            statusEl.textContent = "";
        } else {
            statusEl.textContent = reachable + "/" + checked + " reachable";
        }
    }

    /**
     * Iterate over every service and update its per-service status label.
     *
     * @returns {void}
     */
    function updateAllServiceStatuses() {
        if (!allData) return;
        var services = Object.keys(allData);
        for (var i = 0; i < services.length; i++) {
            updateServiceStatus(services[i]);
        }
    }

    /**
     * Update the global "Hide/Show All" button label and enabled state based
     * on current hide flags and health-results availability.
     *
     * @returns {void}
     */
    function updateGlobalControls() {
        var anyHide = false;
        var services = Object.keys(allData || {});
        for (var i = 0; i < services.length; i++) {
            if (hideByService[services[i]]) { anyHide = true; break; }
        }
        hideAllBtn.textContent = anyHide ? "Show All" : "Hide All Unavailable";
        var hasResults = false;
        for (var k in healthResults) {
            if (healthResults[k] !== BADGE_SKIP) { hasResults = true; break; }
        }
        hideAllBtn.disabled = !hasResults;
    }

    // =========================================================================
    // EVENT LISTENERS (GLOBAL BUTTONS)
    // =========================================================================

    // "Check All" - runs health checks against every instance across all services
    checkAllBtn.addEventListener("click", startCheckAll);

    // "Clear Favorites" - resets the entire favorites store after confirmation
    clearFavsBtn.addEventListener("click", function () {
        if (confirm("Are you sure you want to clear all favorites?")) {
            favorites = { services: {}, urls: {} };
            saveFavorites();
            updateClearFavsBtn();
            updateClearAllDataBtn();
            refresh();
        }
    });

    // "Clear All Data" - wipes favorites, resets filters to defaults, and clears localStorage
    clearAllDataBtn.addEventListener("click", function () {
        if (confirm("Are you sure you want to clear all saved data? This includes favorites, filter settings, and any other stored preferences.")) {
            favorites = { services: {}, urls: {} };
            for (var key in filterCheckboxes) {
                filterCheckboxes[key].checked = true;
            }
            localStorage.removeItem(FAV_STORAGE_KEY);
            localStorage.removeItem(FILTER_STORAGE_KEY);
            updateClearFavsBtn();
            updateClearAllDataBtn();
            refresh();
        }
    });

    // "Hide All / Show All" - toggles the per-service hide flag for every service
    hideAllBtn.addEventListener("click", function () {
        if (!allData) return;
        var anyActive = false;
        var services = Object.keys(allData);
        for (var i = 0; i < services.length; i++) {
            if (hideByService[services[i]]) { anyActive = true; break; }
        }
        var newState = !anyActive;
        for (var j = 0; j < services.length; j++) {
            hideByService[services[j]] = newState;
        }
        updateGlobalControls();
        refresh();
    });

    // =========================================================================
    // COUNTING & MATCHING
    // =========================================================================

    /**
     * Count how many instances of a service match the current search filter
     * and how many remain visible after applying the "hide unavailable" flag.
     *
     * @param {ServiceInstances} service - The per-network URL arrays for the
     *   service.
     * @param {string} serviceName - The service name (used for text matching
     *   and hide-lookup).
     * @param {ActiveNetworks} activeNetworks - Which network types are
     *   currently enabled.
     * @param {string} lowerFilter - Lowercased search term ("" means no
     *   filter).
     * @returns {MatchCounts} Object with `matched` (total instances matching
     *   the filter) and `afterHide` (subset still visible after hiding
     *   unreachable instances).
     */
    function countMatches(service, serviceName, activeNetworks, lowerFilter) {
        var matched = 0;
        var afterHide = 0;
        for (var ni = 0; ni < NETWORK_ORDER.length; ni++) {
            var net = NETWORK_ORDER[ni];
            if (!activeNetworks[net]) continue;
            var netUrls = service[net];
            if (!netUrls) continue;
            for (var u = 0; u < netUrls.length; u++) {
                var url = netUrls[u];
                if (lowerFilter !== "" && serviceName.toLowerCase().indexOf(lowerFilter) === -1 && url.toLowerCase().indexOf(lowerFilter) === -1) continue;
                matched++;
                if (hideByService[serviceName] && healthResults[url] === BADGE_UNREACHABLE) continue;
                afterHide++;
            }
        }
        return { matched: matched, afterHide: afterHide };
    }

    // =========================================================================
    // RENDERING: BADGES
    // =========================================================================

    /**
     * Create a `<span>` badge element that visually indicates a health-check
     * result: ✓ (green) for reachable, ✗ (red) for unreachable, – (muted)
     * for skipped.
     *
     * @param {BadgeResult} result - One of `BADGE_REACHABLE`, `BADGE_UNREACHABLE`,
     *   or `BADGE_SKIP`.
     * @returns {HTMLSpanElement} The badge element ready for DOM insertion.
     */
    function renderBadge(result) {
        var badge = document.createElement("span");
        if (result === BADGE_REACHABLE) {
            badge.textContent = " \u2713";
            badge.style.color = "var(--green)";
        } else if (result === BADGE_UNREACHABLE) {
            badge.textContent = " \u2717";
            badge.style.color = "var(--red)";
        } else if (result === BADGE_SKIP) {
            badge.textContent = " \u2013";
            badge.title = "Cannot check from browser (" + buildSkipLabel() + ")";
            badge.style.color = "var(--text-muted)";
        }
        return badge;
    }

    // =========================================================================
    // RENDERING: MAIN
    // =========================================================================

    /**
     * Build and insert the full instance list DOM from scratch.
     *
     * This is the core rendering function.  It sorts services (favorites
     * first), filters by search text and active networks, collapses hidden
     * services, and produces accessible, interactive markup with favorite
     * toggles, check buttons, hide toggles, and reachability badges.
     *
     * **Security note**: all text content is inserted via
     * `document.createTextNode` or `.textContent`.  Anchor `href` values are
     * validated through {@link isAllowedUrl} and protected from
     * `javascript:` / `data:` URIs.
     *
     * @param {AllData} data - The full service-instance catalog.
     * @param {string} filterText - Raw search input value (untrimmed).
     * @param {ActiveNetworks} activeNetworks - Which network types are enabled.
     * @returns {void}
     */
    function renderInstances(data, filterText, activeNetworks) {
        var services = Object.keys(data);
        services.sort(function (a, b) {
            var aFav = isFavService(a) ? 1 : 0;
            var bFav = isFavService(b) ? 1 : 0;
            if (aFav !== bFav) return bFav - aFav;
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        });

        var fragment = document.createDocumentFragment();
        var lowerFilter = filterText.toLowerCase();

        for (var s = 0; s < services.length; s++) {
            var serviceName = services[s];
            var service = data[serviceName];

            var counts = countMatches(service, serviceName, activeNetworks, lowerFilter);
            if (counts.matched === 0) continue;

            var isExpanded = !!expandedSections[serviceName];
            var section = document.createElement("section");
            if (isFavService(serviceName)) section.classList.add("fav-section");
            section.setAttribute("aria-label", serviceName + " instances");

            var contentDiv = document.createElement("div");
            contentDiv.id = "content-" + serviceName;
            contentDiv.hidden = !isExpanded;

            var header = document.createElement("h2");

            var favBtn = document.createElement("button");
            favBtn.type = "button";
            favBtn.className = "fav-btn" + (isFavService(serviceName) ? " active" : "");
            favBtn.title = isFavService(serviceName) ? "Remove from favorites" : "Add to favorites";
            favBtn.textContent = isFavService(serviceName) ? "\u2605" : "\u2606";
            favBtn.addEventListener("click", (function (sn) {
                return function (e) {
                    e.stopPropagation();
                    toggleFavService(sn);
                };
            })(serviceName));
            header.appendChild(favBtn);

            header.appendChild(document.createTextNode(" "));

            var nameSpan = document.createElement("span");
            nameSpan.appendChild(highlightMatch(serviceName, lowerFilter));
            header.appendChild(nameSpan);

            var countSmall = document.createElement("small");
            if (hideByService[serviceName] && counts.afterHide !== counts.matched) {
                countSmall.textContent = " (" + counts.afterHide + "/" + counts.matched + ")";
            } else {
                countSmall.textContent = " (" + counts.matched + ")";
            }
            header.appendChild(countSmall);

            header.setAttribute("aria-expanded", String(isExpanded));
            header.setAttribute("aria-controls", "content-" + serviceName);
            header.addEventListener("click", (function (content, sn) {
                return function () {
                    var expanded = this.getAttribute("aria-expanded") === "true";
                    this.setAttribute("aria-expanded", String(!expanded));
                    content.hidden = expanded;
                    expandedSections[sn] = !expanded;
                };
            })(contentDiv, serviceName));

            section.appendChild(header);

            var controlsSpan = document.createElement("span");
            controlsSpan.className = "svc-controls";

            var checkBtn = document.createElement("button");
            checkBtn.type = "button";
            checkBtn.className = "ctrl-btn";
            checkBtn.textContent = "Check";
            checkBtn.addEventListener("click", (function (sn) {
                return function () { startCheckService(sn); };
            })(serviceName));
            controlsSpan.appendChild(checkBtn);

            var hideBtn = document.createElement("button");
            hideBtn.type = "button";
            hideBtn.className = "ctrl-btn";
            hideBtn.textContent = hideByService[serviceName] ? "Show" : "Hide N/A";
            if (hideByService[serviceName]) hideBtn.classList.add("active");
            hideBtn.addEventListener("click", (function (sn, btn) {
                return function () {
                    if (Object.keys(healthResults).length === 0) return;
                    hideByService[sn] = !hideByService[sn];
                    btn.textContent = hideByService[sn] ? "Show" : "Hide N/A";
                    if (hideByService[sn]) {
                        btn.classList.add("active");
                    } else {
                        btn.classList.remove("active");
                    }
                    updateGlobalControls();
                    refresh();
                };
            })(serviceName, hideBtn));
            controlsSpan.appendChild(hideBtn);

            var statusSpan = document.createElement("span");
            statusSpan.className = "svc-status";
            statusSpan.id = "svc-status-" + serviceName;
            controlsSpan.appendChild(statusSpan);

            contentDiv.appendChild(controlsSpan);

            section.appendChild(contentDiv);

            for (var ni = 0; ni < NETWORK_ORDER.length; ni++) {
                var net = NETWORK_ORDER[ni];
                if (!activeNetworks[net]) continue;
                var netUrls = service[net];
                if (!netUrls || netUrls.length === 0) continue;

                var visibleUrls = [];
                for (var uj = 0; uj < netUrls.length; uj++) {
                    var url = netUrls[uj];
                    if (lowerFilter !== "" && serviceName.toLowerCase().indexOf(lowerFilter) === -1 && url.toLowerCase().indexOf(lowerFilter) === -1) continue;
                    if (hideByService[serviceName] && healthResults[url] === BADGE_UNREACHABLE) continue;
                    visibleUrls.push(url);
                }

                var favUrls = [];
                var normalUrls = [];
                for (var si = 0; si < visibleUrls.length; si++) {
                    if (isFavUrl(visibleUrls[si])) {
                        favUrls.push(visibleUrls[si]);
                    } else {
                        normalUrls.push(visibleUrls[si]);
                    }
                }
                var sortedUrls = favUrls.concat(normalUrls);

                if (visibleUrls.length === 0) continue;

                var h3 = document.createElement("h3");
                h3.textContent = NETWORK_LABELS[net] + " (" + sortedUrls.length + ")";
                contentDiv.appendChild(h3);

                var ul = document.createElement("ul");
                for (var vi = 0; vi < sortedUrls.length; vi++) {
                    var vUrl = sortedUrls[vi];
                    var li = document.createElement("li");
                    if (isFavUrl(vUrl)) li.classList.add("fav-url");

                    var urlFavBtn = document.createElement("button");
                    urlFavBtn.type = "button";
                    urlFavBtn.className = "fav-btn fav-btn-sm" + (isFavUrl(vUrl) ? " active" : "");
                    urlFavBtn.title = isFavUrl(vUrl) ? "Remove from favorites" : "Add to favorites";
                    urlFavBtn.textContent = isFavUrl(vUrl) ? "\u2605" : "\u2606";
                    urlFavBtn.addEventListener("click", (function (u) {
                        return function () { toggleFavUrl(u); };
                    })(vUrl));
                    li.appendChild(urlFavBtn);

                    // Double-validate: exclude javascript: and data: URIs even if they
                    // somehow passed isAllowedUrl (defense in depth).
                    if (isAllowedUrl(vUrl) && vUrl.indexOf("javascript:") !== 0 && vUrl.indexOf("data:") !== 0) {
                        var a = document.createElement("a");
                        a.href = vUrl;
                        a.appendChild(highlightMatch(vUrl, lowerFilter));
                        a.rel = "noopener noreferrer";
                        li.appendChild(a);
                    } else {
                        var code = document.createElement("code");
                        code.appendChild(highlightMatch(vUrl, lowerFilter));
                        li.appendChild(code);
                    }
                    if (healthResults.hasOwnProperty(vUrl)) {
                        li.appendChild(renderBadge(healthResults[vUrl]));
                    }
                    ul.appendChild(li);
                }
                contentDiv.appendChild(ul);
            }

            fragment.appendChild(section);
        }

        instancesContainer.replaceChildren(fragment);
        updateAllServiceStatuses();
    }

    /**
     * Build the active-networks map from the current state of filter
     * checkboxes.
     *
     * @returns {ActiveNetworks} Object whose keys are network names and values
     *   are boolean checked states.
     */
    function getActiveNetworks() {
        var networks = {};
        for (var key in filterCheckboxes) {
            networks[key] = filterCheckboxes[key].checked;
        }
        return networks;
    }

    // =========================================================================
    // REFRESH & DEBOUNCE
    // =========================================================================

    /**
     * Timer ID for the debounced refresh.  `null` when no refresh is pending.
     * @type {?number}
     */
    var debounceTimer = null;

    /**
     * Immediate (synchronous) re-render of the instance list using current
     * filter state and search input.  No-op if data has not been loaded yet.
     *
     * @returns {void}
     */
    function refresh() {
        if (!allData) return;
        renderInstances(allData, searchInput.value, getActiveNetworks());
    }

    /**
     * Debounced wrapper around {@link refresh}.  Rapid successive calls are
     * coalesced into a single render after 200 ms of inactivity, preventing
     * unnecessary reflows while the user types.
     *
     * @returns {void}
     */
    function debouncedRefresh() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            debounceTimer = null;
            refresh();
        }, 200);
    }

    // =========================================================================
    // SEARCH & FILTER EVENT BINDINGS
    // =========================================================================

    // Search input: debounced re-render on each keystroke
    searchInput.addEventListener("input", debouncedRefresh);

    // Network filter checkboxes: persist state and re-render on change
    for (var key in filterCheckboxes) {
        filterCheckboxes[key].addEventListener("change", function () {
            saveFilters();
            updateClearAllDataBtn();
            refresh();
        });
    }

    // =========================================================================
    // DATA FETCH & INITIALIZATION
    // =========================================================================

    /**
     * AbortController used to cancel in-flight fetches if the user navigates
     * away before they complete, preventing wasted network usage.
     * @type {AbortController}
     */
    var fetchController = new AbortController();

    loadFavorites();
    loadFilters();
    updateClearFavsBtn();
    updateClearAllDataBtn();

    /**
     * Cancel pending fetches on `beforeunload` so the browser can cleanly
     * tear down the page.
     */
    window.addEventListener("beforeunload", function () {
        fetchController.abort();
    });

    /**
     * Build the skip-TLD message string (e.g. "Tor/I2P/Loki") from the current
     * {@link NETWORK_LABELS}, excluding the "clearnet" entry.
     *
     * @returns {string} Comma-separated network labels that are skipped.
     */
    function buildSkipLabel() {
        var labels = [];
        for (var i = 0; i < NETWORK_ORDER.length; i++) {
            if (NETWORK_ORDER[i] !== "clearnet") {
                labels.push(NETWORK_LABELS[NETWORK_ORDER[i]] || NETWORK_ORDER[i]);
            }
        }
        return labels.join("/");
    }

    /**
     * Apply network definitions from a parsed `networks.json` response.
     * Updates {@link NETWORK_LABELS}, {@link NETWORK_ORDER}, and
     * {@link SKIP_TLDS}.
     *
     * @param {Record<string, {tld: string, name: string}>} networks - Parsed
     *   networks.json data.
     * @returns {void}
     */
    function applyNetworks(networks) {
        var labels = {};
        var order = [];
        var tlds = [];

        var keys = Object.keys(networks);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var def = networks[key];
            labels[key] = def.name || key;
            order.push(key);
            if (key !== "clearnet" && def.tld) {
                tlds.push(def.tld);
            }
        }

        if (order.length > 0) {
            NETWORK_ORDER = order;
            NETWORK_LABELS = labels;
            SKIP_TLDS = tlds;
        }
    }

    /**
     * Fetch the network definitions, apply them, then fetch the service
     * instance catalog, and trigger the initial render.
     *
     * On failure an error message is displayed inside the instances container
     * as an ARIA `role="alert"` element so assistive technology announces it.
     */
    fetch(NETWORKS_URL, { signal: fetchController.signal })
        .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(function (networks) {
            applyNetworks(networks);
            return fetch(DATA_URL, { signal: fetchController.signal });
        })
        .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(function (data) {
            allData = data;
            if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
            loadingEl = null;
            instancesContainer.removeAttribute("aria-busy");
            refresh();
        })
        .catch(function (err) {
            instancesContainer.innerHTML = "";
            var p = document.createElement("p");
            p.setAttribute("role", "alert");
            p.textContent = "Failed to load instances: " + err.message;
            instancesContainer.appendChild(p);
        });
})();
