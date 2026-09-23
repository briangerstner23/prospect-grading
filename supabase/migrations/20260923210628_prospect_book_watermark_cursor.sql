-- Prospect Book — the notes watermark becomes a cursor, and two channels are wound back to where
-- they genuinely stopped reading. Owner ruling 23 Sep 2026 (audit record 3, finding A).
--
-- WHY. pb_source_watermarks held one timestamp per channel, and pb-notes compared it as TEXT.
-- Two defects followed, and both lost records without a single error:
--
--   1. Pipedrive spells a time "2026-09-18 14:02:11"; Postgres hands the watermark back as
--      "2026-09-18T14:02:11+00:00". As text " " sorts before "T", so a note touched later on the
--      same day as the watermark compared as already read. The nightly cap stops a run partway
--      through a day, so the rest of 18 Sep's Pipedrive notes were dropped.
--   2. A bulk update stamped several hundred pb_calls rows with one updated_at. The rule was
--      "strictly newer than the watermark", so once the watermark reached or passed that instant
--      every row still sharing it sat behind it, read or not.
--
-- And a third, which made both silent: when the extractor API refused a call (22–23 Sep, no
-- credit) the record was treated as a bad record and the watermark moved past it.
--
-- The code fix is in ingest/notes_sweep.ts (timeKey, isPastCursor, classifyExtractorFailure) and
-- supabase/functions/pb-notes. This file adds the id half of the cursor and winds the two
-- affected watermarks back. Nothing is written twice by a re-read: a candidate is deduplicated
-- by fingerprint and a fact already on record from the same source is skipped
-- (written_record.ts, "already_on_record").

alter table public.pb_source_watermarks
  add column if not exists last_seen_id text;

comment on column public.pb_source_watermarks.last_seen_id is
  'The id of the last record read AT last_seen_at. A record touched at exactly last_seen_at is unread '
  'when its id sorts after this one (numbers numerically, anything else as text). Null — every row '
  'written before 23 Sep 2026 — means everything at last_seen_at was read.';

-- Wind back. pipedrive_note: to the start of 18 Sep, the first day notes were dropped. A few of
-- that day's notes were genuinely read; reading them again costs a model call each and writes
-- nothing new.
update public.pb_source_watermarks
   set last_seen_at = '2026-09-18T00:00:00Z', last_seen_id = null,
       note = 'Wound back 23 Sep 2026 (audit record 3): text-compare and credit-outage losses from 18 Sep on are re-read.'
 where source = 'pipedrive_note';

-- fathom_call: to one millisecond before the bulk instant of 16 Sep 14:14:38.822 UTC, so every
-- row that shares it is in front of the cursor again, along with everything after it.
update public.pb_source_watermarks
   set last_seen_at = '2026-09-16T14:14:38.821Z', last_seen_id = null,
       note = 'Wound back 23 Sep 2026 (audit record 3): the bulk-timestamp tie and the credit outage are re-read.'
 where source = 'fathom_call';
