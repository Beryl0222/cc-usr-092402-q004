// 当地日期工具：跨时区旅行时，每个片段按自身时区落到当地历法日。

export function localDate(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// 账期按当地月份划分。
export function periodOf(localDateStr) {
  return localDateStr.slice(0, 7);
}

// instantMs 之后第一个当地午夜（当地日期发生变化的最早时刻）。
// 用二分查找实现，对夏令时跳变安全。
export function nextLocalMidnightMs(instantMs, timeZone) {
  const d0 = localDate(instantMs, timeZone);
  let lo = instantMs;
  let hi = instantMs + 48 * 3600 * 1000; // 当地一天最长 25 小时，48 小时必跨日
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timeZone) === d0) lo = mid;
    else hi = mid;
  }
  return hi;
}
