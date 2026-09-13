-- pb_calls.meeting_key — which MEETING a recording is of.
--
-- fathom_recording_id identifies a RECORDING. Fathom issues one per recorder, so a call with
-- four WLIQ people running Fathom writes four rows, and the notes sweep extracts the same
-- facts four times. Measured 13 Sep 2026: four of the twelve rows in this table are one
-- meeting.
--
-- The key is built by ingest/fathom_webhook.ts `meetingKey()` from the UTC date, the
-- normalised title, and the EXTERNAL attendee addresses — the three things every recorder on
-- one call agrees about. held_at does not qualify (each recorder has their own start time) and
-- neither does the internal attendee list (Fathom substitutes the recorder's own address).
--
-- Nullable on purpose: a payload with neither a title nor an external address has nothing to
-- key on, and a null key is never grouped with another null.
--
-- The backfill below reproduces meetingKey() in SQL for the rows already stored. It is a
-- one-time statement, not a trigger — the parser owns the key from here on.

alter table public.pb_calls add column if not exists meeting_key text;

comment on column public.pb_calls.meeting_key is
  'Which meeting this recording is of: UTC date | normalised title | sorted external attendee emails. '
  'Several recorders on one call share it. Written by ingest/fathom_webhook.ts meetingKey(); null when unkeyable.';

create index if not exists pb_calls_meeting_key_idx
  on public.pb_calls (account_id, meeting_key)
  where meeting_key is not null;

update public.pb_calls c
set meeting_key = k.key
from (
  select c2.id,
         case
           when coalesce(nm.name, '') = '' and coalesce(em.emails, '') = '' then null
           else coalesce(to_char(c2.held_at at time zone 'UTC', 'YYYY-MM-DD'), '')
                || '|' || coalesce(nm.name, '')
                || '|' || coalesce(em.emails, '')
         end as key
  from public.pb_calls c2
  cross join lateral (
    select regexp_replace(lower(btrim(coalesce(c2.title, ''))), '\s+', ' ', 'g') as name
  ) nm
  cross join lateral (
    select string_agg(e, ',' order by e) as emails
    from (
      select distinct lower(btrim(a->>'email')) as e
      from jsonb_array_elements(coalesce(c2.attendees, '[]'::jsonb)) a
      where (a->>'is_external')::boolean is true
        and coalesce(btrim(a->>'email'), '') <> ''
    ) d
  ) em
) k
where k.id = c.id;
