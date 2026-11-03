-- Reporter-authenticated intake. Conversation blobs stay in private CRM storage.
CREATE TABLE reporter_contexts (
  id uuid PRIMARY KEY,
  crew_member_id uuid NOT NULL REFERENCES crew_members ON DELETE CASCADE,
  case_id text,
  body text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 64000),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (case_id, crew_member_id) REFERENCES cases (id, crew_member_id) ON DELETE CASCADE
);
CREATE INDEX reporter_context_crew_idx ON reporter_contexts (crew_member_id, created_at, id);
