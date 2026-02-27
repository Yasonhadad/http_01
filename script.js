const STORAGE_KEY = "the-one.crm-state.v1";
const DEFAULT_SOURCE_ICON = { label: "Source", icon: "?", className: "" };

const SOURCE_META = {
    facebook: { label: "Facebook", icon: "f", className: "source-facebook" },
    yad2: { label: "Yad2", icon: "Y2", className: "source-yad2" },
    madlan: { label: "Madlan", icon: "M", className: "source-madlan" }
};

const APP_CONFIG = sanitizeConfig(window.THE_ONE_CONFIG || {});

const state = {
    activeFilter: "all",
    allProperties: [],
    crmState: loadCRMState(),
    fallbackMode: false
};

const feedElement = document.getElementById("feed");
const template = document.getElementById("property-card-template");
const filterButtons = Array.from(document.querySelectorAll(".filter-chip[data-filter]"));
const refreshButton = document.getElementById("refresh-feed");
const connectionBanner = document.querySelector(".connection-banner");
const connectionStatusElement = document.getElementById("connection-status");

boot();

function boot() {
    attachEventListeners();
    loadFeed();
}

function attachEventListeners() {
    filterButtons.forEach((button) => {
        button.addEventListener("click", () => {
            state.activeFilter = button.dataset.filter || "all";
            filterButtons.forEach((chip) => chip.classList.remove("active"));
            button.classList.add("active");
            renderFeed();
        });
    });

    refreshButton.addEventListener("click", () => {
        loadFeed();
    });

    feedElement.addEventListener("click", (event) => {
        const actionButton = event.target.closest("button[data-action]");
        if (!actionButton) {
            return;
        }

        const card = actionButton.closest(".property-card");
        if (!card) {
            return;
        }

        const propertyId = card.dataset.propertyId;
        const selectedAction = actionButton.dataset.action;
        const previousAction = state.crmState[propertyId];
        const nextAction = previousAction === selectedAction ? "new" : selectedAction;
        state.crmState[propertyId] = nextAction;
        saveCRMState(state.crmState);
        syncCRMStatus(propertyId, nextAction);
        renderFeed();
    });
}

async function loadFeed() {
    setConnectionStatus("Loading feed...", "warn");

    try {
        if (isSupabaseConfigured()) {
            const remoteProperties = await fetchPropertiesFromSupabase();
            if (remoteProperties.length) {
                state.fallbackMode = false;
                state.allProperties = remoteProperties;
                setConnectionStatus(`Connected to Supabase (${remoteProperties.length} properties).`, "ok");
                renderFeed();
                return;
            }
            setConnectionStatus("Supabase connected but empty feed. Showing fallback sample data.", "warn");
        } else {
            setConnectionStatus("Supabase not configured. Showing fallback sample data.", "warn");
        }

        state.fallbackMode = true;
        state.allProperties = deduplicateListings(getMockListings()).sort(
            (a, b) => Date.parse(b.lastBumpedAt) - Date.parse(a.lastBumpedAt)
        );
        renderFeed();
    } catch (error) {
        console.error("Failed to load from Supabase. Falling back to local sample.", error);
        state.fallbackMode = true;
        state.allProperties = deduplicateListings(getMockListings()).sort(
            (a, b) => Date.parse(b.lastBumpedAt) - Date.parse(a.lastBumpedAt)
        );
        setConnectionStatus("Could not reach Supabase. Showing fallback sample data.", "error");
        renderFeed();
    }
}

async function fetchPropertiesFromSupabase() {
    const fields = [
        "id",
        "city",
        "neighborhood",
        "street",
        "building_number",
        "floor",
        "rooms",
        "area_sqm",
        "current_price_ils",
        "first_spotted_at",
        "last_bumped_at",
        "dedupe_confidence",
        "source_urls",
        "price_history"
    ].join(",");

    const url =
        `${APP_CONFIG.supabaseUrl}/rest/v1/properties` +
        `?select=${encodeURIComponent(fields)}` +
        "&order=last_bumped_at.desc" +
        `&limit=${APP_CONFIG.feedLimit}`;

    const response = await fetch(url, {
        headers: supabaseHeaders(APP_CONFIG.supabaseAnonKey)
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Supabase properties request failed (${response.status}): ${message}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
        return [];
    }

    return rows.map(mapPropertyRowToViewModel);
}

function mapPropertyRowToViewModel(row) {
    const sourceUrls = Array.isArray(row.source_urls) ? row.source_urls : [];
    const priceHistory = Array.isArray(row.price_history) ? row.price_history : [];
    const street = [row.street, row.building_number].filter(Boolean).join(" ").trim();
    const address = street || row.neighborhood || row.city || "Unknown address";
    const fallbackDate = new Date().toISOString();

    const mappedSources = sourceUrls
        .map((entry) => ({
            source: String(entry.source || "").toLowerCase(),
            sourceListingId: entry.source_listing_id || entry.sourceListingId || "unknown",
            deepLink: entry.url || entry.deep_link_url || entry.deepLink || "#",
            firstSpottedAt: entry.first_spotted_at || entry.firstSpottedAt || row.first_spotted_at || fallbackDate,
            lastBumpedAt: entry.last_bumped_at || entry.lastBumpedAt || row.last_bumped_at || fallbackDate
        }))
        .filter((entry) => entry.deepLink && entry.deepLink !== "#");

    return {
        id: row.id,
        anchorListing: null,
        city: row.city || "",
        neighborhood: row.neighborhood || "",
        address,
        floor: row.floor ?? 0,
        rooms: Number(row.rooms ?? 0),
        sqm: Number(row.area_sqm ?? 0),
        firstSpottedAt: row.first_spotted_at || fallbackDate,
        lastBumpedAt: row.last_bumped_at || fallbackDate,
        currentPriceIls: Number(row.current_price_ils ?? 0),
        sourceListings: mappedSources,
        priceHistory: normalizeRemotePriceHistory(priceHistory, mappedSources),
        imageHashes: [],
        matchConfidence: Number(row.dedupe_confidence ?? 0.82)
    };
}

function normalizeRemotePriceHistory(historyEvents, sourceListings) {
    const fallbackSource = sourceListings[0] ? sourceListings[0].source : "facebook";
    return historyEvents
        .map((event) => ({
            at: event.event_at || event.at || null,
            priceIls: Number(event.new_price_ils ?? event.price_ils ?? event.priceIls ?? 0),
            source: String(event.source || fallbackSource).toLowerCase()
        }))
        .filter((event) => event.at && Number.isFinite(event.priceIls) && event.priceIls > 0)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function renderFeed() {
    const visibleProperties = state.allProperties.filter((property) => {
        if (state.activeFilter === "all") {
            return true;
        }
        return computeAgeBadge(property.firstSpottedAt).bucket === state.activeFilter;
    });

    feedElement.innerHTML = "";

    if (!visibleProperties.length) {
        const emptyState = document.createElement("p");
        emptyState.className = "empty-state";
        emptyState.textContent = "No properties found for this filter.";
        feedElement.appendChild(emptyState);
        return;
    }

    visibleProperties.forEach((property) => {
        const cardFragment = template.content.cloneNode(true);
        const card = cardFragment.querySelector(".property-card");
        card.dataset.propertyId = property.id;

        const crmStatus = state.crmState[property.id] || "new";
        if (crmStatus === "not_relevant") {
            card.classList.add("muted");
        }

        const ageBadge = computeAgeBadge(property.firstSpottedAt);
        const ageTag = card.querySelector(".age-tag");
        ageTag.classList.add(ageBadge.className);
        ageTag.textContent = ageBadge.label;

        card.querySelector(".confidence-pill").textContent = `Match ${Math.round(property.matchConfidence * 100)}%`;
        card.querySelector(".property-price").textContent = formatIls(property.currentPriceIls);
        card.querySelector(".property-location").textContent = `${property.address}, ${property.neighborhood || property.city}`;
        card.querySelector(".property-specs").textContent = `${property.rooms || "?"} rooms • ${property.sqm || "?"} sqm • floor ${property.floor || "?"}`;
        card.querySelector(".first-spotted").textContent = formatDate(property.firstSpottedAt);
        card.querySelector(".last-bumped").textContent = formatDate(property.lastBumpedAt);

        const sourceList = card.querySelector(".source-list");
        property.sourceListings.forEach((sourceListing) => {
            sourceList.appendChild(buildSourceLink(sourceListing));
        });
        if (!property.sourceListings.length) {
            sourceList.textContent = "No source links available";
        }

        const historyList = card.querySelector(".price-history");
        if (property.priceHistory.length) {
            property.priceHistory.slice(0, 8).forEach((event) => {
                const item = document.createElement("li");
                const sourceMeta = SOURCE_META[event.source] || DEFAULT_SOURCE_ICON;
                item.textContent = `${formatDate(event.at)} - ${formatIls(event.priceIls)} (${sourceMeta.label})`;
                historyList.appendChild(item);
            });
        } else {
            const item = document.createElement("li");
            item.textContent = "No price history data yet.";
            historyList.appendChild(item);
        }

        card.querySelectorAll("button[data-action]").forEach((button) => {
            button.classList.toggle("active", button.dataset.action === crmStatus);
        });

        feedElement.appendChild(cardFragment);
    });
}

function buildSourceLink(sourceListing) {
    const sourceKey = String(sourceListing.source || "").toLowerCase();
    const sourceDetails = SOURCE_META[sourceKey] || DEFAULT_SOURCE_ICON;
    const link = document.createElement("a");
    link.className = `source-link ${sourceDetails.className}`;
    link.href = sourceListing.deepLink;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = `
        <span class="source-icon">${escapeHTML(sourceDetails.icon)}</span>
        <span>${escapeHTML(sourceDetails.label)}</span>
    `;
    return link;
}

async function syncCRMStatus(propertyId, status) {
    if (!isRemoteCRMSyncEnabled() || state.fallbackMode) {
        return;
    }

    const payload = [
        {
            user_id: APP_CONFIG.userId,
            property_id: propertyId,
            status
        }
    ];

    try {
        const response = await fetch(
            `${APP_CONFIG.supabaseUrl}/rest/v1/user_property_crm?on_conflict=user_id,property_id`,
            {
                method: "POST",
                headers: {
                    ...supabaseHeaders(APP_CONFIG.supabaseAnonKey),
                    "Content-Type": "application/json",
                    Prefer: "resolution=merge-duplicates,return=minimal"
                },
                body: JSON.stringify(payload)
            }
        );

        if (!response.ok) {
            const message = await response.text();
            console.warn(`CRM sync failed (${response.status}): ${message}`);
        }
    } catch (error) {
        console.warn("CRM sync failed with network error.", error);
    }
}

function setConnectionStatus(message, tone) {
    connectionStatusElement.textContent = message;
    connectionBanner.classList.remove("ok", "warn", "error");
    if (tone) {
        connectionBanner.classList.add(tone);
    }
}

function supabaseHeaders(apiKey) {
    return {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`
    };
}

function isSupabaseConfigured() {
    return Boolean(APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseAnonKey);
}

function isRemoteCRMSyncEnabled() {
    return isSupabaseConfigured() && APP_CONFIG.crmSync && APP_CONFIG.userId;
}

function sanitizeConfig(rawConfig) {
    const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const defaultFeedLimit = 80;
    const isPlaceholder = (value) =>
        typeof value === "string" &&
        (value.includes("YOUR_") || value.includes("<") || value.toLowerCase().includes("changeme"));

    const safeUrl = typeof config.supabaseUrl === "string" && !isPlaceholder(config.supabaseUrl)
        ? config.supabaseUrl.replace(/\/$/, "")
        : "";
    const safeKey = typeof config.supabaseAnonKey === "string" && !isPlaceholder(config.supabaseAnonKey)
        ? config.supabaseAnonKey
        : "";

    return {
        supabaseUrl: safeUrl,
        supabaseAnonKey: safeKey,
        userId: typeof config.userId === "string" && !isPlaceholder(config.userId) ? config.userId : "",
        crmSync: config.crmSync !== false,
        feedLimit: Number.isInteger(config.feedLimit) ? config.feedLimit : defaultFeedLimit
    };
}

function deduplicateListings(listings) {
    const properties = [];

    for (const listing of listings) {
        let matchedProperty = null;
        let bestScore = 0;

        for (const property of properties) {
            const matchResult = computeMatch(listing, property.anchorListing);
            if (matchResult.isMatch && matchResult.confidence > bestScore) {
                matchedProperty = property;
                bestScore = matchResult.confidence;
            }
        }

        if (!matchedProperty) {
            properties.push(createProperty(listing));
            continue;
        }

        mergeListing(matchedProperty, listing, bestScore);
    }

    return properties.map(finalizeProperty);
}

function createProperty(listing) {
    const baseId = [
        listing.city,
        listing.neighborhood,
        listing.address,
        listing.floor,
        listing.rooms
    ]
        .map(normalizeText)
        .join("-");

    return {
        id: `property-${baseId}`,
        anchorListing: listing,
        city: listing.city,
        neighborhood: listing.neighborhood,
        address: listing.address,
        floor: listing.floor,
        rooms: listing.rooms,
        sqm: listing.sqm,
        firstSpottedAt: listing.firstSpottedAt,
        lastBumpedAt: listing.lastBumpedAt,
        currentPriceIls: listing.priceIls,
        sourceListings: [
            {
                source: listing.source,
                sourceListingId: listing.sourceListingId,
                deepLink: listing.deepLink,
                firstSpottedAt: listing.firstSpottedAt,
                lastBumpedAt: listing.lastBumpedAt
            }
        ],
        priceHistory: normalizePriceHistory(
            listing.priceHistory,
            listing.source,
            listing.priceIls,
            listing.lastBumpedAt
        ),
        imageHashes: [...listing.imageHashes],
        matchConfidence: 0.62
    };
}

function mergeListing(property, listing, confidenceScore) {
    property.firstSpottedAt = minDate(property.firstSpottedAt, listing.firstSpottedAt);
    property.lastBumpedAt = maxDate(property.lastBumpedAt, listing.lastBumpedAt);
    property.sqm = Math.max(property.sqm, listing.sqm);
    property.currentPriceIls = listing.priceIls;
    property.matchConfidence = Math.max(property.matchConfidence, confidenceScore);
    property.imageHashes = uniqueStrings(property.imageHashes.concat(listing.imageHashes));

    const hasSourceAlready = property.sourceListings.some(
        (item) => item.source === listing.source && item.sourceListingId === listing.sourceListingId
    );

    if (!hasSourceAlready) {
        property.sourceListings.push({
            source: listing.source,
            sourceListingId: listing.sourceListingId,
            deepLink: listing.deepLink,
            firstSpottedAt: listing.firstSpottedAt,
            lastBumpedAt: listing.lastBumpedAt
        });
    }

    const listingPriceHistory = normalizePriceHistory(
        listing.priceHistory,
        listing.source,
        listing.priceIls,
        listing.lastBumpedAt
    );
    property.priceHistory = mergePriceHistory(property.priceHistory, listingPriceHistory);
}

function finalizeProperty(property) {
    const sortedHistory = [...property.priceHistory].sort(
        (a, b) => Date.parse(b.at) - Date.parse(a.at)
    );
    const latestKnown = sortedHistory[0];
    property.currentPriceIls = latestKnown ? latestKnown.priceIls : property.currentPriceIls;
    property.priceHistory = sortedHistory;
    property.sourceListings.sort((a, b) => Date.parse(b.lastBumpedAt) - Date.parse(a.lastBumpedAt));
    return property;
}

function computeMatch(candidate, anchor) {
    const addressScore = tokenSimilarity(candidate.address, anchor.address);
    const neighborhoodScore =
        normalizeText(candidate.neighborhood) === normalizeText(anchor.neighborhood) ? 1 : 0;
    const locationScore = Math.max(addressScore, neighborhoodScore * 0.85);
    const floorScore = Number(candidate.floor) === Number(anchor.floor) ? 1 : 0;
    const priceGap = Math.abs(candidate.priceIls - anchor.priceIls) / Math.max(candidate.priceIls, anchor.priceIls);
    const priceScore = Math.max(0, 1 - priceGap / 0.05);

    // In production this can be replaced by AI vision embeddings or pHash distances.
    const imageScore = jaccardSimilarity(candidate.imageHashes, anchor.imageHashes);

    const isMatch =
        locationScore >= 0.6 &&
        floorScore === 1 &&
        priceGap <= 0.03 &&
        (imageScore >= 0.25 || neighborhoodScore === 1);

    const confidence = locationScore * 0.35 + floorScore * 0.2 + priceScore * 0.2 + imageScore * 0.25;

    return { isMatch, confidence };
}

function normalizePriceHistory(events, source, currentPrice, lastBumpedAt) {
    const normalizedEvents = Array.isArray(events) ? [...events] : [];
    normalizedEvents.push({ at: lastBumpedAt, priceIls: currentPrice });
    return normalizedEvents
        .filter((event) => event && Number.isFinite(event.priceIls) && event.at)
        .map((event) => ({
            at: event.at,
            priceIls: event.priceIls,
            source
        }));
}

function mergePriceHistory(existingHistory, newHistory) {
    const historyMap = new Map();
    [...existingHistory, ...newHistory].forEach((event) => {
        const key = `${event.priceIls}-${event.at}`;
        if (!historyMap.has(key)) {
            historyMap.set(key, event);
        }
    });
    return Array.from(historyMap.values());
}

function computeAgeBadge(firstSpottedAt) {
    const ageHours = (Date.now() - Date.parse(firstSpottedAt)) / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    if (ageHours < 24) {
        return { bucket: "fresh", className: "green", label: "Fresh (<24h)" };
    }
    if (ageDays >= 7 && ageDays <= 14) {
        return { bucket: "watch", className: "yellow", label: "1-2 weeks" };
    }
    if (ageDays > 30) {
        return { bucket: "stale", className: "red", label: ">1 month" };
    }
    return { bucket: "all", className: "orange", label: `${Math.round(ageDays)} days old` };
}

function formatIls(value) {
    return new Intl.NumberFormat("he-IL", {
        style: "currency",
        currency: "ILS",
        maximumFractionDigits: 0
    }).format(Number(value || 0));
}

function formatDate(value) {
    return new Intl.DateTimeFormat("he-IL", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    }).format(new Date(value));
}

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenSimilarity(left, right) {
    const leftTokens = new Set(normalizeText(left).split(" ").filter(Boolean));
    const rightTokens = new Set(normalizeText(right).split(" ").filter(Boolean));
    if (!leftTokens.size || !rightTokens.size) {
        return 0;
    }
    let overlap = 0;
    leftTokens.forEach((token) => {
        if (rightTokens.has(token)) {
            overlap += 1;
        }
    });
    return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function jaccardSimilarity(leftHashes, rightHashes) {
    const left = new Set(leftHashes || []);
    const right = new Set(rightHashes || []);
    if (!left.size || !right.size) {
        return 0;
    }

    let intersection = 0;
    left.forEach((hash) => {
        if (right.has(hash)) {
            intersection += 1;
        }
    });
    const union = new Set([...left, ...right]).size;
    return intersection / union;
}

function loadCRMState() {
    try {
        const rawState = localStorage.getItem(STORAGE_KEY);
        return rawState ? JSON.parse(rawState) : {};
    } catch (error) {
        console.warn("Could not read CRM state from local storage.", error);
        return {};
    }
}

function saveCRMState(stateObject) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateObject));
}

function minDate(left, right) {
    return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxDate(left, right) {
    return Date.parse(left) >= Date.parse(right) ? left : right;
}

function uniqueStrings(values) {
    return Array.from(new Set(values));
}

function escapeHTML(input) {
    return String(input || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getMockListings() {
    const now = Date.now();
    const hoursAgo = (hours) => new Date(now - hours * 60 * 60 * 1000).toISOString();
    const daysAgo = (days) => hoursAgo(days * 24);

    return [
        {
            source: "facebook",
            sourceListingId: "fb-9301",
            deepLink: "https://facebook.com/groups/tel-aviv-rentals/posts/fb-9301",
            city: "Tel Aviv",
            neighborhood: "Florentin",
            address: "32 Herzl Street",
            floor: 2,
            rooms: 3,
            sqm: 68,
            priceIls: 7600,
            imageHashes: ["img-a1", "img-a2", "img-a3"],
            firstSpottedAt: hoursAgo(11),
            lastBumpedAt: hoursAgo(2),
            priceHistory: [
                { at: daysAgo(6), priceIls: 7900 },
                { at: daysAgo(3), priceIls: 7800 },
                { at: hoursAgo(11), priceIls: 7600 }
            ]
        },
        {
            source: "yad2",
            sourceListingId: "y2-55812",
            deepLink: "https://www.yad2.co.il/item/y2-55812",
            city: "Tel Aviv",
            neighborhood: "Florentin",
            address: "32 Herzl St",
            floor: 2,
            rooms: 3,
            sqm: 69,
            priceIls: 7600,
            imageHashes: ["img-a2", "img-a3", "img-a4"],
            firstSpottedAt: hoursAgo(10),
            lastBumpedAt: hoursAgo(3),
            priceHistory: [
                { at: daysAgo(2), priceIls: 7700 },
                { at: hoursAgo(10), priceIls: 7600 }
            ]
        },
        {
            source: "madlan",
            sourceListingId: "md-11290",
            deepLink: "https://www.madlan.co.il/listings/md-11290",
            city: "Tel Aviv",
            neighborhood: "Florentin",
            address: "Herzl 32",
            floor: 2,
            rooms: 3,
            sqm: 68,
            priceIls: 7600,
            imageHashes: ["img-a1", "img-a3", "img-a5"],
            firstSpottedAt: hoursAgo(9),
            lastBumpedAt: hoursAgo(1),
            priceHistory: [{ at: hoursAgo(9), priceIls: 7600 }]
        },
        {
            source: "facebook",
            sourceListingId: "fb-9314",
            deepLink: "https://facebook.com/groups/tel-aviv-rentals/posts/fb-9314",
            city: "Tel Aviv",
            neighborhood: "Ramat Aviv",
            address: "14 Brodetsky Street",
            floor: 5,
            rooms: 2.5,
            sqm: 62,
            priceIls: 8900,
            imageHashes: ["img-b1", "img-b2", "img-b3"],
            firstSpottedAt: daysAgo(11),
            lastBumpedAt: daysAgo(2),
            priceHistory: [
                { at: daysAgo(11), priceIls: 9200 },
                { at: daysAgo(5), priceIls: 9000 },
                { at: daysAgo(2), priceIls: 8900 }
            ]
        },
        {
            source: "yad2",
            sourceListingId: "y2-55899",
            deepLink: "https://www.yad2.co.il/item/y2-55899",
            city: "Tel Aviv",
            neighborhood: "Ramat Aviv",
            address: "14 Brodetsky St.",
            floor: 5,
            rooms: 2.5,
            sqm: 61,
            priceIls: 8900,
            imageHashes: ["img-b2", "img-b4"],
            firstSpottedAt: daysAgo(10.5),
            lastBumpedAt: daysAgo(1),
            priceHistory: [
                { at: daysAgo(4), priceIls: 9000 },
                { at: daysAgo(1), priceIls: 8900 }
            ]
        },
        {
            source: "madlan",
            sourceListingId: "md-11002",
            deepLink: "https://www.madlan.co.il/listings/md-11002",
            city: "Givatayim",
            neighborhood: "Borlov",
            address: "7 Weizmann Street",
            floor: 3,
            rooms: 3,
            sqm: 74,
            priceIls: 6800,
            imageHashes: ["img-c1", "img-c2"],
            firstSpottedAt: daysAgo(45),
            lastBumpedAt: daysAgo(32),
            priceHistory: [
                { at: daysAgo(45), priceIls: 7100 },
                { at: daysAgo(38), priceIls: 6900 },
                { at: daysAgo(32), priceIls: 6800 }
            ]
        }
    ];
}
