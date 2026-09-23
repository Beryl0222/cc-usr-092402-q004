// 终端上报事件的载荷约定。事件基础字段（event_id/kind/occurred_at/subject_id/payload）
// 由 src/culture_time_budget.js 的 validateEvent 校验，这里补充各上报种类的 payload 字段。

export const REPORT_PAYLOAD_FIELDS = Object.freeze({
  // 同步点：设备时钟 ↔ 服务器时钟，用于校正设备时钟漂移
  SYNC_POINT: ["device_id", "device_clock", "server_clock"],
  // 会话片段：一次连续播放的内容区间；断点续播会产生多个片段
  PLAYBACK_FRAGMENT: [
    "device_id",
    "session_id",
    "fragment_seq",
    "content_id",
    "content_start",
    "content_end",
    "started_at",
    "ended_at",
    "timezone",
  ],
  // 暂停：只作证据留存，不产生用量
  PLAYBACK_PAUSED: ["device_id", "session_id", "content_id", "content_position", "paused_at"],
  // 离线下载授权：离线片段晚到时据此校验
  OFFLINE_DOWNLOAD: ["download_id", "device_id", "content_id", "package_id", "granted_at"],
  // 家庭共享归属规则（按生效时间版本化）
  MEMBERSHIP_GRANTED: ["member_subject_id", "account_id", "effective_from"],
  MEMBERSHIP_REVOKED: ["member_subject_id", "account_id", "effective_at"],
  // 设备 → 账户绑定（归属兜底规则）
  DEVICE_BOUND: ["device_id", "account_id", "effective_from"],
});

export function validateReportPayload(kind, payload) {
  const required = REPORT_PAYLOAD_FIELDS[kind];
  if (!required) return ["kind"];
  return required.filter((name) => !(name in payload));
}
