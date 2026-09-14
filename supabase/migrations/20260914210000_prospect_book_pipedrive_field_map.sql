-- WLIQ Prospect Book — collecting PB_PIPEDRIVE_FIELD_MAP from Pipedrive's own field definitions.
--
-- Pipedrive keys every custom field by a 40-hex hash. `pipedrive_webhook.ts` never hard-codes
-- one: it labels incoming custom fields from a map handed in through the Vault secret
-- `PB_PIPEDRIVE_FIELD_MAP`, shaped
--
--   {deals: {<hash>: {label, options?}}, organizations: {…}, persons: {…}, activities: {…}}
--
-- where `options` maps an option id to its text, so an enum arrives as "High" rather than 414.
-- Without the map every webhook delivery still lands and is processed — the fields simply pass
-- through unlabelled, and the run says so in its notes. The Grade field is the one that matters:
-- unlabelled, a webhook deal carries `79d0a04a…: 414` and no `grade_label`.
--
-- RUNBOOK §5 said this map "cannot be collected in-session" because the MCP has no
-- field-definitions endpoint. True of the MCP, and irrelevant since 12 Sep: the REST API has
-- had `/v1/dealFields` all along and `PB_PIPEDRIVE_API_TOKEN` has been in Vault since then. So
-- this runs entirely inside the database, like the roster crawl and the webhook registration.
--
-- **Two steps, because pg_net dispatches only after the calling transaction commits.** A single
-- function cannot fetch and store: its own requests have not left yet when it returns. So
-- `_begin()` fires the four requests and hands back their ids, and `_finish(ids)` reads the
-- replies and writes the secret — the same shape as `pb-roster-begin` / `pb-roster-step`.
--
-- Operator-only, on purpose. No edge function reads these; `pb_secret()` is already service-role
-- only, and a field map is not something a signed-in rater has any reason to rewrite. Neither
-- function is granted to `anon` or `authenticated`.
--
-- Refresh by running the pair again whenever fields are added or renamed in Pipedrive. The map
-- is a snapshot, not a subscription: a field renamed today keeps its old label here until then.

create or replace function public.pb_pipedrive_field_map_begin()
returns bigint[]
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token text := public.pb_secret('PB_PIPEDRIVE_API_TOKEN');
  v_hdrs  jsonb;
  v_out   bigint[];
begin
  if v_token is null or length(v_token) = 0 then
    raise exception 'PB_PIPEDRIVE_API_TOKEN is not in Vault; nothing to collect with';
  end if;
  -- The token travels as a header, never in the URL: a query string is the half of a request
  -- most likely to be written down by something else.
  v_hdrs := jsonb_build_object('x-api-token', v_token);

  -- v1 for all four: v2 pages by cursor and returns a different envelope, and there is no
  -- reason to handle two shapes for a list that fits in one page. `limit=500` is well above
  -- the ~90 fields any one entity has; `_finish` refuses a truncated page rather than
  -- silently storing half a map.
  select array[
    net.http_get(url := 'https://api.pipedrive.com/v1/dealFields?limit=500',         headers := v_hdrs),
    net.http_get(url := 'https://api.pipedrive.com/v1/organizationFields?limit=500', headers := v_hdrs),
    net.http_get(url := 'https://api.pipedrive.com/v1/personFields?limit=500',       headers := v_hdrs),
    net.http_get(url := 'https://api.pipedrive.com/v1/activityFields?limit=500',     headers := v_hdrs)
  ] into v_out;

  return v_out;
end $function$;

create or replace function public.pb_pipedrive_field_map_finish(
  p_requests bigint[],
  p_store    boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_entities text[] := array['deals','organizations','persons','activities'];
  v_map    jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_body   jsonb;
  v_status int;
  v_one    jsonb;
  v_id     uuid;
  i        int;
begin
  if p_requests is null or array_length(p_requests, 1) <> 4 then
    raise exception 'expected the four request ids from pb_pipedrive_field_map_begin(), got %',
      coalesce(array_length(p_requests, 1), 0);
  end if;

  for i in 1..4 loop
    select r.status_code, r.content::jsonb into v_status, v_body
      from net._http_response r where r.id = p_requests[i];

    if not found then
      raise exception 'no reply yet for request % (%) — pg_net dispatches after commit, so run _begin() in its own statement first',
        p_requests[i], v_entities[i];
    end if;
    if v_status <> 200 then
      raise exception 'Pipedrive answered % for % (request %)', v_status, v_entities[i], p_requests[i];
    end if;
    if coalesce((v_body ->> 'success')::boolean, false) is not true then
      raise exception 'Pipedrive reported failure for % (request %)', v_entities[i], p_requests[i];
    end if;
    -- A truncated page would store a map missing exactly the fields nobody noticed were missing.
    if coalesce((v_body -> 'additional_data' -> 'pagination' ->> 'more_items_in_collection')::boolean, false) then
      raise exception '% has more fields than one page; raise the limit rather than storing a partial map', v_entities[i];
    end if;

    -- Custom fields only: the parser's own HASH_KEY test is a 40-hex key, and a built-in field
    -- like `title` needs no labelling.
    select coalesce(jsonb_object_agg(e ->> 'key', jsonb_strip_nulls(jsonb_build_object(
             'label',   e ->> 'name',
             'options', case when jsonb_typeof(e -> 'options') = 'array'
                             then (select jsonb_object_agg(o ->> 'id', o ->> 'label')
                                     from jsonb_array_elements(e -> 'options') o
                                    where o ? 'id')
                             else null end
           ))), '{}'::jsonb)
      into v_one
      from jsonb_array_elements(v_body -> 'data') e
     where e ->> 'key' ~ '^[0-9a-f]{40}$';

    v_map    := v_map    || jsonb_build_object(v_entities[i], v_one);
    v_counts := v_counts || jsonb_build_object(v_entities[i], (select count(*) from jsonb_object_keys(v_one)));
  end loop;

  if p_store then
    select id into v_id from vault.secrets where name = 'PB_PIPEDRIVE_FIELD_MAP';
    if v_id is null then
      perform vault.create_secret(v_map::text, 'PB_PIPEDRIVE_FIELD_MAP',
        'Pipedrive custom-field labels, collected by pb_pipedrive_field_map_finish(). A snapshot; re-run to refresh.');
    else
      perform vault.update_secret(v_id, v_map::text);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'stored', p_store, 'counts', v_counts,
    'bytes', length(v_map::text)
  );
end $function$;

revoke all on function public.pb_pipedrive_field_map_begin() from public, anon, authenticated;
revoke all on function public.pb_pipedrive_field_map_finish(bigint[], boolean) from public, anon, authenticated;
