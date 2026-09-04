/*
 * normalize.js — 单一数值标准化模块（CA.normalize）
 * 统一替代 parser.js / kezu-parser.js / app.js / aggregate.js 中分散的 toNum / toRatio 实现，
 * 解决「同一指标多处归一化口径微差」的根因。
 * 所有采集层只调用本模块，比率字段落库统一存小数(0–1)。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 通用数值清洗：去除 ¥ ￥ % , ， 空格；布尔→1/0；null/非法→null；数字原样返回。
  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).replace(/[¥￥%,，\s]/g, '');
    if (s === '' || s === '#DIV/0!' || s === '#VALUE!' || s === '/' ||
        s.toLowerCase() === 'n/a' || s.toLowerCase() === 'na' ||
        s === '-' || s === '—') return null;
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // 比率归一：统一返回 0–1 小数或 null。
  // opts: { canExceed100?:boolean, unit?:string }
  //   - 以 '%' 结尾 → 去 % 后 ÷100
  //   - 数字 > 1 且非 canExceed100 → ÷100（裸整数百分数，如 70 → 0.7）
  //   - unit === '比' → 保持原值（比值类不 ÷100）
  //   - 已是小数(≤1) / 完成率(canExceed100, 如 1.4) → 原值
  function toRatio(v, opts) {
    opts = opts || {};
    if (v == null || v === '') return null;
    let s = String(v).trim();
    let pct = false;
    if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
    const n = toNum(s);
    if (n == null) return null;
    if (pct) return n / 100;
    if (opts.unit === '比') return n;
    if (n > 1 && !opts.canExceed100) return n / 100;
    return n;
  }

  function toMoney(v) { return toNum(v); }
  function toInt(v) {
    const n = toNum(v);
    return (n == null) ? null : Math.round(n);
  }

  CA.normalize = { toNum, toRatio, toMoney, toInt };
})(window);
