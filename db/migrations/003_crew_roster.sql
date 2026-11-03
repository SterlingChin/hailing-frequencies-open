-- Who a crew member is on the ship. Defaults keep existing rows and direct inserts valid; the seed and service set every field explicitly.
ALTER TABLE crew_members
  ADD COLUMN department text NOT NULL DEFAULT 'operations'
    CHECK (department IN ('command', 'operations', 'engineering', 'sciences', 'security', 'medical')),
  ADD COLUMN section text NOT NULL DEFAULT '',
  ADD COLUMN clearance_level integer NOT NULL DEFAULT 1 CHECK (clearance_level BETWEEN 1 AND 10),
  ADD COLUMN posting text NOT NULL DEFAULT '',
  ADD COLUMN service_number text UNIQUE CHECK (service_number ~ '^SF-[A-Z]-[0-9]{4}$'),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'transferred'));
