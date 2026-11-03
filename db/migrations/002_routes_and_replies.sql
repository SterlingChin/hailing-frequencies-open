-- Queue routes from the decision step, and the caller's reply consent on a task.
ALTER TABLE specialist_tasks DROP CONSTRAINT specialist_tasks_specialist_check;
ALTER TABLE specialist_tasks ADD CONSTRAINT specialist_tasks_specialist_check
  CHECK (specialist IN ('engineering', 'logistics', 'access', 'maintenance', 'expert'));
ALTER TABLE specialist_tasks
  ADD COLUMN reply_channel text CHECK (reply_channel IN ('voice', 'sms')),
  ADD COLUMN reply_contact_point_id uuid REFERENCES contact_points,
  ADD COLUMN reply_consent_at timestamptz,
  ADD COLUMN reply_claimed_at timestamptz,
  ADD COLUMN reply_provider_sid text UNIQUE,
  ADD COLUMN reply_outcome text CHECK (reply_outcome IN ('placed', 'submitted', 'failed', 'unavailable'));
ALTER TABLE specialist_tasks ADD CONSTRAINT specialist_tasks_reply_consent_check
  CHECK ((reply_channel IS NULL) = (reply_contact_point_id IS NULL) AND (reply_channel IS NULL) = (reply_consent_at IS NULL));
ALTER TABLE specialist_tasks ADD CONSTRAINT specialist_tasks_reply_claim_check
  CHECK (reply_claimed_at IS NULL OR reply_channel IS NOT NULL);
-- Reply lifecycle events in the case timeline.
ALTER TABLE case_events DROP CONSTRAINT case_events_kind_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_kind_check
  CHECK (kind IN ('profile_loaded', 'case_resumed', 'case_opened', 'symptom_updated', 'task_started', 'task_result', 'part_updated',
    'message_requested', 'message_status', 'call_ended', 'note', 'reply_requested', 'reply_claimed', 'reply_outcome', 'reply_started'));
