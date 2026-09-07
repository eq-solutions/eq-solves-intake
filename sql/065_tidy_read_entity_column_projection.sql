-- ============================================================================
-- 065 — eq_tidy_read_entity_columns: column-projected sibling of
-- eq_tidy_read_entity, for callers that don't need every column
-- ============================================================================
-- Royce: "fix the rpc pagination" — the report was the Overview tab's health
-- score / licence-expiry / stale-record checks feeling slow on live SKS data.
--
-- eq_tidy_read_entity (049) does `SELECT json_agg(row_to_json(t)) FROM
-- app_data.%I` — every column, every row, every call. Three separate
-- consumers (computeHealthScores, runLicenceExpiryCheck, decayCheck) each
-- call it independently and each only reads a handful of fields (e.g.
-- licence checks want licence_id/licence_type/expiry_date/staff_id — five
-- columns out of staff's ~50 or licences' ~22). "Pagination" (LIMIT/OFFSET)
-- doesn't actually help any of them — they all need a global fact across
-- every row (a completeness fraction, a full stale-bucket count), so paging
-- just turns one round trip into several without shrinking the total bytes
-- moved. Column projection is the fix that actually reduces payload.
--
-- Deliberately a NEW function, not a CREATE OR REPLACE on eq_tidy_read_entity
-- with an added default parameter: Postgres would register that as a second
-- overload rather than replacing the first (same name, different arity),
-- and a bare 1-arg call from an existing caller becomes ambiguous between
-- the two candidates the moment both exist. A separate name sidesteps that
-- risk entirely — eq_tidy_read_entity(text) is untouched, byte-for-byte.
--
-- NOT wired to any client yet. This file only creates the function; the
-- @eq/intake call sites (health-score.ts, licence-expiry-check.ts,
-- decay-detect.ts) get updated in a follow-up commit once this migration
-- has actually landed on ehow — shipping the client change first would call
-- an RPC that doesn't exist yet.
--
-- duplicate-detect.ts's detectAllDuplicates() deliberately keeps calling the
-- original full-row eq_tidy_read_entity: its completenessOf() survivor
-- tie-break counts every populated field on the row, so a projected read
-- would quietly make that heuristic worse rather than just faster.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.eq_tidy_read_entity_columns(
  p_table   text,
  p_columns text[]
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id   uuid;
  v_result      json;
  v_select_list text;
  v_allowed     text[] := ARRAY[
    'customers', 'sites', 'contacts', 'staff', 'licences', 'assets'
  ];
BEGIN
  v_tenant_id := (
    auth.jwt() -> 'app_metadata' ->> 'tenant_id'
  )::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_columns: no tenant_id in JWT';
  END IF;

  IF NOT (p_table = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_columns: table "%" is not allowed', p_table;
  END IF;

  IF p_columns IS NULL OR array_length(p_columns, 1) IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_columns: p_columns must be a non-empty array';
  END IF;

  -- Whitelist requested columns against the target table's REAL columns —
  -- %I below quotes identifiers safely regardless, but this also silently
  -- drops typos/renamed fields instead of producing a confusing dynamic-SQL
  -- error, and guarantees a caller can never read a column that doesn't
  -- exist on this table (e.g. a staff-only column requested against sites).
  SELECT string_agg(format('t.%I', c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO v_select_list
  FROM unnest(p_columns) AS req(column_name)
  JOIN information_schema.columns c
    ON c.table_schema = 'app_data'
   AND c.table_name   = p_table
   AND c.column_name  = req.column_name;

  IF v_select_list IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_columns: none of the requested columns exist on "%"', p_table;
  END IF;

  EXECUTE format(
    'SELECT json_agg(row_to_json(s)) FROM (SELECT %s FROM app_data.%I t WHERE t.tenant_id = $1) s',
    v_select_list,
    p_table
  )
  INTO v_result
  USING v_tenant_id;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_read_entity_columns(text, text[]) IS
  'Column-projected sibling of eq_tidy_read_entity — same tenant scoping, '
  'but returns only the requested columns (whitelisted against the real '
  'table) instead of every column. Use when a caller does not need the '
  'full row; eq_tidy_read_entity itself is unchanged for callers that do '
  '(e.g. duplicate-detect.ts''s completeness scoring).';

GRANT EXECUTE ON FUNCTION public.eq_tidy_read_entity_columns(text, text[]) TO authenticated;

INSERT INTO app_data._eq_migrations (name, checksum)
VALUES ('065_tidy_read_entity_column_projection', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
