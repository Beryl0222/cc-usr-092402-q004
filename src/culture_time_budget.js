// culture_time_budget 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["BUDGET_SET", "CONSUMPTION_RECORDED", "LIMIT_REACHED", "EXCEPTION_REVIEWED", "PROFILE_WITHDRAWN"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
