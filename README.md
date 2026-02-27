# The One - Unified Rental Feed

Smart rental apartment aggregator for the Israeli market.

## What is implemented

### 1) Database design (Supabase/Postgres)

- Canonical table: `properties` (one row per real apartment)
- Source mapping table: `property_sources`
- Timeline table: `property_events`
- Personal CRM table: `user_property_crm`
- SQL files:
  - `database/schema.sql`
  - `database/policies.sql` (optional RLS setup for frontend read + CRM)

### 2) Unified Feed screen (mobile-first web)

- One card per deduplicated property
- Source icons + deep links (Facebook / Yad2 / Madlan)
- Timeline:
  - First spotted
  - Last updated / bumped
  - Price history
- Color tags:
  - Green `<24h`
  - Yellow `1-2 weeks`
  - Red `>1 month`
- CRM actions:
  - Contacted
  - Scheduled Viewing
  - Not Relevant

### 3) Real data sync pipeline

`scripts/sync-listings.mjs`:
- Pulls raw listings from Apify dataset
- Uses OpenAI (optional) to parse unstructured text
- Deduplicates records by address/neighborhood/floor/price/image similarity
- Upserts into:
  - `properties`
  - `property_sources`
  - `property_events`

---

## Quick start

### A. Apply SQL schema

Run in Supabase SQL editor:

1. `database/schema.sql`
2. Optional: `database/policies.sql`

### B. Configure frontend

1. Copy:
   - `app-config.example.js` -> `app-config.js`
2. Fill:
   - `supabaseUrl`
   - `supabaseAnonKey`
   - optional `userId` (for CRM sync)

If `app-config.js` is empty, the app automatically falls back to sample data.

### C. Sync real listings (Apify -> OpenAI -> Supabase)

```bash
APIFY_TOKEN=... \
APIFY_DATASET_ID=... \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
OPENAI_API_KEY=... \
node scripts/sync-listings.mjs
```

`OPENAI_API_KEY` is optional. Without it, the script still works but with less accurate extraction from unstructured text.

---

## File map

- `index.html` - feed UI structure
- `styles.css` - feed styling
- `script.js` - frontend feed logic + Supabase integration + fallback
- `app-config.example.js` - frontend config template
- `app-config.js` - local runtime config (safe placeholder in repo)
- `database/schema.sql` - DB schema
- `database/policies.sql` - optional RLS policies
- `docs/properties-schema.md` - schema explanation
- `scripts/sync-listings.mjs` - ingestion + dedupe + upsert pipeline
