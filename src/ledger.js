// 可携带时长账本核心引擎（纯函数、可整库重放）。
//
// 处理管线：
//   事件(去重) -> 设备对表 -> 参考时区间
//   -> 按【时区切换点 + 规则版本边界】切片（每片归属规则恒定）
//   -> 归属解析(观看人/扣减账号/内容包) -> 按当地日期归周期
//   -> 位置区间去重(首写者胜出) -> 计量原子(atom)
//   -> 开放周期实时汇总；封账周期冻结快照，晚到事实按“原子身份集合差集”追加调整
//
// 关键不变量：
//   1. 同一片段重复上报：时间×位置盒完全重叠，增量为 0，并记录去重原因。
//   2. 电视暂停->手机续播：位置交叠部分只扣一次；真正重看（不同时间）照常计费。
//   3. 首写者胜出的覆盖顺序按 (received_at, event_id) 确定；后到事件不会改变
//      先到原子的增量，因此封账快照 + 调整分录 = 全量重放结果，恒等。
//   4. 封账只冻结数字快照与原子清单；晚到数据修正开放周期，对封账周期只追加
//      LEDGER_ADJUSTMENT（LATE_REPORT / CORRECTION），原账单永不重写。
//   5. 申诉成立：开放周期直接冲销重算；封账周期生成负向调整分录。冲销不释放
//      去重覆盖，杜绝“先申诉退一遍、重复上报再扣/再退”。
//   6. 归属、倍率、时区均取片段当时有效的版本；撤销共享后新原子立即停算，
//      撤销前的财务证据保留，仅可凭最小范围 EVIDENCE_GRANT 查验。

import { validateEvent } from "./events.js";
import { buildClock, splitInterval, sliceByTimezoneAndPeriod, toMs } from "./time.js";
import { buildRuleIndex } from "./rules.js";

const MS_SEC = 1000;

export function fnv1a(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function receivedAt(e) {
  return e.received_at ? toMs(e.received_at) : toMs(e.occurred_at);
}

function canonicalSort(events) {
  return [...events].sort((a, b) => receivedAt(a) - receivedAt(b) || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
}

// 一维位置轴覆盖：同一条续播链路内，候选原子与任一先到原子在“时间轴交叠”
// （并发/重复上报）或“内容位置轴交叠”（断点续播、回跳）都视为已扣减。
// 两类交叠统一投影到候选的位置轴上取并集，返回被覆盖的毫秒数。
function coveredMs(candidate, priors) {
  const posSpan = candidate.pos_end - candidate.pos_start;
  if (posSpan <= 0) return 0;
  const marks = []; // 位置轴上的已看区间（候选坐标）

  // 时间轴先按既有原子切点分片；时间交叠片映射到候选位置子区间。
  const cuts = new Set();
  for (const q of priors) {
    cuts.add(q.ref_start);
    cuts.add(q.ref_end);
  }
  const pieces = splitInterval(candidate.ref_start, candidate.ref_end, [...cuts]);
  const hitSrc = new Set();
  const span = candidate.ref_end - candidate.ref_start;
  const toPos = (t) => candidate.pos_start + ((t - candidate.ref_start) / span) * posSpan;

  for (const [a, b] of pieces) {
    const qs = priors.filter((q) => a < q.ref_end && b > q.ref_start);
    if (qs.length) {
      marks.push([toPos(a), toPos(b)]);
      qs.forEach((q) => hitSrc.add(q.source_event_id));
    }
  }
  // 位置轴直接交叠（不同时刻的断点续播/回跳）。
  for (const q of priors) {
    const lo = Math.max(candidate.pos_start, q.pos_start);
    const hi = Math.min(candidate.pos_end, q.pos_end);
    if (hi > lo) {
      marks.push([lo, hi]);
      hitSrc.add(q.source_event_id);
    }
  }
  if (!marks.length) return { ms: 0, by: [] };

  marks.sort((x, y) => x[0] - y[0]);
  let union = 0;
  let [lo, hi] = marks[0];
  for (const [l, h] of marks.slice(1)) {
    if (l > hi) {
      union += hi - lo;
      [lo, hi] = [l, h];
    } else {
      hi = Math.max(hi, h);
    }
  }
  union += hi - lo;
  const frac = Math.min(1, union / posSpan);
  return { ms: Math.round(frac * candidate.gross_ms), by: [...hitSrc] };
}

// 在给定事件子集上物化出全部计量原子（纯函数）。
export function materialize(events, { periodType = "DAY" } = {}) {
  const problems = [];
  const ordered = canonicalSort(events);
  const seen = new Set();
  const accepted = [];
  for (const e of ordered) {
    if (seen.has(e.event_id)) continue; // 重放/重复投递：幂等丢弃
    seen.add(e.event_id);
    const p = validateEvent(e);
    if (p.length) {
      problems.push({ event_id: e.event_id, problems: p });
      continue;
    }
    accepted.push(e);
  }

  const byDeviceSync = new Map();
  for (const e of accepted.filter((x) => x.kind === "SESSION_SYNC")) {
    if (!byDeviceSync.has(e.payload.device_sn)) byDeviceSync.set(e.payload.device_sn, []);
    byDeviceSync.get(e.payload.device_sn).push(e);
  }
  const clocks = new Map();
  for (const [sn, list] of byDeviceSync) clocks.set(sn, buildClock(list.map((e) => e.payload)));
  const clockOf = (sn) => clocks.get(sn) ?? buildClock([]);

  const rules = buildRuleIndex(accepted);

  const downloads = new Map(); // download_id -> 授权窗
  for (const e of accepted.filter((x) => x.kind === "OFFLINE_DOWNLOAD")) {
    downloads.set(e.payload.download_id, {
      from: toMs(e.payload.licensed_from),
      to: toMs(e.payload.licensed_to),
      event_id: e.event_id,
    });
  }

  const segments = canonicalSort(accepted.filter((e) => e.kind === "PLAYBACK_SEGMENT"));
  const atoms = [];

  for (const seg of segments) {
    const p = seg.payload;
    const clock = clockOf(p.device_sn);
    const syncIds = (byDeviceSync.get(p.device_sn) ?? []).map((e) => e.event_id);
    const r0 = clock.toReference(p.seg_start);
    const r1 = clock.toReference(p.seg_end);
    if (!(r1 > r0)) {
      problems.push({ event_id: seg.event_id, problems: ["seg_end<=seg_start"] });
      continue;
    }

    // 切片：时区切换点 ∪ 规则版本边界 ∪ 离线授权窗边界（归属/授权在每片内恒定）
    const cuts = new Set(clock.changePoints());
    for (const b of rules.boundaries) if (b > r0 && b < r1) cuts.add(b);
    let license = null;
    if (p.offline) {
      license = downloads.get(p.download_id) ?? null;
      if (license) {
        if (license.from > r0 && license.from < r1) cuts.add(license.from);
        if (license.to > r0 && license.to < r1) cuts.add(license.to);
      }
    }
    const slices = splitInterval(r0, r1, [...cuts]);
    const segSpan = r1 - r0;
    const posOf = (t) => {
      const f = (t - r0) / segSpan;
      return Math.round(p.pos_start_ms + (p.pos_end_ms - p.pos_start_ms) * f);
    };

    let sliceIdx = 0;
    for (const [a, b] of slices) {
      const tz = clock.timezoneAt(a);
      const device = rules.deviceAt(p.device_sn, Math.floor((a + b) / 2));
      const periodPieces = sliceByTimezoneAndPeriod(clock, a, b, periodType);
      const baseCtx = {
        seg, p, clock, syncIds, receivedAt: receivedAt(seg), periodType, tz,
        owner: device?.owner ?? null, sliceIdx, posOf,
      };

      // PAUSED 片段仅留证，不计量、不占覆盖（但按当地周期切片，客服可见暂停间隙）
      if (p.state === "PAUSED") {
        emitEvidence("PAUSED", "PAUSED", [], baseCtx, periodPieces, { license: null });
        sliceIdx += 1;
        continue;
      }

      // 离线授权：窗内可计，窗外只留证（允许授权窗覆盖片段的一部分）
      if (p.offline && (!license || a < license.from || b > license.to)) {
        emitEvidence("OFFLINE_UNLICENSED", "OFFLINE_OUTSIDE_LICENSE_WINDOW", device ? [device.event_id] : [], baseCtx, periodPieces, { license });
        sliceIdx += 1;
        continue;
      }

      const resolution = rules.resolve(seg, Math.floor((a + b) / 2));
      if (resolution.status !== "BILLED") {
        emitEvidence(resolution.status, resolution.reason ?? resolution.status, resolution.rule_event_ids, baseCtx, periodPieces, {
          license, pack: resolution.pack, viewer_id: resolution.viewer_id ?? p.viewer_id ?? null,
        });
        sliceIdx += 1;
        continue;
      }

      let pieceIdx = 0;
      for (const pc of periodPieces) {
        const pos0 = posOf(pc.start);
        const pos1 = posOf(pc.end);
        const pack = resolution.pack;
        atoms.push({
          atom_id: `atom:${fnv1a([seg.event_id, sliceIdx, pieceIdx, p.viewer_id ?? ""].join("|"))}`,
          source_event_id: seg.event_id,
          device_sn: p.device_sn,
          session_id: p.session_id,
          resume_chain: p.resume_chain ?? null,
          viewer_id: resolution.viewer_id,
          bill_account: resolution.bill_account,
          content_id: p.content_id,
          ref_start: pc.start,
          ref_end: pc.end,
          pos_start: pos0,
          pos_end: pos1,
          gross_ms: pc.durationMs,
          rate: pack.rate,
          pack_id: pack.pack_id ?? null,
          pack_version: pack.version,
          attribution_reason: resolution.reason,
          status: pack.billable ? "BILLED" : "ZERO_RATED",
          period_type: periodType,
          period_key: pc.periodKey,
          tz: pc.tz,
          offline: !!p.offline,
          download_id: p.download_id ?? null,
          license_event_id: license?.event_id ?? null,
          received_at: receivedAt(seg),
          sync_event_ids: syncIds,
          rule_event_ids: resolution.rule_event_ids,
          slice_idx: sliceIdx,
          piece_idx: pieceIdx,
          covered_ms: 0,
          covered_by: [],
          charge_ms: 0,
          increment_ms: 0,
          voided_by: null,
        });
        pieceIdx += 1;
      }
      sliceIdx += 1;
    }
  }

  function emitEvidence(status, reason, ruleIds, ctx, periodPieces, extra) {
    const { seg, p, syncIds, receivedAt: recvAt, periodType, owner, sliceIdx, posOf } = ctx;
    let pieceIdx = 0;
    for (const pc of periodPieces) {
      atoms.push({
        atom_id: `atom:${fnv1a([seg.event_id, "ev", status, sliceIdx, pieceIdx].join("|"))}`,
        source_event_id: seg.event_id,
        device_sn: p.device_sn,
        session_id: p.session_id,
        resume_chain: p.resume_chain ?? null,
        viewer_id: extra.viewer_id ?? p.viewer_id ?? owner ?? null,
        bill_account: status === "PAUSED" ? owner : null,
        content_id: p.content_id,
        ref_start: pc.start,
        ref_end: pc.end,
        pos_start: posOf(pc.start),
        pos_end: posOf(pc.end),
        gross_ms: pc.durationMs,
        charge_ms: 0,
        increment_ms: 0,
        status,
        status_reason: reason,
        period_type: periodType,
        period_key: pc.periodKey,
        tz: pc.tz,
        offline: !!p.offline,
        download_id: p.download_id ?? null,
        license_event_id: extra.license?.event_id ?? null,
        pack: extra.pack ?? null,
        received_at: recvAt,
        sync_event_ids: syncIds,
        rule_event_ids: ruleIds,
        slice_idx: sliceIdx,
        piece_idx: pieceIdx,
        covered_by: [],
        voided_by: null,
      });
      pieceIdx += 1;
    }
  }

  // 去重计量：同一 (观看人, 内容, 续播链路) 上首写者胜出；
  // 被申诉冲销的原子仍占据覆盖（防止裁定后换事件重报再生费），零率/暂停/证据原子不占覆盖。
  const coverGroups = new Map();
  const order = canonicalSort(segments).map((e) => e.event_id);
  const coverCandidates = atoms
    .filter((a) => a.status === "BILLED")
    .sort((a, b) => order.indexOf(a.source_event_id) - order.indexOf(b.source_event_id) || a.slice_idx - b.slice_idx || a.piece_idx - b.piece_idx);

  for (const a of coverCandidates) {
    const chain = a.resume_chain ?? `segonly:${a.source_event_id}`;
    const key = `${a.viewer_id}|${a.content_id}|${chain}`;
    const priors = coverGroups.get(key) ?? [];
    const { ms: covered, by } = coveredMs(a, priors);
    a.covered_ms = covered;
    a.covered_by = [...new Set(by)];
    a.charge_ms = Math.round(((a.gross_ms - covered) * a.rate) / MS_SEC) * MS_SEC;
    a.increment_ms = a.charge_ms;
    // voided_by 由后续裁定阶段填写；无论是否被冲销，该原子都留在 priors 中占位。
    priors.push(a);
    coverGroups.set(key, priors);
  }
  for (const a of atoms) {
    if (a.status === "ZERO_RATED") a.increment_ms = 0;
  }

  // 申诉裁定（按收到顺序）：成立则冲销对应原子，冲销不释放覆盖。
  const rulings = canonicalSort(accepted.filter((e) => e.kind === "DISPUTE_RULING"));
  for (const r of rulings) {
    if (r.payload.decision !== "SUSTAINED") continue;
    const targets = atoms.filter(
      (a) => a.source_event_id === r.payload.segment_ref && (a.status === "BILLED" || a.status === "ZERO_RATED") && !a.voided_by,
    );
    for (const t of targets) {
      t.voided_by = r.event_id;
      atoms.push({
        atom_id: `atom:${fnv1a([r.event_id, t.atom_id].join("|"))}`,
        source_event_id: r.event_id,
        ruling_case_id: r.payload.case_id,
        reverses_atom: t.atom_id,
        device_sn: t.device_sn,
        session_id: t.session_id,
        viewer_id: t.viewer_id,
        bill_account: t.bill_account,
        content_id: t.content_id,
        ref_start: t.ref_start,
        ref_end: t.ref_end,
        pos_start: t.pos_start,
        pos_end: t.pos_end,
        gross_ms: 0,
        rate: t.rate,
        status: "DISPUTE_REVERSAL",
        period_type: periodType,
        period_key: t.period_key,
        tz: t.tz,
        received_at: receivedAt(r),
        charge_ms: -t.increment_ms,
        increment_ms: -t.increment_ms,
        covered_ms: 0,
        covered_by: [],
        rule_event_ids: t.rule_event_ids,
        sync_event_ids: t.sync_event_ids,
        voided_by: null,
      });
      // 原原子保留 +C，由冲销原子 -C 对冲（净额 0）；其覆盖不释放，防止申诉后重复上报再生费。
    }
  }

  atoms.sort((a, b) => a.ref_start - b.ref_start || a.atom_id.localeCompare(b.atom_id));

  const totals = new Map();
  const addTotal = (a) => {
    if (!a.bill_account || !a.period_key) return;
    const k = `${a.bill_account}|${a.period_type}|${a.period_key}`;
    totals.set(k, (totals.get(k) ?? 0) + a.increment_ms);
  };
  for (const a of atoms) addTotal(a);

  return { atoms, totals, problems, accepted_event_ids: accepted.map((e) => e.event_id) };
}

// —— 账本门面：封账快照、调整分录、账单行追溯、证据授权 ——

export class TimeLedger {
  constructor(events, opts = {}) {
    this.periodType = opts.periodType ?? "DAY";
    this.raw = canonicalSort(events);
    this.full = materialize(events, { periodType: this.periodType });

    // 封账登记：每次封账用“当时已收到”的事件子集物化并冻结数字。
    this.closures = new Map(); // key -> {closed_at, received_cutoff, snapshot_total, snapshot_atoms:Map(atom_id->charge)}
    for (const c of this.raw.filter((e) => e.kind === "PERIOD_CLOSED")) {
      const key = `${c.subject_id}|${c.payload.period_type}|${c.payload.period_key}`;
      if (this.closures.has(key)) continue; // 重复封账事件幂等忽略
      const cutoff = receivedAt(c);
      const subset = this.raw.filter((e) => receivedAt(e) <= cutoff);
      const snap = materialize(subset, { periodType: c.payload.period_type });
      const snapshotAtoms = new Map();
      for (const a of snap.atoms) {
        if (a.bill_account === c.subject_id && a.period_key === c.payload.period_key && a.increment_ms !== 0) {
          snapshotAtoms.set(a.atom_id, a.increment_ms);
        }
      }
      this.closures.set(key, {
        event_id: c.event_id,
        closed_at: c.payload.closed_at,
        received_cutoff: cutoff,
        snapshot_total: [...snapshotAtoms.values()].reduce((s, v) => s + v, 0),
        snapshot_atoms: snapshotAtoms,
      });
    }

    // 人工调整事件：只对已封账周期有效，逐笔追加、永不改写快照。
    this.manualAdjustments = new Map();
    const seenManual = new Set();
    for (const m of this.raw.filter((e) => e.kind === "LEDGER_ADJUSTMENT")) {
      if (seenManual.has(m.event_id)) continue; // 重放幂等
      seenManual.add(m.event_id);
      const key = `${m.subject_id}|${m.payload.period_type}|${m.payload.period_key}`;
      if (!this.manualAdjustments.has(key)) this.manualAdjustments.set(key, []);
      this.manualAdjustments.get(key).push({
        adjustment_id: `adj:${fnv1a([m.event_id, "manual"].join("|"))}`,
        reason: m.payload.reason,
        delta_ms: m.payload.delta_ms,
        atom_id: null,
        account: m.subject_id,
        period_key: m.payload.period_key,
        source_event_id: m.event_id,
      });
    }
  }

  static replay(events, opts) {
    return new TimeLedger(events, opts);
  }

  // 封账周期的调整分录：快照原子身份集合与全量结果之间的确定性差集。
  adjustments(account, periodKey) {
    const key = `${account}|${this.periodType}|${periodKey}`;
    const closure = this.closures.get(key);
    if (!closure) return null;

    const live = new Map();
    for (const a of this.full.atoms) {
      if (a.bill_account === account && a.period_key === periodKey && a.increment_ms !== 0) {
        live.set(a.atom_id, a.increment_ms);
      }
    }

    const entries = [];
    for (const [id, charge] of closure.snapshot_atoms) {
      if (!live.has(id)) {
        entries.push(adj(id, "CORRECTION", -charge, account, periodKey, closure));
      } else if (live.get(id) !== charge) {
        entries.push(adj(id, "CORRECTION", live.get(id) - charge, account, periodKey, closure));
      }
    }
    for (const [id, charge] of live) {
      if (!closure.snapshot_atoms.has(id)) {
        const a = this.full.atoms.find((x) => x.atom_id === id);
        const src = a?.source_event_id && this.raw.find((e) => e.event_id === a.source_event_id);
        let reason = "CORRECTION";
        if (src && src.kind === "DISPUTE_RULING") reason = "DISPUTE_REFUND";
        else if (src && receivedAt(src) > closure.received_cutoff) reason = "LATE_REPORT";
        entries.push(adj(id, reason, charge, account, periodKey, closure));
      }
    }
    entries.sort((a, b) => a.adjustment_id.localeCompare(b.adjustment_id));
    for (const m of this.manualAdjustments.get(key) ?? []) entries.push(m);
    return {
      period_type: this.periodType,
      period_key: periodKey,
      account,
      closed_at: closure.closed_at,
      snapshot_total_ms: closure.snapshot_total,
      adjustments: entries,
      adjusted_total_ms: closure.snapshot_total + entries.reduce((s, e) => s + e.delta_ms, 0),
    };
  }

  // 客服视角：账单行 -> 原始片段、去重原因、调整版本全链路。
  explainLine(account, periodKey) {
    const key = `${account}|${this.periodType}|${periodKey}`;
    const closure = this.closures.get(key);
    const lineAtoms = this.full.atoms.filter(
      (a) => (a.bill_account === account || a.viewer_id === account) && a.period_key === periodKey,
    );
    const openTotal = this.full.totals.get(key) ?? 0;
    const adj = this.adjustments(account, periodKey);
    return {
      account,
      period_type: this.periodType,
      period_key: periodKey,
      state: closure ? "CLOSED" : "OPEN",
      current_total_ms: closure ? adj.adjusted_total_ms : openTotal,
      frozen_bill: closure
        ? { closed_event_id: closure.event_id, closed_at: closure.closed_at, total_ms: closure.snapshot_total }
        : null,
      adjustment_versions: closure ? adj.adjustments : [],
      atoms: lineAtoms.map((a) => this.#describeAtom(a)),
    };
  }

  #describeAtom(a) {
    const segment = this.raw.find((e) => e.event_id === a.source_event_id);
    return {
      atom_id: a.atom_id,
      status: a.status,
      viewer_id: a.viewer_id,
      bill_account: a.bill_account,
      content_id: a.content_id,
      device_sn: a.device_sn,
      session_id: a.session_id,
      resume_chain: a.resume_chain,
      local_period: a.period_key ? `${a.period_type}:${a.period_key}@${a.tz}` : null,
      ref_window: [new Date(a.ref_start).toISOString(), new Date(a.ref_end).toISOString()],
      pos_window_ms: [a.pos_start, a.pos_end],
      gross_ms: a.gross_ms,
      covered_ms: a.covered_ms ?? 0,
      covered_by: a.covered_by ?? [],
      dedup_reason:
        (a.covered_ms ?? 0) > 0
          ? `与先到片段 ${a.covered_by.join(", ")} 在时间×位置上交叠，首写者胜出`
          : a.status === "BILLED" || a.status === "DISPUTE_REVERSAL"
            ? null
            : a.status_reason ?? a.status,
      charge_ms: a.charge_ms,
      increment_ms: a.increment_ms,
      pack: a.pack_id ? { pack_id: a.pack_id, version: a.pack_version, rate: a.rate } : null,
      attribution_reason: a.attribution_reason ?? null,
      offline: a.offline || false,
      voided_by: a.voided_by,
      ruling_case_id: a.ruling_case_id ?? null,
      evidence: {
        source_event_id: a.source_event_id,
        raw_segment: segment ?? null,
        sync_event_ids: a.sync_event_ids ?? [],
        rule_event_ids: a.rule_event_ids ?? [],
      },
    };
  }

  // 最小范围查验：账号本人随时可查；他人须持有覆盖该账单行且未过期的授权。
  assertEvidenceAccess(actor, account, periodKey, atIso) {
    if (actor === account) return { granted: true, scope: "SELF" };
    const at = toMs(atIso);
    for (const g of this.raw.filter((e) => e.kind === "EVIDENCE_GRANT")) {
      const s = g.payload;
      if (s.granted_to !== actor) continue;
      if (toMs(s.valid_until) < at) continue;
      const scope = s.scope ?? {};
      const matchPeriod =
        scope.kind === "PERIOD" &&
        scope.account === account &&
        scope.period_type === this.periodType &&
        scope.period_key === periodKey;
      if (matchPeriod) {
        return { granted: true, scope: "GRANT", grant_id: s.grant_id, valid_until: s.valid_until };
      }
    }
    const err = new Error("EVIDENCE_DENIED");
    err.code = "EVIDENCE_DENIED";
    throw err;
  }

  openPeriods() {
    const out = [];
    for (const [k, total] of this.full.totals) {
      if (!this.closures.has(k)) {
        const [account, , ...rest] = k.split("|");
        out.push({ account, period_type: this.periodType, period_key: rest.join("|"), total_ms: total });
      }
    }
    return out.sort((a, b) => a.period_key.localeCompare(b.period_key));
  }

  problems() {
    return this.full.problems;
  }
}

function adj(atomId, reason, delta, account, periodKey, closure) {
  return {
    adjustment_id: `adj:${fnv1a([closure.event_id, atomId, reason].join("|"))}`,
    reason, // LATE_REPORT：封账后晚到事实；CORRECTION：晚到同步点/规则改变了原子
    delta_ms: delta,
    atom_id: atomId,
    account,
    period_key: periodKey,
    // 原账单不动；调整只引用原子与来源事件，客服可逐级展开
    supersedes_bill_event_id: closure.event_id,
  };
}
