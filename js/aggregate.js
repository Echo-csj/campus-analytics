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

  // 横向对比表构造器
  function buildCompare(columns, records, fieldList) {
    const rows = fieldList.map(f => {
      const vals = columns.map(c => {
        const rec = records[c.key];
        return rec ? rec.values[f.key] : null;
      });
      return { key: f.key, label: f.label, group: f.group, unit: f.unit, type: f.type, values: vals };
    });
    return { columns, rows };
  }

  // 月度对比：某年某月各周横向
  function compareMonthly(weeklyRecs, year, month) {
    const recs = weeklyRecs.filter(r => r.year === year && r.month === month)
      .sort((a, b) => a.week - b.week);
    const columns = recs.map(r => ({ key: r.week, label: '第' + r.week + '周' }));
    const recMap = {}; recs.forEach(r => recMap[r.week] = r);
    return buildCompare(columns, recMap, CA.SCHEMA.weeklyFields.filter(f => f.group !== '基础信息' || ['totalWeeksOfMonth', 'weekSeq'].includes(f.key)));
  }

  // 季度对比：某年某季各月月度周报横向
  function compareQuarter(weeklyRecs, year, quarter) {
    const months = [1, 2, 3].map(m => (quarter - 1) * 3 + m);
    const me = monthEndWeeklies(weeklyRecs).filter(r => r.year === year && months.includes(r.month));
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    return buildCompare(columns, recMap, CA.SCHEMA.weeklyFields.filter(f => f.group !== '基础信息'));
  }

  // 年度对比：某年各月月度周报横向
  function compareYear(weeklyRecs, year) {
    const me = monthEndWeeklies(weeklyRecs).filter(r => r.year === year);
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    return buildCompare(columns, recMap, CA.SCHEMA.weeklyFields.filter(f => f.group !== '基础信息'));
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

  CA.aggregate = {
    withMonthEnd, monthEndWeeklies, compareMonthly, compareQuarter, compareYear,
    kezuMonthly, kpiMonthly, kpiHalfYear, satisfactionFromMonthEnd, yearOptions,
  };

})(window);
