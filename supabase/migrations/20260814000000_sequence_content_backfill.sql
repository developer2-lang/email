-- Backfill the legacy sequences.subject_N/body_N + subject_Na/body_Na wide
-- columns from the canonical step content (sequence_branch_steps first, then
-- sequence_steps). Only fills NULL cells — never overwrites existing non-null
-- data. Idempotent; safe to run again.
--
-- Mapping:
--   non-NOT_OPENED (STARTING/OPENED) nodes -> subject_N / body_N
--   NOT_OPENED nodes                       -> subject_Na / body_Na

DO $$
DECLARE
  n integer;
BEGIN
  FOR n IN 1..12 LOOP
    -- 1) Non-opened content from sequence_branch_steps (builder source)
    EXECUTE format($f$
      UPDATE sequences s
      SET
        subject_%1$s = COALESCE(s.subject_%1$s, b.subject),
        body_%1$s    = COALESCE(s.body_%1$s,    b.body)
      FROM (
        SELECT DISTINCT ON (sequence_id) sequence_id, subject, body
        FROM sequence_branch_steps
        WHERE step = %2$s
          AND (parent_branch IS NULL OR parent_branch <> 'NOT_OPENED')
        ORDER BY sequence_id, id
      ) b
      WHERE b.sequence_id = s.id;
    $f$, n, n);

    -- 2) Not-opened content from sequence_branch_steps
    --    (no subject_1a/body_1a columns — step 1 is always STARTING)
    IF n > 1 THEN
      EXECUTE format($f$
        UPDATE sequences s
        SET
          subject_%1$sa = COALESCE(s.subject_%1$sa, b.subject),
          body_%1$sa    = COALESCE(s.body_%1$sa,    b.body)
        FROM (
          SELECT DISTINCT ON (sequence_id) sequence_id, subject, body
          FROM sequence_branch_steps
          WHERE step = %2$s
            AND parent_branch = 'NOT_OPENED'
          ORDER BY sequence_id, id
        ) b
        WHERE b.sequence_id = s.id;
      $f$, n, n);
    END IF;

    -- 3) Non-opened fallback from canonical sequence_steps
    EXECUTE format($f$
      UPDATE sequences s
      SET
        subject_%1$s = COALESCE(s.subject_%1$s, st.normal_subject),
        body_%1$s    = COALESCE(s.body_%1$s,    st.normal_body)
      FROM (
        SELECT DISTINCT ON (sequence_id) sequence_id, normal_subject, normal_body
        FROM sequence_steps
        WHERE step_number = %2$s
          AND archived_at IS NULL
          AND (parent_branch IS NULL OR parent_branch <> 'NOT_OPENED')
        ORDER BY sequence_id, id
      ) st
      WHERE st.sequence_id = s.id;
    $f$, n, n);

    -- 4) Not-opened fallback from canonical sequence_steps
    IF n > 1 THEN
      EXECUTE format($f$
        UPDATE sequences s
        SET
          subject_%1$sa = COALESCE(s.subject_%1$sa, st.increment_subject),
          body_%1$sa    = COALESCE(s.body_%1$sa,    st.increment_body)
        FROM (
          SELECT DISTINCT ON (sequence_id) sequence_id, increment_subject, increment_body
          FROM sequence_steps
          WHERE step_number = %2$s
            AND archived_at IS NULL
            AND parent_branch = 'NOT_OPENED'
          ORDER BY sequence_id, id
        ) st
        WHERE st.sequence_id = s.id;
      $f$, n, n);
    END IF;
  END LOOP;
END $$;