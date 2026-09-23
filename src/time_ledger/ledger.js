// 可携带时长账本。
//
// 设计要点：
// - 用量是状态的纯函数：归属规则、设备同步点、内容包规则都按"当时有效"解析，
//   因此时钟漂移、跨时区旅行、周期中途的成员关系变化都沿用当时规则；
// - 同一账户下同一内容按内容位置区间取并集，任何一段内容只扣减一次，
//   每个被去重的区间都记录原因（OVERLAP / ALREADY_COUNTED）与来源片段；
// - 账期按片段当地日期归月。未封账的周期晚到数据就地修正；已封账/开票/退款的
//   周期只追加调整（adjustment），原账单行冻结，永不重写；
// - 所有入口按事件 ID / 片段键 / 单据 ID 幂等，同一批上报重放多次结果不变；
// - 账本状态为纯 JSON，可整体导出、迁移、重放（可携带）。

import { validateEvent } from "../culture_time_budget.js";
import { validateReportPayload } from "./events.js";
import { mergeIntervals, subtractInterval } from "./intervals.js";
import { localDate, periodOf, nextLocalMidnightMs } from "./clock.js";

const OPEN = "OPEN";
const CLOSED = "CLOSED";
const INVOICED = "INVOICED";
const REFUNDED = "REFUNDED";

export const PERIOD_STATUS = Object.freeze({ OPEN, CLOSED, INVOICED, REFUNDED });

const round3 = (x) => Math.round(x * 1000) / 1000;

export class TimeLedger {
  constructor(state = null) {
    this.state = state ?? {
      seen_events: {}, // event_id → true，幂等重放的第一道闸
      devices: {}, // device_id → { syncs: [{device_ms, server_ms}], bindings: [...] }
      membership: [], // 家庭共享归属规则：{subject_id, account_id, from_ms, to_ms}
      package_rules: [], // 内容包规则：{package_id, content_ids, rounding_seconds, daily_cap_seconds, from_ms, to_ms}
      downloads: {}, // download_id → 离线下载授权
      fragments: {}, // fragment_key → 会话片段
      pauses: [], // 暂停证据
      appeals: {}, // appeal_id → 申诉与裁定
      periods: {}, // account → period → 周期记录
      seq: 0, // 全局摄入序号，保证排序确定
    };
  }

  static fromJSON(json) {
    const data = typeof json === "string" ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
    return new TimeLedger(data);
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.state));
  }

  // ---------- 配置：内容包规则（按生效时间版本化） ----------

  setPackageRule(rule) {
    this.state.package_rules.push({
      package_id: rule.package_id,
      content_ids: [...rule.content_ids],
      rounding_seconds: rule.rounding_seconds ?? 0,
      daily_cap_seconds: rule.daily_cap_seconds ?? null,
      from_ms: Date.parse(rule.effective_from),
      to_ms: rule.effective_to ? Date.parse(rule.effective_to) : null,
    });
    this._retouchAll(`package:${rule.package_id}:${this.state.package_rules.length}`);
    return this;
  }

  // ---------- 事件入口 ----------

  ingest(event) {
    const problems = validateEvent(event);
    if (problems.length > 0) return { status: "rejected", problems };
    if (this.state.seen_events[event.event_id]) {
      return { status: "duplicate", event_id: event.event_id };
    }
    switch (event.kind) {
      case "SYNC_POINT":
        return this._withPayload(event, (p) => this._onSyncPoint(event, p));
      case "PLAYBACK_FRAGMENT":
        return this._onFragment(event);
      case "PLAYBACK_PAUSED":
        return this._withPayload(event, (p) => {
          this.state.pauses.push({ event_id: event.event_id, subject_id: event.subject_id, ...p });
          return { status: "applied" };
        });
      case "OFFLINE_DOWNLOAD":
        return this._withPayload(event, (p) => this._onDownload(event, p));
      case "MEMBERSHIP_GRANTED":
        return this._withPayload(event, (p) => {
          this.state.membership.push({
            rule_id: event.event_id,
            subject_id: p.member_subject_id,
            account_id: p.account_id,
            from_ms: Date.parse(p.effective_from),
            to_ms: null,
          });
          this._retouchFragments((f) => f.subject_id === p.member_subject_id, event.event_id);
          return { status: "applied" };
        });
      case "MEMBERSHIP_REVOKED":
        return this._withPayload(event, (p) => {
          // 撤销立即生效：归属窗口在 effective_at 关闭，之后的片段不再汇总到共享账户
          let rules_closed = 0;
          for (const r of this.state.membership) {
            if (r.subject_id === p.member_subject_id && r.account_id === p.account_id && r.to_ms === null) {
              r.to_ms = Date.parse(p.effective_at);
              rules_closed += 1;
            }
          }
          this._retouchFragments((f) => f.subject_id === p.member_subject_id, event.event_id);
          return { status: "applied", rules_closed };
        });
      case "DEVICE_BOUND":
        return this._withPayload(event, (p) => {
          this._device(p.device_id).bindings.push({
            account_id: p.account_id,
            from_ms: Date.parse(p.effective_from),
            to_ms: p.effective_to ? Date.parse(p.effective_to) : null,
          });
          this._retouchFragments((f) => f.device_id === p.device_id, event.event_id);
          return { status: "applied" };
        });
      default:
        // 旧领域事件（BUDGET_SET 等）只登记，不参与时长计算
        this.state.seen_events[event.event_id] = true;
        return { status: "recorded" };
    }
  }

  ingestAll(events) {
    return events.map((e) => this.ingest(e));
  }

  _withPayload(event, handler) {
    const missing = validateReportPayload(event.kind, event.payload);
    if (missing.length > 0) return { status: "rejected", problems: missing };
    this.state.seen_events[event.event_id] = true;
    return handler(event.payload);
  }

  _onSyncPoint(event, p) {
    const dev = this._device(p.device_id);
    dev.syncs.push({ device_ms: Date.parse(p.device_clock), server_ms: Date.parse(p.server_clock) });
    dev.syncs.sort((a, b) => a.device_ms - b.device_ms);
    // 晚到的同步点可能改变该设备已报片段的校正时间，重触相关周期
    this._retouchFragments((f) => f.device_id === p.device_id, event.event_id);
    return { status: "applied" };
  }

  _onFragment(event) {
    const missing = validateReportPayload("PLAYBACK_FRAGMENT", event.payload);
    if (missing.length > 0) return { status: "rejected", problems: missing };
    const p = event.payload;
    const key = `${p.device_id}/${p.session_id}/${p.fragment_seq}`;
    if (this.state.fragments[key]) return { status: "duplicate", fragment_key: key };
    const started = Date.parse(p.started_at);
    const ended = Date.parse(p.ended_at);
    if (!(ended > started) || !(p.content_end > p.content_start)) {
      return { status: "rejected", problems: ["time_range"] };
    }
    this.state.seen_events[event.event_id] = true;
    const fragment = {
      key,
      event_id: event.event_id,
      subject_id: event.subject_id,
      device_id: p.device_id,
      session_id: p.session_id,
      seq: p.fragment_seq,
      content_id: p.content_id,
      content_start: p.content_start,
      content_end: p.content_end,
      started_device_ms: started,
      ended_device_ms: ended,
      timezone: p.timezone,
      offline: Boolean(p.offline),
      download_id: p.download_id ?? null,
      status: "active", // active | quarantined | void
      quarantine_reason: null,
      forced_account: null, // 申诉裁定 REASSIGN 后的强制归属
      ingest_seq: ++this.state.seq,
      occurred_at: event.occurred_at,
    };
    if (fragment.offline) {
      const reason = this._downloadViolation(fragment);
      if (reason) {
        fragment.status = "quarantined";
        fragment.quarantine_reason = reason;
      }
    }
    this.state.fragments[key] = fragment;
    if (fragment.status === "active") {
      this._touchScopes(this._scopesOfFragment(fragment), event.event_id);
    }
    return {
      status: fragment.status === "active" ? "applied" : "quarantined",
      fragment_key: key,
      reason: fragment.quarantine_reason ?? undefined,
    };
  }

  _onDownload(event, p) {
    this.state.downloads[p.download_id] = { event_id: event.event_id, ...p };
    // 下载授权晚到时，放行此前因 UNKNOWN_DOWNLOAD 被隔离的片段
    for (const f of Object.values(this.state.fragments)) {
      if (f.status === "quarantined" && f.quarantine_reason === "UNKNOWN_DOWNLOAD" && f.download_id === p.download_id) {
        if (!this._downloadViolation(f)) {
          f.status = "active";
          f.quarantine_reason = null;
          this._touchScopes(this._scopesOfFragment(f), event.event_id);
        }
      }
    }
    return { status: "applied" };
  }

  _downloadViolation(f) {
    const d = this.state.downloads[f.download_id];
    if (!d || d.content_id !== f.content_id || d.device_id !== f.device_id) return "UNKNOWN_DOWNLOAD";
    if (d.expires_at && f.started_device_ms > Date.parse(d.expires_at)) return "DOWNLOAD_EXPIRED";
    return null;
  }

  // ---------- 周期生命周期 ----------

  closePeriod(account, period) {
    const rec = this._periodRec(account, period);
    if (rec.status !== OPEN) return { status: rec.status, version: rec.version, already: true };
    const view = this._computeAll();
    rec.snapshot = { lines: view.lines[account]?.[period] ?? [], taken_at_version: rec.version };
    rec.status = CLOSED;
    rec.version += 1;
    rec.history.push({ version: rec.version, cause: "close", kind: "CLOSE" });
    this._refreshContributors(account, period, rec, view);
    return { status: rec.status, version: rec.version, lines: rec.snapshot.lines };
  }

  recordInvoice(account, period, invoice_id) {
    const rec = this._periodRec(account, period);
    if (rec.invoices.some((i) => i.invoice_id === invoice_id)) return { status: "duplicate", invoice_id };
    if (rec.status === OPEN) this.closePeriod(account, period);
    rec.status = INVOICED;
    const invoice = { invoice_id, version: rec.version, lines: this._currentLines(rec) };
    rec.invoices.push(invoice);
    rec.history.push({ version: rec.version, cause: invoice_id, kind: "INVOICE" });
    return { status: "invoiced", invoice };
  }

  recordRefund(account, period, refund_id) {
    const rec = this._periodRec(account, period);
    if (rec.refunds.some((r) => r.refund_id === refund_id)) return { status: "duplicate", refund_id };
    if (rec.status === OPEN) this.closePeriod(account, period);
    rec.status = REFUNDED;
    const refund = { refund_id, version: rec.version, lines: this._currentLines(rec) };
    rec.refunds.push(refund);
    rec.history.push({ version: rec.version, cause: refund_id, kind: "REFUND" });
    return { status: "refunded", refund };
  }

  // ---------- 查询 ----------

  billFor(account, period) {
    const rec = this.state.periods[account]?.[period];
    if (!rec) return { account, period, status: "EMPTY", version: 0, lines: [], adjustments: [] };
    if (rec.status === OPEN) {
      const view = this._computeAll();
      return {
        account,
        period,
        status: rec.status,
        version: rec.version,
        lines: view.lines[account]?.[period] ?? [],
        adjustments: [],
        history: rec.history,
      };
    }
    // 已封账：原账单行冻结返回，晚到数据体现在 adjustments 与 current_lines
    return {
      account,
      period,
      status: rec.status,
      version: rec.version,
      lines: rec.snapshot.lines,
      adjustments: rec.adjustments,
      current_lines: this._currentLines(rec),
      history: rec.history,
    };
  }

  // 从任意账单行展开：原始片段、去重原因、调整版本。
  // scope="minimal" 只保留财务核验所需的最小字段；家庭共享撤销后仅允许最小范围，
  // 除非显式声明用途（purpose，如 "dispute" / "audit"）。
  explainLine(account, period, line_id, { scope = "full", purpose = null } = {}) {
    const rec = this.state.periods[account]?.[period];
    if (!rec) return null;
    if (scope === "full" && this._isPrivacyLocked(account) && !purpose) {
      throw new Error("家庭共享已撤销：仅允许最小范围查验，或显式声明查验用途");
    }
    const view = this._computeAll();
    const liveLine = (view.lines[account]?.[period] ?? []).find((l) => l.line_id === line_id);
    const billedLine = rec.status === OPEN ? liveLine : (rec.snapshot.lines.find((l) => l.line_id === line_id) ?? null);
    const currentLine = rec.status === OPEN ? liveLine : (this._currentLines(rec).find((l) => l.line_id === line_id) ?? null);

    const fragments = [];
    for (const d of Object.values(view.details)) {
      if (d.account !== account || d.package_id !== line_id || !d.periods.includes(period)) continue;
      const slices = d.slices.filter((s) => s.period === period);
      const credited_seconds = round3(slices.reduce((acc, s) => acc + s.seconds, 0));
      if (scope === "minimal") {
        fragments.push({
          fragment_key: d.key,
          content_id: d.content_id,
          status: d.void ? "void" : d.quarantined ? "quarantined" : "active",
          credited_seconds,
          deduped: d.deduped.map((x) => ({ reason: x.reason, against: x.against })),
        });
      } else {
        fragments.push({
          fragment_key: d.key,
          event_id: this.state.fragments[d.key].event_id,
          device_id: d.device_id,
          session_id: d.session_id,
          content_id: d.content_id,
          content_range: this.state.fragments[d.key]
            ? [this.state.fragments[d.key].content_start, this.state.fragments[d.key].content_end]
            : null,
          status: d.void ? "void" : d.quarantined ? "quarantined" : "active",
          forced_account: d.forced_account,
          window: d.window?.map((ms) => new Date(ms).toISOString()) ?? null,
          timezone: d.timezone,
          credited: d.credited,
          credited_seconds,
          deduped: d.deduped,
          slices,
        });
      }
    }
    fragments.sort((a, b) => (a.fragment_key < b.fragment_key ? -1 : 1));

    const adjustments =
      scope === "minimal"
        ? rec.adjustments.map((a) => ({ version: a.version, lines_delta: a.lines_delta }))
        : rec.adjustments;

    return {
      line_ref: `${account}/${period}#${line_id}`,
      account,
      period,
      line_id,
      status: rec.status,
      version: rec.version,
      billed_seconds: billedLine?.seconds ?? 0,
      current_seconds: currentLine?.seconds ?? 0,
      fragments,
      adjustments,
      history: scope === "full" ? rec.history : undefined,
    };
  }

  // 客服可见的待处理异常：被隔离的片段、无法归属的片段
  exceptions() {
    const out = [];
    for (const f of Object.values(this.state.fragments)) {
      if (f.status === "quarantined") {
        out.push({ fragment_key: f.key, kind: f.quarantine_reason, download_id: f.download_id });
      } else if (f.status === "active" && !this._resolveAccount(f)) {
        out.push({ fragment_key: f.key, kind: "UNATTRIBUTED", subject_id: f.subject_id });
      }
    }
    return out.sort((a, b) => (a.fragment_key < b.fragment_key ? -1 : 1));
  }

  // ---------- 申诉与裁定（逐片段，全程留痕） ----------

  fileAppeal({ appeal_id, fragment_key, reason, filed_at }) {
    if (this.state.appeals[appeal_id]) return { status: "duplicate", appeal_id };
    if (!this.state.fragments[fragment_key]) return { status: "rejected", problems: ["fragment_key"] };
    this.state.appeals[appeal_id] = {
      appeal_id,
      fragment_key,
      reason,
      filed_at,
      status: "OPEN",
      adjudication: null,
    };
    return { status: "filed", appeal_id };
  }

  adjudicate({ appeal_id, verdict, decided_at, account_id = null, note = null }) {
    const appeal = this.state.appeals[appeal_id];
    if (!appeal) return { status: "rejected", problems: ["appeal_id"] };
    if (appeal.status !== "OPEN") return { status: "duplicate", appeal_id };
    appeal.status = "DECIDED";
    appeal.adjudication = { verdict, decided_at, account_id, note };
    const f = this.state.fragments[appeal.fragment_key];
    if (verdict === "VOID") {
      f.status = "void";
      f.void_reason = `appeal:${appeal_id}`;
    } else if (verdict === "REASSIGN") {
      f.forced_account = account_id;
      if (f.status === "quarantined") {
        f.status = "active";
        f.quarantine_reason = null;
      }
    } else if (verdict === "UPHOLD" && f.status === "quarantined") {
      f.status = "active";
      f.quarantine_reason = null;
    }
    // 走统一的修正/追加调整通道：未封账就地改，已封账追加调整
    this._retouchFragments((x) => x.key === f.key, `appeal:${appeal_id}`);
    return { status: "decided", appeal_id };
  }

  // ---------- 内部：设备与归属 ----------

  _device(device_id) {
    return (this.state.devices[device_id] ??= { syncs: [], bindings: [] });
  }

  // 设备时钟漂移校正：取设备时钟不大于 t 的最近同步点
  _offsetMs(device_id, deviceMs) {
    const syncs = this.state.devices[device_id]?.syncs ?? [];
    let chosen = null;
    for (const s of syncs) {
      if (s.device_ms <= deviceMs) chosen = s;
      else break;
    }
    if (!chosen && syncs.length > 0) chosen = syncs[0];
    return chosen ? chosen.server_ms - chosen.device_ms : 0;
  }

  _normWindow(f) {
    return [
      f.started_device_ms + this._offsetMs(f.device_id, f.started_device_ms),
      f.ended_device_ms + this._offsetMs(f.device_id, f.ended_device_ms),
    ];
  }

  // 归属解析：申诉裁定 > 当时有效的成员规则 > 当时有效的设备绑定
  _resolveAccount(f) {
    if (f.forced_account) return f.forced_account;
    const [t] = this._normWindow(f);
    let best = null;
    for (const r of this.state.membership) {
      if (r.subject_id !== f.subject_id) continue;
      if (r.from_ms <= t && (r.to_ms === null || t < r.to_ms)) {
        if (!best || r.from_ms > best.from_ms) best = r;
      }
    }
    if (best) return best.account_id;
    let binding = null;
    for (const b of this.state.devices[f.device_id]?.bindings ?? []) {
      if (b.from_ms <= t && (b.to_ms === null || t < b.to_ms)) {
        if (!binding || b.from_ms > binding.from_ms) binding = b;
      }
    }
    return binding ? binding.account_id : null;
  }

  _packageRuleFor(content_id, t_ms) {
    let best = null;
    for (const r of this.state.package_rules) {
      if (!r.content_ids.includes(content_id)) continue;
      if (r.from_ms <= t_ms && (r.to_ms === null || t_ms < r.to_ms)) {
        if (!best || r.from_ms > best.from_ms) best = r;
      }
    }
    return best;
  }

  _isPrivacyLocked(account) {
    return this.state.membership.some((r) => r.account_id === account && r.to_ms !== null);
  }

  // ---------- 内部：周期路由 ----------

  _periodRec(account, period) {
    const perAccount = (this.state.periods[account] ??= {});
    if (!perAccount[period]) {
      perAccount[period] = {
        status: OPEN,
        version: 0,
        history: [{ version: 0, cause: null, kind: "OPEN" }],
        snapshot: null,
        adjustments: [],
        invoices: [],
        refunds: [],
        contributors: [],
      };
    }
    return perAccount[period];
  }

  _spanPeriods(f) {
    const [ws, we] = this._normWindow(f);
    const out = new Set();
    for (const slice of this._sliceByLocalDay(ws, we, f.timezone)) out.add(periodOf(slice.date));
    return [...out];
  }

  _scopesOfFragment(f) {
    const account = this._resolveAccount(f);
    if (!account) return [];
    return this._spanPeriods(f).map((period) => `${account}|${period}`);
  }

  _knownScopesOf(fragmentKey) {
    const out = [];
    for (const [account, periods] of Object.entries(this.state.periods)) {
      for (const [period, rec] of Object.entries(periods)) {
        if (rec.contributors.includes(fragmentKey)) out.push(`${account}|${period}`);
      }
    }
    return out;
  }

  _retouchFragments(pred, cause) {
    const scopes = new Set();
    for (const f of Object.values(this.state.fragments)) {
      if (!pred(f)) continue;
      for (const s of this._scopesOfFragment(f)) scopes.add(s);
      for (const s of this._knownScopesOf(f.key)) scopes.add(s);
    }
    this._touchScopes([...scopes], cause);
  }

  _retouchAll(cause) {
    const scopes = [];
    for (const [account, periods] of Object.entries(this.state.periods)) {
      for (const period of Object.keys(periods)) scopes.push(`${account}|${period}`);
    }
    this._touchScopes(scopes, cause);
  }

  _touchScopes(scopes, cause) {
    for (const scope of scopes) {
      const sep = scope.indexOf("|");
      const account = scope.slice(0, sep);
      const period = scope.slice(sep + 1);
      const rec = this._periodRec(account, period);
      if (rec.status === OPEN) {
        // 未封账：就地修正，留版本痕迹
        rec.version += 1;
        rec.history.push({ version: rec.version, cause, kind: "INGEST" });
        this._refreshContributors(account, period, rec);
      } else {
        // 已封账/开票/退款：只追加调整，不改原账单
        this._appendAdjustment(account, period, rec, cause);
      }
    }
  }

  _appendAdjustment(account, period, rec, cause) {
    if (rec.adjustments.some((a) => a.cause_event_id === cause)) return null; // 幂等
    const view = this._computeAll();
    const current = new Map((view.lines[account]?.[period] ?? []).map((l) => [l.line_id, l.seconds]));
    const base = new Map((rec.snapshot?.lines ?? []).map((l) => [l.line_id, l.seconds]));
    for (const adj of rec.adjustments) {
      for (const [lid, d] of Object.entries(adj.lines_delta)) {
        base.set(lid, round3((base.get(lid) ?? 0) + d));
      }
    }
    const delta = {};
    for (const lid of new Set([...current.keys(), ...base.keys()])) {
      const d = round3((current.get(lid) ?? 0) - (base.get(lid) ?? 0));
      if (d !== 0) delta[lid] = d;
    }
    if (Object.keys(delta).length === 0) return null; // 无实际变化（含重放）
    rec.version += 1;
    const adjustment = { version: rec.version, cause_event_id: cause, lines_delta: delta };
    rec.adjustments.push(adjustment);
    rec.history.push({ version: rec.version, cause, kind: "ADJUSTMENT" });
    this._refreshContributors(account, period, rec, view);
    return adjustment;
  }

  _refreshContributors(account, period, rec, view = null) {
    const v = view ?? this._computeAll();
    rec.contributors = Object.values(v.details)
      .filter((d) => d.account === account && d.slices.some((s) => s.period === period))
      .map((d) => d.key)
      .sort();
  }

  _currentLines(rec) {
    const map = new Map((rec.snapshot?.lines ?? []).map((l) => [l.line_id, { ...l }]));
    for (const adj of rec.adjustments) {
      for (const [lid, d] of Object.entries(adj.lines_delta)) {
        const line =
          map.get(lid) ?? { line_id: lid, package_id: lid, seconds: 0, raw_seconds: 0, days: {}, contents: {}, fragments: [] };
        line.seconds = round3(line.seconds + d);
        map.set(lid, line);
      }
    }
    return [...map.values()].sort((a, b) => (a.line_id < b.line_id ? -1 : 1));
  }

  // ---------- 内部：用量计算（纯函数，可重放） ----------

  _sliceByLocalDay(w0, w1, timeZone) {
    const total = w1 - w0;
    if (!(total > 0)) return [{ date: localDate(w0, timeZone), ratio: 1 }];
    const out = [];
    let cur = w0;
    while (cur < w1) {
      const boundary = nextLocalMidnightMs(cur, timeZone);
      const end = Math.min(boundary, w1);
      out.push({ date: localDate(cur, timeZone), ratio: (end - cur) / total });
      cur = end;
    }
    return out;
  }

  _computeAll() {
    const details = {};
    const groups = new Map(); // `${account}||${content_id}` → fragments

    for (const f of Object.values(this.state.fragments)) {
      const [ws, we] = this._normWindow(f);
      const rule = this._packageRuleFor(f.content_id, ws);
      const d = {
        key: f.key,
        account: null,
        package_id: rule?.package_id ?? "UNPACKAGED",
        rule,
        content_id: f.content_id,
        device_id: f.device_id,
        session_id: f.session_id,
        timezone: f.timezone,
        forced_account: f.forced_account,
        void: f.status === "void",
        quarantined: f.status === "quarantined",
        window: [ws, we],
        periods: this._spanPeriods(f),
        credited: [],
        deduped: [],
        slices: [],
      };
      details[f.key] = d;
      // 归属对所有状态都解析（作废/隔离的片段仍需作为证据展开），但只有 active 参与计账
      d.account = this._resolveAccount(f);
      if (f.status !== "active") continue;
      if (!d.account) continue;
      const gk = `${d.account}||${f.content_id}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(f);
    }

    // 去重：同一账户同一内容的区间并集，先到的片段优先计账
    for (const frags of groups.values()) {
      frags.sort(
        (a, b) => details[a.key].window[0] - details[b.key].window[0] || a.ingest_seq - b.ingest_seq,
      );
      let union = [];
      const creditedByFrag = {};
      for (const f of frags) {
        const base = [f.content_start, f.content_end];
        const credited = subtractInterval(base, union);
        const covered = subtractInterval(base, credited);
        const d = details[f.key];
        d.credited = credited;
        d.deduped = covered.map(([s, e]) => {
          const against = frags.find(
            (g) => g.key !== f.key && (creditedByFrag[g.key] ?? []).some(([cs, ce]) => cs < e && s < ce),
          );
          return {
            interval: [s, e],
            reason: s === base[0] && e === base[1] ? "ALREADY_COUNTED" : "OVERLAP",
            against: against?.key ?? null,
          };
        });
        creditedByFrag[f.key] = credited;
        union = mergeIntervals([...union, ...credited]);
      }
      // 把计账区间按墙钟比例映射并切到当地日期（跨午夜片段会落到两个周期）
      for (const f of frags) {
        const d = details[f.key];
        const [ws, we] = d.window;
        const span = f.content_end - f.content_start;
        for (const [cs, ce] of d.credited) {
          const w0 = ws + ((cs - f.content_start) / span) * (we - ws);
          const w1 = ws + ((ce - f.content_start) / span) * (we - ws);
          for (const slice of this._sliceByLocalDay(w0, w1, f.timezone)) {
            d.slices.push({
              date: slice.date,
              period: periodOf(slice.date),
              seconds: round3((ce - cs) * slice.ratio),
              package_id: d.package_id,
              content_id: f.content_id,
              cap: d.rule?.daily_cap_seconds ?? null,
              rounding: d.rule?.rounding_seconds ?? 0,
            });
          }
        }
      }
    }

    // 汇总：账户 → 周期 → 内容包账单行
    const lines = {};
    for (const d of Object.values(details)) {
      if (!d.account || d.void || d.quarantined) continue;
      for (const s of d.slices) {
        const perAccount = (lines[d.account] ??= {});
        const perPeriod = (perAccount[s.period] ??= new Map());
        if (!perPeriod.has(s.package_id)) {
          perPeriod.set(s.package_id, { days: new Map(), fragments: new Set(), contents: new Map(), rounding: 0 });
        }
        const bucket = perPeriod.get(s.package_id);
        const day = bucket.days.get(s.date) ?? { seconds: 0, cap: s.cap };
        day.seconds = round3(day.seconds + s.seconds);
        if (day.cap === null) day.cap = s.cap;
        bucket.days.set(s.date, day);
        bucket.fragments.add(d.key);
        bucket.contents.set(s.content_id, round3((bucket.contents.get(s.content_id) ?? 0) + s.seconds));
        if (!bucket.rounding && s.rounding) bucket.rounding = s.rounding;
      }
    }

    const out = {};
    for (const [account, periods] of Object.entries(lines)) {
      out[account] = {};
      for (const [period, packages] of Object.entries(periods)) {
        out[account][period] = [...packages.entries()]
          .map(([package_id, bucket]) => {
            const days = {};
            let raw = 0;
            for (const [date, d] of [...bucket.days.entries()].sort()) {
              const capped = d.cap === null ? d.seconds : Math.min(d.seconds, d.cap);
              days[date] = round3(capped);
              raw = round3(raw + capped);
            }
            const seconds =
              bucket.rounding > 0 && raw > 0 ? Math.ceil(raw / bucket.rounding) * bucket.rounding : raw;
            return {
              line_id: package_id,
              package_id,
              seconds: round3(seconds),
              raw_seconds: raw,
              days,
              contents: Object.fromEntries([...bucket.contents.entries()].sort()),
              fragments: [...bucket.fragments].sort(),
            };
          })
          .sort((a, b) => (a.line_id < b.line_id ? -1 : 1));
      }
    }
    return { lines: out, details };
  }
}
