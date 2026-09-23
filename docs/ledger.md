# 可携带时长账本设计说明

本文档说明事件目录、处理管线与账本不变量。所有时间处理以"平台参考时刻"（UTC 毫秒）为内部基准；当地日期只在归周期时使用。

## 1. 事件目录

### 1.1 终端上报层

| 事件 | 关键字段 | 含义 |
| --- | --- | --- |
| `PLAYBACK_SEGMENT` | `device_sn`、`session_id`、`content_id`、`state`(PLAYING/PAUSED)、`seg_start/seg_end`（设备时钟）、`pos_start_ms/pos_end_ms`（内容内位置） | 一段播放或暂停观察，半开区间 `[start,end)`。可选 `viewer_id`（观看人档案声明）、`pack_id`、`resume_chain`（跨终端续播链路）、`offline`+`download_id` |
| `SESSION_SYNC` | `device_clock`、`reference_clock`、`drift_ppm_tolerance`、`iana_timezone` | 对表点：同一瞬间的设备读数与平台时基，并声明设备当时所在时区 |
| `OFFLINE_DOWNLOAD` | `download_id`、`licensed_from/to` | 内容离线计秒授权窗；窗外的离线播放只留证 |

### 1.2 规则层（全部版本化）

- `RELATIONSHIP_RULE`：`member_id`（实际观看人）、`relationship`、`attribution`（`TO_OWNER` 计入设备属主 / `TO_MEMBER`、`TO_GUEST_QUOTA` 计入观看人 / `NONE` 已撤销）。
- `DEVICE_BINDING`：`device_sn` 的属主账号与 `sharing`（`PERSONAL`/`FAMILY_SHARED`/`GUEST_ALLOWED`）。
- `CONTENT_PACK_RULE`：`billable`、`rate`（计秒倍率）、`category`。

同一 `rule_id` 的事件按 `version`/`valid_from` 排序，新版本生效刻自动收口旧版本（`[valid_from, next.valid_from)`）；显式 `valid_to` 或 `PROFILE_WITHDRAWN` 也会收口。

### 1.3 账本层

- `PERIOD_CLOSED`：对 `(subject_id, period_type, period_key)` 封账。封账只对**收到时刻 ≤ 封账时刻**的事件做一次物化并冻结数字与原子清单。
- `LEDGER_ADJUSTMENT`：人工调整（如善意补偿），带 `delta_ms`，只追加。
- `DISPUTE_RULING`：`case_id` + `segment_ref` + `decision`（`SUSTAINED`/`REJECTED`），逐片段裁定。
- `EVIDENCE_GRANT`：`scope.kind=PERIOD` 的最小范围授权（账号 + 周期类型 + 周期键）、`granted_to`、`valid_until`。

## 2. 处理管线

```
事件(按 event_id 去重、字段校验)
  → 每设备同步点建立时钟模型
  → 设备读数换算为参考时刻（分段线性，含漂移率）
  → 切片：时区切换点 ∪ 规则版本边界 ∪ 离线授权窗边界
      每片内：时区、归属规则、授权状态恒定
  → 归属解析（观看人 / 扣减账号 / 内容包）
  → 再按当地周期边界（日/周/月）切片
  → 位置区间去重（首写者胜出）
  → 计量原子 atom（含 gross / covered / charge / increment）
  → 开放周期实时汇总；封账周期冻结 + 追加调整
```

### 2.1 时钟漂移

同步点序列 `(device, reference)`：

- 相邻同步点之间按实测走速 `Δref/Δdevice` 线性插值；
- 区间外用最近走速外推（无同步点时按 1:1，设备时钟字符串自身带偏移）；
- 设备快慢只改变换算结果，不改变用量。

### 2.2 时区与当地日期

- 参考时刻 `t` 的时区 = 不晚于 `t` 的最后一次同步声明的 IANA 时区；
- 片段跨越时区切换点先切开，再用各时区当地日历日（支持 DST，午夜定位在切换日收敛复核）切分；
- 周期键：日 `YYYY-MM-DD`、ISO 周 `YYYY-Www`、月 `YYYY-MM`，均按当地日期。

### 2.3 归属

每片中点取当时有效的设备绑定与关系版本：

- 设备无绑定 → `UNBOUND_DEVICE`（只留证）；
- 观看人 = 设备属主 → `OWNER_SESSION`；
- 他人使用且无当时有效关系 → `NO_RELATIONSHIP`；曾有过关系但已收口 → `REVOKED`；
- `TO_OWNER` 计入设备属主；`TO_MEMBER`/`TO_GUEST_QUOTA` 计入观看人本人；`NONE` → `REVOKED`；
- 内容包 `billable=false` → `ZERO_RATED`（留证不扣）。

原子记录 `rule_event_ids` 与 `sync_event_ids`，任何归属结论都可追溯到当时生效的规则版本与对表点。

### 2.4 去重：任何一段内容只扣一次

去重单位 = `(viewer_id, content_id, resume_chain)`：

- **时间轴交叠**：并发上报、同一观察弱网重发（即使换了事件 ID）；
- **内容位置轴交叠**：断点续播起点回退、跳转回看；
- 两者取并集投影到候选原子的位置轴，首写者胜出（顺序由 `(received_at, event_id)` 确定），被覆盖部分记录 `covered_ms` 与 `covered_by`。
- 另一条 `resume_chain`（不同时间的真正重看）不在同一去重组，照常计费。
- PAUSED、零率、留证原子不占覆盖；**被申诉冲销的原子仍占据覆盖**，防止"先申诉退款、再换事件 ID 重报"再生费。
- 片段被规则边界切开时，内容位置相对**整段**线性映射（不会因切片自身归一化而误判重叠）。

## 3. 封账、调整与重放

### 3.1 封账快照

`PERIOD_CLOSED` 物化 `received_at ≤ 封账时刻` 的事件子集，保存：

- `snapshot_total`：账单金额（永不改变）；
- `snapshot_atoms`：原子 ID → 增量金额。

### 3.2 晚到事实

- 开放周期：整库物化天然包含晚到事件，直接重算；
- 封账周期：比较"快照原子身份集合"与"全量物化集合"的确定性差集——
  - 快照有、全量无/金额变：`CORRECTION`（如晚到同步点修正了参考时刻）；
  - 全量新增且来源事件晚于封账：`LATE_REPORT`；
  - 来源为申诉裁定：`DISPUTE_REFUND`（负向）；
  - 人工事件：`LEDGER_ADJUSTMENT` 原样追加。

调整 ID 由 `(封账事件, 原子, 原因)` FNV-1a 派生，重放稳定；原账单一行不改。

### 3.3 申诉裁定

- `SUSTAINED`：原原子保留 `+C` 并标记 `voided_by`，另生成 `-C` 的 `DISPUTE_REVERSAL` 原子（净额 0），其覆盖不释放；
  - 开放周期：净额直接反映在实时汇总；
  - 封账周期：冲销原子进入差集，形成 `DISPUTE_REFUND` 调整；
- `REJECTED`：无任何账务效果，但裁定事件留档；
- 重复裁定（同 event_id 重放）幂等。

### 3.4 重放恒等性

`materialize(events)` 是纯函数：固定输入 → 固定原子 ID、固定金额、固定调整。`TimeLedger` 对重复封账、重复人工调整按事件 ID 去重。因此：

```
materialize(E) === materialize(E ⧺ E ⧺ E)      // 原子与汇总一致
explainLine 输出 JSON 重放前后逐字节一致
快照总额 + 调整序列之和 === 全量物化结果          // 封账行恒等
```

## 4. 撤销共享与证据查验

- 撤销 = 关系新版本 `attribution=NONE`（或 `PROFILE_WITHDRAWN`）在撤销刻收口旧版本；之后片段立即 `REVOKED`，不再产生任何扣减；
- 撤销前的账单、原子、原始片段全部保留（财务证据链不断）；
- 查验：账号本人随时可查；任何第三方必须持有 `granted_to=本人`、未过期、且 `scope` 精确覆盖该账单行（账号+周期类型+周期键）的授权，否则抛 `EVIDENCE_DENIED`。

## 5. 客服追溯视图

`ledger.explainLine(account, periodKey)` 返回：

- `state`：OPEN / CLOSED；
- `frozen_bill`：封账事件与冻结金额；
- `adjustment_versions`：每笔调整的 ID、原因、差额、来源（可逐级展开到原子与事件）；
- `current_total_ms`：开放期实时值 / 封账期"快照 + 调整"；
- `atoms[]`：每个原子的设备、会话、续播链、参考时间窗、内容位置窗、当地周期、`gross/covered/charge`、`covered_by`、人类可读 `dedup_reason`、内容包版本、归属原因、离线授权，以及 `evidence`（原始上报事件 + 对表点 + 规则依据事件）。

## 6. 状态码一览

| 状态 | 计量 | 含义 |
| --- | --- | --- |
| `BILLED` | 是（按 rate，去重后） | 正常计费 |
| `ZERO_RATED` | 否 | 内容包不计费（儿童包等），留证 |
| `PAUSED` | 否 | 暂停间隙，留证 |
| `OFFLINE_UNLICENSED` | 否 | 离线播放落在下载授权窗外（含部分落出的片段） |
| `UNBOUND_DEVICE` / `UNKNOWN_PACK` | 否 | 无法解析设备或内容包 |
| `NO_RELATIONSHIP` / `REVOKED` | 否 | 无归属关系 / 共享已撤销，进入申诉视野 |
| `DISPUTE_REVERSAL` | 负向冲销 | 申诉成立的对冲原子 |
