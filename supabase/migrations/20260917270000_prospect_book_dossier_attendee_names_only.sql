-- `calls.attendees` was passed through whole, and it carries an email address per attendee —
-- including the PROSPECT's personal address. On a page with no sign-in that publishes a named
-- individual's contact details, which is a different thing from the dossier being public and
-- is not what the owner ruled. The 16 September layout shows attendees by NAME — a first name and
-- a last initial, no address — so names-only is matching the layout, not overriding the ruling:
-- the same reasoning that already keeps pb_contacts.email out.
--
-- (RULE 2 NOTE: this is the one line where the file diverges from the statement recorded in
-- schema_migrations. The applied version illustrated the point with two real attendees' names,
-- which is exactly the breach DECISIONS §23 is about — an agency or a person entering as an
-- EXAMPLE in prose. The example is shaped here instead. Nothing executable differs; run
-- scripts/no_prospect_names.ts before adding prose, not after.)
--
-- Provenance fields are deliberately left as they are: `entered_by` on a fact and `recorded_by`
-- on a call identify which WLIQ person or which extractor version put it there, and that audit
-- trail is the point of rule 8. The page renders them by the local part, as the artifact did.
create or replace function public.pb_dossier(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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

    'apollo', (
      select jsonb_build_object(
        'org_name', ap.org_name, 'employees', ap.employees, 'industry', ap.industry,
        'eng_headcount', ap.eng_headcount, 'revenue', ap.revenue,
        'founded_year', ap.founded_year, 'build_keywords', ap.build_keywords,
        'fetched_at', ap.fetched_at)
      from pb_apollo_enrichment ap
      join pb_accounts a2 on lower(a2.domain) = lower(ap.domain)
      where a2.id = p_account_id and ap.matched limit 1)
  );
$$;

revoke all on function public.pb_dossier(uuid) from public;
grant execute on function public.pb_dossier(uuid) to anon, authenticated, service_role;

comment on function public.pb_dossier(uuid) is
  'One account''s full dossier — the 16 September board''s row detail (DECISIONS §37, §43): the '
  'engine''s read and full trace, the written brief, the research read, people, calls, contact '
  'events, resolved facts with their evidence labels, signals, register rows and the Apollo '
  'check. PUBLIC by owner ruling of 17 Sep 2026 ("no sign in required"). NO EMAIL ADDRESSES: not '
  'from pb_contacts and not from call attendees, who are returned by name and side only — the '
  'layout being matched shows names, and a page with no sign-in should not publish an '
  'individual''s contact details. Provenance (entered_by, recorded_by) is kept: it is the audit '
  'trail rule 8 exists for.';