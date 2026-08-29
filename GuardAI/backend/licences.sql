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

-- ===========================================================================
-- The Chrome Web Store reviewer's licence — NOT DEFINED IN THIS FILE.
--
-- It used to be, as a literal `GK-REVIEW-CHROME-STORE-0001` that never
-- expired. This repository is public. A never-expiring credential committed
-- to a public repo is a standing liability, and that one was revoked on
-- 2026-08-29 after exactly that was noticed.
--
-- THE FIX IS NOT A BETTER KEY IN THIS FILE. A fresh key written here leaks on
-- the next push, the same way, and an expiry only bounds how long the next
-- leak lasts. So the key lives in two places and neither is the repo:
--
--   1. The Developer Dashboard's "Privacy practices -> test credentials"
--      field, which is where the reviewer reads it from.
--   2. The licences table, put there by hand with the template below.
--
-- MINT A NEW ONE PER SUBMISSION. That is the trade this design makes and it
-- is worth stating plainly, because the old comment here argued the opposite
-- and it was not wrong: store review recurs on every update, months apart,
-- with a different person each time, so a key that has expired by the time
-- the NEXT update is reviewed gets that update rejected as non-functional.
-- A per-submission key with a 90-day life keeps the reviewer working and
-- keeps a leak bounded — but only if minting one is part of the release
-- checklist rather than something remembered. See STORE_LISTING.md.
--
-- Template. Generate the code with real entropy (crypto.randomBytes over an
-- alphabet with no 0/O/1/I, since a reviewer may retype it), never a
-- sequential one — `...-0001` invites `...-0002`.
--
--   insert into public.licences (key, plan, status, current_period_end, max_activations)
--   values ('GK-REVIEW-<random>', 'review', 'active', now() + interval '90 days', 10000);
--
-- On max_activations: generous on purpose. The failure that costs real money
-- is a reviewer hitting DEVICE_LIMIT and rejecting the submission, not a
-- stranger getting a bounded free ride. The expiry is what bounds the leak.
--
-- REVOKING: by key, never by plan.
--
--   update public.licences set status = 'cancelled' where key = 'GK-REVIEW-...';
--
-- The old comment here said `where plan = 'review'`, which cancels EVERY
-- reviewer key including the one for the submission currently in flight.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Handy checks.
-- ---------------------------------------------------------------------------
-- select key, plan, status, current_period_end, max_activations
--   from public.licences where plan = 'review' order by created_at desc;
-- select public.activate_licence('<the key>');
-- select public.refresh_entitlement('<the token that came back>');
--
-- How many activations a key has taken — worth checking on a key you are
-- revoking, since it tells you whether anyone actually found it:
-- select l.key, count(a.token) as activations, max(a.last_seen_at) as last_used
--   from public.licences l
--   left join public.licence_activations a on a.licence_id = l.id
--  where l.plan = 'review' group by l.key order by activations desc;
