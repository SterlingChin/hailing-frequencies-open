// Repository interface: transaction(fn), then tx.find/insert/update/remove,
// tx.nextCaseId/resetCaseSequence. Rows use SQL names and ISO timestamps.
// Only trusted service/seed code gets this interface; it is never a model tool.
export const columns = {
  reporter_contexts: 'id crew_member_id case_id body created_at',
  crew_members: 'id display_name rank ship auth_code_hash language preferred_language is_demo created_at department section clearance_level posting service_number status',
  contact_points: 'id crew_member_id kind value label created_at',
  channel_preferences: 'id crew_member_id topic channel updated_at',
  equipment: 'id crew_member_id model location last_service_at last_service_note',
  cases: 'id crew_member_id equipment_id status title symptom symptom_revision diagnosis diagnosis_status next_step opened_at updated_at resolved_at',
  interactions: 'id case_id crew_member_id channel direction provider_sid auth_attempts started_at ended_at',
  case_events: 'id case_id interaction_id at kind summary data',
  specialist_tasks: 'id case_id specialist assignment symptom_revision status result created_at completed_at reply_channel reply_contact_point_id reply_consent_at reply_claimed_at reply_provider_sid reply_outcome context_snapshot',
  part_orders: 'id case_id part_name part_number status carrier eta updated_at',
  outbound_messages: 'id case_id contact_point_id channel body status status_history provider_sid idempotency_key requested_at requested_in_interaction_id',
};
export function validateColumns(table, values) {
  if (!Object.hasOwn(columns, table) || !values || Object.keys(values).some(key => !columns[table].split(' ').includes(key))) {
    throw new TypeError('Invalid repository fields');
  }
}
export const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
export const caseId = number => `HF-${String(number).padStart(3, '0')}`;
