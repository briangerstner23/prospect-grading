-- pb_accounts.cohort — WHICH BOOK an account belongs to.
--
-- WLIQ does not have one roster, it has several relationships that need the same evidence and
-- different grading: agency partners (the core), direct clients, peer communities (AMI, BABA —
-- long-term growth), Friends of WLIQ, and others. Rubric 0.1.0 grades every row as though it
-- were an agency partner, which is why a restaurant and a plumber currently hold rungs on the
-- agency chase list.
--
-- Nullable and unconstrained on purpose. The vocabulary is the owner's to settle and is not yet
-- complete, so nothing here forecloses it; a check constraint comes once the list is agreed.
-- Null means "not yet assigned", never "none of these".
--
-- This column does NOT change any grade. It records which book a row belongs to so that grading
-- can later be scoped per cohort. Today only agency_partner has a rubric.

alter table public.pb_accounts add column if not exists cohort text;

comment on column public.pb_accounts.cohort is
  'Which book this account belongs to: agency_partner | direct_client | peer_community | friend_of_wliq | not_a_prospect | null (unassigned). '
  'Same evidence pipeline for every cohort; grading differs per cohort and today only agency_partner is graded. Vocabulary not yet final.';

create index if not exists pb_accounts_cohort_idx on public.pb_accounts (cohort) where cohort is not null;

-- Derive only what the book already states. Peer communities and Friends of WLIQ are NOT derived
-- here: all 31 Friends-of-WLIQ organisations in Pipedrive's Client Journey (stage 69) are absent
-- from pb_accounts entirely, so there is nothing yet to label.
update public.pb_accounts a
set cohort = case
      when lower(btrim(a.name)) in ('test','tbd','none','not yet','individual','confidential','n/a','na','vb','moor')
        then 'not_a_prospect'
      when a.relationship_type = 'agency' then 'agency_partner'
      when a.relationship_type = 'direct' then 'direct_client'
      when exists (select 1 from public.pb_facts f
                    where f.account_id = a.id and f.key = 'icp_class' and f.value = '"ICP-6"')
        then 'direct_client'
      else null
    end,
    updated_at = now()
where a.merged_into is null and a.cohort is null;
