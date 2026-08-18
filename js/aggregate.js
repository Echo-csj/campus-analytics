/*
 * aggregate.js — 汇聚与对比（派生，不修改原始记录）
 * 固定数据源：所有汇总指标均在此层从 store 的「月度周报」派生，UI 不散算。
 *   季度汇总 = 当季各月「月度周报」横向聚合（last / sum / avg / derived）
 *   年度汇总 = 全年各月「月度周报」横向聚合
 *   数据库视图 = 全年各月「月度周报」按标准字段逐项并排（compareYearStandard）
 * 月度周报 = 每月最后一周（weekSeq === totalWeeksOfMonth），统一口径见 monthEndWeeklies。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 标注每条周报是否为月度周报
  // 注意：克隆 values，避免下游归一化/派生改写原始 store 记录（保持派生层为纯函数）
  function withMonthEnd(recs) {
    return recs.map(r => {
      const w = r.values && r.values.weekSeq;
      const t = r.values && r.values.totalWeeksOfMonth;
      const isME = (w != null && t != null) ? (w === t) : false;
      return Object.assign({}, r, { isMonthEnd: isME, values: Object.assign({}, r.values) });
    });
  }

  // 取各区各月的月度周报（无则取该月周序号最大者）
  function monthEndWeeklies(weeklyRecs) {
    const byMonth = {};
    withMonthEnd(weeklyRecs).forEach(r => {
      const k = r.year + '-' + r.month;
      if (!byMonth[k]) byMonth[k] = [];
      byMonth[k].push(r);
    });
    const result = [];
    Object.keys(byMonth).forEach(k => {
      const arr = byMonth[k];
      let pick = arr.find(r => r.isMonthEnd);
      if (!pick) pick = arr.reduce((a, b) => (b.week > a.week ? b : a), arr[0]);
      result.push(pick);
    });
    result.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    // 兼容旧数据 + 统一口径：
    // 1) 比例字段防御性归一化为小数（旧数据可能把 70.39 当作 70.39% 存储）
    // 2) 「1V1月生产完成率」统一重写为 生产课时/目标课时（与季度/年度聚合一致），
    //    覆盖原表列可能触发的脏值（自定义%格式/带%号裸值）；任何下游（核心看板趋势图、
    //    数据库页签等）读取月度周报 v1MonthRate 都得到同一派生口径，形成单一数据源闭环。
    return result.map(r => {
      r = normalizeWeeklyValues(r);
      const prod = r.values.v1MonthProduced, tgt = r.values.v1MonthTarget;
      if (prod != null && tgt != null && tgt !== 0) {
        // 优先用 生产课时/目标课时 派生，与季度/年度聚合口径统一
        r.values.v1MonthRate = prod / tgt;
      } else {
        // 派生失败：回退修复已被错误缩小100倍的旧数据（完成率极少低于5%）
        const rate = r.values.v1MonthRate;
        if (typeof rate === 'number' && rate > 0 && rate < 0.05) {
          r.values.v1MonthRate = rate * 100;
        }
      }
      return r;
    });
  }

  // —— 人工月支持：把周报记录映射到「人工月」（周度=自然周 Mon–Sun，月度=人工月，最后一天为周日）——
  // 人工月最后一天（自然周周日）：自然月最后一天若在当周周二及之前→该周归上月，周三及之后→归本月
  function manualLastDay(Y, m) {
    const L = new Date(Y, m, 0); // 自然月最后一天（m 月：取 m 月第 0 天）
    const dw = L.getDay() === 0 ? 7 : L.getDay(); // 周一=1..周日=7
    if (dw <= 2) return new Date(L.getFullYear(), L.getMonth(), L.getDate() - dw); // 上一周日
    return new Date(L.getFullYear(), L.getMonth(), L.getDate() + (7 - dw)); // 本周日
  }
  function manualMonthOf(date) {
    let Y = date.getFullYear(), m = date.getMonth() + 1;
    const ML = manualLastDay(Y, m);
    if (date <= ML) {
      let pY = Y, pm0 = m - 1; if (pm0 < 1) { pm0 = 12; pY = Y - 1; }
      const prevML = manualLastDay(pY, pm0);
      if (date > prevML) return { year: Y, month: m };
      return { year: pY, month: pm0 };
    }
    let nY = Y, nm = m + 1; if (nm > 12) { nm = 1; nY = Y + 1; }
    return { year: nY, month: nm };
  }
  // 由周报记录的（自然年/自然月/weekSeq）重建该周「周日（周度最后一天）」日期
  function weekEndSunday(y, m, wk) {
    if (!y || !m || !wk) return null;
    const first = new Date(y, m - 1, 1);
    const dow = first.getDay(); // 0=Sun..6=Sat
    const monOffset = (8 - dow) % 7; // 当月第 1 周周一距 1 号的天数（Sun→1, Mon→0, …）
    const wk1Mon = new Date(y, m - 1, 1 + monOffset);
    return new Date(wk1Mon.getFullYear(), wk1Mon.getMonth(), wk1Mon.getDate() + (wk - 1) * 7 + 6);
  }
  // 人工月周数：该人工月含多少个自然周（周一至周日），纯日历推导
  function manualMonthWeekCount(Y, m) {
    let pY = Y, pm0 = m - 1; if (pm0 < 1) { pm0 = 12; pY = Y - 1; }
    const prevML = manualLastDay(pY, pm0);
    const MS = new Date(prevML.getFullYear(), prevML.getMonth(), prevML.getDate() + 1); // 人工月首周一
    const ML = manualLastDay(Y, m);
    const diff = Math.round((ML - MS) / 86400000);
    return (diff + 1) / 7; // diff 恒为 7 的倍数 → 整数
  }
  // 取各区各「人工月」的月度周报（人工月最后一周），供核心看板年度/季度看板使用
  function manualMonthEndWeeklies(weeklyRecs) {
    const byMM = {};
    withMonthEnd(weeklyRecs).forEach(r => {
      const sun = weekEndSunday(r.year, r.month, r.week);
      const mm = sun ? manualMonthOf(sun) : { year: r.year, month: r.month }; // 缺 weekSeq 退化为自然月
      const k = mm.year + '-' + mm.month;
      if (!byMM[k]) byMM[k] = { year: mm.year, month: mm.month, recs: [] };
      byMM[k].recs.push({ rec: r, sun: sun ? sun.getTime() : 0, wk: r.week || 0 });
    });
    const result = [];
    Object.keys(byMM).forEach(k => {
      const g = byMM[k];
      g.recs.sort((a, b) => (b.sun - a.sun) || (b.wk - a.wk)); // 周度最后一天最晚者 = 人工月最后一周
      const pick = g.recs[0].rec;
      result.push(Object.assign({}, pick, { year: g.year, month: g.month, isMonthEnd: true }));
    });
    result.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    // 与自然月月度周报保持同一派生口径（比例归一化 + 完成率重写）
    return result.map(r => {
      r = normalizeWeeklyValues(r);
      const prod = r.values.v1MonthProduced, tgt = r.values.v1MonthTarget;
      if (prod != null && tgt != null && tgt !== 0) r.values.v1MonthRate = prod / tgt;
      else { const rate = r.values.v1MonthRate; if (typeof rate === 'number' && rate > 0 && rate < 0.05) r.values.v1MonthRate = rate * 100; }
      return r;
    });
  }

  // 比例字段防御性归一化：统一存为小数(0–1)。旧数据/异常原表可能把 70.39 当 70.39% 存储。
  // 完成率字段（canExceed100）可>100%，值>1 表示完成倍数（如 1.4 → 140%），不做 ÷100。
  function normalizeRatio(key, val) {
    if (val == null || typeof val !== 'number' || !isFinite(val)) return val;
    const f = CA.SCHEMA.weeklyFields.find(x => x.key === key);
    if (!f || f.type !== 'ratio' || f.unit === '比') return val;
    if (f.canExceed100) return val;
    return val > 1 ? val / 100 : val;
  }

  // 清洗单条周报 values 中所有比例字段（用于兼容旧数据）
  function normalizeWeeklyValues(rec) {
    if (!rec || !rec.values) return rec;
    CA.SCHEMA.weeklyFields.forEach(f => {
      if (f.type === 'ratio' && f.unit !== '比' && rec.values[f.key] != null) {
        rec.values[f.key] = normalizeRatio(f.key, rec.values[f.key]);
      }
    });
    return rec;
  }

  // 年度对比（标准字段模式）：只显示《季度数据统计标准》中列出的月度原数据字段，
  // 并保持与 QUARTERLY_RULES 一致的顺序，便于与季度汇总口径对齐。
  function compareYearStandard(weeklyRecs, year) {
    const me = monthEndWeeklies(weeklyRecs).filter(r => r.year === year);
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    const rows = QUARTERLY_RULES.map(rule => {
      const f = CA.SCHEMA.weeklyFields.find(x => x.key === rule.key);
      const cells = columns.map(c => {
        const rec = recMap[c.key];
        if (!rec) return null;
        // 各字段统一取自月度周报（rec.values）。v1MonthRate 已在 monthEndWeeklies 统一
        // 派生为 生产课时/目标课时，与季度/年度聚合一致；原表列脏值被覆盖，无需特判。
        const rawVal = rec.values[rule.key];
        if (rawVal == null) return null;
        const val = normalizeRatio(rule.key, rawVal);
        const isRatio = f && f.type === 'ratio';
        const isBi = f && f.unit === '比';
        let num, text;
        if (isRatio) {
          num = isBi ? val : val * 100;
          text = isBi ? String(val) : (val * 100).toFixed(1) + '%';
        } else {
          num = val;
          text = String(val);
        }
        return { num: num, text: text, isPct: isRatio && !isBi };
      });
      return { key: rule.key, label: rule.src, isPct: f && f.type === 'ratio' && f.unit !== '比', values: cells };
    }).filter(r => r.values.some(c => c != null));
    return { columns, rows };
  }

  // 教师 KPI：月度汇总（按 年-月-教师）
  function kpiMonthly(kpiRecs) {
    const groups = {};
    kpiRecs.forEach(r => {
      const k = r.year + '-' + r.month + '-' + r.dimension;
      if (!groups[k]) groups[k] = { year: r.year, month: r.month, dimension: r.dimension, _weeks: [] };
      groups[k]._weeks.push(r);
    });
    return Object.values(groups).map(g => {
      const v = {};
      ['weekHours', 'weekSessions', 'weekRefSessions'].forEach(f => v[f] = g._weeks.reduce((s, r) => s + (r.values[f] || 0), 0));
      const last = [...g._weeks].reverse().find(r => r.values.progressRate != null);
      v.progressRate = last ? last.values.progressRate : null;
      const first = g._weeks[0];
      v.subjectGroup = first ? first.values.subjectGroup : null;
      v.saturation = v.weekRefSessions ? v.weekSessions / v.weekRefSessions : null;
      return { year: g.year, month: g.month, dimension: g.dimension, values: v };
    });
  }

  // 教师 KPI：半年度汇总（按 年-半年-教师）
  function kpiHalfYear(kpiRecs, year, half) {
    const months = half === 1 ? [1, 2, 3, 4, 5, 6] : [7, 8, 9, 10, 11, 12];
    const monthly = kpiMonthly(kpiRecs).filter(r => r.year === year && months.includes(r.month));
    const groups = {};
    monthly.forEach(r => {
      const k = r.dimension;
      if (!groups[k]) groups[k] = { dimension: r.dimension, _months: [] };
      groups[k]._months.push(r);
    });
    return Object.values(groups).map(g => {
      const v = {};
      ['weekHours', 'weekSessions', 'weekRefSessions'].forEach(f => v[f] = g._months.reduce((s, r) => s + (r.values[f] || 0), 0));
      v.saturation = v.weekRefSessions ? v.weekSessions / v.weekRefSessions : null;
      const last = [...g._months].reverse().find(r => r.values.progressRate != null);
      v.progressRate = last ? last.values.progressRate : null;
      v.subjectGroup = g._months[0] ? g._months[0].values.subjectGroup : null;
      const totalHours = v.weekHours;
      // 级别评定（专业分默认 0，可在半年复盘面板补；文化/日常默认满分）
      const lvl = CA.rulebook.teacherLevelTotal({
        progressRate: v.progressRate || 0,
        profScore: 0,
        saturation: v.saturation || 0,
        culture: 30, daily: 15,
      });
      return { year, half, dimension: g.dimension, values: v, level: lvl, totalHours };
    });
  }

  // 五项满意度：从月度周报自动提取（校区级，取「月」口径率）
  function satisfactionFromMonthEnd(weeklyRecs) {
    return monthEndWeeklies(weeklyRecs).map(r => {
      const out = { year: r.year, month: r.month };
      CA.SCHEMA.satisfactionItems.forEach(it => { out[it.key] = r.values[it.src]; });
      return out;
    });
  }

  // 年份 / 月份 选项
  function yearOptions(weeklyRecs) {
    const ys = new Set(weeklyRecs.map(r => r.year));
    return [...ys].sort((a, b) => a - b);
  }

  // —— 季度汇总（依据最新《季度数据统计标准·数据统计表》）——
  // 数据源：各月「月度周报」（每月最后一周 DOS 周报），其「月」口径字段即当月累计值。
  // 规则（严格对齐标准表 col C「季度数据填写标准」）：
  //   last    = 当季度最后一个月的数据（取季内最大月份的那份月度周报）
  //   sum     = 当季度三个月之和
  //   avg     = 当季度三个月的平均值（各类「率」直接对三个月的月度率取平均；
  //             月人均效能值 = 各月(月课时生产总现金 / 校区总人数) 之平均）
  //   derived = 仅 生产完成率 / 课时生产总现金 / 金额占比 / 离职人数率 四项仍按原表公式（=C…）
  // 说明：最新标准已将「续费/推荐/结课/退费各率、停课率、骨干/双三占比、现金均价、停课人数、
  //       骨干/双三人数、月人均效能值」全部改为「三个月平均」，不再用季度分子 / 季末基数相除。
  // label = 第二列「季度数据」名称（季度汇总显示/导出用）；src = 第一列「月度原数据」名称（提取映射/参考）。
  const QUARTERLY_RULES = [
    { key: 'teacherCount', label: '教师数', src: '教师数', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'campusTotal', label: '校区总人数', src: '校区总人数', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v1Students', label: '1v1在读学员', src: '1v1在读学员', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v1Subjects', label: '1v1在读单科', src: '1v1在读单科', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'subjectRatio', label: '单科比', src: '单科比', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v6Students', label: '1v6在读学员数', src: '1v6在读学员数', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v6Subjects', label: '1v6在读学单科', src: '1v6在读学单科', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v6SubjectRatio', label: '1v6单科比', src: '1v6单科比', rule: 'last', ruleText: '当季度最后一个月的数据' },
    { key: 'v1MonthTarget', label: '1V1季度目标课时', src: '1V1月目标课时', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'v1MonthProduced', label: '1v1季度生产课时', src: '1v1月生产课时', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'v6MonthProduced', label: '1v6季度生产课时', src: '1v6月生产课时', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'v1MonthRate', label: '1V1季度生产完成率', src: '1V1月生产完成率', rule: 'derived', expr: 'v1MonthProduced / v1MonthTarget', ruleText: '当季度生产课时 / 当季度目标课时' },
    { key: 'v1MonthCash', label: '1v1季度课时生产现金', src: '1v1月课时生产现金', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'v1MonthCashAvg', label: '1v1季度课时生产现金均价', src: '1v1月课时生产现金均价', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'v6MonthCash', label: '1v6季度课时生产现金', src: '1v6月课时生产现金', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'monthCashTotal', label: '季度课时生产总现金', src: '月课时生产总现金', rule: 'sum', ruleText: '当季度各月「月课时生产总现金」之和（尊重直接录入的总额，含 1V1/1V6 之外现金；缺总额时回退 1V1+1V6）' },
    { key: 'v1MonthCashRatio', label: '1v1季度课时生产金额占比', src: '1v1月课时生产金额占比', rule: 'derived', expr: 'v1MonthCash / monthCashTotal', ruleText: '1v1季度课时生产现金 / 季度课时生产总现金' },
    { key: 'monthEff', label: '季度人均效能值', src: '月人均效能值', rule: 'avg', ruleText: '当季度三个月的平均值（各月 月课时生产总现金/校区总人数 之平均）' },
    { key: 'v1MonthUnitAvg', label: '1v1季度单位周平均', src: '1v1月单位周平均', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'monthSaturation', label: '季度饱和度', src: '月饱和度', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'xfMonthNum', label: '1V1季度续费人数', src: '1V1月续费人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'xfMonthNumRate', label: '1V1季度续费人数率', src: '1V1月续费人数率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'xfMonthSubj', label: '1V1季度续费单科', src: '1V1月续费单科', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'xfMonthSubjRate', label: '1V1季度续费单科率', src: '1V1月续费单科率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tjMonthNum', label: '1V1季度推荐人数', src: '1V1月推荐人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'tjMonthNumRate', label: '1V1季度推荐人数率', src: '1V1月推荐人数率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tjMonthSubj', label: '1V1季度推荐单科', src: '1V1月推荐单科', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'tjMonthSubjRate', label: '1V1季度推荐单科率', src: '1V1月推荐单科率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'jkMonthSubj', label: '1V1季度结课单科', src: '1V1月结课单科', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'jkMonthSubjRate', label: '1V1季度结课单科率', src: '1V1月结课单科率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'jkMonthNum', label: '1V1季度结课人数', src: '1V1月结课人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'jkMonthNumRate', label: '1V1季度结课人数率', src: '1V1月结课人数率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tfMonthSubj', label: '1V1季度退费单科', src: '1V1月退费单科', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'tfMonthSubjRate', label: '1V1季度退费单科率', src: '1V1月退费单科率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tfMonthNum', label: '1V1季度退费人数', src: '1V1月退费人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'tfMonthNumRate', label: '1V1季度退费人数率', src: '1V1月退费人数率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tkNum', label: '1V1季度停课人数', src: '1V1停课人数', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'tkNumRate', label: '1V1季度停课人数率', src: '1V1停课人数率', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'entryMonth', label: '季度入职人数', src: '月入职人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'quitMonth', label: '季度离职人数', src: '月离职人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'quitMonthRate', label: '季度离职人数率', src: '月离职人数率', rule: 'derived', expr: 'quitMonth / (teacherCount + quitMonth)', ruleText: '季度离职人数 / (教师数 + 季度离职人数)' },
    { key: 'coreTeacherCount', label: '季度骨干教师人数', src: '骨干教师人数', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'coreTeacherRatio', label: '季度骨干教师占比', src: '骨干教师占比', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'doubleThreeCount', label: '季度双三老师人数', src: '双三老师人数', rule: 'avg', ruleText: '当季度三个月的平均值' },
    { key: 'doubleThreeRatio', label: '季度双三老师占比', src: '双三老师占比', rule: 'avg', ruleText: '当季度三个月的平均值' },
  ];

  // 安全表达式求值：expr 仅引用已汇总到 q 的季度值键；任一依赖为 null → 结果 null
  function evalExpr(expr, q) {
    const keys = Object.keys(q);
    let fn;
    try { fn = new Function(...keys, 'return (' + expr + ');'); }
    catch (e) { return null; }
    const args = keys.map(k => (q[k] == null || !isFinite(q[k])) ? NaN : q[k]);
    let r;
    try { r = fn(...args); } catch (e) { return null; }
    // 除零 / 缺失 → NaN → null
    return (typeof r === 'number' && isFinite(r)) ? r : null;
  }

  // 月度「课时生产总现金」统一口径：优先用月度周报**直接录入**的「月课时生产总现金」字段
  // （该字段可能包含 1V1 / 1V6 之外的现金，如班课等，故不能简单用 v1+v6 重算）；
  // 仅在缺失时回退 v1MonthCash + v6MonthCash，保证鲁棒。
  function monthCashOf(r) {
    const v = r && r.values;
    if (!v) return null;
    if (v.monthCashTotal != null && isFinite(v.monthCashTotal)) return v.monthCashTotal;
    const c = (v.v1MonthCash || 0) + (v.v6MonthCash || 0);
    return (v.v1MonthCash != null || v.v6MonthCash != null) ? c : null;
  }

  // 三个月平均：绝大多数 avg 字段直接取各月该键的值平均；
  // 月人均效能值（monthEff）非月度直接字段，按各月 (月课时生产总现金 / 校区总人数) 取平均。
  // 注意：分子用 monthCashOf（尊重直接录入的月度总现金），与「课时生产总现金」口径一致。
  function avgMonthly(months, key) {
    const vals = months.map(r => {
      if (key === 'monthEff') {
        const cash = monthCashOf(r);
        const pop = r.values.campusTotal;
        return (cash != null && pop != null && pop !== 0) ? cash / pop : null;
      }
      return normalizeRatio(key, r.values[key]);
    }).filter(v => v != null && isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  // 季度分组（按 年-季），返回可直接渲染的季度汇总记录
  function quarterlyAggregate(weeklyRecs, meOverride) {
    const me = meOverride || monthEndWeeklies(weeklyRecs);
    const map = {};
    me.forEach(r => {
      const q = Math.floor((r.month - 1) / 3) + 1;
      const k = r.year + '-' + q;
      if (!map[k]) map[k] = { year: r.year, quarter: q, months: [] };
      map[k].months.push(r);
    });
    return Object.values(map).map(g => {
      g.months.sort((a, b) => a.month - b.month);
      const qv = {};
      // 第一遍：标量聚合（last / sum / avg）
      QUARTERLY_RULES.forEach(rule => {
        if (rule.rule === 'last') {
          const last = [...g.months].reverse().find(r => r.values[rule.key] != null);
          qv[rule.key] = last ? last.values[rule.key] : null;
      } else if (rule.rule === 'sum') {
        const vals = g.months.map(r => (rule.key === 'monthCashTotal' ? monthCashOf(r) : r.values[rule.key])).filter(v => v != null && isFinite(v));
        qv[rule.key] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      } else if (rule.rule === 'avg') {
        qv[rule.key] = avgMonthly(g.months, rule.key);
      }
      });
      // 第二遍：派生字段（定点迭代，按依赖顺序收敛）
      let changed = true, guard = 0;
      while (changed && guard < 12) {
        changed = false; guard++;
        QUARTERLY_RULES.forEach(rule => {
          if (rule.rule === 'derived' && qv[rule.key] == null) {
            const v = evalExpr(rule.expr, qv);
            if (v != null) { qv[rule.key] = v; changed = true; }
          }
        });
      }
      // 生产完成率：仅基于同时有生产课时与目标课时的月份，避免缺失目标拉偏结果
      const validRateMonthsQ = g.months.filter(r => r.values.v1MonthProduced != null && r.values.v1MonthTarget != null);
      if (validRateMonthsQ.length) {
        const sumProd = validRateMonthsQ.reduce((s, r) => s + r.values.v1MonthProduced, 0);
        const sumTgt = validRateMonthsQ.reduce((s, r) => s + r.values.v1MonthTarget, 0);
        if (sumTgt) qv.v1MonthRate = sumProd / sumTgt;
      }
      g.values = qv;
      // 缺失的月份（季内应有的 3 个月中，没有月度周报的）
      const expected = [1, 2, 3].map(m => (g.quarter - 1) * 3 + m);
      g.missingMonths = expected.filter(m => !g.months.some(r => r.month === m));
      g.sourceMonths = g.months.map(r => r.month);
      return g;
    }).sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
  }

  // —— 年度汇总（依据《年度数据统计标准·数据统计表》）——
  // 规则与季度标准一致，仅 label 前缀改为「年度」、ruleText 改为「当年」口径。
  //   last = 当年最后一个月的数据
  //   sum  = 当年各月之和
  //   avg  = 当年各月的平均值（月人均效能值 = 各月(月课时生产总现金/校区总人数) 之平均）
  //   derived = 生产完成率/课时生产总现金/金额占比/离职人数率 四项按原表公式
  const YEARLY_RULES = [
    { key: 'teacherCount', label: '教师数', src: '教师数', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'campusTotal', label: '校区总人数', src: '校区总人数', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v1Students', label: '1v1在读学员', src: '1v1在读学员', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v1Subjects', label: '1v1在读单科', src: '1v1在读单科', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'subjectRatio', label: '单科比', src: '单科比', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v6Students', label: '1v6在读学员数', src: '1v6在读学员数', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v6Subjects', label: '1v6在读学单科', src: '1v6在读学单科', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v6SubjectRatio', label: '1v6单科比', src: '1v6单科比', rule: 'last', ruleText: '当年最后一个月的数据' },
    { key: 'v1MonthTarget', label: '1V1年度目标课时', src: '1V1月目标课时', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'v1MonthProduced', label: '1v1年度生产课时', src: '1v1月生产课时', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'v6MonthProduced', label: '1v6年度生产课时', src: '1v6月生产课时', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'v1MonthRate', label: '1V1年度生产完成率', src: '1V1月生产完成率', rule: 'derived', expr: 'v1MonthProduced / v1MonthTarget', ruleText: '年度生产课时总和 / 年度目标课时总和' },
    { key: 'v1MonthCash', label: '1v1年度课时生产现金', src: '1v1月课时生产现金', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'v1MonthCashAvg', label: '1v1年度课时生产现金均价', src: '1v1月课时生产现金均价', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'v6MonthCash', label: '1v6年度课时生产现金', src: '1v6月课时生产现金', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'monthCashTotal', label: '年度课时生产总现金', src: '月课时生产总现金', rule: 'sum', ruleText: '当年各月「月课时生产总现金」之和（尊重直接录入的总额，含 1V1/1V6 之外现金；缺总额时回退 1V1+1V6）' },
    { key: 'v1MonthCashRatio', label: '1v1年度课时生产金额占比', src: '1v1月课时生产金额占比', rule: 'derived', expr: 'v1MonthCash / monthCashTotal', ruleText: '1v1年度课时生产现金 / 年度课时生产总现金' },
    { key: 'monthEff', label: '年度人均效能值', src: '月人均效能值', rule: 'avg', ruleText: '当年各月的平均值（各月 月课时生产总现金/校区总人数 之平均）' },
    { key: 'v1MonthUnitAvg', label: '1v1年度单位周平均', src: '1v1月单位周平均', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'monthSaturation', label: '年度饱和度', src: '月饱和度', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'xfMonthNum', label: '1V1年度续费人数', src: '1V1月续费人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'xfMonthNumRate', label: '1V1年度续费人数率', src: '1V1月续费人数率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'xfMonthSubj', label: '1V1年度续费单科', src: '1V1月续费单科', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'xfMonthSubjRate', label: '1V1年度续费单科率', src: '1V1月续费单科率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tjMonthNum', label: '1V1年度推荐人数', src: '1V1月推荐人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'tjMonthNumRate', label: '1V1年度推荐人数率', src: '1V1月推荐人数率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tjMonthSubj', label: '1V1年度推荐单科', src: '1V1月推荐单科', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'tjMonthSubjRate', label: '1V1年度推荐单科率', src: '1V1月推荐单科率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'jkMonthSubj', label: '1V1年度结课单科', src: '1V1月结课单科', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'jkMonthSubjRate', label: '1V1年度结课单科率', src: '1V1月结课单科率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'jkMonthNum', label: '1V1年度结课人数', src: '1V1月结课人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'jkMonthNumRate', label: '1V1年度结课人数率', src: '1V1月结课人数率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tfMonthSubj', label: '1V1年度退费单科', src: '1V1月退费单科', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'tfMonthSubjRate', label: '1V1年度退费单科率', src: '1V1月退费单科率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tfMonthNum', label: '1V1年度退费人数', src: '1V1月退费人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'tfMonthNumRate', label: '1V1年度退费人数率', src: '1V1月退费人数率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tkNum', label: '1V1年度停课人数', src: '1V1停课人数', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'tkNumRate', label: '1V1年度停课人数率', src: '1V1停课人数率', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'entryMonth', label: '年度入职人数', src: '月入职人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'quitMonth', label: '年度离职人数', src: '月离职人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'quitMonthRate', label: '年度离职人数率', src: '月离职人数率', rule: 'derived', expr: 'quitMonth / (teacherCount + quitMonth)', ruleText: '年度离职人数 / (教师数 + 年度离职人数)' },
    { key: 'coreTeacherCount', label: '年度骨干教师人数', src: '骨干教师人数', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'coreTeacherRatio', label: '年度骨干教师占比', src: '骨干教师占比', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'doubleThreeCount', label: '年度双三老师人数', src: '双三老师人数', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'doubleThreeRatio', label: '年度双三老师占比', src: '双三老师占比', rule: 'avg', ruleText: '当年各月的平均值' },
  ];

  // 年度汇总：按年聚合所有月度周报
  function yearlyAggregate(weeklyRecs, year, meOverride) {
    const me = (meOverride || monthEndWeeklies(weeklyRecs)).filter(r => r.year === year);
    if (!me.length) return null;
    me.sort((a, b) => a.month - b.month);
    const months = me;
    const yv = {};
    // 第一遍：标量聚合
    YEARLY_RULES.forEach(rule => {
      if (rule.rule === 'last') {
        const last = [...months].reverse().find(r => r.values[rule.key] != null);
        yv[rule.key] = last ? last.values[rule.key] : null;
      } else if (rule.rule === 'sum') {
        const vals = months.map(r => (rule.key === 'monthCashTotal' ? monthCashOf(r) : r.values[rule.key])).filter(v => v != null && isFinite(v));
        yv[rule.key] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      } else if (rule.rule === 'avg') {
        yv[rule.key] = avgMonthly(months, rule.key);
      }
    });
    // 第二遍：派生字段
    let changed = true, guard = 0;
    while (changed && guard < 12) {
      changed = false; guard++;
      YEARLY_RULES.forEach(rule => {
        if (rule.rule === 'derived' && yv[rule.key] == null) {
          const v = evalExpr(rule.expr, yv);
          if (v != null) { yv[rule.key] = v; changed = true; }
        }
      });
    }
    // 年度生产完成率：仅基于同时有生产课时与目标课时的月份，避免缺失目标拉偏结果
    const validRateMonthsY = months.filter(r => r.values.v1MonthProduced != null && r.values.v1MonthTarget != null);
    if (validRateMonthsY.length) {
      const sumProd = validRateMonthsY.reduce((s, r) => s + r.values.v1MonthProduced, 0);
      const sumTgt = validRateMonthsY.reduce((s, r) => s + r.values.v1MonthTarget, 0);
      if (sumTgt) yv.v1MonthRate = sumProd / sumTgt;
    }
    const expected = Array.from({ length: 12 }, (_, i) => i + 1);
    const missingMonths = expected.filter(m => !months.some(r => r.month === m));
    return { year, values: yv, months, sourceMonths: months.map(r => r.month), missingMonths };
  }

  CA.aggregate = {
    monthEndWeeklies, manualMonthEndWeeklies, compareYearStandard,
    manualLastDay, manualMonthOf, manualMonthWeekCount, kpiMonthly, kpiHalfYear, satisfactionFromMonthEnd, yearOptions,
    QUARTERLY_RULES, quarterlyAggregate,
    YEARLY_RULES, yearlyAggregate,
  };

})(window);
