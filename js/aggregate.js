/*
 * aggregate.js — 汇聚与对比（派生，不修改原始记录）
 * 对比逻辑统一：下一层汇总单元横向并排
 *   月度对比 = 当月各周周报横向
 *   季度对比 = 当季各月「月度周报」横向
 *   年度对比 = 全年各月「月度周报」横向
 * 月度周报 = 每月最后一周（weekSeq === totalWeeksOfMonth）
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 标注每条周报是否为月度周报
  function withMonthEnd(recs) {
    return recs.map(r => {
      const w = r.values && r.values.weekSeq;
      const t = r.values && r.values.totalWeeksOfMonth;
      const isME = (w != null && t != null) ? (w === t) : false;
      return Object.assign({}, r, { isMonthEnd: isME });
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
    return result;
  }

  // 取某条周报的「原表事项」行；优先用解析时忠实保留的 rows，
  // 旧记录/示例数据无 rows 时，按 weeklyFields 从 values 回退合成（保证可对比）。
  function recToRows(rec) {
    if (rec.rows && rec.rows.length) return rec.rows;
    const v = rec.values || {};
    return CA.SCHEMA.weeklyFields.filter(f => v[f.key] != null).map(f => {
      const isPct = f.type === 'ratio';
      const raw = v[f.key];
      const base = (typeof raw === 'number') ? raw : CA.parser.toNum(raw);
      let num, text;
      if (isPct) {
        // 归一为小数（兼容旧数据可能直接存了百分数）；text 显示百分数，num 为百分数供图表
        const pn = (base != null && base > 1) ? base / 100 : base;
        num = (pn != null) ? pn * 100 : null;
        text = (pn != null) ? (pn * 100).toFixed(1) + '%' : (raw == null ? '' : String(raw));
      } else {
        num = base; text = (raw == null ? '' : String(raw));
      }
      return { label: f.label, raw: text, num: num, isPct: isPct, text: text };
    });
  }

  // 横向对比表构造器（忠实原表）：按列顺序取并集标签，逐行对齐；
  // 某列未出现的项 → 该单元格留空（null），渲染时显示空白。
  function buildCompareRaw(columns, recMap) {
    const seen = new Set();
    const order = [];
    columns.forEach(c => {
      const rec = recMap[c.key];
      const rows = rec ? recToRows(rec) : [];
      rows.forEach(r => {
        const lab = String(r.label).trim();
        if (lab && !seen.has(lab)) { seen.add(lab); order.push(lab); }
      });
    });
    const table = order.map(lab => {
      const cells = columns.map(c => {
        const rec = recMap[c.key];
        if (!rec) return null;
        const hit = recToRows(rec).find(r => String(r.label).trim() === lab);
        return hit ? { num: hit.num, text: hit.text, isPct: !!hit.isPct } : null;
      });
      return { key: lab, label: lab, isPct: cells.some(c => c && c.isPct), values: cells };
    });
    return { columns, rows: table };
  }

  // 月度对比：某年某月各周横向
  function compareMonthly(weeklyRecs, year, month) {
    const recs = weeklyRecs.filter(r => r.year === year && r.month === month)
      .sort((a, b) => a.week - b.week);
    const columns = recs.map(r => ({ key: r.week, label: '第' + r.week + '周' }));
    const recMap = {}; recs.forEach(r => recMap[r.week] = r);
    return buildCompareRaw(columns, recMap);
  }

  // 季度对比：某年某季各月月度周报横向
  function compareQuarter(weeklyRecs, year, quarter) {
    const months = [1, 2, 3].map(m => (quarter - 1) * 3 + m);
    const me = monthEndWeeklies(weeklyRecs).filter(r => r.year === year && months.includes(r.month));
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    return buildCompareRaw(columns, recMap);
  }

  // 年度对比：某年各月月度周报横向
  function compareYear(weeklyRecs, year) {
    const me = monthEndWeeklies(weeklyRecs).filter(r => r.year === year);
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    return buildCompareRaw(columns, recMap);
  }

  // 最佳科组：月度自动汇总（按 年-月-科组）
  // 课时/结课/退费/停课/续费/推荐 = 流量（各周累加）；单科数/教师数/离职/进步率 = 存量（取月末周快照）
  // 月周平均 = (Σ周课时 / 当月周数) / 单科数快照  ← 对齐 PK-最佳科组细则（周平均=月课时/(单科数×周数)）
  const ADD_FIELDS = ['hours', 'jkSubj', 'tfSubj', 'tkSubj', 'xfSubj', 'tjSubj'];
  const SNAP_FIELDS = ['subjects', 'teacherCount', 'quitCount', 'progressRate'];
  function kezuMonthly(kezuRecs) {
    const groups = {};
    kezuRecs.forEach(r => {
      const k = r.year + '-' + r.month + '-' + r.dimension;
      if (!groups[k]) groups[k] = { year: r.year, month: r.month, dimension: r.dimension, _weeks: [] };
      groups[k]._weeks.push(r);
    });
    return Object.values(groups).map(g => {
      const v = {};
      const weekCount = g._weeks.length;
      ADD_FIELDS.forEach(f => v[f] = g._weeks.reduce((s, r) => s + (r.values[f] || 0), 0));
      SNAP_FIELDS.forEach(f => {
        const last = [...g._weeks].reverse().find(r => r.values[f] != null);
        v[f] = last ? last.values[f] : null;
      });
      v.weekAvg = (v.subjects && weekCount) ? (v.hours / weekCount) / v.subjects : 0;
      return { year: g.year, month: g.month, dimension: g.dimension, values: v };
    });
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
    { key: 'monthCashTotal', label: '季度课时生产总现金', src: '月课时生产总现金', rule: 'derived', expr: 'v1MonthCash + v6MonthCash', ruleText: '1v1季度课时生产现金 + 1v6季度课时生产现金' },
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

  // 三个月平均：绝大多数 avg 字段直接取各月该键的值平均；
  // 月人均效能值（monthEff）非月度直接字段，按各月 (月课时生产总现金 / 校区总人数) 取平均。
  function avgMonthly(months, key) {
    const vals = months.map(r => {
      if (key === 'monthEff') {
        const cash = (r.values.v1MonthCash || 0) + (r.values.v6MonthCash || 0);
        const pop = r.values.campusTotal;
        return (pop != null && pop !== 0) ? cash / pop : null;
      }
      return r.values[key];
    }).filter(v => v != null && isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  // 季度分组（按 年-季），返回可直接渲染的季度汇总记录
  function quarterlyAggregate(weeklyRecs) {
    const me = monthEndWeeklies(weeklyRecs);
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
          const vals = g.months.map(r => r.values[rule.key]).filter(v => v != null && isFinite(v));
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
      g.values = qv;
      // 缺失的月份（季内应有的 3 个月中，没有月度周报的）
      const expected = [1, 2, 3].map(m => (g.quarter - 1) * 3 + m);
      g.missingMonths = expected.filter(m => !g.months.some(r => r.month === m));
      g.sourceMonths = g.months.map(r => r.month);
      return g;
    }).sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
  }

  // 可选季度（年-季）列表
  function quarterOptions(weeklyRecs) {
    const me = monthEndWeeklies(weeklyRecs);
    const set = new Set();
    me.forEach(r => set.add(r.year + '-' + (Math.floor((r.month - 1) / 3) + 1)));
    return [...set].sort().reverse().map(s => { const [y, q] = s.split('-'); return { year: +y, quarter: +q }; });
  }

  CA.aggregate = {
    withMonthEnd, monthEndWeeklies, compareMonthly, compareQuarter, compareYear, recToRows, buildCompareRaw,
    kezuMonthly, kpiMonthly, kpiHalfYear, satisfactionFromMonthEnd, yearOptions,
    QUARTERLY_RULES, quarterlyAggregate, quarterOptions, evalExpr,
  };

})(window);
