import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/events.js";
import { materialize, TimeLedger } from "../src/ledger.js";

// —— 构造工具：全部数据为虚构 ——
let seq = 0;
const E = (kind, occurred_at, subject_id, payload, received_at) => ({
  event_id: payload.event_id ?? `e${++seq}`,
  kind,
  occurred_at,
  subject_id,
  payload: (({ event_id: _ignored, ...rest }) => rest)(payload),
  ...(received_at ? { received_at } : {}),
});
const MIN = 60_000;

const stdPack = () =>
  E("CONTENT_PACK_RULE", "2026-09-01T00:00:00Z", "platform", {
    event_id: "pack", rule_id: "pack", version: 1, pack_id: "STD",
    billable: true, rate: 1, category: "STANDARD", valid_from: "2026-09-01T00:00:00Z",
  });
const bind = (sn, sharing = "PERSONAL", owner = "owner") =>
  E("DEVICE_BINDING", "2026-09-01T00:00:00Z", owner, {
    event_id: `bind-${sn}`, rule_id: `bind-${sn}`, version: 1, device_sn: sn,
    sharing, valid_from: "2026-09-01T00:00:00Z",
  });
const sync = (sn, tz, at, ref = at) =>
  E("SESSION_SYNC", at, "owner", {
    event_id: `sync-${sn}-${at}`, device_sn: sn, session_id: `sess-${sn}`,
    device_clock: at, reference_clock: ref, drift_ppm_tolerance: 500, iana_timezone: tz,
  });
const seg = (p) =>
  E("PLAYBACK_SEGMENT", p.end, p.owner ?? "owner", {
    event_id: p.id, device_sn: p.sn, session_id: `sess-${p.sn}`,
    content_id: p.content ?? "C1", state: p.state ?? "PLAYING",
    seg_start: p.start, seg_end: p.end,
    pos_start_ms: p.p0 ?? 0, pos_end_ms: p.p1 ?? (p.mins * MIN),
    viewer_id: p.viewer ?? "owner", pack_id: "STD",
    ...(p.chain ? { resume_chain: p.chain } : {}),
    ...(p.offline ? { offline: true, download_id: p.download_id } : {}),
  }, p.received);
const totalOf = (mat, account, pk) => mat.totals.get(`${account}|DAY|${pk}`) ?? 0;

test("样例文件均符合事件领域约定", async () => {
  for (const f of ["../data/sample.json", "../data/scenario.json"]) {
    const data = JSON.parse(await readFile(new URL(f, import.meta.url), "utf8"));
    const records = data.events ?? [data];
    for (const r of records) assert.deepEqual(validateEvent(r), [], `${f} ${r.event_id}`);
  }
});

test("电视暂停后手机续播：同一内容只扣减一次", () => {
  const events = [
    stdPack(), bind("TV"), bind("PH"),
    sync("TV", "Asia/Shanghai", "2026-09-20T19:00:00+08:00"),
    sync("PH", "Asia/Shanghai", "2026-09-20T20:30:00+08:00"),
    seg({ id: "tv", sn: "TV", start: "2026-09-20T20:00:00+08:00", end: "2026-09-20T20:30:00+08:00", mins: 30, p1: 30 * MIN, chain: "K1" }),
    seg({ id: "ph", sn: "PH", start: "2026-09-20T20:40:00+08:00", end: "2026-09-20T21:05:00+08:00", mins: 25, p0: 30 * MIN, p1: 55 * MIN, chain: "K1" }),
  ];
  const mat = materialize(events);
  assert.equal(totalOf(mat, "owner", "2026-09-20") / MIN, 55);
  const ph = mat.atoms.find((a) => a.source_event_id === "ph");
  assert.equal(ph.covered_ms / MIN, 0); // 续播位置不重叠：两段都计费
  // 手机上报把起点回退到电视段内（常见续播重叠 5 分钟）
  const events2 = [...events];
  events2[6] = seg({ id: "ph", sn: "PH", start: "2026-09-20T20:40:00+08:00", end: "2026-09-20T21:05:00+08:00", mins: 25, p0: 25 * MIN, p1: 50 * MIN, chain: "K1" });
  const mat2 = materialize(events2);
  assert.equal(totalOf(mat2, "owner", "2026-09-20") / MIN, 50); // 0-30 电视 + 30-50 手机新看，25-30 重看不双扣
  const ph2 = mat2.atoms.find((a) => a.source_event_id === "ph");
  assert.equal(ph2.covered_ms / MIN, 5);
  assert.deepEqual(ph2.covered_by, ["tv"]);
});

test("同批上报重放多次（含弱网重发）不多扣", () => {
  const events = [
    stdPack(), bind("TV"), bind("PH"),
    sync("TV", "Asia/Shanghai", "2026-09-20T19:00:00+08:00"),
    sync("PH", "Asia/Shanghai", "2026-09-20T20:30:00+08:00"),
    seg({ id: "tv", sn: "TV", start: "2026-09-20T20:00:00+08:00", end: "2026-09-20T20:30:00+08:00", mins: 30, p1: 30 * MIN, chain: "K1" }),
    seg({ id: "ph", sn: "PH", start: "2026-09-20T20:40:00+08:00", end: "2026-09-20T21:05:00+08:00", mins: 25, p0: 30 * MIN, p1: 55 * MIN, chain: "K1" }),
    // 同观察以新事件 ID 重发
    seg({ id: "ph-dup", sn: "PH", start: "2026-09-20T20:40:00+08:00", end: "2026-09-20T21:05:00+08:00", mins: 25, p0: 30 * MIN, p1: 55 * MIN, chain: "K1", received: "2026-09-20T21:06:00+08:00" }),
  ];
  const once = materialize(events);
  const replayed = materialize([...events, ...events, ...events]);
  assert.equal(replayed.atoms.length, once.atoms.length);
  assert.deepEqual([...replayed.totals.values()], [...once.totals.values()]);
  assert.equal(totalOf(once, "owner", "2026-09-20") / MIN, 55);
  const dup = once.atoms.find((a) => a.source_event_id === "ph-dup");
  assert.equal(dup.increment_ms, 0);
  assert.deepEqual(dup.covered_by, ["ph"]);
});

test("真正的重看（另一条续播链路、不同时间）照常计费", () => {
  const events = [
    stdPack(), bind("TV"),
    sync("TV", "Asia/Shanghai", "2026-09-19T19:00:00+08:00"),
    seg({ id: "watch1", sn: "TV", start: "2026-09-19T20:00:00+08:00", end: "2026-09-19T20:30:00+08:00", mins: 30, p1: 30 * MIN, chain: "K1" }),
    seg({ id: "watch2", sn: "TV", start: "2026-09-20T20:00:00+08:00", end: "2026-09-20T20:30:00+08:00", mins: 30, p1: 30 * MIN, chain: "K2" }),
  ];
  const mat = materialize(events);
  assert.equal(totalOf(mat, "owner", "2026-09-19") / MIN, 30);
  assert.equal(totalOf(mat, "owner", "2026-09-20") / MIN, 30);
});

test("家庭成员借用车机：按当时关系规则计入账号主人", () => {
  const events = [
    stdPack(), bind("CAR", "FAMILY_SHARED"),
    E("RELATIONSHIP_RULE", "2026-09-01T00:00:00Z", "owner", {
      event_id: "rel", rule_id: "rel", version: 1, member_id: "spouse",
      relationship: "FAMILY_ADULT", attribution: "TO_OWNER", valid_from: "2026-09-01T00:00:00Z",
    }),
    sync("CAR", "Asia/Shanghai", "2026-09-21T07:00:00+08:00"),
    seg({ id: "drive", sn: "CAR", viewer: "spouse", content: "POD", start: "2026-09-21T08:00:00+08:00", end: "2026-09-21T08:20:00+08:00", mins: 20 }),
  ];
  const mat = materialize(events);
  assert.equal(totalOf(mat, "owner", "2026-09-21") / MIN, 20);
  assert.equal(totalOf(mat, "spouse", "2026-09-21"), 0);
  const a = mat.atoms.find((x) => x.source_event_id === "drive");
  assert.match(a.attribution_reason, /TO_OWNER/);

  // 无关系的借用人不得静默计入主人
  const mat2 = materialize([...events.slice(0, 3), sync("CAR", "Asia/Shanghai", "2026-09-21T07:00:00+08:00"),
    seg({ id: "stranger", sn: "CAR", viewer: "stranger", content: "POD", start: "2026-09-21T09:00:00+08:00", end: "2026-09-21T09:10:00+08:00", mins: 10 })]);
  assert.equal(totalOf(mat2, "owner", "2026-09-21"), 0);
  assert.ok(mat2.atoms.some((x) => x.status === "NO_RELATIONSHIP"));
});

test("周期中途成员关系变更：变更前后分别沿用当时规则", () => {
  const events = [
    stdPack(), bind("CAR", "FAMILY_SHARED"),
    E("RELATIONSHIP_RULE", "2026-09-01T00:00:00Z", "owner", {
      event_id: "rel-v1", rule_id: "rel", version: 1, member_id: "spouse",
      relationship: "FAMILY_ADULT", attribution: "TO_OWNER",
      valid_from: "2026-09-01T00:00:00Z",
    }),
    E("RELATIONSHIP_RULE", "2026-09-21T11:00:00+08:00", "owner", {
      event_id: "rel-v2", rule_id: "rel", version: 2, member_id: "spouse",
      relationship: "FAMILY_ADULT", attribution: "TO_MEMBER",
      valid_from: "2026-09-21T11:00:00+08:00",
    }),
    sync("CAR", "Asia/Shanghai", "2026-09-21T07:00:00+08:00"),
    seg({ id: "drive", sn: "CAR", viewer: "spouse", content: "POD", start: "2026-09-21T10:00:00+08:00", end: "2026-09-21T12:00:00+08:00", mins: 120 }),
  ];
  const mat = materialize(events);
  assert.equal(totalOf(mat, "owner", "2026-09-21") / MIN, 60);
  assert.equal(totalOf(mat, "spouse", "2026-09-21") / MIN, 60);
});

test("设备时钟漂移：对表后按平台参考时刻归当地日期", () => {
  // 设备时钟比参考时快 2 分钟：设备自称 23:58 开始的片段，参考时已跨次日 00:00
  const events = [
    stdPack(), bind("TV"),
    sync("TV", "Asia/Shanghai", "2026-09-20T23:50:00+08:00", "2026-09-20T15:48:00Z"),
    seg({ id: "late", sn: "TV", start: "2026-09-20T23:58:00+08:00", end: "2026-09-21T00:04:00+08:00", mins: 6, p1: 6 * MIN }),
  ];
  const mat = materialize(events);
  // 参考时间 = 设备读数 - 2 分钟 -> 23:56~00:02（上海），跨日切分
  assert.equal(totalOf(mat, "owner", "2026-09-20") / MIN, 4);
  assert.equal(totalOf(mat, "owner", "2026-09-21") / MIN, 2);
});

test("跨时区旅行：按同步点声明的时区切片归日", () => {
  const events = [
    stdPack(), bind("PH"),
    // 起飞前上海
    sync("PH", "Asia/Shanghai", "2026-09-20T12:00:00+08:00"),
    // 落地伦敦（UTC+1 -> +08:00 转换），设备在伦敦 10:00 本地再次对表
    sync("PH", "Europe/London", "2026-09-20T17:00:00+08:00", "2026-09-20T09:00:00Z"),
    // 参考时刻 09:30~11:30 伦敦：覆盖伦敦当地日 2026-09-20
    seg({ id: "plane", sn: "PH", start: "2026-09-20T17:30:00+08:00", end: "2026-09-20T19:30:00+08:00", mins: 120, p1: 120 * MIN }),
  ];
  const mat = materialize(events);
  const byPeriod = mat.atoms.filter((a) => a.source_event_id === "plane");
  assert.ok(byPeriod.every((a) => a.tz === "Europe/London"));
  assert.deepEqual([...new Set(byPeriod.map((a) => a.period_key))], ["2026-09-20"]);
  assert.equal(totalOf(mat, "owner", "2026-09-20") / MIN, 120);
});

test("离线数据晚到：开放周期直接修正", () => {
  const events = [
    stdPack(), bind("PH"),
    sync("PH", "Asia/Shanghai", "2026-09-20T08:00:00+08:00"),
    E("OFFLINE_DOWNLOAD", "2026-09-20T08:00:00+08:00", "owner", {
      event_id: "dl", device_sn: "PH", content_id: "C1", download_id: "D1",
      licensed_from: "2026-09-20T00:00:00+08:00", licensed_to: "2026-09-30T00:00:00+08:00",
    }, "2026-09-22T10:00:00+08:00"),
    seg({ id: "off", sn: "PH", offline: true, download_id: "D1", start: "2026-09-20T09:00:00+08:00", end: "2026-09-20T09:40:00+08:00", mins: 40, received: "2026-09-22T10:00:01+08:00" }),
  ];
  const L = new TimeLedger(events);
  const line = L.explainLine("owner", "2026-09-20");
  assert.equal(line.state, "OPEN");
  assert.equal(line.current_total_ms / MIN, 40);
  assert.ok(line.atoms.some((a) => a.offline));

  // 无下载授权的离线片段只留证不计费
  const bad = materialize([...events.filter((e) => e.event_id !== "dl")]);
  assert.ok(bad.atoms.some((a) => a.status === "OFFLINE_UNLICENSED"));
  assert.equal(totalOf(bad, "owner", "2026-09-20"), 0);
});

test("离线数据晚到：已开票周期冻结原账单并追加 LATE_REPORT 调整", () => {
  const base = [
    stdPack(), bind("PH"),
    sync("PH", "Asia/Shanghai", "2026-09-20T08:00:00+08:00"),
    seg({ id: "online", sn: "PH", start: "2026-09-20T08:00:00+08:00", end: "2026-09-20T08:30:00+08:00", mins: 30, received: "2026-09-20T09:00:00+08:00" }),
    E("PERIOD_CLOSED", "2026-09-21T00:05:00+08:00", "owner", {
      event_id: "close", period_type: "DAY", period_key: "2026-09-20", closed_at: "2026-09-21T00:05:00+08:00",
    }, "2026-09-21T00:05:00+08:00"),
  ];
  const closed = new TimeLedger(base);
  assert.equal(closed.explainLine("owner", "2026-09-20").current_total_ms / MIN, 30);

  const withLate = [
    ...base,
    E("OFFLINE_DOWNLOAD", "2026-09-20T08:00:00+08:00", "owner", {
      event_id: "dl", device_sn: "PH", content_id: "C1", download_id: "D1",
      licensed_from: "2026-09-20T00:00:00+08:00", licensed_to: "2026-09-30T00:00:00+08:00",
    }, "2026-09-22T10:00:00+08:00"),
    seg({ id: "late-off", sn: "PH", offline: true, download_id: "D1", start: "2026-09-20T09:00:00+08:00", end: "2026-09-20T09:40:00+08:00", mins: 40, received: "2026-09-22T10:00:01+08:00" }),
  ];
  const L = new TimeLedger(withLate);
  const line = L.explainLine("owner", "2026-09-20");
  assert.equal(line.state, "CLOSED");
  assert.equal(line.frozen_bill.total_ms / MIN, 30); // 原账单不动
  assert.equal(line.current_total_ms / MIN, 70);
  const lateAdj = line.adjustment_versions.filter((a) => a.reason === "LATE_REPORT");
  assert.equal(lateAdj.reduce((s, a) => s + a.delta_ms, 0) / MIN, 40);

  // 确定性：调整 ID 重放不变，且重复事件不会产生第二笔调整
  const replay = new TimeLedger([...withLate, ...withLate]);
  assert.deepEqual(
    replay.explainLine("owner", "2026-09-20").adjustment_versions.map((a) => a.adjustment_id).sort(),
    line.adjustment_versions.map((a) => a.adjustment_id).sort(),
  );
  assert.equal(replay.explainLine("owner", "2026-09-20").current_total_ms / MIN, 70);
});

test("撤销家庭共享：新用量立即停算，既有财务证据最小范围可查", () => {
  const events = [
    stdPack(), bind("CAR", "FAMILY_SHARED"),
    E("RELATIONSHIP_RULE", "2026-09-01T00:00:00Z", "owner", {
      event_id: "rel-v1", rule_id: "rel", version: 1, member_id: "spouse",
      relationship: "FAMILY_ADULT", attribution: "TO_OWNER", valid_from: "2026-09-01T00:00:00Z",
    }),
    E("RELATIONSHIP_RULE", "2026-09-21T12:00:00+08:00", "owner", {
      event_id: "rel-v2", rule_id: "rel", version: 2, member_id: "spouse",
      relationship: "FAMILY_ADULT", attribution: "NONE", valid_from: "2026-09-21T12:00:00+08:00",
    }),
    sync("CAR", "Asia/Shanghai", "2026-09-21T07:00:00+08:00"),
    seg({ id: "before", sn: "CAR", viewer: "spouse", content: "POD", start: "2026-09-21T11:00:00+08:00", end: "2026-09-21T11:30:00+08:00", mins: 30, received: "2026-09-21T11:31:00+08:00" }),
    seg({ id: "after", sn: "CAR", viewer: "spouse", content: "POD", start: "2026-09-21T12:30:00+08:00", end: "2026-09-21T13:00:00+08:00", mins: 30, received: "2026-09-21T13:01:00+08:00" }),
    E("EVIDENCE_GRANT", "2026-09-22T00:00:00+08:00", "owner", {
      event_id: "grant", grant_id: "G1",
      scope: { kind: "PERIOD", account: "owner", period_type: "DAY", period_key: "2026-09-21" },
      granted_to: "auditor-spouse", valid_until: "2026-10-22T00:00:00+08:00",
    }),
  ];
  const L = new TimeLedger(events);
  assert.equal(L.explainLine("owner", "2026-09-21").current_total_ms / MIN, 30);
  assert.ok(materialize(events).atoms.some((a) => a.source_event_id === "after" && a.status === "REVOKED"));

  // 证据访问：本人、最小授权人、越权/过期
  assert.equal(L.assertEvidenceAccess("owner", "owner", "2026-09-21", "2026-09-23T00:00:00+08:00").granted, true);
  assert.equal(L.assertEvidenceAccess("auditor-spouse", "owner", "2026-09-21", "2026-09-23T00:00:00+08:00").scope, "GRANT");
  assert.throws(() => L.assertEvidenceAccess("auditor-spouse", "owner", "2026-09-20", "2026-09-23T00:00:00+08:00"), /EVIDENCE_DENIED/);
  assert.throws(() => L.assertEvidenceAccess("auditor-spouse", "owner", "2026-09-21", "2026-10-23T00:00:00+08:00"), /EVIDENCE_DENIED/);
  assert.throws(() => L.assertEvidenceAccess("nobody", "owner", "2026-09-21", "2026-09-23T00:00:00+08:00"), /EVIDENCE_DENIED/);
});

test("逐片段申诉成立：封账周期只追加退款调整，原账单不重写、重放不多退", () => {
  const events = [
    stdPack(), bind("TV"),
    sync("TV", "Asia/Shanghai", "2026-09-20T19:00:00+08:00"),
    seg({ id: "tv", sn: "TV", start: "2026-09-20T20:00:00+08:00", end: "2026-09-20T20:30:00+08:00", mins: 30, received: "2026-09-20T20:31:00+08:00" }),
    E("PERIOD_CLOSED", "2026-09-21T00:05:00+08:00", "owner", {
      event_id: "close", period_type: "DAY", period_key: "2026-09-20", closed_at: "2026-09-21T00:05:00+08:00",
    }, "2026-09-21T00:05:00+08:00"),
    E("DISPUTE_RULING", "2026-09-22T10:00:00+08:00", "owner", {
      event_id: "ruling", case_id: "CASE-9", segment_ref: "tv",
      decision: "SUSTAINED", decided_at: "2026-09-22T10:00:00+08:00",
    }, "2026-09-22T10:00:00+08:00"),
  ];
  const L = new TimeLedger(events);
  const line = L.explainLine("owner", "2026-09-20");
  assert.equal(line.frozen_bill.total_ms / MIN, 30);
  assert.equal(line.current_total_ms, 0);
  const refunds = line.adjustment_versions.filter((a) => a.reason === "DISPUTE_REFUND");
  assert.equal(refunds.reduce((s, a) => s + a.delta_ms, 0) / MIN, -30);
  assert.ok(line.atoms.some((a) => a.status === "DISPUTE_REVERSAL" && a.ruling_case_id === "CASE-9"));

  const replay = new TimeLedger([...events, ...events]);
  assert.equal(replay.explainLine("owner", "2026-09-20").current_total_ms, 0);
  assert.equal(
    replay.explainLine("owner", "2026-09-20").adjustment_versions.filter((a) => a.reason === "DISPUTE_REFUND").length,
    1,
  );

  // 裁定被拒（REJECTED）不产生冲销
  const rejected = [...events.slice(0, 5), { ...events[5], event_id: "ruling2", payload: { ...events[5].payload, case_id: "CASE-10", decision: "REJECTED" } }];
  assert.equal(new TimeLedger(rejected).explainLine("owner", "2026-09-20").current_total_ms / MIN, 30);
});

test("客服从账单行可展开原始片段、去重原因与调整版本", async () => {
  const data = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));
  const L = new TimeLedger(data.events);
  const line = L.explainLine("acct-004", "2026-09-20");
  const dup = line.atoms.find((a) => a.evidence.source_event_id === "seg-phone-resume-dup");
  assert.ok(dup);
  assert.match(dup.dedup_reason, /首写者胜出/);
  assert.deepEqual(dup.covered_by, ["seg-phone-resume"]);
  assert.ok(dup.evidence.raw_segment); // 原始上报
  assert.ok(dup.evidence.sync_event_ids.length > 0); // 对表证据
  const car = L.explainLine("acct-004", "2026-09-21").atoms.find((a) => a.evidence.source_event_id === "seg-car-spouse");
  assert.ok(car.evidence.rule_event_ids.includes("rel-spouse-004-v1")); // 归属依据
});

test("离线片段部分落在授权窗外：窗内计费、窗外留证", () => {
  const events = [
    stdPack(), bind("PH"),
    sync("PH", "Asia/Shanghai", "2026-09-20T08:00:00+08:00"),
    E("OFFLINE_DOWNLOAD", "2026-09-20T08:00:00+08:00", "owner", {
      event_id: "dl", device_sn: "PH", content_id: "C1", download_id: "D1",
      licensed_from: "2026-09-20T09:10:00+08:00", licensed_to: "2026-09-30T00:00:00+08:00",
    }),
    seg({ id: "off", sn: "PH", offline: true, download_id: "D1", start: "2026-09-20T09:00:00+08:00", end: "2026-09-20T09:40:00+08:00", mins: 40 }),
  ];
  const mat = materialize(events);
  assert.equal(totalOf(mat, "owner", "2026-09-20") / MIN, 30);
  assert.ok(mat.atoms.some((a) => a.source_event_id === "off" && a.status === "BILLED"));
  assert.ok(mat.atoms.some((a) => a.source_event_id === "off" && a.status === "OFFLINE_UNLICENSED"));
});

test("人工 LEDGER_ADJUSTMENT 只追加到封账周期且重放幂等", () => {
  const events = [
    stdPack(), bind("TV"),
    sync("TV", "Asia/Shanghai", "2026-09-20T19:00:00+08:00"),
    seg({ id: "tv", sn: "TV", start: "2026-09-20T20:00:00+08:00", end: "2026-09-20T20:30:00+08:00", mins: 30, received: "2026-09-20T20:31:00+08:00" }),
    E("PERIOD_CLOSED", "2026-09-21T00:05:00+08:00", "owner", {
      event_id: "close", period_type: "DAY", period_key: "2026-09-20", closed_at: "2026-09-21T00:05:00+08:00",
    }, "2026-09-21T00:05:00+08:00"),
    E("LEDGER_ADJUSTMENT", "2026-09-22T12:00:00+08:00", "owner", {
      event_id: "goodwill", period_type: "DAY", period_key: "2026-09-20",
      reason: "GOODWILL_CREDIT", delta_ms: -3 * MIN,
    }, "2026-09-22T12:00:00+08:00"),
  ];
  const L = new TimeLedger(events);
  const line = L.explainLine("owner", "2026-09-20");
  assert.equal(line.frozen_bill.total_ms / MIN, 30);
  assert.equal(line.current_total_ms / MIN, 27);
  assert.ok(line.adjustment_versions.some((a) => a.reason === "GOODWILL_CREDIT" && a.delta_ms === -3 * MIN));

  const replay = new TimeLedger([...events, ...events]);
  assert.equal(
    replay.explainLine("owner", "2026-09-20").adjustment_versions.filter((a) => a.reason === "GOODWILL_CREDIT").length,
    1,
  );
  assert.equal(replay.explainLine("owner", "2026-09-20").current_total_ms / MIN, 27);
});

test("整库重放：客服账单行视图逐字节一致", () => {
  const data = JSON.parse(readFileSync(new URL("../data/scenario.json", import.meta.url), "utf8"));
  const once = new TimeLedger(data.events).explainLine("acct-004", "2026-09-20");
  const thrice = new TimeLedger([...data.events, ...data.events, ...data.events]).explainLine("acct-004", "2026-09-20");
  assert.equal(JSON.stringify(thrice), JSON.stringify(once));
});
