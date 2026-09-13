-- WLIQ Prospect Book — confidence as a letter, and a human override of it.
--
-- pb_reads.confidence holds High/Medium/Low, copied off the fit read. That says it in three
-- steps, says it only about fit, and says nothing about the read as a whole. These columns
-- carry the whole read's confidence as a letter, plus the letter the rubric's bands produced
-- before any person moved it, so an override is always legible as an override.
--
-- All three are NULLABLE on purpose. The bands live in rubric 0.1.1, which is a DRAFT: until
-- it is previewed and activated the engine returns null and these columns stay null. An absent
-- spec is not a grade of F (rule 5, one level up).
--
-- Rule 6 is unchanged: pb_reads is written by pb-score and by nothing else. A person moves the
-- grade by writing a pb_register row of kind 'override' whose payload names confidence_grade —
-- the same lane, reason code, written reason and expiry a tier override already signs (rule 7).
-- No schema change is needed for that: the register's payload is jsonb and the kind already
-- exists. resolve_features reads the row, the engine enforces the cap.

alter table public.pb_reads
  add column if not exists confidence_grade text,
  add column if not exists computed_confidence_grade text,
  add column if not exists confidence_overridden boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pb_reads_confidence_grade_ck') then
    alter table public.pb_reads
      add constraint pb_reads_confidence_grade_ck
      check (confidence_grade is null or confidence_grade = any (array['A','B','C','D','F']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pb_reads_computed_confidence_grade_ck') then
    alter table public.pb_reads
      add constraint pb_reads_computed_confidence_grade_ck
      check (computed_confidence_grade is null or computed_confidence_grade = any (array['A','B','C','D','F']));
  end if;
end $$;

comment on column public.pb_reads.confidence_grade is
  'The whole read''s confidence as a letter (A..F), after any override. Null while no active rubric defines confidence_grade. About the INPUTS, never about the prospect: F means the book knows nothing yet.';
comment on column public.pb_reads.computed_confidence_grade is
  'The letter the rubric''s bands produced, before any override. Equal to confidence_grade unless a person moved it.';
comment on column public.pb_reads.confidence_overridden is
  'True when a pb_register override moved the grade. The reason and approver are on the register row, never here.';

-- The page reads this column for every account in the listing.
create index if not exists pb_reads_confidence_grade_idx
  on public.pb_reads (confidence_grade) where confidence_grade is not null;
