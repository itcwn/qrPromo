create extension if not exists pgcrypto;

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) <= 255),
  max_scans integer not null check (max_scans > 0 and max_scans <= 100000),
  consumed_scans integer not null default 0 check (consumed_scans >= 0),
  status text not null default 'active' check (status in ('active', 'expired')),
  promotion_type text not null check (promotion_type in ('redirect', 'promo_code', 'image')),
  promo_code text,
  redirect_url text,
  image_url text,
  cashier_code text,
  title text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_consumed_vs_max check (consumed_scans <= max_scans)
);

create index if not exists campaigns_status_idx on public.campaigns(status);

create table if not exists public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  token text not null unique,
  is_test boolean not null default false,
  total_scans integer not null default 0,
  created_at timestamptz not null default now(),
  last_scanned_at timestamptz
);

create index if not exists qr_codes_campaign_idx on public.qr_codes(campaign_id);
create index if not exists qr_codes_token_idx on public.qr_codes(token);

create table if not exists public.scan_events (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  qr_code_id uuid not null references public.qr_codes(id) on delete cascade,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  metadata jsonb
);

create index if not exists scan_events_campaign_idx on public.scan_events(campaign_id);
create index if not exists scan_events_qr_idx on public.scan_events(qr_code_id);

create or replace function public.set_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_timestamp on public.campaigns;
create trigger set_timestamp
before update on public.campaigns
for each row
execute function public.set_timestamp();

create or replace function public.consume_campaign_scan(p_token text)
returns table (
  campaign_id uuid,
  status text,
  remaining_scans integer,
  promotion_type text,
  promo_code text,
  redirect_url text,
  image_url text,
  cashier_code text,
  is_test boolean
) as $$
declare
  v_qr public.qr_codes%rowtype;
  v_campaign public.campaigns%rowtype;
begin
  select * into v_qr
  from public.qr_codes
  where token = p_token
  limit 1;

  if not found then
    return;
  end if;

  select * into v_campaign
  from public.campaigns
  where id = v_qr.campaign_id
  for update;

  if not found then
    return;
  end if;

  if v_campaign.status = 'expired' then
    return query
    select
      v_campaign.id,
      v_campaign.status,
      greatest(v_campaign.max_scans - v_campaign.consumed_scans, 0),
      v_campaign.promotion_type,
      v_campaign.promo_code,
      v_campaign.redirect_url,
      v_campaign.image_url,
      v_campaign.cashier_code,
      v_qr.is_test;
  end if;

  if v_qr.is_test then
    update public.qr_codes
      set total_scans = total_scans + 1,
          last_scanned_at = now()
      where id = v_qr.id;

    insert into public.scan_events (campaign_id, qr_code_id, is_test, metadata)
    values (v_campaign.id, v_qr.id, true, jsonb_build_object('type', 'test_scan'));

    return query
    select
      v_campaign.id,
      v_campaign.status,
      greatest(v_campaign.max_scans - v_campaign.consumed_scans, 0),
      v_campaign.promotion_type,
      v_campaign.promo_code,
      v_campaign.redirect_url,
      v_campaign.image_url,
      v_campaign.cashier_code,
      true;
  end if;

  if v_campaign.consumed_scans >= v_campaign.max_scans then
    update public.campaigns
      set status = 'expired'
      where id = v_campaign.id;

    return query
    select
      v_campaign.id,
      'expired',
      0,
      v_campaign.promotion_type,
      v_campaign.promo_code,
      v_campaign.redirect_url,
      v_campaign.image_url,
      v_campaign.cashier_code,
      false;
  end if;

  update public.campaigns
    set consumed_scans = consumed_scans + 1,
        status = case when consumed_scans + 1 >= max_scans then 'expired' else 'active' end
    where id = v_campaign.id
    returning * into v_campaign;

  update public.qr_codes
    set total_scans = total_scans + 1,
        last_scanned_at = now()
    where id = v_qr.id
    returning * into v_qr;

  insert into public.scan_events (campaign_id, qr_code_id, is_test, metadata)
  values (v_campaign.id, v_qr.id, false, jsonb_build_object('type', 'scan'));

  return query
  select
    v_campaign.id,
    v_campaign.status,
    greatest(v_campaign.max_scans - v_campaign.consumed_scans, 0),
    v_campaign.promotion_type,
    v_campaign.promo_code,
    v_campaign.redirect_url,
    v_campaign.image_url,
    v_campaign.cashier_code,
    false;
end;
$$ language plpgsql
security definer
set search_path = public;

grant usage on schema public to anon, authenticated;

grant execute on function public.consume_campaign_scan(text) to anon, authenticated;

alter table public.campaigns enable row level security;
alter table public.qr_codes enable row level security;
alter table public.scan_events enable row level security;

create policy "Only service role can modify campaigns" on public.campaigns
  for all using (auth.jwt() ->> 'role' = 'service_role')
  with check (auth.jwt() ->> 'role' = 'service_role');

create policy "Only service role can modify qr codes" on public.qr_codes
  for all using (auth.jwt() ->> 'role' = 'service_role')
  with check (auth.jwt() ->> 'role' = 'service_role');

create policy "Only service role can modify scan events" on public.scan_events
  for all using (auth.jwt() ->> 'role' = 'service_role')
  with check (auth.jwt() ->> 'role' = 'service_role');
