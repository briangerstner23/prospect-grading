-- A client is still a prospect, and a live quote is the hottest signal there is. (Owner, 16 Sep.)
--
-- The first cut of pb_mdm_resolution told a reader that an account the registry calls a client
-- "belongs in the promotion queue, not a chase list". The owner ruled the opposite, and the
-- reasoning matters more than the verdict:
--
--   * an Orbit project is very often a QUOTE, which means they are mid-decision — the moment that
--     deserves the most attention, not an exclusion;
--   * after a signature the account hands to an AM, and that transition is where the investment
--     is most at risk, so nurture continues rather than stops;
--   * a client buying one line is a prospect for every other line.
--
-- So delivery is not a disqualification. It changes the LANE — chase, nurture-through-transition,
-- or expansion — and the lane is advice to a person, not a filter that removes rows.
--
-- The related correction, same ruling: a stage of "Quote Lost" does not mean the client is lost.
-- A no is a positive sign; it is a priced conversation that can be re-shaped, and the loss may
-- have been our scoping rather than their budget.

drop view if exists public.pb_mdm_resolution;

create view public.pb_mdm_resolution
with (security_invoker = true) as
with m as (
  select a.id as account_id, a.name as account_name, a.domain,
         c.slug, c.canonical_name, c.entity_type, c.status, c.review_state, c.signed_off_at,
         case
           when al_d.slug is not null then 'domain'
           when al_n.slug is not null then 'alias_name'
           else 'canonical_name'
         end as matched_on,
         coalesce(al_n.authoritative, al_d.authoritative, true) as alias_authoritative
    from public.pb_accounts a
    left join public.pb_mdm_aliases al_d
           on al_d.alias_type = 'domain' and lower(al_d.alias) = lower(a.domain)
    left join public.pb_mdm_aliases al_n
           on al_n.alias_type = 'name' and lower(al_n.alias) = lower(a.name)
    join public.pb_mdm_companies c
           on c.slug = coalesce(al_d.slug, al_n.slug)
           or lower(c.canonical_name) = lower(a.name)
)
select m.*,
       exists (select 1 from public.pb_mdm_junk j
                where (j.kind = 'name'   and lower(j.value) = lower(m.account_name))
                   or (j.kind = 'domain' and lower(j.value) = lower(coalesce(m.domain,'')))) as is_junk,
       case
         when m.entity_type = 'client' then
           'client per the registry — STAYS in the book. Delivery is a relationship, not a '
           || 'disqualification: they are a prospect for every line they are not already buying, '
           || 'and the handover to an account manager is the moment to nurture hardest.'
         when m.entity_type = 'sub_client' then
           'a pod of another company — not an account of its own; work it through the parent'
         when m.entity_type = 'prospect' then
           'prospect per the registry — stays in the book'
       end as lane,
       (m.signed_off_at is null) as pending_signoff
  from m;

comment on view public.pb_mdm_resolution is
  'Prospect Book accounts matched against the identity registry, by domain then alias then canonical name — never by a Notion Client ID (R4). `lane` is advice about HOW to work the account, never a filter: a client stays in the book (owner ruling, 16 Sep 2026).';

/**
 * A quote is the hottest thing on the board.
 *
 * `pb_engagement` grades recency of contact. This adds the shape of that contact: an account with
 * a quote raised in the last 60 days is mid-decision, and that outranks a chat. Reported beside
 * engagement rather than folded into it, so the two can disagree visibly.
 */
create or replace view public.pb_engagement_shape
with (security_invoker = true) as
select e.account_id, e.name, e.engagement, e.stage_label,
       e.last_contact, e.last_engaged, e.last_quote,
       (now()::date - e.last_quote::date) as days_since_quote,
       case
         when e.last_quote >= now() - interval '60 days'  then 'quote_open'
         when e.last_quote >= now() - interval '180 days' then 'quoted_recently'
         else null
       end as quote_state,
       case
         when e.last_quote >= now() - interval '60 days' then 'quoted in the last 60 days — mid-decision, highest attention'
         when e.engagement in ('engaged','responsive') and e.last_quote is not null
           then 'talking, and has been quoted before'
         when e.engagement in ('engaged','responsive') then 'talking, never quoted — find the first scope'
         when e.engagement = 'pursued'  then 'we are reaching out and they have not come back'
         when e.engagement = 'fading'   then 'going quiet'
         when e.engagement = 'dormant'  then 'nothing for six months'
         else 'nothing recorded — not the same as cold'
       end as why
  from public.pb_engagement e;

comment on view public.pb_engagement_shape is
  'Engagement plus the shape of it. A quote raised in the last 60 days means mid-decision and outranks conversation alone (owner ruling, 16 Sep 2026). Reported beside engagement, not folded into it.';
