-- New Decisions routes are IT and Maintenance. Retain historical desk values
-- for older authored repair workflows and evidence; new routing never uses them.
ALTER TABLE specialist_tasks DROP CONSTRAINT specialist_tasks_specialist_check;
ALTER TABLE specialist_tasks ADD CONSTRAINT specialist_tasks_specialist_check
  CHECK (specialist IN ('engineering', 'logistics', 'access', 'it', 'maintenance', 'expert'));
UPDATE specialist_tasks SET specialist = 'it' WHERE specialist = 'access';
ALTER TABLE specialist_tasks ADD COLUMN context_snapshot jsonb
  CHECK (context_snapshot IS NULL OR jsonb_typeof(context_snapshot) = 'object');
