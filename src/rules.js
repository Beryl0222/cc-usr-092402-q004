// 时效归属规则。
//
// 关系、设备绑定、内容包都是“带版本有效期”的事实流：
//   - 同一 rule_id 的新版本自带 valid_from；前一版本在该刻（半开 [from,to)）自动收口；
//   - 事件可显式带 valid_to（例如撤销家庭共享：新版本 valid_from=撤销时刻，attribution=NONE）；
//   - PROFILE_WITHDRAWN 会在 occurred_at 关闭该主体名下全部关系版本；
//   - 封账与归属一律按片段每个时刻“当时有效”的版本解析，片段跨越版本边界时先切片（见 ledger）。
//
// 归属判定输出：
//   bill_account  实际扣减账号
//   viewer_id     实际观看人
//   reason        归属原因，供客服展开
//   pack          当时有效内容包规则（billable/rate/category）
// 无法确定观看人或共享已撤销时不静默计入主人，记为 UNASSIGNED / REVOKED，进入申诉视野。

import { toMs } from "./time.js";

const OPEN_END = Infinity;

function versionsOf(ruleEvents) {
  // 同一 rule_id 按 valid_from 排序，并自动收口上一版本。
  const byRule = new Map();
  for (const e of ruleEvents) {
    const p = e.payload;
    const v = {
      rule_id: p.rule_id,
      version: p.version,
      from: toMs(p.valid_from),
      to: p.valid_to ? toMs(p.valid_to) : OPEN_END,
      raw: p,
      event_id: e.event_id,
    };
    if (!byRule.has(p.rule_id)) byRule.set(p.rule_id, []);
    byRule.get(p.rule_id).push(v);
  }
  const all = [];
  for (const versions of byRule.values()) {
    versions.sort((a, b) => a.from - b.from || String(a.version).localeCompare(String(b.version)));
    for (let i = 0; i < versions.length; i++) {
      const next = versions[i + 1];
      if (next) versions[i].to = Math.min(versions[i].to, next.from);
      all.push(versions[i]);
    }
  }
  all.sort((a, b) => a.from - b.from);
  return all;
}

export function buildRuleIndex(events) {
  const is = (k) => events.filter((e) => e.kind === k);

  const relAll = versionsOf(is("RELATIONSHIP_RULE"));
  const devAll = versionsOf(is("DEVICE_BINDING"));
  const packAll = versionsOf(is("CONTENT_PACK_RULE"));

  // PROFILE_WITHDRAWN：该主体撤销资料后，其作为主人的全部关系版本在撤销刻收口
  for (const w of is("PROFILE_WITHDRAWN")) {
    const at = toMs(w.occurred_at);
    for (const v of relAll) {
      if (v.event_id && events.find((e) => e.event_id === v.event_id)?.subject_id === w.subject_id) {
        v.to = Math.min(v.to, at);
      }
    }
  }

  const relByAccount = new Map(); // owner(subject_id) -> versions
  for (const v of relAll) {
    const owner = events.find((e) => e.event_id === v.event_id).subject_id;
    v.owner = owner;
    if (!relByAccount.has(owner)) relByAccount.set(owner, []);
    relByAccount.get(owner).push(v);
  }

  const byDevice = new Map();
  for (const v of devAll) {
    v.device_sn = v.raw.device_sn;
    v.sharing = v.raw.sharing;
    v.owner = events.find((e) => e.event_id === v.event_id).subject_id;
    if (!byDevice.has(v.device_sn)) byDevice.set(v.device_sn, []);
    byDevice.get(v.device_sn).push(v);
  }

  const byPack = new Map();
  for (const v of packAll) {
    v.pack_id = v.raw.pack_id;
    if (!byPack.has(v.pack_id)) byPack.set(v.pack_id, []);
    byPack.get(v.pack_id).push(v);
  }

  function pick(list, at) {
    return list.find((v) => at >= v.from && at < v.to) ?? null;
  }

  function deviceAt(deviceSn, at) {
    return pick(byDevice.get(deviceSn) ?? [], at);
  }

  function packAt(packId, at) {
    if (!packId) return { billable: true, rate: 1, category: "STANDARD", version: "default" };
    const v = pick(byPack.get(packId) ?? [], at);
    if (!v) return null;
    return {
      pack_id: packId,
      billable: v.raw.billable,
      rate: v.raw.rate,
      category: v.raw.category,
      version: v.version,
    };
  }

  // 归属解析：at 为参考时刻，segment 为播放片段事件（取 payload.viewer_id / payload.pack_id）。
  function resolve(segment, at) {
    const p = segment.payload;
    const device = deviceAt(p.device_sn, at);
    if (!device) {
      return { status: "UNBOUND_DEVICE", bill_account: null, viewer_id: p.viewer_id ?? null, pack: null, rule_event_ids: [] };
    }
    const owner = device.owner;
    const pack = packAt(p.pack_id, at);
    if (pack === null) {
      return { status: "UNKNOWN_PACK", bill_account: null, viewer_id: p.viewer_id ?? null, pack: null, rule_event_ids: [device.event_id] };
    }

    const viewer = p.viewer_id ?? null;
    let rel = null;
    if (viewer && viewer !== owner) {
      rel = (relByAccount.get(owner) ?? []).find(
        (v) => v.raw.member_id === viewer && at >= v.from && at < v.to,
      ) ?? null;
    }

    // 主人本人设备/会话
    if (!viewer || viewer === owner) {
      return {
        status: "BILLED",
        bill_account: owner,
        viewer_id: owner,
        reason: "OWNER_SESSION",
        pack,
        sharing: device.sharing,
        rule_event_ids: [device.event_id],
      };
    }

    // 他人使用：必须有当时有效的家庭/访客关系
    if (!rel) {
      // 共享已撤销：关系版本在撤销刻收口，此处解析不到
      const hadBefore = (relByAccount.get(owner) ?? []).some((v) => v.raw.member_id === viewer && v.from <= at);
      return {
        status: hadBefore ? "REVOKED" : "NO_RELATIONSHIP",
        bill_account: null,
        viewer_id: viewer,
        reason: hadBefore ? "FAMILY_SHARING_REVOKED" : "NO_ACTIVE_RELATIONSHIP",
        pack,
        sharing: device.sharing,
        rule_event_ids: [device.event_id],
      };
    }

    const attribution = rel.raw.attribution;
    if (attribution === "NONE") {
      return {
        status: "REVOKED",
        bill_account: null,
        viewer_id: viewer,
        reason: "FAMILY_SHARING_REVOKED",
        pack,
        sharing: device.sharing,
        rule_event_ids: [device.event_id, rel.event_id],
      };
    }
    if (attribution === "TO_OWNER") {
      return {
        status: "BILLED",
        bill_account: owner,
        viewer_id: viewer,
        reason: `RELATION_${rel.raw.relationship}_TO_OWNER@v${rel.version}`,
        pack,
        sharing: device.sharing,
        rule_event_ids: [device.event_id, rel.event_id],
      };
    }
    // TO_MEMBER / TO_GUEST_QUOTA：计入实际观看人
    return {
      status: "BILLED",
      bill_account: viewer,
      viewer_id: viewer,
      reason: `RELATION_${rel.raw.relationship}_${attribution}@v${rel.version}`,
      pack,
      sharing: device.sharing,
      rule_event_ids: [device.event_id, rel.event_id],
    };
  }

  // 所有规则边界（参考时刻），账本据此在归属可能变化的点切开片段
  const boundaries = new Set();
  for (const v of [...relAll, ...devAll, ...packAll]) {
    if (v.from !== -8.64e15) boundaries.add(v.from);
    if (v.to !== OPEN_END) boundaries.add(v.to);
  }

  return { resolve, deviceAt, packAt, boundaries: [...boundaries].sort((a, b) => a - b), _relAll: relAll };
}
