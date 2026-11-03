-- Update only Dax's fictional demo identity. Keep the UUID and all related
-- interactions, cases, and contact history intact.
DO $$
DECLARE
  dax crew_members%ROWTYPE;
BEGIN
  SELECT * INTO dax FROM crew_members
    WHERE id = '00000000-0000-4000-8000-000000000102';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF dax.is_demo IS NOT TRUE
    OR dax.display_name NOT IN ('Dax Roe', 'Dax Row')
    OR dax.auth_code_hash NOT IN (
      'bd6ee8a83445bf6da21ddfc33419b359fe08e5a416ddecaf1276bdeab71ee84a',
      '8293b02353b28afd5b44e7f53a2a1d427eacdc2164f85d07eefead71563df0d2'
    ) THEN
    RAISE EXCEPTION 'Dax demo identity differs from expected; refusing authorization update';
  END IF;

  UPDATE crew_members
    SET display_name = 'Dax Row',
        auth_code_hash = '8293b02353b28afd5b44e7f53a2a1d427eacdc2164f85d07eefead71563df0d2'
    WHERE id = dax.id;
END $$;
