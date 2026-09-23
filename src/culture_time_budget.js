// culture_time_budget 领域资料的基础结构。

// 前五种为预算与消费事件；后七种为可携带时长账本的终端上报事件
// （见 src/time_ledger/）。
export const EVENT_KINDS = Object.freeze([
  "BUDGET_SET",
  "CONSUMPTION_RECORDED",
  "LIMIT_REACHED",
  "EXCEPTION_REVIEWED",
  "PROFILE_WITHDRAWN",
  "SYNC_POINT",
  "PLAYBACK_FRAGMENT",
  "PLAYBACK_PAUSED",
  "OFFLINE_DOWNLOAD",
  "MEMBERSHIP_GRANTED",
  "MEMBERSHIP_REVOKED",
  "DEVICE_BOUND",
]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
