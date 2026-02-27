# The One - Unified Rental Feed (Demo)

This repository now includes:

1. **Database schema design** for a rental aggregator with de-duplication and timeline tracking.
2. **Main Unified Feed screen** (mobile-first web demo) with:
   - One card per deduplicated property
   - Source icons + deep links (Facebook / Yad2 / Madlan)
   - First spotted + last bumped timeline fields
   - Price history panel
   - Color-coded age tags:
     - Green: `<24h`
     - Yellow: `1-2 weeks`
     - Red: `>1 month`
   - Personal CRM actions:
     - Contacted
     - Scheduled Viewing
     - Not Relevant

## Files

- `database/schema.sql` - Supabase/Postgres schema
- `docs/properties-schema.md` - schema explanation
- `index.html` - unified feed screen structure
- `styles.css` - mobile-first UI styles
- `script.js` - dedupe logic + timeline rendering + CRM interactions

## Notes on de-duplication

The frontend demo merges raw listings using:

- Address/neighborhood similarity
- Same floor
- Near-identical price
- Image hash Jaccard similarity (stand-in for AI vision score)

In production, replace image hash comparison with model-based image embeddings or perceptual hash distance from your ingestion pipeline.
