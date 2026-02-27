# The One - Properties Schema Outline

This schema is designed for **one canonical property card per real apartment** even when the same apartment appears in multiple marketplaces.

## 1) `properties` (canonical entity)

One row = one real apartment.

Key fields:

- `id` (UUID PK)
- `canonical_hash` (unique fingerprint for dedupe)
- `city`, `neighborhood`, `street`, `building_number`
- `floor`, `rooms`, `area_sqm`, `current_price_ils`
- `first_spotted_at` (first time seen across all sources)
- `last_bumped_at` (latest detected bump/update)
- `source_urls` (JSON array of all source links attached to the property)
- `bump_history` (JSON array of bump/update events)
- `price_history` (JSON array of historical price changes)
- `dedupe_confidence` (merge confidence score)

Why JSON fields in `properties`?

- Fast feed rendering from one table read.
- Still keeps full normalized history in companion tables.

## 2) `property_sources` (many listings -> one property)

Stores each source listing separately:

- `source` (`facebook | yad2 | madlan`)
- `source_listing_id`
- `deep_link_url`
- per-source first spotted / last bumped timestamps
- raw extracted payload and source-level image hashes

## 3) `property_events` (immutable timeline)

Every important change is appended here:

- `first_spotted`
- `bumped`
- `price_change`
- `source_added`

This enables full timeline UI and auditing.

## 4) `user_property_crm` (personal card actions)

Tracks personal state by user and property:

- `new`
- `contacted`
- `scheduled_viewing`
- `not_relevant`

---

## Recommended Dedupe Fingerprint Inputs

Use weighted matching:

1. Address + neighborhood similarity
2. Same floor
3. Same or near-identical price (for example <= 3% difference)
4. Image similarity (pHash/embedding similarity from AI vision)

If combined score is above threshold (for example 0.75), merge into the same `properties` row and append timeline events.

See `database/schema.sql` for full SQL DDL.
