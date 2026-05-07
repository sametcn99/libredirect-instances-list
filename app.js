(function () {
    var DATA_URL = "https://raw.githubusercontent.com/libredirect/instances/main/data.json";
    var ALLOWED_SCHEMES = ["https:", "http:"];
    var NETWORK_LABELS = {
        clearnet: "Clearnet",
        tor: "Tor",
        i2p: "I2P",
        loki: "Loki"
    };
    var NETWORK_ORDER = ["clearnet", "tor", "i2p", "loki"];
    var CHECK_TIMEOUT_MS = 6000;
    var CONCURRENCY = 16;
    var BADGE_REACHABLE = 1;
    var BADGE_UNREACHABLE = 0;
    var BADGE_SKIP = -1;

    var instancesContainer = document.getElementById("instances");
    var loadingEl = document.getElementById("loading");
    var searchInput = document.getElementById("search");
    var filterCheckboxes = {
        clearnet: document.getElementById("filter-clearnet"),
        tor: document.getElementById("filter-tor"),
        i2p: document.getElementById("filter-i2p"),
        loki: document.getElementById("filter-loki")
    };
    var checkAllBtn = document.getElementById("check-all");
    var hideAllBtn = document.getElementById("hide-all");
    var healthStatusEl = document.getElementById("health-status");
    var clearFavsBtn = document.getElementById("clear-favs");
    var clearAllDataBtn = document.getElementById("clear-all-data");

    var FAV_STORAGE_KEY = "libredirect_favorites";
    var FILTER_STORAGE_KEY = "libredirect_network_filters";
    var FAV_SVC_KEY = "svc_";
    var FAV_URL_KEY = "url_";

    var allData = null;
    var healthResults = {};
    var checkingServices = {};
    var hideByService = {};
    var expandedSections = {};
    var pendingChecks = {};
    var checkInProgressCount = 0;
    var favorites = { services: {}, urls: {} };

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

    function isFavService(name) {
        return !!favorites.services[FAV_SVC_KEY + name];
    }

    function isFavUrl(url) {
        return !!favorites.urls[FAV_URL_KEY + url];
    }

    function updateClearFavsBtn() {
        var hasFav = false;
        for (var k in favorites.services) { hasFav = true; break; }
        if (!hasFav) {
            for (var u in favorites.urls) { hasFav = true; break; }
        }
        clearFavsBtn.disabled = !hasFav;
    }

    function updateClearAllDataBtn() {
        var hasData = !!localStorage.getItem(FAV_STORAGE_KEY) || !!localStorage.getItem(FILTER_STORAGE_KEY);
        clearAllDataBtn.disabled = !hasData;
    }

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

    function isCheckableUrl(url) {
        if (!isAllowedUrl(url)) return false;
        try {
            var host = new URL(url).hostname.toLowerCase();
            if (host.endsWith(".onion")) return false;
            if (host.endsWith(".i2p")) return false;
            if (host.endsWith(".loki")) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

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
        healthStatusEl.textContent = "Checking 0/" + urls.length + (cached > 0 ? " (cached: " + cached + ")" : "") + (skippedCount > 0 ? " | " + skippedCount + " skipped (Tor/I2P/Loki)" : "");

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

    function updateAllServiceStatuses() {
        if (!allData) return;
        var services = Object.keys(allData);
        for (var i = 0; i < services.length; i++) {
            updateServiceStatus(services[i]);
        }
    }

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

    checkAllBtn.addEventListener("click", startCheckAll);

    clearFavsBtn.addEventListener("click", function () {
        if (confirm("Are you sure you want to clear all favorites?")) {
            favorites = { services: {}, urls: {} };
            saveFavorites();
            updateClearFavsBtn();
            updateClearAllDataBtn();
            refresh();
        }
    });

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
            badge.title = "Cannot check from browser (Tor/I2P/Loki)";
            badge.style.color = "var(--text-muted)";
        }
        return badge;
    }

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

    function getActiveNetworks() {
        var networks = {};
        for (var key in filterCheckboxes) {
            networks[key] = filterCheckboxes[key].checked;
        }
        return networks;
    }

    var debounceTimer = null;
    function refresh() {
        if (!allData) return;
        renderInstances(allData, searchInput.value, getActiveNetworks());
    }

    function debouncedRefresh() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            debounceTimer = null;
            refresh();
        }, 200);
    }

    searchInput.addEventListener("input", debouncedRefresh);
    for (var key in filterCheckboxes) {
        filterCheckboxes[key].addEventListener("change", function () {
            saveFilters();
            updateClearAllDataBtn();
            refresh();
        });
    }

    var fetchController = new AbortController();

    loadFavorites();
    loadFilters();
    updateClearFavsBtn();
    updateClearAllDataBtn();

    window.addEventListener("beforeunload", function () {
        fetchController.abort();
    });

    fetch(DATA_URL, { signal: fetchController.signal })
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