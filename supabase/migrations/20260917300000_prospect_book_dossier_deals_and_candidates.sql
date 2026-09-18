-- Two sections of the owner's approved layout had no data behind them, which is why they were
-- never rebuilt: "Quotes on record" and "Waiting on a person" (DECISIONS §52, web/CONTRACT.json).
--
-- Both were in the 16 September artifact and both matter for the same reason: they are the parts
-- of the record that say what is UNRESOLVED. A lost quote is the first thing to explain before
-- re-approaching, and a claim read out of a call and deliberately not written is the book telling
-- you what it does not yet know on purpose.
--
-- `candidates` returns COUNTS and the keys, never the claims themselves. The claims carry
-- unreviewed machine-read assertions about a named company; reviewing them is a signed-in screen
-- (pb_fact_candidates is closed to anon, and stays closed). How many are waiting, how many are
-- high confidence, and how many contradict something on file — that is what a reader of the
-- dossier needs, and none of it is a claim.
--
-- The address scrub from the previous migration is unchanged and still the last thing that
-- happens to the result, so the two new sections pass through it like everything else.
create or replace function public.pb_dossier(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- Built exactly as before; the address scrub is the last thing that happens to it.
  with raw as (
    select jsonb_build_object(
        'account', (
          select jsonb_build_object(
            'id', a.id, 'name', a.name, 'domain', a.domain,
            'roster_source', a.roster_source, 'roster_certified', a.roster_certified,
            'lineage', a.lineage, 'relationship_type', a.relationship_type)
          from pb_accounts a where a.id = p_account_id),

        'read', (
          select jsonb_build_object(
            'effective_tier', r.effective_tier, 'cell', r.cell, 'ceiling', r.ceiling,
            'headroom_band', r.headroom_band, 'year1_band', r.year1_band,
            'facts_present', r.facts_present, 'qualification_label', r.qualification_label,
            'confidence', r.confidence, 'confidence_grade', r.confidence_grade,
            'status', r.status, 'urgency', r.urgency, 'flags', r.flags,
            'reason', r.reason, 'as_of', r.as_of,
            'rubric_version', r.rubric_version, 'rubric_fingerprint', r.rubric_fingerprint,
            'trace', r.scorecard)
          from pb_current_reads r where r.account_id = p_account_id),

        'brief', (
          select jsonb_build_object(
            'generated_at', b.generated_at, 'author', b.author, 'brief', b.brief,
            'location', b.location, 'headcount', b.headcount,
            'headcount_confidence', b.headcount_confidence,
            'confidence', b.confidence, 'next_step', b.next_step)
          from pb_briefs b
          where b.account_id = p_account_id and b.superseded_at is null
          order by b.generated_at desc limit 1),

        'research', (
          select jsonb_build_object(
            'read_at', ar.read_at, 'reader', ar.reader, 'method', ar.method,
            'site_found', ar.site_found, 'summary', ar.summary,
            'confidence', ar.confidence, 'verified', ar.verified, 'verdict', ar.verdict,
            'fields', ar.fields)
          from pb_account_reads ar
          where ar.account_id = p_account_id and ar.superseded_at is null
          order by ar.read_at desc limit 1),

        'people', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', c.name, 'title', c.title, 'seniority', c.seniority,
            'is_decision_maker', c.is_decision_maker, 'source', c.source,
            'last_job_change_at', c.last_job_change_at)
            order by c.is_decision_maker desc nulls last, c.name)
          from pb_contacts c where c.account_id = p_account_id), '[]'::jsonb),

        'calls', coalesce((
          select jsonb_agg(jsonb_build_object(
            'held_at', k.held_at, 'title', k.title, 'url', k.url,
            'recorded_by', k.recorded_by,
            -- names and side only; the address never leaves the database
            'attendees', (
              select coalesce(jsonb_agg(jsonb_build_object(
                'name', at->>'name', 'is_external', at->'is_external')), '[]'::jsonb)
              from jsonb_array_elements(coalesce(k.attendees, '[]'::jsonb)) at),
            'summary', left(k.summary, 2000), 'extraction_status', k.extraction_status)
            order by k.held_at desc)
          from (select * from pb_calls where account_id = p_account_id
                order by held_at desc limit 12) k), '[]'::jsonb),

        'events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'occurred_at', e.occurred_at, 'channel', e.channel,
            'direction', e.direction, 'source', e.source, 'subject', left(e.subject, 200))
            order by e.occurred_at desc)
          from (select * from pb_contact_events where account_id = p_account_id
                order by occurred_at desc limit 40) e), '[]'::jsonb),

        'facts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'key', f.key, 'value', f.value, 'evidence_label', f.evidence_label,
            'source', f.source, 'observed_at', f.observed_at, 'entered_by', f.entered_by,
            'evidence_url', f.evidence_url, 'note', f.note)
            order by f.key)
          from pb_current_facts f where f.account_id = p_account_id), '[]'::jsonb),

        'signals', coalesce((
          select jsonb_agg(jsonb_build_object(
            'type', s.type, 'source', s.source, 'observed_at', s.observed_at,
            'weight', s.weight, 'decays', s.decays, 'lifespan_days', s.lifespan_days,
            'payload', s.payload, 'evidence_url', s.evidence_url)
            order by s.observed_at desc)
          from (select * from pb_signals where account_id = p_account_id
                order by observed_at desc limit 40) s), '[]'::jsonb),

        'register', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', g.kind, 'made_by', g.made_by, 'reason_code', g.reason_code,
            'text', g.text, 'created_at', g.created_at, 'expires_at', g.expires_at)
            order by g.created_at desc)
          from (select * from pb_register where account_id = p_account_id
                order by created_at desc limit 20) g), '[]'::jsonb),

    -- Quotes on record. A lost quote is the first thing to explain before re-approaching, so it
    -- belongs in the dossier and not only in the CRM.
    'deals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', dl.title, 'value', dl.value, 'currency', dl.currency,
        'status', dl.status, 'stage_name', dl.stage_name, 'close_date', dl.close_date,
        'health', dl.health, 'is_cj', dl.is_cj)
        order by dl.close_date desc nulls last)
      from (select * from pb_deals where account_id = p_account_id
            order by close_date desc nulls last limit 20) dl), '[]'::jsonb),

    -- What was read out of calls and notes and NOT written, and why it waits. Counts only: the
    -- claims themselves are a reviewer's screen, behind sign-in, not a public dossier's business.
    'candidates', (
      select jsonb_build_object(
        'n', count(*),
        'high', count(*) filter (where confidence = 'high'),
        'conflicts', count(*) filter (where conflicts),
        'keys', coalesce(jsonb_agg(distinct key), '[]'::jsonb))
      from pb_fact_candidates
      where account_id = p_account_id and status = 'proposed'),

        'apollo', (
          select jsonb_build_object(
            'org_name', ap.org_name, 'employees', ap.employees, 'industry', ap.industry,
            'eng_headcount', ap.eng_headcount, 'revenue', ap.revenue,
            'founded_year', ap.founded_year, 'build_keywords', ap.build_keywords,
            'fetched_at', ap.fetched_at)
          from pb_apollo_enrichment ap
          join pb_accounts a2 on lower(a2.domain) = lower(ap.domain)
          where a2.id = p_account_id and ap.matched limit 1)
      ) as j
  )
  select regexp_replace(
           raw.j::text,
           '([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
           '\1',
           'g'
         )::jsonb
    from raw;
$$;

revoke all on function public.pb_dossier(uuid) from public;
grant execute on function public.pb_dossier(uuid) to anon, authenticated, service_role;

comment on function public.pb_dossier(uuid) is
  'One account''s full dossier — the 16 September board''s row detail (DECISIONS §43, §49): the '
  'engine''s read and full trace, the written brief, the research read, people, calls, contact '
  'events, resolved facts with their evidence labels, signals, register rows and the Apollo '
  'check. PUBLIC by owner ruling of 17 Sep 2026 ("no sign in required"). NO EMAIL ADDRESS LEAVES '
  'THIS FUNCTION: every one is reduced to its local part on the way out, applied to the whole '
  'result rather than per key, because the per-key version missed the 332 call attendees whose '
  'NAME is an address and every address written inside a note, a subject or a brief. Provenance '
  'still identifies who or what wrote a row, so rule 8''s audit trail is intact. Also returns the '
  'quotes on record (pb_deals) and COUNTS of what is waiting on a person (pb_fact_candidates: how '
  'many, how many at high confidence, how many contradict a fact on file, and which keys) — never '
  'the claims themselves, which stay behind sign-in. web/CONTRACT.json §52 names both sections.';
