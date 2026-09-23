// 可携带时长账本：事件目录与最小字段校验。
//
// 事件分三层：
//   终端上报层  各设备按设备序列号与会话片段上报播放、暂停、离线下载、同步点
//   规则层      账号关系、设备绑定、内容包规则均为“带版本有效期”的事实
//   账本层      封账、调整、申诉裁定、证据授权，由账本侧产生
//
// 所有事件只追加、不修改；重放同一批事件必须得到同一结果。

export const EVENT_KINDS = Object.freeze([
  // 兼容既有领域资料
  "BUDGET_SET",
  "CONSUMPTION_RECORDED",
  "LIMIT_REACHED",
  "EXCEPTION_REVIEWED",
  "PROFILE_WITHDRAWN",

  // —— 终端上报层 ——
  // 一段播放/暂停观察：半开区间 [start, end)，含内容内位置 [pos_start, pos_end)
  "PLAYBACK_SEGMENT",
  // 会话同步点：设备时钟与平台时基对表，并声明当时所在 IANA 时区
  "SESSION_SYNC",
  // 离线下载授权：内容在 [licensed_from, licensed_to) 内可离线计秒
  "OFFLINE_DOWNLOAD",

  // —— 规则层（均带 version 与 [valid_from, valid_to)）——
  // 家庭成员关系：subject（账号主人）与 member（实际观看人）之间的归属规则
  "RELATIONSHIP_RULE",
  // 设备绑定：设备序列号的归属账号、共享属性
  "DEVICE_BINDING",
  // 内容包规则：免费/计费、倍率、是否计入预算、消费类目
  "CONTENT_PACK_RULE",

  // —— 账本层 ——
  "PERIOD_CLOSED", // 周期封账（开票/退款后）
  "LEDGER_ADJUSTMENT", // 对已封账周期追加调整，不重写原账单
  "DISPUTE_RULING", // 逐片段申诉裁定
  "EVIDENCE_GRANT", // 财务证据的最小范围查验授权（家庭共享撤销后使用）
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 各事件类型的最小 payload 字段（缺失即拒收入账）。
export const PAYLOAD_FIELDS = Object.freeze({
  PLAYBACK_SEGMENT: [
    "device_sn", // 设备序列号
    "session_id", // 会话片段标识（同一续播链路上各终端可不同，用 payload.resume_chain 串联）
    "content_id",
    "state", // PLAYING | PAUSED
    "seg_start", // 设备时钟读数（ISO8601，含设备自身偏移）
    "seg_end",
    "pos_start_ms", // 内容内播放位置（毫秒）
    "pos_end_ms",
  ], // 可选：viewer_id（观看人档案声明）、pack_id、resume_chain、offline、download_id
  SESSION_SYNC: [
    "device_sn",
    "session_id",
    "device_clock", // 同步瞬间设备时钟读数
    "reference_clock", // 平台时基同一瞬间
    "drift_ppm_tolerance", // 设备晶振漂移容忍上限
    "iana_timezone", // 同步时设备所在时区
  ], // 可选：resume_chain（跨终端续播链路标识）
  OFFLINE_DOWNLOAD: [
    "device_sn",
    "content_id",
    "download_id",
    "licensed_from",
    "licensed_to",
  ],
  RELATIONSHIP_RULE: [
    "rule_id",
    "version",
    "member_id", // 实际观看人（如家庭成员、车机借用人）
    "relationship", // FAMILY_ADULT | FAMILY_CHILD | GUEST | OWNER ...
    "attribution", // TO_OWNER | TO_MEMBER | TO_GUEST_QUOTA
    "valid_from",
  ],
  DEVICE_BINDING: [
    "rule_id",
    "version",
    "device_sn",
    "sharing", // PERSONAL | FAMILY_SHARED | GUEST_ALLOWED
    "valid_from",
  ],
  CONTENT_PACK_RULE: [
    "rule_id",
    "version",
    "pack_id",
    "billable", // 是否扣减预算
    "rate", // 计秒倍率（如 1，儿童包 0）
    "category",
    "valid_from",
  ],
  PERIOD_CLOSED: ["period_type", "period_key", "closed_at"],
  LEDGER_ADJUSTMENT: ["period_type", "period_key", "reason", "delta_ms"],
  DISPUTE_RULING: ["case_id", "segment_ref", "decision", "decided_at"],
  EVIDENCE_GRANT: ["grant_id", "scope", "granted_to", "valid_until"],
  BUDGET_SET: [],
  CONSUMPTION_RECORDED: [],
  LIMIT_REACHED: [],
  EXCEPTION_REVIEWED: [],
  PROFILE_WITHDRAWN: [],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  const need = PAYLOAD_FIELDS[record.kind] ?? [];
  const payload = (record.payload ?? {});
  for (const name of need) {
    if (!(name in payload)) problems.push(`payload.${name}`);
  }
  return problems;
}
