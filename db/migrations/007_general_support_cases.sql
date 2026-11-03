-- Account access and other support requests need not refer to registered
-- physical equipment. Keep the ownership FK for every non-null equipment ID.
ALTER TABLE cases ALTER COLUMN equipment_id DROP NOT NULL;
