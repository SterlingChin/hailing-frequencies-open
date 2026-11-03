-- Rename the existing fictional crew member in place, preserving the same
-- UUID and every related CRM record. The phrase is stored only as its hash.
DO $$
DECLARE
  crew crew_members%ROWTYPE;
BEGIN
  SELECT * INTO crew FROM crew_members
    WHERE id = '00000000-0000-4000-8000-000000000102';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF crew.is_demo IS NOT TRUE
    OR crew.display_name NOT IN ('Dax Row', 'Michael Watson')
    OR crew.auth_code_hash NOT IN (
      '8293b02353b28afd5b44e7f53a2a1d427eacdc2164f85d07eefead71563df0d2',
      '47f8ca172fe94e0d3cbfa835ec606da6de1e700c0f39ec78738537efc3872e82'
    ) THEN
    RAISE EXCEPTION 'Demo crew identity differs from expected; refusing Michael Watson update';
  END IF;

  UPDATE crew_members
    SET display_name = 'Michael Watson',
        auth_code_hash = '47f8ca172fe94e0d3cbfa835ec606da6de1e700c0f39ec78738537efc3872e82'
    WHERE id = crew.id;
END $$;
