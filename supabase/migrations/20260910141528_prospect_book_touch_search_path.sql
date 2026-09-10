-- WLIQ Prospect Book — pin the trigger function's search_path.
--
-- Supabase's security linter flags `pb_touch_updated_at` as having a role-mutable
-- search_path (lint 0011). The body touches only `new.updated_at` and resolves no
-- object by name, so nothing here changes behaviour; an empty search_path simply
-- removes the warning and the class of risk it stands for.
alter function public.pb_touch_updated_at() set search_path = '';
