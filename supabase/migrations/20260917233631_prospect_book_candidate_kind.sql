alter table public.pb_fact_candidates
  add column if not exists kind text;

alter table public.pb_fact_candidates
  drop constraint if exists pb_fact_candidates_kind_check;
alter table public.pb_fact_candidates
  add constraint pb_fact_candidates_kind_check
  check (kind is null or kind in ('observation', 'judgement'));

comment on column public.pb_fact_candidates.kind is
  'observation = the sentence states something a reader could check; judgement = it is somebody''s '
  'assessment of it. Decided by notes_sweep.verifyClaims (the model says, the judgement lexicon '
  'overrules). NULL means the producer did not record it — NOT that it is an observation.';

update public.pb_fact_candidates
   set kind = 'judgement'
 where kind is null
   and note ilike '%assessment, not something a reader could check%';

update public.pb_fact_candidates
   set kind = 'observation'
 where kind is null
   and note ~ '^Confidence (high|medium|low); a person confirms before it becomes a fact\.';