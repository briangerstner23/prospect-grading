-- Read-only review of existing proposals. Source rows and decisions remain unchanged.
-- This schema is operator-only; do not expose these views through the Data API.
create view prospect_intake.identity_review_groups with (security_invoker=true) as
with grouped as (
 select c.account_id,c.source,c.source_id,
        case when nullif(btrim(c.source_id),'') is null then c.id else null end as blank_reference_nonce,
        array_agg(c.id order by c.created_at,c.id) as candidate_ids,
        count(*)::integer as candidate_count,
        count(distinct jsonb_build_object('name',c.source_name,'domain',c.source_domain,
          'matched_on',c.matched_on,'confidence',c.confidence,'note',c.note))::integer as evidence_variant_count,
        jsonb_agg(distinct jsonb_build_object('name',c.source_name,'domain',c.source_domain,
          'matched_on',c.matched_on,'confidence',c.confidence,'note',c.note)) as evidence_variants,
        min(c.created_at) as first_proposed_at,max(c.created_at) as last_proposed_at
 from public.pb_identity_candidates c
 where c.status='proposed'
 group by c.account_id,c.source,c.source_id,
          case when nullif(btrim(c.source_id),'') is null then c.id else null end
)
select md5(jsonb_build_array(g.account_id,g.source,g.source_id,g.blank_reference_nonce)::text) as review_group_key,
       g.account_id,a.name as account_name,a.status as account_status,g.source,g.source_id,
       g.candidate_ids,g.candidate_count,g.evidence_variant_count,
       g.candidate_count-g.evidence_variant_count as repeated_identical_evidence_rows,
       g.evidence_variants,g.first_proposed_at,g.last_proposed_at,
       (case when g.account_id is null then array['account_not_attached']::text[] else array[]::text[] end)
       ||(case when nullif(btrim(g.source_id),'') is null then array['source_reference_missing']::text[] else array[]::text[] end)
       ||(case when a.merged_into is not null then array['account_already_merged']::text[] else array[]::text[] end)
       ||(case when g.evidence_variant_count>1 then array['multiple_evidence_variants']::text[] else array[]::text[] end)
       as review_blockers,
       true as human_identity_confirmation_required
from grouped g left join public.pb_accounts a on a.id=g.account_id;

create view prospect_intake.fact_review_groups with (security_invoker=true) as
with grouped as (
 select c.account_id,c.key,c.value,
        array_agg(c.id order by c.created_at,c.id) as candidate_ids,
        count(*)::integer as candidate_count,
        coalesce(bool_or(c.kind='judgement'),false) as contains_judgement,
        bool_or(c.kind is null) as contains_untyped_legacy_candidate,
        coalesce(bool_or(c.conflicts),false) as source_conflict_flag,
        jsonb_agg(distinct jsonb_build_object('source',c.source,'source_id',c.source_id,
          'url',c.evidence_url,'observed_at',c.observed_at,'kind',c.kind,
          'support',c.support,'support_basis',c.support_basis)) as evidence_variants,
        min(c.created_at) as first_proposed_at,max(c.created_at) as last_proposed_at
 from public.pb_fact_candidates c where c.status='proposed'
 group by c.account_id,c.key,c.value
), compared as (
 select g.*,a.name as account_name,
        count(*) over(partition by g.account_id,g.key)::integer as proposed_value_variants_for_field,
        exists(select 1 from public.pb_facts f where f.account_id=g.account_id
               and f.key=g.key and f.value is not distinct from g.value) as matches_stored_fact_value,
        (select jsonb_agg(jsonb_build_object('id',f.id,'value',f.value,'source',f.source,
           'observed_at',f.observed_at,'entered_by',f.entered_by,'stand_in',f.stand_in) order by f.id)
         from public.pb_facts f where f.account_id=g.account_id and f.key=g.key) as stored_fact_records
 from grouped g left join public.pb_accounts a on a.id=g.account_id
)
select md5(jsonb_build_array(c.account_id,c.key,c.value)::text) as review_group_key,c.*,
       case when c.contains_judgement then 'human_judgement_review'
            when c.contains_untyped_legacy_candidate then 'legacy_type_review'
            when c.proposed_value_variants_for_field>1 or c.source_conflict_flag then 'conflicting_observation_review'
            when c.matches_stored_fact_value then 'additional_evidence_review'
            else 'observation_review' end as review_lane,
       true as human_admission_required
from compared c;

revoke all privileges on prospect_intake.identity_review_groups,prospect_intake.fact_review_groups
from public,anon,authenticated,service_role;
comment on view prospect_intake.identity_review_groups is
'Read-only grouping of pending identity proposals. Blank source references stay separate; every original candidate and evidence variant is retained. No merge or approval is performed.';
comment on view prospect_intake.fact_review_groups is
'Read-only grouping of pending fact proposals. Matching an existing value does not confirm a proposal or replace its evidence. Judgements, legacy types and conflicting observations remain review lanes.';
