-- ===========================================================================
-- GuardAI — licensing schema.
--
-- Run this in the Supabase SQL editor. Safe to re-run: every statement is
-- idempotent, and it touches nothing belonging to the company/invite-code
-- side that already exists.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS IN THE REPO
--
-- The company side (connect_company, record_event) was written directly in the
-- Supabase dashboard and has no source anywhere. The extension's privacy
-- guarantees are half enforced by SQL nobody can read, review or restore. This
-- file is the start of fixing that; the company side should be reconciled into
-- it when someone has the dashboard open.
--
-- ---------------------------------------------------------------------------
-- THE SECURITY MODEL, WHICH IS THE SAME ONE connect_company USES
--
-- The anon key ships inside the extension, so treat it as public. It is safe
-- because the anon role can EXECUTE two functions and can SELECT nothing:
--
--   * RLS is on and no policy is created, so even if a grant were added by
--     accident the tables stay unreadable.
--   * Both functions are SECURITY DEFINER with a pinned search_path.
--   * Neither function can read data back out. activate_licence returns a
--     token it just minted; refresh_entitlement returns a boolean and a date.
--     Neither will tell you whether a key exists, beyond succeeding or not.
--
-- The service_role key must never appear in the extension.
--
-- ---------------------------------------------------------------------------
-- KEY FORMAT — read before generating any
--
-- PostgREST applies no rate limit, so a licence key is only as good as its
-- entropy. Use:
--
--     GK- + 16 characters from Crockford base32 (0-9 A-Z minus I L O U)
--
-- in 4-character groups: GK-XXXX-XXXX-XXXX-XXXX. That is 16 x 5 = 80 bits,
-- which is not guessable at any request rate worth worrying about. Do NOT
-- shorten it for tidiness, and do NOT derive it from anything about the
-- customer.
--
-- The extension upper-cases and strips whitespace before sending, so keys must
-- be stored upper-case.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.licences (
  id                     uuid primary key default gen_random_uuid(),
  key                    text unique not null,
  plan                   text not null
                           check (plan in ('individual', 'review')),
  status                 text not null default 'active'
                           check (status in ('active', 'cancelled', 'refunded')),
  -- null means "never expires", which is reserved for review builds. An
  -- individual licence always carries the Stripe period end.
  current_period_end     timestamptz,
  -- Activations, not devices: one licence covers a work laptop and a home one.
  -- A hard 1 generates support mail on day one and stops nobody determined.
  max_activations        int not null default 3,
  stripe_subscription_id text,
  created_at             timestamptz not null default now()
);

create table if not exists public.licence_activations (
  token        uuid primary key default gen_random_uuid(),
  licence_id   uuid not null references public.licences(id) on delete cascade,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists licence_activations_licence_idx
  on public.licence_activations (licence_id);

alter table public.licences            enable row level security;
alter table public.licence_activations enable row level security;

revoke all on public.licences            from anon, authenticated;
revoke all on public.licence_activations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- activate_licence(key) -> { token, plan, valid_until }
--
-- Called once, when someone types their key in. Mints a device token; every
-- later check uses that token, never the key again.
--
-- The exception names below are a CONTRACT with the extension: background.js
-- matches on these exact strings to produce a message a person can act on.
-- test/backend-contract.cjs asserts the two stay in step. Renaming one here
-- without renaming it there degrades a specific, useful error into "check your
-- connection", which sends the user looking in the wrong place entirely.
-- ---------------------------------------------------------------------------
create or replace function public.activate_licence(p_key text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.licences%rowtype;
  n int;
  t uuid;
begin
  select * into l from public.licences where key = upper(btrim(p_key));
  if not found then
    raise exception 'INVALID_KEY';
  end if;

  if l.status <> 'active' then
    raise exception 'LICENCE_INACTIVE';
  end if;

  if l.current_period_end is not null and l.current_period_end < now() then
    raise exception 'LICENCE_EXPIRED';
  end if;

  select count(*) into n from public.licence_activations where licence_id = l.id;
  if n >= l.max_activations then
    raise exception 'DEVICE_LIMIT';
  end if;

  insert into public.licence_activations (licence_id) values (l.id)
    returning token into t;

  return json_build_object(
    'token', t,
    'plan', l.plan,
    'valid_until', l.current_period_end
  );
end
$$;

-- ---------------------------------------------------------------------------
-- refresh_entitlement(token) -> { valid, plan, valid_until }
--
-- The daily re-check. Note what this does NOT do: it never raises. A licence
-- that has been cancelled returns { valid: false } with a 200, because the
-- extension treats any non-200 as "the server failed to answer" and fails
-- OPEN. Raising here would mean a cancelled subscription silently kept
-- working, which is the mirror image of the bug the fail-open design exists to
-- prevent. An unknown token returns valid:false for the same reason.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_entitlement(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.licences%rowtype;
begin
  select lc.* into l
    from public.licences lc
    join public.licence_activations a on a.licence_id = lc.id
   where a.token = p_token;

  if not found then
    return json_build_object('valid', false);
  end if;

  update public.licence_activations set last_seen_at = now() where token = p_token;

  if l.status <> 'active'
     or (l.current_period_end is not null and l.current_period_end < now())
  then
    return json_build_object('valid', false);
  end if;

  return json_build_object(
    'valid', true,
    'plan', l.plan,
    'valid_until', l.current_period_end
  );
end
$$;

grant execute on function public.activate_licence(text)    to anon;
grant execute on function public.refresh_entitlement(uuid) to anon;

-- ---------------------------------------------------------------------------
-- The Chrome Web Store reviewer's licence.
--
-- Store review is not a one-off. Every update is reviewed, by a different
-- person, months apart, and a key that expires or burns an activation will be
-- exhausted by the third submission — at which point the reviewer installs the
-- extension, finds it does nothing, and rejects it as non-functional.
--
-- So: never expires (current_period_end null), effectively unlimited
-- activations, and plan 'review' so the extension can tell it apart. It
-- reports nothing, exactly like an individual licence.
--
-- It is worth roughly $14/month to anyone who finds it, which is not worth
-- protecting heavily, but revoke it if it turns up somewhere public:
--     update public.licences set status = 'cancelled' where plan = 'review';
-- ---------------------------------------------------------------------------
insert into public.licences (key, plan, current_period_end, max_activations)
values ('GK-REVIEW-CHROME-STORE-0001', 'review', null, 1000000)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Handy checks after running the above.
-- ---------------------------------------------------------------------------
-- select key, plan, status, current_period_end, max_activations from public.licences;
-- select public.activate_licence('GK-REVIEW-CHROME-STORE-0001');
-- select public.refresh_entitlement('<the token that came back>');
