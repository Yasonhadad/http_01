-- Optional policies for frontend access via anon key.
-- Run these only after creating the tables from schema.sql
-- and according to your security requirements.

alter table if exists properties enable row level security;
alter table if exists user_property_crm enable row level security;

-- Allow anyone with anon key to read the feed.
drop policy if exists "anon can read properties feed" on properties;
create policy "anon can read properties feed"
on properties
for select
to anon
using (true);

-- CRM table: prefer using Supabase Auth and auth.uid() in production.
-- This demo policy allows authenticated users to manage their own rows.
drop policy if exists "users manage own crm rows" on user_property_crm;
create policy "users manage own crm rows"
on user_property_crm
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());
