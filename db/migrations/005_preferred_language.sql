-- The reporting agent uses this value for spoken replies after profile load.
-- Existing crew default to English; preserve an earlier Klingon selection if present.
ALTER TABLE crew_members
  ADD COLUMN preferred_language text NOT NULL DEFAULT 'english'
    CHECK (preferred_language IN ('english', 'klingon'));

UPDATE crew_members SET preferred_language = 'klingon' WHERE lower(language) = 'klingon';

-- Keep the selected fictional demo example on Klingon without reseeding its
-- existing cases or contact history in production.
UPDATE crew_members SET preferred_language = 'klingon'
WHERE id = '00000000-0000-4000-8000-000000000102' AND is_demo = true AND display_name = 'Dax Roe';
