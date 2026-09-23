// 设备时钟与跨时区处理。
//
// 每台设备的 SESSION_SYNC 同步点给出 (设备时钟, 平台时基, 时区)。
// 设备读数先经“分段线性对表”换算为平台参考时刻：
//   - 两个同步点之间按实测走速线性插值（吸收时钟漂移）；
//   - 区间外用最近实测走速外推（无实测则按走速 1）。
// 归属与封账一律以参考时刻为准，设备时钟快慢不会改变用量。
//
// 时区以“该参考时刻最近一次同步声明的 IANA 时区”为准；时区在同步点切换，
// 片段跨越切换点时先切片，再按当地日历日切分。周期键按当地日期生成。

const MS_DAY = 86_400_000;

export function toMs(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${iso}`);
  return ms;
}

export function buildClock(syncPoints) {
  const syncs = syncPoints
    .map((s) => ({
      d: toMs(s.device_clock),
      r: toMs(s.reference_clock),
      tz: s.iana_timezone,
    }))
    .sort((a, b) => a.d - b.d);

  function rate(i) {
    // 第 i 段（syncs[i] -> syncs[i+1]）的设备走速
    const dd = syncs[i + 1].d - syncs[i].d;
    if (dd <= 0) return 1;
    return (syncs[i + 1].r - syncs[i].r) / dd;
  }

  function toReference(deviceIso) {
    const D = toMs(deviceIso);
    if (syncs.length === 0) return D; // 无同步点：设备时钟已含偏移，原样使用
    if (syncs.length === 1) return syncs[0].r + (D - syncs[0].d);

    if (D < syncs[0].d) {
      const a = rate(0);
      return syncs[0].r + (D - syncs[0].d) * a;
    }
    for (let i = 0; i < syncs.length - 1; i++) {
      if (D < syncs[i + 1].d) {
        return syncs[i].r + (D - syncs[i].d) * rate(i);
      }
    }
    const last = syncs.length - 1;
    const a = rate(last - 1);
    return syncs[last].r + (D - syncs[last].d) * a;
  }

  // 参考时刻 -> 当时生效时区（取不晚于该时刻的最后一次同步）
  function timezoneAt(refMs) {
    let tz = syncs[0]?.tz ?? "UTC";
    for (const s of syncs) {
      if (s.r <= refMs) tz = s.tz;
      else break;
    }
    return tz;
  }

  // 时区切换点（参考时刻），用于跨时区切片
  function changePoints() {
    const out = [];
    for (let i = 1; i < syncs.length; i++) {
      if (syncs[i].tz !== syncs[i - 1].tz) out.push(syncs[i].r);
    }
    return out;
  }

  return { toReference, timezoneAt, changePoints, hasSync: syncs.length > 0 };
}

// 在若干切点处把 [start, end) 切成若干不重叠半开区间。
export function splitInterval(start, end, cutPoints) {
  const cuts = [...new Set(cutPoints)].filter((t) => t > start && t < end).sort((a, b) => a - b);
  const parts = [];
  let cursor = start;
  for (const t of cuts) {
    parts.push([cursor, t]);
    cursor = t;
  }
  parts.push([cursor, end]);
  return parts.filter(([a, b]) => b > a);
}

const dateFmtCache = new Map();
function dateParts(refMs, tz) {
  let fmt = dateFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFmtCache.set(tz, fmt);
  }
  const p = fmt.formatToParts(new Date(refMs));
  const get = (t) => p.find((x) => x.type === t).value;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

export function localDateKey(refMs, tz) {
  const { y, m, d } = dateParts(refMs, tz);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// 求某时区在参考时刻的 UTC 偏移（local = UTC + offset），单位毫秒。
function tzOffsetMs(refMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(refMs)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  const hour = Number(p.hour === "24" ? "00" : p.hour); // 部分环境午夜输出 24
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - Math.floor(refMs / 1000) * 1000;
}

// 当地日历日 00:00 对应的参考时刻（UTC 毫秒）。
export function localMidnightMs(y, m1, d1, tz) {
  const wallMidnight = Date.UTC(y, m1 - 1, d1, 0);
  // 先用 UTC 正午（永不落在 DST 缺口）读偏移作初值，再在午夜处复核收敛。
  const noon = Date.UTC(y, m1 - 1, d1, 12);
  let midnight = wallMidnight - tzOffsetMs(noon, tz);
  for (let i = 0; i < 3; i++) {
    const next = wallMidnight - tzOffsetMs(midnight + 60_000, tz);
    if (next === midnight) break;
    midnight = next;
  }
  return midnight;
}

// ISO-8601 周编号
function isoWeekKey(y, m0, d) {
  const date = new Date(Date.UTC(y, m0, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = date.getTime();
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = 1 + Math.round((firstThursday - yearStart) / MS_DAY / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function periodKey(type, refMs, tz) {
  const { y, m, d } = dateParts(refMs, tz);
  if (type === "DAY") return localDateKey(refMs, tz);
  if (type === "MONTH") return `${y}-${String(m).padStart(2, "0")}`;
  if (type === "WEEK") {
    // 以当地日期对应的 ISO 周
    return isoWeekKey(y, m - 1, d);
  }
  throw new Error(`未知周期类型: ${type}`);
}

// 把参考时区间间 [start,end)（单一时区）按当地周期边界切成
// { periodKey, tz, start, end, durationMs }
export function splitByPeriod(type, tz, start, end) {
  if (end <= start) return [];
  const startPeriod = periodKey(type, start, tz);
  const endPeriod = periodKey(type, Math.max(start, end - 1), tz);
  if (startPeriod === endPeriod) {
    return [{ periodKey: startPeriod, tz, start, end, durationMs: end - start }];
  }

  const parts = [];
  let cursor = start;
  let guard = 0;
  while (cursor < end) {
    const cur = periodKey(type, cursor, tz);
    const { y, m, d } = dateParts(cursor, tz);
    let nextMidnight;
    if (type === "DAY") {
      nextMidnight = localMidnightMs(y, m, d + 1, tz);
    } else if (type === "WEEK") {
      // 当地日期逐天前进，直到周期键变化，即下一个周一 00:00
      let cand = localMidnightMs(y, m, d + 1, tz);
      while (periodKey(type, cand + MS_DAY / 2, tz) === cur) cand += MS_DAY;
      nextMidnight = cand;
    } else if (type === "MONTH") {
      let cand = localMidnightMs(y, m + 1 > 12 ? 1 : m + 1, m + 1 > 12 ? d : 1, tz);
      // 简化：直接逐月定位
      const nextM = m === 12 ? [y + 1, 1] : [y, m + 1];
      cand = localMidnightMs(nextM[0], nextM[1], 1, tz);
      nextMidnight = cand;
    } else {
      throw new Error(`未知周期类型: ${type}`);
    }
    const cut = Math.min(nextMidnight, end);
    parts.push({ periodKey: cur, tz, start: cursor, end: cut, durationMs: cut - cursor });
    cursor = cut;
    if (++guard > 400) throw new Error("周期切分异常");
  }
  return parts;
}

// 顶层便捷方法：把一个参考时间区间先按时区切换、再按当地周期切开。
export function sliceByTimezoneAndPeriod(clock, start, end, periodType) {
  const tzCuts = clock.changePoints();
  return splitInterval(start, end, tzCuts).flatMap(([a, b]) => {
    const tz = clock.timezoneAt(a);
    return splitByPeriod(periodType, tz, a, b);
  });
}
