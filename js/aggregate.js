/*
 * aggregate.js — 汇聚与对比（派生，不修改原始记录）
 *
 * —— 两套数据源体系（关联边界，数据流转据此分层）——
 *   周度数据 (store stream = 'weekly')：DOS 周报各周。
 *      关联边界：仅「周报对比」。绝不进入任何月度 / 季度 / 年度 / 满意度计算。
 *   月度数据 (store stream = 'monthly')：每月最后一周周报。
 *      判定口径：报表自带 weekSeq === totalWeeksOfMonth（忽略上传时间、不做任何日历日期重建）。
 *      关联边界：季度汇总 / 年度汇总 / 五项满意度 / 数据库视图(年度各月对比) / 科组月度跟踪。
 *      生成方式：由「数据源 → 月度数据」面板的「从周报生成月度数据」按钮【显式派生】自 weekly 流
 *                （取每月月末周 weekSeq===totalWeeksOfMonth 写入 monthly 流，带生成日志），校区层单一源头=周报。
 *   固定数据源：所有月度汇总指标均从 monthly 流派生，UI 不散算。
 *      季度汇总 = 当季各月「月度数据」横向聚合（last / sum / avg / derived）
 *      年度汇总 = 全年各月「月度数据」横向聚合
 *      数据库视图 = 全年各月「月度数据」按标准字段逐项并排（compareYearStandard）
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 两套数据源体系的关联边界（供 UI 文案与自检参考）
  const DATA_LAYERS = {
    weekly: { stream: 'weekly', label: '周度数据', sources: ['DOS 周报（各周）'], associates: ['周报对比'] },
    monthly: { stream: 'monthly', label: '月度数据', sources: ['每月最后一周周报'], associates: ['季度汇总', '年度汇总', '五项满意度', '数据库视图', '科组月度跟踪'] },
  };

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
  // 【用户权威口径·对齐拉取页面(91paike)】人工月周次 = 页面周次。页面按「周日所属自然月」标注周次：
  //   每月周次 = 该自然月内「周日」的个数；跨月溢出周（如 9/28–10/4，其周日为 10/4）归属下月第 1 周。
  //   => 人工月最后一天 = 自然月内「最后一个周日」（即 ≤ 自然月最后一天 的最后一个周日）。
  //   例：2026-09 最后一天为周三(9/30)，最后一个周日=9/27 → 9 月只有第 1–4 周；9/28–10/4 属 10 月第 1 周。
  //   （早前曾按「周三及之后归本月」推算成 9 月第 5 周，与页面不一致——页面根本没有 9 月第 5 周选项，已废弃该口径。）
  function manualLastDay(Y, m) {
    const L = new Date(Y, m, 0); // 自然月最后一天（m 月：取 m 月第 0 天）
    const dow = L.getDay();      // 0=周日..6=周六
    return new Date(L.getFullYear(), L.getMonth(), L.getDate() - dow); // 回退到 ≤L 的最后一个周日
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
  // 人工月周数：该人工月含多少个自然周（周一至周日），纯日历推导
  function manualMonthWeekCount(Y, m) {
    let pY = Y, pm0 = m - 1; if (pm0 < 1) { pm0 = 12; pY = Y - 1; }
    const prevML = manualLastDay(pY, pm0);
    const MS = new Date(prevML.getFullYear(), prevML.getMonth(), prevML.getDate() + 1); // 人工月首周一
    const ML = manualLastDay(Y, m);
    const diff = Math.round((ML - MS) / 86400000);
    return (diff + 1) / 7; // diff 恒为 7 的倍数 → 整数
  }
  // —— 科组生产预测「目标帧」：以当前日期(人工月)为锚的月份推进决策（2026-09-03 修复）——
  // 背景：原逻辑参考月 =「最佳科组(bestkezu)有数据的最大月份」，预测月 = 参考月 + 1；
  //   日历日期只参与「完成率第几周」，不参与月份推进 → 月初若上月 bestkezu 未录入，
  //   预测会无限期停留在过期月份且无任何提示（形似"卡死/未自动刷新"）。
  // 口径：预测目标月 = 当前人工月（执行中的月份）；默认参考月 = bestkezu 中
  //   「≤ 上一个人工月」的最近数据月（最新已完成参考月）。
  //   - bestkezu 已覆盖到上一个人工月 → ok：预测自动推进到当前人工月；
  //   - bestkezu 落后于上一个人工月 → lag：参考月回退最近可用，并给出缺口区间，提示补录后自动推进；
  //   - bestkezu 为空 → empty：提示应上传「上一个人工月」的数据。
  // monthList: [{year,month},...]（可乱序/含未来月，内部排序去重）；date: 当前日期（测试可注入）。
  const kzMonthKey = mm => mm.year * 12 + mm.month;
  function kzPrevMonth(mm) { let y = mm.year, m = mm.month - 1; if (m < 1) { m = 12; y -= 1; } return { year: y, month: m }; }
  function kzNextMonth(mm) { let y = mm.year, m = mm.month + 1; if (m > 12) { m = 1; y += 1; } return { year: y, month: m }; }
  const kzLabel = mm => (mm ? mm.year + ' 年 ' + mm.month + ' 月' : '—');
  function kezuTargetFrame(monthList, date) {
    const cur = manualMonthOf(date || new Date());
    const prev = kzPrevMonth(cur); // 上一个人工月 = 最新「已完成」人工月（预测参考目标）
    const seen = {};
    const sorted = (monthList || [])
      .filter(m => m && m.year && m.month)
      .map(m => ({ year: m.year, month: m.month }))
      .sort((a, b) => kzMonthKey(a) - kzMonthKey(b))
      .filter(m => { const k = kzMonthKey(m); if (seen[k]) return false; seen[k] = 1; return true; });
    const best = sorted.length ? sorted[sorted.length - 1] : null;
    const past = sorted.filter(m => kzMonthKey(m) <= kzMonthKey(prev)); // ≤ 上一个人工月
    const lastPast = past.length ? past[past.length - 1] : null;
    let ref = null, state = 'empty', lagged = false, missing = [];
    if (!sorted.length) {
      state = 'empty';
    } else if (lastPast) {
      ref = lastPast;
      lagged = kzMonthKey(lastPast) < kzMonthKey(prev);
      if (lagged) {
        state = 'lag';
        // 缺口区间：(ref, prev] —— 从 ref 下一个月到 prev
        missing = [];
        let it = kzNextMonth(ref);
        while (kzMonthKey(it) <= kzMonthKey(prev)) { missing.push(it); it = kzNextMonth(it); }
      } else {
        state = 'ok';
      }
    } else {
      // bestkezu 全部晚于当前人工月（异常超前数据）→ 沿用最新数据月兜底（与原行为一致）
      ref = best;
      state = 'ok';
    }
    const pred = ref ? kzNextMonth(ref) : null;
    let note;
    if (state === 'empty') {
      note = '暂无「最佳科组」数据。上传最近已完成月份（' + kzLabel(prev) + '）数据后，将自动生成 ' + kzLabel(cur) + ' 的科组生产预测。';
    } else if (state === 'lag') {
      const missTxt = missing.length === 1 ? kzLabel(missing[0]) : (kzLabel(missing[0]) + ' 至 ' + kzLabel(missing[missing.length - 1]) + '（共 ' + missing.length + ' 个月）');
      note = '当前已到 ' + kzLabel(cur) + '，但「最佳科组」最新数据为 ' + kzLabel(ref) + '，预测暂按 ' + kzLabel(pred) + ' 生成。请上传 ' + missTxt + ' 的最佳科组数据，预测将自动更新到 ' + kzLabel(cur) + '。';
    } else {
      note = '当前人工月 ' + kzLabel(cur) + '：默认参考 ' + kzLabel(ref) + '，预测 ' + kzLabel(pred) + '（最佳科组最新数据 ' + kzLabel(best) + '）。';
    }
    return { cur, prev, best, ref, pred, state, lagged, missing, note };
  }
  // 单月「1V1 月生产完成率」单一权威口径：生产课时 / 目标课时（小数 0–1）。
  // 月度派生(materializeMonthlyFromWeekly) 与季度/年度聚合 均以此口径为基准；
  // 季度/年度为「各月生产课时之和 / 各月目标课时之和」（见 QUARTERLY_RULES / YEARLY_RULES 派生公式）。
  function v1MonthRate(rec) {
    const v = rec && rec.values;
    if (!v) return null;
    const prod = v.v1MonthProduced, tgt = v.v1MonthTarget;
    if (prod == null || tgt == null || tgt === 0) return null;
    return prod / tgt;
  }

  // 由周报(weekly 流)派生「月度数据」：每月最后一周周报。
  // 【判定口径】周次界定以**报表自带字段**为准，忽略上传时间、不做任何日历日期重建：
  //   - 直接按每条周报声明的 (year, month) 分组（即用户认定其所属的人工月）；
  //   - 该月「最后一周」= weekSeq === totalWeeksOfMonth（报表中周次 = 本月总周数）的那一份；
  //   - 无显式月末标记时，取 weekSeq 最大者（无 weekSeq 时退化为顶层 week）。
  // 此函数为纯派生工具，当前 app.js 运行时不再自动调用（月度数据已改为手动上传），保留为导出能力以备查验 / 迁移。
  function manualMonthEndWeeklies(weeklyRecs) {
    const byMM = {};
    withMonthEnd(weeklyRecs).forEach(r => {
      const k = r.year + '-' + r.month; // 报表声明的 年-月（用户认定的人工月）
      if (!byMM[k]) byMM[k] = [];
      byMM[k].push(r);
    });
    const result = [];
    Object.keys(byMM).forEach(k => {
      const arr = byMM[k];
      let pick = arr.find(r => r.isMonthEnd); // weekSeq === totalWeeksOfMonth
      if (!pick) {
        const wsOf = x => (x.values && x.values.weekSeq != null ? x.values.weekSeq : (x.week || 0));
        pick = arr.reduce((a, b) => (wsOf(b) > wsOf(a) ? b : a), arr[0]);
      }
      result.push(Object.assign({}, pick, { isMonthEnd: true }));
    });
    result.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    // 与自然月月度周报保持同一派生口径（比例归一化 + 完成率重写）
    return result.map(r => {
      r = normalizeWeeklyValues(r);
      const rate = v1MonthRate(r);
      if (rate != null) r.values.v1MonthRate = rate;
      else { const raw = r.values.v1MonthRate; if (typeof raw === 'number' && raw > 0 && raw < 0.05) r.values.v1MonthRate = raw * 100; }
      return r;
    });
  }

  // 由周报(weekly 流)【显式、透明】派生「月度数据」：取每月月末周(weekSeq===totalWeeksOfMonth)，
  // 写为 monthly 流记录(week=0, isMonthEnd=true)。这是校区层单一源头(周报)→月度数据的唯一派生路径，
  // 不后台静默回退；配套「从周报生成月度数据」按钮 + 生成日志，可审计、可重跑。
  // 返回可直接 STORE.upsert 的月度记录数组；campus 缺省「泉山」。
  function materializeMonthlyFromWeekly(weeklyRecs) {
    const picks = manualMonthEndWeeklies(weeklyRecs); // 月末周挑选 + 比例归一化 + v1MonthRate 重写
    return picks.map(r => ({
      stream: 'monthly',
      campus: (r.campus || '泉山'),
      year: r.year,
      month: r.month,
      week: 0,
      dimension: '_',
      isMonthEnd: true,
      values: Object.assign({}, r.values),
      rows: r.rows || null,
      importedAt: Date.now(),
      sourceWeek: (r.values && r.values.weekSeq != null) ? r.values.weekSeq : (r.week || 0),
      derivedFrom: 'weekly',
    }));
  }

  // 比例字段防御性归一化：统一存为小数(0–1)。旧数据/异常原表可能把 70.39 当 70.39% 存储。
  // 完成率字段（canExceed100）可>100%，值>1 表示完成倍数（如 1.4 → 140%），不做 ÷100。
  function normalizeRatio(key, val) {
    if (val == null || typeof val !== 'number' || !isFinite(val)) return val;
    const f = CA.SCHEMA.weeklyFields.find(x => x.key === key);
    if (!f || f.type !== 'ratio') return val;
    // 单一权威：委托 CA.normalize.toRatio（统一处理 '%' / 比 / canExceed100 / 裸整数百分数）
    return CA.normalize.toRatio(val, { canExceed100: !!f.canExceed100, unit: f.unit });
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

  // 年度对比（标准字段模式）：以模板《数据统计表》sheet1 第一列字段顺序（SCHEMA.weeklyFields）原样展示
  // 各月「月度周报」的月度原数据字段，保持与数据源报表一致的排列顺序；某月未出现的项留空。
  // 入参 monthlyRecs = 月度数据(monthly 流)，由调用方负责提供，本函数不再做 week→month 派生。
  function compareYearStandard(monthlyRecs, year) {
    const me = monthlyRecs.filter(r => r.year === year);
    const columns = me.map(r => ({ key: r.month, label: r.month + '月' }));
    const recMap = {}; me.forEach(r => recMap[r.month] = r);
    const rows = CA.SCHEMA.weeklyFields.map(f => {
      const cells = columns.map(c => {
        const rec = recMap[c.key];
        if (!rec) return null;
        // 各字段统一取自月度周报（rec.values）。v1MonthRate 已在 monthEndWeeklies 统一
        // 派生为 生产课时/目标课时，与季度/年度聚合一致；原表列脏值被覆盖，无需特判。
        const rawVal = rec.values[f.key];
        if (rawVal == null) return null;
        const val = normalizeRatio(f.key, rawVal);
        const isRatio = f.type === 'ratio';
        const isBi = f.unit === '比';
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
      return { key: f.key, label: f.label, isPct: f.type === 'ratio' && f.unit !== '比', values: cells };
    }).filter(r => r.values.some(c => c != null));
    return { columns, rows };
  }

  // —— 教师 KPI（新版：教师个人月度台账，stream='tkpi'）——
  // 月度派生值：总学员数 / 参考课次 / 月饱和度 / 月度周平均（不落库，读取时统一计算）
  function tkpiMonthDerived(v) {
    const v1 = +(v.v1Students || 0), v6 = +(v.v6Students || 0);
    const wk = +(v.weekSeq || 0);
    const totalStudents = v1 + v6;
    const refSessions = wk * (CA.SCHEMA.REF_SESSIONS_PER_WEEK || 16);
    const monthSessions = +(v.monthSessions || 0);
    const saturation = refSessions ? monthSessions / refSessions : null;
    const v1Sessions = +(v.v1Sessions || 0);
    const weekAvg = (wk && v1) ? v1Sessions * 3 / v1 / wk : null;
    return { totalStudents, refSessions, saturation, weekAvg };
  }

  // 半年度标签：上半年 = 3-8月（当年）；下半年 = 9-2月（9-12月属当年，1-2月属上一年）
  function tkpiHalfLabel(year, month) {
    if (month >= 3 && month <= 8) return { label: year + '上半年', year, half: 1 };
    if (month >= 9) return { label: year + '下半年', year, half: 2 };
    return { label: (year - 1) + '下半年', year: year - 1, half: 2 }; // 1-2月
  }

  // 教师 KPI：半年度汇总（按 教师 × 半年度）
  // 口径（2026-08-26 用户确认）：
  //   总/1V1/1V6 学员数 = 半年内最新月份的值；课次/参考课次 = 累计；饱和度 = 累计课次 ÷ 累计参考课次
  //   周平均/1V1停课人数 = 各月平均数；结课/退费/续费/参评单科数 = 累计
  //   优秀/及格 = 两次专业考结果直接体现（H1：3月&6月，H2：9月&12月）
  //   进步率 = 两次进步率平均值（H1：4月&6月，H2：11月&1月）
  //   半年内无数据的月份按 0 计；整个半年无记录的教师由调用方补零行。
  function tkpiHalfYear(recs) {
    const groups = {};
    recs.forEach(r => {
      const hl = tkpiHalfLabel(r.year, r.month);
      const k = hl.label + '|' + r.dimension;
      if (!groups[k]) groups[k] = { label: hl.label, year: hl.year, half: hl.half, dimension: r.dimension, _months: [] };
      groups[k]._months.push(r);
    });
    return Object.values(groups).map(g => {
      const ms = g._months.slice().sort((a, b) => (a.year - b.year) || (a.month - b.month));
      const latest = ms[ms.length - 1];
      const lv = latest ? latest.values : {};
      const sum = f => ms.reduce((s, r) => s + (+(r.values[f] || 0)), 0);
      const mean = f => {
        const arr = ms.map(r => r.values[f]).filter(x => x != null && isFinite(x));
        return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
      };
      const sessions = sum('monthSessions');
      const refSessions = ms.reduce((s, r) => s + (tkpiMonthDerived(r.values).refSessions || 0), 0);
      const weekAvgs = ms.map(r => tkpiMonthDerived(r.values).weekAvg).filter(x => x != null && isFinite(x));
      const examMonths = g.half === 1 ? [3, 6] : [9, 12];
      const progMonths = g.half === 1 ? [4, 6] : [11, 1];
      const examResults = examMonths.map(m => {
        const rec = ms.find(r => r.month === m && r.values.examResult != null && String(r.values.examResult).trim() !== '');
        return rec ? { m, r: String(rec.values.examResult).trim() } : null;
      }).filter(Boolean);
      const progVals = progMonths.map(m => {
        const rec = ms.find(r => r.month === m && r.values.progressRate != null && isFinite(r.values.progressRate));
        return rec ? rec.values.progressRate : null;
      }).filter(x => x != null);
      return {
        label: g.label, year: g.year, half: g.half, dimension: g.dimension,
        values: {
          subjectGroup: ms[0] ? ms[0].values.subjectGroup : '',
          totalStudents: (lv.v1Students || 0) + (lv.v6Students || 0),
          v1Students: lv.v1Students || 0, v6Students: lv.v6Students || 0,
          sessions, refSessions,
          saturation: refSessions ? sessions / refSessions : null,
          weekAvg: weekAvgs.length ? weekAvgs.reduce((s, x) => s + x, 0) / weekAvgs.length : 0,
          stopCount: mean('stopCount'),
          gradCount: sum('gradCount'), refundCount: sum('refundCount'), renewCount: sum('renewCount'),
          evalSubjects: sum('evalSubjects'),
          examResults,
          progressRate: progVals.length ? progVals.reduce((s, x) => s + x, 0) / progVals.length : 0,
        },
      };
    });
  }

  // 五项满意度：从月度数据(monthly 流)提取（校区级，取「月」口径率）
  function satisfactionFromMonthEnd(monthlyRecs) {
    return monthlyRecs.map(r => {
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
    { key: 'tkNumRate', label: '1V1季度停课人数率', src: '1V1停课人数率', rule: 'sum', ruleText: '当季度三个月「月停课人数率」之和' },
    { key: 'entryMonth', label: '季度入职人数', src: '月入职人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'quitMonth', label: '季度离职人数', src: '月离职人数', rule: 'sum', ruleText: '当季度三个月之和' },
    { key: 'quitMonthRate', label: '季度离职人数率', src: '月离职人数率', rule: 'sum', ruleText: '当季度三个月「月离职人数率」之和' },
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
    const me = meOverride || []; // 月度数据必须由 monthly 流显式提供（getMonthlyRecords()），不再由 weekly 静默派生
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
      // 单一口径（与 v1MonthRate 一致）：季度 = 各月生产课时之和 / 各月目标课时之和
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
    { key: 'tkNumRate', label: '1V1年度停课人数率', src: '1V1停课人数率', rule: 'sum', ruleText: '当年各月「月停课人数率」之和' },
    { key: 'entryMonth', label: '年度入职人数', src: '月入职人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'quitMonth', label: '年度离职人数', src: '月离职人数', rule: 'sum', ruleText: '当年各月之和' },
    { key: 'quitMonthRate', label: '年度离职人数率', src: '月离职人数率', rule: 'sum', ruleText: '当年各月「月离职人数率」之和' },,
    { key: 'coreTeacherCount', label: '年度骨干教师人数', src: '骨干教师人数', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'coreTeacherRatio', label: '年度骨干教师占比', src: '骨干教师占比', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'doubleThreeCount', label: '年度双三老师人数', src: '双三老师人数', rule: 'avg', ruleText: '当年各月的平均值' },
    { key: 'doubleThreeRatio', label: '年度双三老师占比', src: '双三老师占比', rule: 'avg', ruleText: '当年各月的平均值' },
  ];

  // 年度汇总：按年聚合所有月度周报
  function yearlyAggregate(weeklyRecs, year, meOverride) {
    const me = (meOverride || []).filter(r => r.year === year); // 月度数据必须由 monthly 流显式提供，不再由 weekly 静默派生
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
    // 单一口径（与 v1MonthRate 一致）：年度 = 各月生产课时之和 / 各月目标课时之和
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

  // —— 最佳科组（bestkezu）季度 / 年度聚合 ——
  // 输入为「扁平化」最佳科组记录（kezuFlat：subject/year/month/quarter + hours/weeks/subjects/xufei/jieke/tuifei/tingke/quit/teachers）。
  // 口径与 kezu-schema.js 的 DENOM 一致；聚合逻辑集中在 CA.aggregate，不再散落于 UI。
  function kezuAnnual(rs) {
    const bySubj = {};
    rs.forEach(r => { (bySubj[r.subject] = bySubj[r.subject] || []).push(r); });
    const out = [];
    Object.keys(bySubj).forEach(subj => {
      const g = bySubj[subj];
      const sum = k => g.reduce((a, r) => a + (r[k] || 0), 0);
      const n = g.length;
      const totalHours = sum('hours'), totalWeeks = sum('weeks');
      const avgSubjects = n ? sum('subjects') / n : 0;
      const xf = sum('xufei'), jk = sum('jieke'), tf = sum('tuifei'), tk = sum('tingke'), qt = sum('quit');
      const last = g.slice().sort((a, b) => b.month - a.month)[0];
      const lastTeachers = last.teachers || 0;
      out.push({
        subject: subj, totalHours, totalWeeks,
        avgSubjects: Math.round(avgSubjects * 10) / 10,
        yearWeekAvg: (totalWeeks && avgSubjects) ? totalHours / totalWeeks / avgSubjects : null,
        xf, jk, tf, tk, qt,
        xufeiRate: avgSubjects ? xf / avgSubjects : null,
        jiekeRate: avgSubjects ? jk / avgSubjects : null,
        tuifeiRate: (tf + avgSubjects) ? tf / (tf + avgSubjects) : null,
        tingkeRate: (tk + avgSubjects) ? tk / (tk + avgSubjects) : null,
        quitRate: (qt + lastTeachers) ? qt / (qt + lastTeachers) : null,
        teachers: lastTeachers
      });
    });
    return out.sort((a, b) => b.totalHours - a.totalHours);
  }
  function kezuQuarter(rs) {
    const byKey = {};
    rs.forEach(r => {
      const key = r.subject + '|' + r.quarter;
      (byKey[key] = byKey[key] || []).push(r);
    });
    const out = [];
    Object.keys(byKey).forEach(key => {
      const g = byKey[key];
      const [subj, q] = key.split('|');
      const sum = k => g.reduce((a, r) => a + (r[k] || 0), 0);
      const n = g.length;
      const totalHours = sum('hours'), totalWeeks = sum('weeks');
      const avgSubjects = n ? sum('subjects') / n : 0;
      const xf = sum('xufei'), jk = sum('jieke'), tf = sum('tuifei'), tk = sum('tingke'), qt = sum('quit');
      const last = g.slice().sort((a, b) => b.month - a.month)[0];
      const lastTeachers = last.teachers || 0;
      out.push({
        subject: subj, quarter: +q, totalHours, totalWeeks,
        avgSubjects: Math.round(avgSubjects * 10) / 10,
        quarterWeekAvg: (totalWeeks && avgSubjects) ? totalHours / totalWeeks / avgSubjects : null,
        xf, jk, tf, tk, qt,
        xufeiRate: avgSubjects ? xf / avgSubjects : null,
        jiekeRate: avgSubjects ? jk / avgSubjects : null,
        tuifeiRate: (tf + avgSubjects) ? tf / (tf + avgSubjects) : null,
        tingkeRate: (tk + avgSubjects) ? tk / (tk + avgSubjects) : null,
        quitRate: (qt + lastTeachers) ? qt / (qt + lastTeachers) : null,
        teachers: lastTeachers
      });
    });
    return out.sort((a, b) => a.subject.localeCompare(b.subject) || (a.quarter - b.quarter));
  }

  // —— 校区指标分解 ↔ 科组层 关联对账（R3 双向哨兵）——
  // 校区层单一源头=周报(派生 monthly)；科组层=kezuActual(生产预排+实际)+kezuTargetC(校区总盘C)+bestkezu。
  // 对账：R1 科组实际生产课时合计 ↔ 校区月度生产课时；R2 校区生产总盘C ↔ 科组预排课时合计。
  // 偏差超容差 → ok=false（UI 给告警，提示补录/核对）；数据缺失侧 ok=null（不参与判定）。
  function linkageCheck(campus, y, m) {
    campus = campus || '泉山';
    const get = s => (CA.store.list(s) || []).filter(r => (r.campus || '泉山') === campus && r.year === y && r.month === m);
    const monthly = get('monthly')[0];
    const actuals = get('kezuActual');
    const targetC = (CA.store.list('kezuTargetC') || []).filter(r => (r.campus || '泉山') === campus)[0];
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
    // 对账容差优先取「数据修正中心」配置的 tolerance 规则（档A），缺省 0.01
    const TOL = (CA.overrides && typeof CA.overrides.tolerance === 'function') ? CA.overrides.tolerance('linkage') : 0.01;
    const kezuProd = actuals.reduce((s, r) => s + (num(r.values && r.values.produced) || 0), 0);
    const campusProd = monthly ? num(monthly.values.v1MonthProduced) : null;
    const kezuSched = actuals.reduce((s, r) => s + (num(r.values && r.values.scheduled) || 0), 0);
    const cVal = targetC ? num(targetC.values && targetC.values.C) : null;
    const checks = [
      { name: '科组实际生产课时合计 ↔ 校区月度生产课时', kezuVal: kezuProd, campusVal: campusProd,
        ok: campusProd == null ? null : Math.abs(kezuProd - campusProd) <= Math.max(TOL * (Math.abs(campusProd) || 1), 1) },
      { name: '校区生产总盘C ↔ 科组预排课时合计', kezuVal: kezuSched, campusVal: cVal,
        ok: cVal == null ? null : Math.abs(kezuSched - cVal) <= Math.max(TOL * (Math.abs(cVal) || 1), 1) },
    ];
    const hasData = !!(monthly || actuals.length || targetC);
    const okAll = checks.every(c => c.ok === true);
    return { year: y, month: m, campus, checks, ok: hasData ? okAll : null, hasData };
  }

  CA.aggregate = {
    DATA_LAYERS,
    monthEndWeeklies, manualMonthEndWeeklies, materializeMonthlyFromWeekly, v1MonthRate, compareYearStandard,
    manualLastDay, manualMonthOf, manualMonthWeekCount, kezuTargetFrame, tkpiMonthDerived, tkpiHalfLabel, tkpiHalfYear, satisfactionFromMonthEnd, yearOptions,
    QUARTERLY_RULES, quarterlyAggregate,
    YEARLY_RULES, yearlyAggregate,
    monthCashOf,
    kezuQuarter, kezuAnnual, linkageCheck,
  };

})(window);
