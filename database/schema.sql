-- The One - Supabase/Postgres schema
-- Focus: one canonical property, many source listings, full timeline.

create extension if not exists pgcrypto;

create type listing_source as enum ('facebook', 'yad2', 'madlan');
create type property_event_type as enum ('first_spotted', 'bumped', 'price_change', 'source_added');
create type crm_status as enum ('new', 'contacted', 'scheduled_viewing', 'not_relevant');

-- Core canonical property entity (one row per real apartment)
create table if not exists properties (
    id uuid primary key default gen_random_uuid(),
    canonical_hash text unique not null,
    city text not null,
    neighborhood text not null,
    street text,
    building_number text,
    floor integer not null,
    rooms numeric(3,1),
    area_sqm integer,
    current_price_ils integer not null,
    first_spotted_at timestamptz not null,
    last_bumped_at timestamptz not null,
    dedupe_confidence numeric(4,3) not null default 0.500,

    -- Denormalized snapshot for fast feed reads:
    -- [{source, source_listing_id, url, first_spotted_at, last_bumped_at}]
    source_urls jsonb not null default '[]'::jsonb,

    -- [{event_at, source, kind: "bumped", url}]
    bump_history jsonb not null default '[]'::jsonb,

    -- [{event_at, source, old_price_ils, new_price_ils}]
    price_history jsonb not null default '[]'::jsonb,

    image_hashes text[] not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint properties_source_urls_is_array check (jsonb_typeof(source_urls) = 'array'),
    constraint properties_bump_history_is_array check (jsonb_typeof(bump_history) = 'array'),
    constraint properties_price_history_is_array check (jsonb_typeof(price_history) = 'array')
);

create index if not exists idx_properties_feed on properties (last_bumped_at desc);
create index if not exists idx_properties_geo on properties (city, neighborhood, floor);
create index if not exists idx_properties_hash on properties (canonical_hash);

-- Raw listing references from each marketplace (many rows per property)
create table if not exists property_sources (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    source listing_source not null,
    source_listing_id text not null,
    deep_link_url text not null,
    source_first_spotted_at timestamptz not null,
    source_last_bumped_at timestamptz not null,
    source_last_price_ils integer,
    image_hashes text[] not null default '{}',
    raw_payload jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (source, source_listing_id)
);

create index if not exists idx_property_sources_property on property_sources (property_id);
create index if not exists idx_property_sources_bumped on property_sources (source_last_bumped_at desc);

-- Immutable timeline events for audits and charts
create table if not exists property_events (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    source_id uuid references property_sources(id) on delete set null,
    event_type property_event_type not null,
    event_at timestamptz not null,
    old_price_ils integer,
    new_price_ils integer,
    event_payload jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_property_events_property_time
    on property_events (property_id, event_at desc);

-- Per-user CRM state for each property card action
create table if not exists user_property_crm (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    property_id uuid not null references properties(id) on delete cascade,
    status crm_status not null default 'new',
    note text,
    updated_at timestamptz not null default now(),
    unique (user_id, property_id)
);

create index if not exists idx_user_property_crm_user on user_property_crm (user_id);
create index if not exists idx_user_property_crm_status on user_property_crm (status);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_properties_updated_at on properties;
create trigger trg_properties_updated_at
before update on properties
for each row execute function set_updated_at();

drop trigger if exists trg_property_sources_updated_at on property_sources;
create trigger trg_property_sources_updated_at
before update on property_sources
for each row execute function set_updated_at();
