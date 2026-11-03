CREATE SEQUENCE case_number_seq START 42;

CREATE TABLE crew_members (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  rank text NOT NULL,
  ship text NOT NULL,
  auth_code_hash text NOT NULL UNIQUE CHECK (auth_code_hash ~ '^[a-f0-9]{64}$'),
  language text NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);
CREATE TABLE contact_points (
  id uuid PRIMARY KEY,
  crew_member_id uuid NOT NULL REFERENCES crew_members ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'phone'),
  value text NOT NULL CHECK (value ~ '^\+[1-9][0-9]{1,14}$'),
  label text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (kind, value, crew_member_id)
);
CREATE INDEX contact_phone_idx ON contact_points (kind, value);
CREATE TABLE channel_preferences (
  id uuid PRIMARY KEY,
  crew_member_id uuid NOT NULL REFERENCES crew_members ON DELETE CASCADE,
  topic text NOT NULL CHECK (topic IN ('troubleshooting', 'repair_steps', 'parts_updates')),
  channel text NOT NULL CHECK (channel IN ('voice', 'sms', 'screen')),
  updated_at timestamptz NOT NULL,
  UNIQUE (crew_member_id, topic)
);
CREATE TABLE equipment (
  id uuid PRIMARY KEY,
  crew_member_id uuid NOT NULL REFERENCES crew_members ON DELETE CASCADE,
  model text NOT NULL,
  location text NOT NULL,
  last_service_at timestamptz,
  last_service_note text,
  UNIQUE (id, crew_member_id)
);
CREATE TABLE cases (
  id text PRIMARY KEY CHECK (id ~ '^HF-[0-9]{3,}$'),
  crew_member_id uuid NOT NULL REFERENCES crew_members ON DELETE CASCADE,
  equipment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved', 'closed')),
  title text NOT NULL,
  symptom text NOT NULL,
  symptom_revision integer NOT NULL CHECK (symptom_revision > 0),
  diagnosis text,
  diagnosis_status text NOT NULL CHECK (diagnosis_status IN ('none', 'proposed', 'confirmed_fixed', 'not_fixed')),
  next_step text,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  UNIQUE (id, crew_member_id),
  FOREIGN KEY (equipment_id, crew_member_id) REFERENCES equipment (id, crew_member_id)
);
CREATE INDEX crew_cases_idx ON cases (crew_member_id, status, updated_at DESC);
CREATE TABLE interactions (
  id uuid PRIMARY KEY,
  case_id text,
  crew_member_id uuid REFERENCES crew_members ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('voice', 'sms')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_sid text NOT NULL UNIQUE,
  auth_attempts integer NOT NULL DEFAULT 0 CHECK (auth_attempts BETWEEN 0 AND 3),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (case_id IS NULL OR crew_member_id IS NOT NULL),
  FOREIGN KEY (case_id, crew_member_id) REFERENCES cases (id, crew_member_id) ON DELETE CASCADE
);
CREATE TABLE case_events (
  id uuid PRIMARY KEY,
  -- Profile loading precedes case selection. Its event is linked on selection.
  case_id text REFERENCES cases ON DELETE CASCADE,
  interaction_id uuid REFERENCES interactions ON DELETE SET NULL,
  at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('profile_loaded', 'case_resumed', 'case_opened', 'symptom_updated', 'task_started', 'task_result', 'part_updated', 'message_requested', 'message_status', 'call_ended', 'note')),
  summary text NOT NULL CHECK (length(summary) <= 300),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX case_timeline_idx ON case_events (case_id, at);
CREATE TABLE specialist_tasks (
  id uuid PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases ON DELETE CASCADE,
  specialist text NOT NULL CHECK (specialist IN ('engineering', 'logistics')),
  assignment text NOT NULL,
  symptom_revision integer NOT NULL CHECK (symptom_revision > 0),
  status text NOT NULL CHECK (status IN ('working', 'result_ready', 'failed', 'obsolete')),
  result jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX case_tasks_idx ON specialist_tasks (case_id);
CREATE TABLE part_orders (
  id uuid PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases ON DELETE CASCADE,
  part_name text NOT NULL,
  part_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'reserved', 'ordered', 'shipped', 'delivered', 'cancelled')),
  carrier text,
  eta timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK (status <> 'shipped' OR (length(trim(carrier)) > 0 AND carrier IS NOT NULL AND eta IS NOT NULL))
);
CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases ON DELETE CASCADE,
  contact_point_id uuid NOT NULL REFERENCES contact_points,
  channel text NOT NULL CHECK (channel = 'sms'),
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'queued', 'submitted', 'sent', 'delivered', 'failed', 'undelivered')),
  status_history jsonb NOT NULL CHECK (jsonb_typeof(status_history) = 'array'),
  provider_sid text UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL,
  requested_in_interaction_id uuid NOT NULL REFERENCES interactions
);
CREATE INDEX case_messages_idx ON outbound_messages (case_id, requested_at DESC);
