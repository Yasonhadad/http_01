#!/usr/bin/env node

import crypto from "node:crypto";

const CONFIG = {
    apifyToken: process.env.APIFY_TOKEN || "",
    apifyDatasetId: process.env.APIFY_DATASET_ID || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
};

validateConfig();
run().catch((error) => {
    console.error("\nSync failed:", error);
    process.exit(1);
});

async function run() {
    console.log("Fetching raw listings from Apify dataset...");
    const rawItems = await fetchApifyDatasetItems();
    console.log(`Fetched ${rawItems.length} raw items.`);

    const normalizedListings = [];
    for (const item of rawItems) {
        const parsed = await normalizeRawListing(item);
        if (parsed) {
            normalizedListings.push(parsed);
        }
    }
    console.log(`Normalized ${normalizedListings.length} listings.`);

    if (!normalizedListings.length) {
        console.log("No valid listings to sync.");
        return;
    }

    const unifiedProperties = deduplicateListings(normalizedListings)
        .map(finalizeProperty)
        .sort((a, b) => Date.parse(b.lastBumpedAt) - Date.parse(a.lastBumpedAt));

    console.log(`Deduplicated into ${unifiedProperties.length} unified properties.`);

    for (const property of unifiedProperties) {
        const persistedId = await upsertProperty(property);
        await upsertPropertySources(persistedId, property);
        await syncPropertyEvents(persistedId, property);
    }

    console.log("Sync completed successfully.");
}

function validateConfig() {
    const requiredVars = [
        ["APIFY_TOKEN", CONFIG.apifyToken],
        ["APIFY_DATASET_ID", CONFIG.apifyDatasetId],
        ["SUPABASE_URL", CONFIG.supabaseUrl],
        ["SUPABASE_SERVICE_ROLE_KEY", CONFIG.supabaseServiceRoleKey]
    ];

    const missing = requiredVars.filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (missing.length) {
        throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
}

async function fetchApifyDatasetItems() {
    const url = `https://api.apify.com/v2/datasets/${CONFIG.apifyDatasetId}/items?token=${CONFIG.apifyToken}&clean=true&format=json`;
    const response = await fetch(url);
    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Apify dataset fetch failed (${response.status}): ${message}`);
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
}

async function normalizeRawListing(item) {
    const source = normalizeSource(
        firstValue(item, ["source", "platform", "origin", "marketplace", "site"])
    );
    const deepLink = firstValue(item, ["url", "deepLink", "link", "permalink", "listingUrl"]);

    if (!source || !deepLink) {
        return null;
    }

    const textBlob = [
        firstValue(item, ["title", "headline"]),
        firstValue(item, ["description", "text", "body"]),
        firstValue(item, ["address", "street", "location"])
    ]
        .filter(Boolean)
        .join("\n");

    let aiParsed = null;
    if (CONFIG.openaiApiKey && textBlob) {
        aiParsed = await parseListingWithOpenAI(textBlob);
    }

    const priceIls = numericValue(
        firstValue(item, ["priceIls", "price", "price_ils", "rent"])
    ) || numericValue(aiParsed?.priceIls);

    const rooms = numericValue(firstValue(item, ["rooms", "roomCount"])) || numericValue(aiParsed?.rooms);
    const sqm = numericValue(firstValue(item, ["sqm", "area", "squareMeters"])) || numericValue(aiParsed?.sqm);
    const floor = numericValue(firstValue(item, ["floor", "level"])) || numericValue(aiParsed?.floor);

    const city = firstValue(item, ["city"]) || aiParsed?.city || "Unknown";
    const neighborhood = firstValue(item, ["neighborhood", "hood"]) || aiParsed?.neighborhood || "Unknown";
    const address = firstValue(item, ["address", "street"]) || aiParsed?.address || "Unknown address";

    if (!priceIls || !floor) {
        return null;
    }

    const firstSpottedAt = coerceDate(
        firstValue(item, ["firstSpottedAt", "createdAt", "postedAt", "publishedAt"])
    );
    const lastBumpedAt = coerceDate(
        firstValue(item, ["lastBumpedAt", "updatedAt", "bumpedAt", "scrapedAt"])
    );
    const sourceListingId =
        firstValue(item, ["sourceListingId", "listingId", "id", "postId"]) ||
        shortHash(`${source}:${deepLink}`);

    const imageUrls = readImageUrls(item);
    const imageHashes = imageUrls.map(shortHash);
    const inferredPriceHistory = buildPriceHistory(item, priceIls, lastBumpedAt);

    return {
        source,
        sourceListingId: String(sourceListingId),
        deepLink: String(deepLink),
        city: String(city),
        neighborhood: String(neighborhood),
        address: String(address),
        floor: Number(floor),
        rooms: Number.isFinite(rooms) ? Number(rooms) : null,
        sqm: Number.isFinite(sqm) ? Number(sqm) : null,
        priceIls: Number(priceIls),
        imageHashes,
        firstSpottedAt,
        lastBumpedAt,
        priceHistory: inferredPriceHistory
    };
}

async function parseListingWithOpenAI(text) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.openaiApiKey}`
        },
        body: JSON.stringify({
            model: CONFIG.openaiModel,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content:
                        "Extract rental listing fields from Israeli apartment text. Return JSON only with keys: city, neighborhood, address, floor, rooms, sqm, priceIls."
                },
                { role: "user", content: text }
            ]
        })
    });

    if (!response.ok) {
        const message = await response.text();
        console.warn(`OpenAI parse skipped (${response.status}): ${message}`);
        return null;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
        return null;
    }

    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
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

    return properties;
}

function createProperty(listing) {
    return {
        anchorListing: listing,
        city: listing.city,
        neighborhood: listing.neighborhood,
        address: listing.address,
        floor: listing.floor,
        rooms: listing.rooms,
        sqm: listing.sqm || 0,
        firstSpottedAt: listing.firstSpottedAt,
        lastBumpedAt: listing.lastBumpedAt,
        currentPriceIls: listing.priceIls,
        sourceListings: [
            {
                source: listing.source,
                sourceListingId: listing.sourceListingId,
                deepLink: listing.deepLink,
                firstSpottedAt: listing.firstSpottedAt,
                lastBumpedAt: listing.lastBumpedAt,
                priceIls: listing.priceIls,
                imageHashes: listing.imageHashes
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
    property.sqm = Math.max(property.sqm || 0, listing.sqm || 0);
    property.currentPriceIls = listing.priceIls;
    property.matchConfidence = Math.max(property.matchConfidence, confidenceScore);
    property.imageHashes = uniqueStrings(property.imageHashes.concat(listing.imageHashes));

    const exists = property.sourceListings.some(
        (item) => item.source === listing.source && item.sourceListingId === listing.sourceListingId
    );
    if (!exists) {
        property.sourceListings.push({
            source: listing.source,
            sourceListingId: listing.sourceListingId,
            deepLink: listing.deepLink,
            firstSpottedAt: listing.firstSpottedAt,
            lastBumpedAt: listing.lastBumpedAt,
            priceIls: listing.priceIls,
            imageHashes: listing.imageHashes
        });
    }

    property.priceHistory = mergePriceHistory(
        property.priceHistory,
        normalizePriceHistory(listing.priceHistory, listing.source, listing.priceIls, listing.lastBumpedAt)
    );
}

function finalizeProperty(property) {
    const sortedHistory = [...property.priceHistory].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const latest = sortedHistory[0];
    property.currentPriceIls = latest ? latest.priceIls : property.currentPriceIls;
    property.priceHistory = sortedHistory;
    property.sourceListings.sort((a, b) => Date.parse(b.lastBumpedAt) - Date.parse(a.lastBumpedAt));
    property.canonicalHash = buildCanonicalHash(property);
    return property;
}

async function upsertProperty(property) {
    const existing = await fetchPropertyByCanonicalHash(property.canonicalHash);

    const propertyRow = existing
        ? mergePropertyRows(existing, property)
        : buildPropertyInsertRow(property);

    if (existing) {
        await supabaseRequest(`/rest/v1/properties?id=eq.${existing.id}`, {
            method: "PATCH",
            body: propertyRow,
            headers: { Prefer: "return=representation" }
        });
        return existing.id;
    }

    const inserted = await supabaseRequest("/rest/v1/properties?on_conflict=canonical_hash", {
        method: "POST",
        body: propertyRow,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" }
    });

    if (!Array.isArray(inserted) || !inserted[0]?.id) {
        throw new Error("Failed to read inserted property id.");
    }
    return inserted[0].id;
}

async function fetchPropertyByCanonicalHash(canonicalHash) {
    const rows = await supabaseRequest(
        `/rest/v1/properties?canonical_hash=eq.${encodeURIComponent(canonicalHash)}&select=id,canonical_hash,first_spotted_at,last_bumped_at,current_price_ils,dedupe_confidence,source_urls,bump_history,price_history,image_hashes,city,neighborhood,street,building_number,floor,rooms,area_sqm&limit=1`,
        { method: "GET" }
    );
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function buildPropertyInsertRow(property) {
    return {
        canonical_hash: property.canonicalHash,
        city: property.city,
        neighborhood: property.neighborhood,
        street: property.address,
        building_number: null,
        floor: property.floor,
        rooms: property.rooms,
        area_sqm: property.sqm,
        current_price_ils: property.currentPriceIls,
        first_spotted_at: property.firstSpottedAt,
        last_bumped_at: property.lastBumpedAt,
        dedupe_confidence: Number(property.matchConfidence.toFixed(3)),
        source_urls: toSourceUrls(property.sourceListings),
        bump_history: toBumpHistory(property.sourceListings),
        price_history: toPriceHistoryRows(property.priceHistory),
        image_hashes: property.imageHashes
    };
}

function mergePropertyRows(existing, property) {
    const existingSources = Array.isArray(existing.source_urls) ? existing.source_urls : [];
    const existingBumps = Array.isArray(existing.bump_history) ? existing.bump_history : [];
    const existingPrices = Array.isArray(existing.price_history) ? existing.price_history : [];
    const existingHashes = Array.isArray(existing.image_hashes) ? existing.image_hashes : [];

    const mergedSources = dedupeObjectsByKey(
        existingSources.concat(toSourceUrls(property.sourceListings)),
        (entry) => `${entry.source}:${entry.source_listing_id}`
    );
    const mergedBumps = dedupeObjectsByKey(
        existingBumps.concat(toBumpHistory(property.sourceListings)),
        (entry) => `${entry.source}:${entry.event_at}`
    );
    const mergedPrices = dedupeObjectsByKey(
        existingPrices.concat(toPriceHistoryRows(property.priceHistory)),
        (entry) => `${entry.source}:${entry.event_at}:${entry.new_price_ils}`
    ).sort((a, b) => Date.parse(b.event_at) - Date.parse(a.event_at));

    const latestPrice = mergedPrices[0]?.new_price_ils ?? property.currentPriceIls;

    return {
        city: property.city || existing.city,
        neighborhood: property.neighborhood || existing.neighborhood,
        street: property.address || existing.street,
        floor: property.floor || existing.floor,
        rooms: property.rooms || existing.rooms,
        area_sqm: Math.max(Number(existing.area_sqm || 0), Number(property.sqm || 0)),
        first_spotted_at: minDate(existing.first_spotted_at, property.firstSpottedAt),
        last_bumped_at: maxDate(existing.last_bumped_at, property.lastBumpedAt),
        current_price_ils: latestPrice,
        dedupe_confidence: Math.max(Number(existing.dedupe_confidence || 0), Number(property.matchConfidence || 0)),
        source_urls: mergedSources,
        bump_history: mergedBumps,
        price_history: mergedPrices,
        image_hashes: uniqueStrings(existingHashes.concat(property.imageHashes))
    };
}

async function upsertPropertySources(propertyId, property) {
    for (const sourceListing of property.sourceListings) {
        const payload = [
            {
                property_id: propertyId,
                source: sourceListing.source,
                source_listing_id: sourceListing.sourceListingId,
                deep_link_url: sourceListing.deepLink,
                source_first_spotted_at: sourceListing.firstSpottedAt,
                source_last_bumped_at: sourceListing.lastBumpedAt,
                source_last_price_ils: sourceListing.priceIls,
                image_hashes: sourceListing.imageHashes,
                raw_payload: {
                    synced_at: new Date().toISOString()
                }
            }
        ];

        await supabaseRequest("/rest/v1/property_sources?on_conflict=source,source_listing_id", {
            method: "POST",
            body: payload,
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" }
        });
    }
}

async function syncPropertyEvents(propertyId, property) {
    const existing = await supabaseRequest(
        `/rest/v1/property_events?property_id=eq.${propertyId}&select=event_type,event_at,new_price_ils`,
        { method: "GET" }
    );
    const existingKeys = new Set(
        (Array.isArray(existing) ? existing : []).map(
            (entry) => `${entry.event_type}:${entry.event_at}:${entry.new_price_ils ?? ""}`
        )
    );

    const events = [];
    events.push({
        property_id: propertyId,
        event_type: "first_spotted",
        event_at: property.firstSpottedAt,
        event_payload: { source: "system" }
    });

    property.sourceListings.forEach((listing) => {
        events.push({
            property_id: propertyId,
            event_type: "bumped",
            event_at: listing.lastBumpedAt,
            event_payload: { source: listing.source, url: listing.deepLink }
        });
    });

    property.priceHistory.forEach((event) => {
        events.push({
            property_id: propertyId,
            event_type: "price_change",
            event_at: event.at,
            new_price_ils: event.priceIls,
            event_payload: { source: event.source }
        });
    });

    const missingEvents = events.filter((event) => {
        const key = `${event.event_type}:${event.event_at}:${event.new_price_ils ?? ""}`;
        return !existingKeys.has(key);
    });

    if (!missingEvents.length) {
        return;
    }

    await supabaseRequest("/rest/v1/property_events", {
        method: "POST",
        body: missingEvents,
        headers: { Prefer: "return=minimal" }
    });
}

async function supabaseRequest(path, { method = "GET", body, headers = {} } = {}) {
    const url = `${CONFIG.supabaseUrl}${path}`;
    const response = await fetch(url, {
        method,
        headers: {
            apikey: CONFIG.supabaseServiceRoleKey,
            Authorization: `Bearer ${CONFIG.supabaseServiceRoleKey}`,
            "Content-Type": "application/json",
            ...headers
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Supabase request failed (${response.status}) ${method} ${path}: ${message}`);
    }

    if (response.status === 204) {
        return null;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

function toSourceUrls(sourceListings) {
    return sourceListings.map((listing) => ({
        source: listing.source,
        source_listing_id: listing.sourceListingId,
        url: listing.deepLink,
        first_spotted_at: listing.firstSpottedAt,
        last_bumped_at: listing.lastBumpedAt
    }));
}

function toBumpHistory(sourceListings) {
    return sourceListings.map((listing) => ({
        event_at: listing.lastBumpedAt,
        source: listing.source,
        kind: "bumped",
        url: listing.deepLink
    }));
}

function toPriceHistoryRows(priceHistory) {
    const sortedAsc = [...priceHistory].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let previous = null;
    return sortedAsc.map((event) => {
        const row = {
            event_at: event.at,
            source: event.source,
            old_price_ils: previous,
            new_price_ils: event.priceIls
        };
        previous = event.priceIls;
        return row;
    });
}

function buildPriceHistory(item, currentPrice, lastBumpedAt) {
    const raw = firstValue(item, ["priceHistory", "price_history"]);
    if (!Array.isArray(raw)) {
        return [{ at: lastBumpedAt, priceIls: currentPrice }];
    }

    const parsed = raw
        .map((entry) => ({
            at: coerceDate(entry.at || entry.event_at || entry.date || lastBumpedAt),
            priceIls: numericValue(entry.priceIls || entry.new_price_ils || entry.price)
        }))
        .filter((entry) => entry.at && entry.priceIls);

    if (!parsed.length) {
        return [{ at: lastBumpedAt, priceIls: currentPrice }];
    }
    return parsed;
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
        const key = `${event.source}:${event.priceIls}:${event.at}`;
        if (!historyMap.has(key)) {
            historyMap.set(key, event);
        }
    });
    return Array.from(historyMap.values());
}

function computeMatch(candidate, anchor) {
    const addressScore = tokenSimilarity(candidate.address, anchor.address);
    const neighborhoodScore =
        normalizeText(candidate.neighborhood) === normalizeText(anchor.neighborhood) ? 1 : 0;
    const locationScore = Math.max(addressScore, neighborhoodScore * 0.85);
    const floorScore = Number(candidate.floor) === Number(anchor.floor) ? 1 : 0;
    const priceGap = Math.abs(candidate.priceIls - anchor.priceIls) / Math.max(candidate.priceIls, anchor.priceIls);
    const priceScore = Math.max(0, 1 - priceGap / 0.05);
    const imageScore = jaccardSimilarity(candidate.imageHashes, anchor.imageHashes);

    const isMatch =
        locationScore >= 0.6 &&
        floorScore === 1 &&
        priceGap <= 0.03 &&
        (imageScore >= 0.25 || neighborhoodScore === 1);

    const confidence = locationScore * 0.35 + floorScore * 0.2 + priceScore * 0.2 + imageScore * 0.25;
    return { isMatch, confidence };
}

function buildCanonicalHash(property) {
    const material = [
        normalizeText(property.city),
        normalizeText(property.neighborhood),
        normalizeText(property.address),
        Number(property.floor || 0),
        Number(property.rooms || 0)
    ].join("|");

    return crypto.createHash("sha256").update(material).digest("hex");
}

function normalizeSource(input) {
    const value = normalizeText(input);
    if (value.includes("facebook")) {
        return "facebook";
    }
    if (value.includes("yad2")) {
        return "yad2";
    }
    if (value.includes("madlan")) {
        return "madlan";
    }
    return "";
}

function readImageUrls(item) {
    const images = firstValue(item, ["images", "imageUrls", "photos", "pictures"]);
    if (!Array.isArray(images)) {
        return [];
    }
    return images
        .map((entry) => {
            if (typeof entry === "string") {
                return entry;
            }
            return entry.url || entry.src || "";
        })
        .filter(Boolean);
}

function firstValue(object, keys) {
    for (const key of keys) {
        if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
            return object[key];
        }
    }
    return null;
}

function numericValue(input) {
    if (input === null || input === undefined) {
        return null;
    }
    const cleaned = String(input).replace(/[^\d.]/g, "");
    const asNumber = Number(cleaned);
    return Number.isFinite(asNumber) ? asNumber : null;
}

function coerceDate(input) {
    const date = input ? new Date(input) : new Date();
    if (Number.isNaN(date.getTime())) {
        return new Date().toISOString();
    }
    return date.toISOString();
}

function shortHash(input) {
    return crypto.createHash("sha1").update(String(input)).digest("hex").slice(0, 12);
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

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
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

function dedupeObjectsByKey(items, keyBuilder) {
    const map = new Map();
    items.forEach((item) => {
        map.set(keyBuilder(item), item);
    });
    return Array.from(map.values());
}
