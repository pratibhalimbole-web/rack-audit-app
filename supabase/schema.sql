-- Rack Audit — Supabase schema
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New query > paste > Run)
-- on a brand-new Supabase project. Safe to re-run top section is guarded with "if not exists"
-- where practical; the seed section at the bottom is NOT idempotent (re-running it duplicates
-- rows) — only run it once, right after creating the tables.

-- ============ TABLES ============

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  initials text,
  warehouse text
);

create table if not exists audit_plans (
  audit_id text primary key,
  audit_name text not null,
  audit_type text not null,           -- 'Full' | 'Cycle Count' | 'Spot Check'
  count_method text not null,
  scope_type text not null,           -- 'Rack' | 'Bay' | 'Layout'
  scope_values text[] not null default '{}',
  team_members text[] not null default '{}',
  start_date date not null,
  end_date date not null,
  status text not null default 'Scheduled',  -- 'Scheduled' | 'In Progress' | 'Submitted' | 'Reconciled' | 'Closed'
  priority text                       -- 'High' | 'Medium' | 'Low'
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  audit_id text not null references audit_plans(audit_id) on delete cascade,
  layout_name text not null,
  rack_code text not null,
  bay_code text not null,
  location_code text not null,
  status text not null default 'Not Started'  -- 'Not Started' | 'In Progress' | 'Completed'
);
create index if not exists locations_audit_id_idx on locations(audit_id);

create table if not exists count_records (
  id uuid primary key default gen_random_uuid(),
  audit_id text not null references audit_plans(audit_id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  pallet_id text not null,
  sku text not null,
  sku_name text,
  lot text,
  qty int not null,
  condition text not null,            -- one of CONDITIONS in the app
  scanned_by uuid references profiles(id),
  scanned_at timestamptz not null default now(),
  saved boolean not null default true
);
create index if not exists count_records_location_id_idx on count_records(location_id);
create index if not exists count_records_audit_id_idx on count_records(audit_id);

-- ============ ROW LEVEL SECURITY ============
-- anon gets no access at all — real login (Supabase Auth) is required for any data.
-- authenticated can read everything and write to locations/count_records; audit_plans
-- status is also updatable by authenticated (needed for submitAudit()).

alter table profiles enable row level security;
alter table audit_plans enable row level security;
alter table locations enable row level security;
alter table count_records enable row level security;

create policy "profiles: read own" on profiles
  for select using (auth.uid() = id);
create policy "profiles: update own" on profiles
  for update using (auth.uid() = id);

create policy "audit_plans: read all (authenticated)" on audit_plans
  for select using (auth.role() = 'authenticated');
create policy "audit_plans: update (authenticated)" on audit_plans
  for update using (auth.role() = 'authenticated');

create policy "locations: read all (authenticated)" on locations
  for select using (auth.role() = 'authenticated');
create policy "locations: update (authenticated)" on locations
  for update using (auth.role() = 'authenticated');

create policy "count_records: read all (authenticated)" on count_records
  for select using (auth.role() = 'authenticated');
create policy "count_records: insert (authenticated)" on count_records
  for insert with check (auth.role() = 'authenticated');
create policy "count_records: delete (authenticated)" on count_records
  for delete using (auth.role() = 'authenticated');

-- Auto-create a profile row whenever a new auth user is created, so you don't
-- have to manually insert into profiles after creating the Auth user below.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, initials, warehouse)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'initials', upper(left(new.email, 2))),
    coalesce(new.raw_user_meta_data->>'warehouse', 'Warehouse-01')
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ SEED DATA ============
-- Translated 1:1 from the app's current mock data (AUDITS / LOCATIONS in
-- rack-audit-app.html) so the deployed app looks identical to the prototype
-- on first load. Run this once, right after the tables above are created.

-- audit_plans
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0231', 'Zone A Full Count', 'Full', 'Blind (Enforced)', 'Rack', ARRAY['Rack A-05','Rack A-06']::text[], ARRAY['Arjun Sharma','Meera Kulkarni','Priya Singh']::text[], '2026-06-20', '2026-07-10', 'In Progress', 'High');
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0233', 'Spot Check — Layout C & E', 'Spot Check', 'Blind (Enforced)', 'Layout', ARRAY['Layout C','Layout E']::text[], ARRAY['Arjun Sharma']::text[], '2026-07-09', '2026-07-09', 'Scheduled', 'Low');
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0234', 'Cycle — Fast Movers, Layout B', 'Cycle Count', 'Blind (Enforced)', 'Layout', ARRAY['Layout B']::text[], ARRAY['Arjun Sharma','Rohan Kumar']::text[], '2026-07-11', '2026-07-15', 'Scheduled', 'High');
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0225', 'Zone C Damaged Recheck', 'Cycle Count', 'Blind (Enforced)', 'Rack', ARRAY['Rack C-04']::text[], ARRAY['Arjun Sharma','Sanjay Patil']::text[], '2026-06-24', '2026-06-30', 'Submitted', 'High');
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0219', 'Bay Recount — B-02', 'Spot Check', 'Blind (Enforced)', 'Bay', ARRAY['Bay B-02-03']::text[], ARRAY['Arjun Sharma']::text[], '2026-06-28', '2026-07-05', 'In Progress', 'High');
insert into audit_plans (audit_id, audit_name, audit_type, count_method, scope_type, scope_values, team_members, start_date, end_date, status, priority) values ('AUD-0240', 'Full Count — Layouts A & B', 'Full', 'Blind (Enforced)', 'Layout', ARRAY['Layout A','Layout B']::text[], ARRAY['Arjun Sharma','Meera Kulkarni']::text[], '2026-07-08', '2026-07-22', 'Scheduled', 'High');

-- locations + count_records
do $$
declare
  loc_1 uuid;
  loc_2 uuid;
  loc_3 uuid;
  loc_4 uuid;
  loc_5 uuid;
  loc_6 uuid;
  loc_7 uuid;
  loc_8 uuid;
  loc_9 uuid;
  loc_10 uuid;
  loc_11 uuid;
  loc_12 uuid;
  loc_13 uuid;
  loc_14 uuid;
  loc_15 uuid;
  loc_16 uuid;
  loc_17 uuid;
  loc_18 uuid;
  loc_19 uuid;
  loc_20 uuid;
  loc_21 uuid;
  loc_22 uuid;
  loc_23 uuid;
  loc_24 uuid;
  loc_25 uuid;
  loc_26 uuid;
  loc_27 uuid;
  loc_28 uuid;
  loc_29 uuid;
  loc_30 uuid;
  loc_31 uuid;
  loc_32 uuid;
  loc_33 uuid;
  loc_34 uuid;
  loc_35 uuid;
  loc_36 uuid;
  loc_37 uuid;
  loc_38 uuid;
  loc_39 uuid;
  loc_40 uuid;
  loc_41 uuid;
  loc_42 uuid;
  loc_43 uuid;
  loc_44 uuid;
  loc_45 uuid;
  loc_46 uuid;
  loc_47 uuid;
  loc_48 uuid;
  loc_49 uuid;
  loc_50 uuid;
  loc_51 uuid;
  loc_52 uuid;
  loc_53 uuid;
  loc_54 uuid;
  loc_55 uuid;
  loc_56 uuid;
  loc_57 uuid;
  loc_58 uuid;
  loc_59 uuid;
  loc_60 uuid;
  loc_61 uuid;
  loc_62 uuid;
  loc_63 uuid;
  loc_64 uuid;
  loc_65 uuid;
  loc_66 uuid;
  loc_67 uuid;
  loc_68 uuid;
  loc_69 uuid;
  loc_70 uuid;
  loc_71 uuid;
  loc_72 uuid;
  loc_73 uuid;
  loc_74 uuid;
  loc_75 uuid;
  loc_76 uuid;
  loc_77 uuid;
  loc_78 uuid;
  loc_79 uuid;
  loc_80 uuid;
  loc_81 uuid;
  loc_82 uuid;
  loc_83 uuid;
  loc_84 uuid;
  loc_85 uuid;
  loc_86 uuid;
  loc_87 uuid;
  loc_88 uuid;
  loc_89 uuid;
  loc_90 uuid;
  loc_91 uuid;
  loc_92 uuid;
  loc_93 uuid;
  loc_94 uuid;
  loc_95 uuid;
  loc_96 uuid;
  loc_97 uuid;
  loc_98 uuid;
  loc_99 uuid;
  loc_100 uuid;
  loc_101 uuid;
  loc_102 uuid;
  loc_103 uuid;
  loc_104 uuid;
  loc_105 uuid;
  loc_106 uuid;
  loc_107 uuid;
begin
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-01', 'A-05-B01-01', 'Completed') returning id into loc_1;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-01', 'A-05-B01-02', 'Completed') returning id into loc_2;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-01', 'A-05-B01-03', 'Completed') returning id into loc_3;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-02', 'A-05-B02-01', 'Completed') returning id into loc_4;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-02', 'A-05-B02-02', 'Completed') returning id into loc_5;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-02', 'A-05-B02-03', 'In Progress') returning id into loc_6;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-03', 'A-05-B03-01', 'Not Started') returning id into loc_7;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-03', 'A-05-B03-02', 'Not Started') returning id into loc_8;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-03', 'A-05-B03-03', 'Not Started') returning id into loc_9;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-04', 'A-05-B04-01', 'Not Started') returning id into loc_10;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-04', 'A-05-B04-02', 'Not Started') returning id into loc_11;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-05', 'B-04', 'A-05-B04-03', 'Not Started') returning id into loc_12;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-01', 'A-06-B01-01', 'Completed') returning id into loc_13;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-01', 'A-06-B01-02', 'Completed') returning id into loc_14;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-01', 'A-06-B01-03', 'Completed') returning id into loc_15;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-02', 'A-06-B02-01', 'Completed') returning id into loc_16;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-02', 'A-06-B02-02', 'Completed') returning id into loc_17;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-02', 'A-06-B02-03', 'Not Started') returning id into loc_18;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-03', 'A-06-B03-01', 'Not Started') returning id into loc_19;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-03', 'A-06-B03-02', 'Not Started') returning id into loc_20;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-03', 'A-06-B03-03', 'Not Started') returning id into loc_21;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-04', 'A-06-B04-01', 'Not Started') returning id into loc_22;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-04', 'A-06-B04-02', 'Not Started') returning id into loc_23;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0231', 'Layout A', 'A-06', 'B-04', 'A-06-B04-03', 'Not Started') returning id into loc_24;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout C', 'B-07', 'B-07-01', 'B-07-01-01', 'Not Started') returning id into loc_25;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout C', 'B-07', 'B-07-01', 'B-07-01-02', 'Not Started') returning id into loc_26;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout C', 'B-07', 'B-07-02', 'B-07-02-01', 'Not Started') returning id into loc_27;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout C', 'B-07', 'B-07-02', 'B-07-02-02', 'Not Started') returning id into loc_28;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout E', 'E-01', 'E-01-01', 'E-01-01-01', 'Not Started') returning id into loc_29;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout E', 'E-01', 'E-01-01', 'E-01-01-02', 'Not Started') returning id into loc_30;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout E', 'E-01', 'E-01-02', 'E-01-02-01', 'Not Started') returning id into loc_31;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0233', 'Layout E', 'E-01', 'E-01-02', 'E-01-02-02', 'Not Started') returning id into loc_32;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-01', 'B-01-B-01-01', 'Completed') returning id into loc_33;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-01', 'B-01-B-01-02', 'Completed') returning id into loc_34;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-01', 'B-01-B-01-03', 'Completed') returning id into loc_35;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-02', 'B-01-B-02-01', 'Completed') returning id into loc_36;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-02', 'B-01-B-02-02', 'Completed') returning id into loc_37;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-02', 'B-01-B-02-03', 'Completed') returning id into loc_38;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-03', 'B-01-B-03-01', 'Completed') returning id into loc_39;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-03', 'B-01-B-03-02', 'Completed') returning id into loc_40;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-01', 'B-03', 'B-01-B-03-03', 'Completed') returning id into loc_41;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-01', 'B-02-B-01-01', 'Completed') returning id into loc_42;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-01', 'B-02-B-01-02', 'Not Started') returning id into loc_43;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-01', 'B-02-B-01-03', 'Not Started') returning id into loc_44;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-02', 'B-02-B-02-01', 'Not Started') returning id into loc_45;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-02', 'B-02-B-02-02', 'Not Started') returning id into loc_46;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-02', 'B-02-B-02-03', 'Not Started') returning id into loc_47;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-03', 'B-02-B-03-01', 'Not Started') returning id into loc_48;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-03', 'B-02-B-03-02', 'Not Started') returning id into loc_49;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-02', 'B-03', 'B-02-B-03-03', 'Not Started') returning id into loc_50;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-01', 'B-03-B-01-01', 'Not Started') returning id into loc_51;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-01', 'B-03-B-01-02', 'Not Started') returning id into loc_52;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-01', 'B-03-B-01-03', 'Not Started') returning id into loc_53;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-02', 'B-03-B-02-01', 'Not Started') returning id into loc_54;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-02', 'B-03-B-02-02', 'Not Started') returning id into loc_55;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-02', 'B-03-B-02-03', 'Not Started') returning id into loc_56;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-03', 'B-03-B-03-01', 'Not Started') returning id into loc_57;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-03', 'B-03-B-03-02', 'Not Started') returning id into loc_58;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-03', 'B-03', 'B-03-B-03-03', 'Not Started') returning id into loc_59;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-01', 'B-04-B-01-01', 'Not Started') returning id into loc_60;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-01', 'B-04-B-01-02', 'Not Started') returning id into loc_61;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-01', 'B-04-B-01-03', 'Not Started') returning id into loc_62;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-02', 'B-04-B-02-01', 'Not Started') returning id into loc_63;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-02', 'B-04-B-02-02', 'Not Started') returning id into loc_64;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-02', 'B-04-B-02-03', 'Not Started') returning id into loc_65;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-03', 'B-04-B-03-01', 'Not Started') returning id into loc_66;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-03', 'B-04-B-03-02', 'Not Started') returning id into loc_67;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0234', 'Layout B', 'B-04', 'B-03', 'B-04-B-03-03', 'Not Started') returning id into loc_68;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0225', 'Layout A', 'C-04', 'C-04-01', 'C-04-01-01', 'Completed') returning id into loc_69;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0225', 'Layout A', 'C-04', 'C-04-01', 'C-04-01-02', 'Completed') returning id into loc_70;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0219', 'Layout A', 'B-02', 'B-02-03', 'B-02-03-01', 'In Progress') returning id into loc_71;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0219', 'Layout A', 'B-02', 'B-02-03', 'B-02-03-02', 'Not Started') returning id into loc_72;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-01', 'A-20-B-01-01', 'Completed') returning id into loc_73;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-01', 'A-20-B-01-02', 'Completed') returning id into loc_74;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-01', 'A-20-B-01-03', 'Completed') returning id into loc_75;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-02', 'A-20-B-02-01', 'Completed') returning id into loc_76;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-02', 'A-20-B-02-02', 'Completed') returning id into loc_77;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-02', 'A-20-B-02-03', 'Completed') returning id into loc_78;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-03', 'A-20-B-03-01', 'Completed') returning id into loc_79;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-03', 'A-20-B-03-02', 'Completed') returning id into loc_80;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-20', 'B-03', 'A-20-B-03-03', 'Completed') returning id into loc_81;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-01', 'A-21-B-01-01', 'Completed') returning id into loc_82;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-01', 'A-21-B-01-02', 'Not Started') returning id into loc_83;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-01', 'A-21-B-01-03', 'Not Started') returning id into loc_84;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-02', 'A-21-B-02-01', 'Not Started') returning id into loc_85;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-02', 'A-21-B-02-02', 'Not Started') returning id into loc_86;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-02', 'A-21-B-02-03', 'Not Started') returning id into loc_87;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-03', 'A-21-B-03-01', 'Not Started') returning id into loc_88;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-03', 'A-21-B-03-02', 'Not Started') returning id into loc_89;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-21', 'B-03', 'A-21-B-03-03', 'Not Started') returning id into loc_90;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-01', 'A-22-B-01-01', 'Not Started') returning id into loc_91;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-01', 'A-22-B-01-02', 'Not Started') returning id into loc_92;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-01', 'A-22-B-01-03', 'Not Started') returning id into loc_93;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-02', 'A-22-B-02-01', 'Not Started') returning id into loc_94;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-02', 'A-22-B-02-02', 'Not Started') returning id into loc_95;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-02', 'A-22-B-02-03', 'Not Started') returning id into loc_96;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-03', 'A-22-B-03-01', 'Not Started') returning id into loc_97;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-03', 'A-22-B-03-02', 'Not Started') returning id into loc_98;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout A', 'A-22', 'B-03', 'A-22-B-03-03', 'Not Started') returning id into loc_99;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-20', 'B-01', 'B-20-B-01-01', 'Completed') returning id into loc_100;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-20', 'B-01', 'B-20-B-01-02', 'Not Started') returning id into loc_101;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-20', 'B-02', 'B-20-B-02-01', 'Not Started') returning id into loc_102;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-20', 'B-02', 'B-20-B-02-02', 'Not Started') returning id into loc_103;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-21', 'B-01', 'B-21-B-01-01', 'Not Started') returning id into loc_104;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-21', 'B-01', 'B-21-B-01-02', 'Not Started') returning id into loc_105;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-21', 'B-02', 'B-21-B-02-01', 'Not Started') returning id into loc_106;
  insert into locations (audit_id, layout_name, rack_code, bay_code, location_code, status) values ('AUD-0240', 'Layout B', 'B-21', 'B-02', 'B-21-B-02-02', 'Not Started') returning id into loc_107;

  insert into count_records (audit_id, location_id, pallet_id, sku, sku_name, lot, qty, condition, saved) values ('AUD-0231', loc_6, 'P-10481', 'SKU-1042', 'Steel Bracket 90', 'L-2291', 46, 'Good', true);
  insert into count_records (audit_id, location_id, pallet_id, sku, sku_name, lot, qty, condition, saved) values ('AUD-0225', loc_69, 'P-20011', 'SKU-3301', 'Plastic Crate Blue', 'L-2304', 18, 'Good', true);
  insert into count_records (audit_id, location_id, pallet_id, sku, sku_name, lot, qty, condition, saved) values ('AUD-0225', loc_69, 'P-20011', 'SKU-5088', 'Corner Protector', 'L-2319', 6, 'Damaged', true);
  insert into count_records (audit_id, location_id, pallet_id, sku, sku_name, lot, qty, condition, saved) values ('AUD-0225', loc_70, 'P-20012', 'SKU-9011', 'Rack Label Kit', 'L-2311', 12, 'Good', true);
  insert into count_records (audit_id, location_id, pallet_id, sku, sku_name, lot, qty, condition, saved) values ('AUD-0225', loc_70, 'P-20012', 'SKU-1180', 'Fastener Pack M10', 'L-2322', 3, 'Broken', true);
end $$;

-- ============ NEXT STEPS (manual, in the Supabase dashboard) ============
-- 1. Authentication > Users > Add user — create arjun@example.com with a password
--    of your choice, and set "User Metadata" (as JSON) to:
--      { "full_name": "Arjun Sharma", "initials": "AS", "warehouse": "Warehouse-01" }
--    The trigger above will auto-create the matching profiles row.
-- 2. Settings > API — copy the "Project URL" and "anon public" key and give them
--    to me (or paste into rack-audit-app.html's SUPABASE_URL / SUPABASE_ANON_KEY
--    constants) so the app can connect.
