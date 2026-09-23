// 半开区间 [start, end) 的集合运算，单位为内容位置秒。
// 时长去重的核心：同一账户对同一段内容只扣减一次。

export function mergeIntervals(list) {
  const sorted = list
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// 返回 base 中未被 covers 覆盖的部分；covers 必须为已合并的不交区间。
export function subtractInterval(base, covers) {
  const parts = [];
  let [s, e] = base;
  for (const [cs, ce] of covers) {
    if (ce <= s) continue;
    if (cs >= e) break;
    if (cs > s) parts.push([s, Math.min(cs, e)]);
    s = Math.max(s, ce);
    if (s >= e) return parts;
  }
  if (s < e) parts.push([s, e]);
  return parts;
}

export function measure(list) {
  return list.reduce((acc, [s, e]) => acc + (e - s), 0);
}
