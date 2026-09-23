import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/culture_time_budget.js";
import { TimeLedger } from "../src/time_ledger/ledger.js";

const ev = (id, kind, subject, payload, occurred_at = "2026-09-23T12:00:00Z") => ({
  event_id: id,
  kind,
  occurred_at,
  subject_id: subject,
  payload,
});

const frag = (id, subject, device, session, seq, content, range, started, ended, timezone, extra = {}) =>
  ev(id, "PLAYBACK_FRAGMENT", subject, {
    device_id: device,
    session_id: session,
    fragment_seq: seq,
    content_id: content,
    content_start: range[0],
    content_end: range[1],
    started_at: started,
    ended_at: ended,
    timezone,
    ...extra,
  });

const bind = (id, device, account, from = "2026-09-01T00:00:00Z") =>
  ev(id, "DEVICE_BOUND", account, { device_id: device, account_id: account, effective_from: from });

const totalSeconds = (bill) => (bill.lines ?? []).reduce((acc, l) => acc + l.seconds, 0);
const currentSeconds = (bill) => (bill.current_lines ?? bill.lines ?? []).reduce((acc, l) => acc + l.seconds, 0);

const PKG = {
  package_id: "pkg-video",
  content_ids: ["movie-1", "movie-2", "mov-a", "mov-off", "c1", "c2", "cA", "cB", "cx1", "cx2"],
  rounding_seconds: 0,
  effective_from: "2026-01-01T00:00:00Z",
};

function newLedger() {
  return new TimeLedger().setPackageRule(PKG);
}

test("断点续播与重叠片段：同一段内容只扣减一次，去重原因可查", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    bind("b1", "tv-01", "acct-1"),
    bind("b2", "phone-01", "acct-1"),
    // 电视看到 600 秒处暂停
    frag("f1", "viewer", "tv-01", "s1", 1, "movie-1", [0, 600], "2026-09-20T10:00:00Z", "2026-09-20T10:10:00Z", "Asia/Shanghai"),
    // 手机从 540 秒续播（重叠 60 秒），看到 900 秒
    frag("f2", "viewer", "phone-01", "s2", 1, "movie-1", [540, 900], "2026-09-20T10:10:00Z", "2026-09-20T10:16:00Z", "Asia/Shanghai"),
  ]);

  const bill = ledger.billFor("acct-1", "2026-09");
  assert.equal(totalSeconds(bill), 900); // 不是 600+360，而是并集 900

  const explain = ledger.explainLine("acct-1", "2026-09", "pkg-video");
  const phone = explain.fragments.find((f) => f.fragment_key === "phone-01/s2/1");
  assert.deepEqual(phone.credited, [[600, 900]]);
  assert.deepEqual(phone.deduped, [{ interval: [540, 600], reason: "OVERLAP", against: "tv-01/s1/1" }]);
});

test("内容包规则：日上限与取整在汇总时生效", () => {
  const ledger = new TimeLedger().setPackageRule({
    ...PKG,
    package_id: "pkg-cap",
    content_ids: ["cx1", "cx2"],
    daily_cap_seconds: 600,
    rounding_seconds: 60,
  });
  ledger.ingestAll([
    bind("b1", "tv-01", "acct-1"),
    frag("f1", "viewer", "tv-01", "s1", 1, "cx1", [0, 600], "2026-09-20T10:00:00Z", "2026-09-20T10:10:00Z", "Asia/Shanghai"),
    frag("f2", "viewer", "tv-01", "s2", 1, "cx2", [0, 300], "2026-09-20T11:00:00Z", "2026-09-20T11:05:00Z", "Asia/Shanghai"),
  ]);
  const [line] = ledger.billFor("acct-1", "2026-09").lines;
  assert.equal(line.raw_seconds, 600); // 900 被日上限截到 600
  assert.equal(line.seconds, 600);
});

test("同一批上报重放多次：不多扣时长、不多退费用", () => {
  const batch = [
    bind("b1", "tv-01", "acct-1"),
    frag("f1", "viewer", "tv-01", "s1", 1, "movie-1", [0, 600], "2026-09-20T10:00:00Z", "2026-09-20T10:10:00Z", "Asia/Shanghai"),
    frag("f2", "viewer", "tv-01", "s2", 1, "movie-1", [540, 900], "2026-09-20T10:10:00Z", "2026-09-20T10:16:00Z", "Asia/Shanghai"),
  ];
  const ledger = newLedger();
  ledger.ingestAll(batch);
  ledger.closePeriod("acct-1", "2026-09");
  ledger.recordInvoice("acct-1", "2026-09", "inv-1");
  ledger.recordRefund("acct-1", "2026-09", "rf-1");
  const before = ledger.toJSON();

  // 整批重放 + 重复单据
  ledger.ingestAll(batch);
  ledger.recordInvoice("acct-1", "2026-09", "inv-1");
  ledger.recordRefund("acct-1", "2026-09", "rf-1");

  assert.deepEqual(ledger.toJSON(), before);
  const bill = ledger.billFor("acct-1", "2026-09");
  assert.equal(totalSeconds(bill), 900);
  assert.equal(bill.adjustments.length, 0);
  assert.equal(ledger.state.periods["acct-1"]["2026-09"].refunds.length, 1);
});

test("设备时钟漂移：按同步点校正后再套用当时有效的归属规则", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    bind("b1", "car-01", "acct-owner"),
    // 成员规则 10:05 起生效
    ev("g1", "MEMBERSHIP_GRANTED", "acct-owner", {
      member_subject_id: "member-1",
      account_id: "acct-family",
      effective_from: "2026-09-20T10:05:00Z",
    }),
    // 车机时钟快 10 分钟：设备读数 10:10 时服务器才 10:00
    ev("s1", "SYNC_POINT", "ops", {
      device_id: "car-01",
      device_clock: "2026-09-20T10:10:00Z",
      server_clock: "2026-09-20T10:00:00Z",
    }),
    // 设备上报 10:10–10:20，校正后为 10:00–10:10，早于成员规则生效点
    frag("f1", "member-1", "car-01", "s1", 1, "movie-1", [0, 600], "2026-09-20T10:10:00Z", "2026-09-20T10:20:00Z", "Asia/Shanghai"),
  ]);
  assert.equal(totalSeconds(ledger.billFor("acct-owner", "2026-09")), 600);
  assert.equal(totalSeconds(ledger.billFor("acct-family", "2026-09")), 0);
});

test("跨时区旅行：同一时刻按片段当地日期落入不同账期", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    bind("b1", "phone-01", "acct-1"),
    // 2026-09-30 23:30 UTC：上海已是 10-01，纽约还是 09-30
    frag("f1", "viewer", "phone-01", "s1", 1, "cA", [0, 1200], "2026-09-30T23:30:00Z", "2026-09-30T23:50:00Z", "Asia/Shanghai"),
    frag("f2", "viewer", "phone-01", "s2", 1, "cB", [0, 1200], "2026-09-30T23:30:00Z", "2026-09-30T23:50:00Z", "America/New_York"),
  ]);
  const sep = ledger.billFor("acct-1", "2026-09");
  const oct = ledger.billFor("acct-1", "2026-10");
  assert.deepEqual(Object.keys(sep.lines[0]?.contents ?? {}), ["cB"]);
  assert.deepEqual(Object.keys(oct.lines[0]?.contents ?? {}), ["cA"]);
});

test("周期中途的成员关系变化：前后片段各自沿用当时有效的归属", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    bind("b1", "phone-m", "acct-m"),
    ev("g1", "MEMBERSHIP_GRANTED", "acct-owner", {
      member_subject_id: "member-1",
      account_id: "acct-family",
      effective_from: "2026-09-15T00:00:00Z",
    }),
    frag("f1", "member-1", "phone-m", "s1", 1, "c1", [0, 60], "2026-09-10T12:00:00Z", "2026-09-10T12:01:00Z", "Asia/Shanghai"),
    frag("f2", "member-1", "phone-m", "s2", 1, "c2", [0, 60], "2026-09-20T12:00:00Z", "2026-09-20T12:01:00Z", "Asia/Shanghai"),
  ]);
  assert.equal(totalSeconds(ledger.billFor("acct-m", "2026-09")), 60);
  assert.equal(totalSeconds(ledger.billFor("acct-family", "2026-09")), 60);
});

test("晚到离线数据：未封账就地修正，已开票/退款只追加调整且不重写原账单", () => {
  const ledger = new TimeLedger().setPackageRule({ ...PKG, rounding_seconds: 60 });
  ledger.ingestAll([
    bind("b1", "phone-01", "acct-1"),
    frag("f1", "viewer", "phone-01", "s1", 1, "mov-a", [0, 300], "2026-09-10T10:00:00Z", "2026-09-10T10:05:00Z", "Asia/Shanghai"),
  ]);
  assert.equal(totalSeconds(ledger.billFor("acct-1", "2026-09")), 300);

  // 离线片段先到、下载授权未到 → 隔离，不计账
  const late1 = frag("f2", "viewer", "phone-01", "s2", 1, "mov-off", [0, 120], "2026-09-12T08:00:00Z", "2026-09-12T08:02:00Z", "Asia/Shanghai", { offline: true, download_id: "dl-1" });
  assert.equal(ledger.ingest(late1).status, "quarantined");
  assert.deepEqual(ledger.exceptions().map((e) => e.kind), ["UNKNOWN_DOWNLOAD"]);

  // 下载授权晚到 → 放行，未封账周期就地修正
  ledger.ingest(ev("d1", "OFFLINE_DOWNLOAD", "viewer", {
    download_id: "dl-1", device_id: "phone-01", content_id: "mov-off", package_id: "pkg-video", granted_at: "2026-09-11T00:00:00Z",
  }));
  const corrected = ledger.billFor("acct-1", "2026-09");
  assert.equal(totalSeconds(corrected), 420);
  assert.equal(corrected.adjustments.length, 0);
  assert.equal(ledger.exceptions().length, 0);

  // 封账并开票
  ledger.closePeriod("acct-1", "2026-09");
  const invoice = ledger.recordInvoice("acct-1", "2026-09", "inv-1").invoice;
  assert.equal(invoice.lines[0].seconds, 420);

  // 开票后晚到的离线片段 → 追加调整，原账单行冻结
  ledger.ingest(frag("f3", "viewer", "phone-01", "s3", 1, "mov-off", [120, 240], "2026-09-13T08:00:00Z", "2026-09-13T08:02:00Z", "Asia/Shanghai", { offline: true, download_id: "dl-1" }));
  const billed = ledger.billFor("acct-1", "2026-09");
  assert.equal(totalSeconds(billed), 420); // 原账单不变
  assert.equal(currentSeconds(billed), 540); // 含调整的当前值
  assert.equal(billed.adjustments.length, 1);
  assert.deepEqual(billed.adjustments[0].lines_delta, { "pkg-video": 120 });

  // 退款后仍有晚到数据 → 继续追加调整；单据重放不产生第二笔退款
  ledger.recordRefund("acct-1", "2026-09", "rf-1");
  ledger.ingest(frag("f4", "viewer", "phone-01", "s4", 1, "mov-off", [240, 300], "2026-09-14T08:00:00Z", "2026-09-14T08:01:00Z", "Asia/Shanghai", { offline: true, download_id: "dl-1" }));
  const afterRefund = ledger.billFor("acct-1", "2026-09");
  assert.equal(afterRefund.status, "REFUNDED");
  assert.equal(afterRefund.adjustments.length, 2);
  assert.equal(currentSeconds(afterRefund), 600);
  assert.equal(ledger.recordRefund("acct-1", "2026-09", "rf-1").status, "duplicate");
  assert.equal(ledger.state.periods["acct-1"]["2026-09"].refunds.length, 1);
});

test("撤销家庭共享：新汇总立即停止，既有财务证据按最小范围查验", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    ev("g1", "MEMBERSHIP_GRANTED", "acct-owner", {
      member_subject_id: "member-1",
      account_id: "acct-family",
      effective_from: "2026-09-01T00:00:00Z",
    }),
    frag("f1", "member-1", "phone-x", "s1", 1, "movie-1", [0, 100], "2026-09-10T10:00:00Z", "2026-09-10T10:01:40Z", "Asia/Shanghai"),
    ev("r1", "MEMBERSHIP_REVOKED", "acct-owner", {
      member_subject_id: "member-1",
      account_id: "acct-family",
      effective_at: "2026-09-20T00:00:00Z",
    }),
    // 撤销后的新片段不再汇总到共享账户
    frag("f2", "member-1", "phone-x", "s2", 1, "movie-2", [0, 100], "2026-09-21T10:00:00Z", "2026-09-21T10:01:40Z", "Asia/Shanghai"),
  ]);

  assert.equal(totalSeconds(ledger.billFor("acct-family", "2026-09")), 100);
  assert.deepEqual(ledger.exceptions().map((e) => [e.fragment_key, e.kind]), [["phone-x/s2/1", "UNATTRIBUTED"]]);

  // 既有证据：全量查验被拒，最小范围可查
  assert.throws(() => ledger.explainLine("acct-family", "2026-09", "pkg-video"), /最小范围/);
  const minimal = ledger.explainLine("acct-family", "2026-09", "pkg-video", { scope: "minimal" });
  assert.equal(minimal.fragments.length, 1);
  assert.equal(minimal.fragments[0].fragment_key, "phone-x/s1/1");
  assert.equal(minimal.fragments[0].credited_seconds, 100);
  assert.equal("device_id" in minimal.fragments[0], false);
  // 显式声明用途的查验仍可进行（如申诉处理）
  const audited = ledger.explainLine("acct-family", "2026-09", "pkg-video", { purpose: "dispute" });
  assert.equal(audited.fragments[0].device_id, "phone-x");
});

test("逐片段申诉与裁定：留痕并触发调整，平台间差异可改判归属", () => {
  const ledger = newLedger();
  ledger.ingestAll([
    ev("g1", "MEMBERSHIP_GRANTED", "acct-owner", {
      member_subject_id: "member-1",
      account_id: "acct-family",
      effective_from: "2026-09-01T00:00:00Z",
    }),
    // 家庭成员借用车机，时长先记到了共享账户
    frag("f1", "member-1", "car-01", "s1", 1, "movie-1", [0, 300], "2026-09-10T10:00:00Z", "2026-09-10T10:05:00Z", "Asia/Shanghai"),
  ]);
  ledger.closePeriod("acct-family", "2026-09");
  ledger.recordInvoice("acct-family", "2026-09", "inv-1");

  // 申诉：这段应归成员个人账户
  ledger.fileAppeal({ appeal_id: "ap-1", fragment_key: "car-01/s1/1", reason: "借用设备，归属错误", filed_at: "2026-09-25T09:00:00Z" });
  ledger.adjudicate({ appeal_id: "ap-1", verdict: "REASSIGN", account_id: "acct-m", decided_at: "2026-09-26T09:00:00Z", note: "裁定改归成员账户" });

  // 原账户：已开票周期追加负向调整，原账单不变
  const familyBill = ledger.billFor("acct-family", "2026-09");
  assert.equal(totalSeconds(familyBill), 300);
  assert.deepEqual(familyBill.adjustments[0].lines_delta, { "pkg-video": -300 });
  assert.equal(currentSeconds(familyBill), 0);
  // 成员账户：未封账周期直接入账
  assert.equal(totalSeconds(ledger.billFor("acct-m", "2026-09")), 300);
  // 裁定留痕
  const appeal = ledger.state.appeals["ap-1"];
  assert.equal(appeal.status, "DECIDED");
  assert.equal(appeal.adjudication.verdict, "REASSIGN");
  // 重复裁定幂等
  assert.equal(ledger.adjudicate({ appeal_id: "ap-1", verdict: "REASSIGN", account_id: "acct-m", decided_at: "2026-09-26T09:00:00Z" }).status, "duplicate");
  assert.equal(familyBill.adjustments.length, 1);

  // 第二起申诉：片段作废，未封账周期就地修正
  ledger.fileAppeal({ appeal_id: "ap-2", fragment_key: "car-01/s1/1", reason: "非本人观看", filed_at: "2026-09-27T09:00:00Z" });
  ledger.adjudicate({ appeal_id: "ap-2", verdict: "VOID", decided_at: "2026-09-28T09:00:00Z" });
  assert.equal(totalSeconds(ledger.billFor("acct-m", "2026-09")), 0);
  const explain = ledger.explainLine("acct-m", "2026-09", "pkg-video");
  assert.equal(explain.fragments[0].status, "void");
});

test("可携带账本：序列化往返一致，重放同一事件流得到同一状态", () => {
  const events = [
    bind("b1", "tv-01", "acct-1"),
    ev("s1", "SYNC_POINT", "ops", { device_id: "tv-01", device_clock: "2026-09-20T10:10:00Z", server_clock: "2026-09-20T10:00:00Z" }),
    frag("f1", "viewer", "tv-01", "s1", 1, "movie-1", [0, 600], "2026-09-20T10:10:00Z", "2026-09-20T10:20:00Z", "Asia/Shanghai"),
    frag("f2", "viewer", "tv-01", "s2", 1, "movie-1", [540, 900], "2026-09-20T10:20:00Z", "2026-09-20T10:26:00Z", "Asia/Shanghai"),
  ];
  const ledger = newLedger();
  ledger.ingestAll(events);
  ledger.closePeriod("acct-1", "2026-09");
  ledger.recordInvoice("acct-1", "2026-09", "inv-1");

  // 序列化 → 迁移 → 恢复，账单一致
  const restored = TimeLedger.fromJSON(ledger.toJSON());
  assert.deepEqual(restored.billFor("acct-1", "2026-09"), ledger.billFor("acct-1", "2026-09"));

  // 空账本重放同一事件流 + 同一规则，状态逐字节一致
  const replayed = newLedger();
  replayed.ingestAll(events);
  replayed.closePeriod("acct-1", "2026-09");
  replayed.recordInvoice("acct-1", "2026-09", "inv-1");
  assert.deepEqual(replayed.toJSON(), ledger.toJSON());
});

test("样例批次端到端：格式合规、续播去重、重放幂等", async () => {
  const batch = JSON.parse(await readFile(new URL("../data/sample_report_batch.json", import.meta.url), "utf8"));
  for (const event of batch.events) assert.deepEqual(validateEvent(event), []);

  const ledger = new TimeLedger().setPackageRule({
    package_id: "pkg-video",
    content_ids: ["movie-1", "movie-2"],
    rounding_seconds: 60,
    effective_from: "2026-01-01T00:00:00Z",
  });
  ledger.ingestAll(batch.events);

  const bill = ledger.billFor("acct-demo", "2026-09");
  // movie-1 并集 600 秒 + movie-2 离线 120 秒
  assert.equal(totalSeconds(bill), 720);
  assert.deepEqual(ledger.exceptions(), []);

  const before = ledger.toJSON();
  ledger.ingestAll(batch.events); // 整批重放
  assert.deepEqual(ledger.toJSON(), before);
});
