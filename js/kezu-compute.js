/* ============================================
   kezu-compute.js — 科组联动「唯一计算源」（仅数据分析工作台）
   作用：把「最佳科组排名 / 科组生产预测」的全部业务计算集中于此，
   由 sync.js 在「推送分析到个人台」时一次性算好，打包进快照 kezu.linked，
   个人工作台只做纯模板渲染、不再二次推导（保证永远与数据分析台一致）。
   算法口径与核心看板完全一致（computeKezuTarget / kezuTargetWideTableHTML 等）。
   ============================================ */
(function () {
  var App = window.App || (window.App = {});

  /* ---------- 工具 ---------- */
  function fmt(v, digits) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    if (typeof v === 'number') {
      if (Math.abs(v) >= 10000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
      return v.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 2 : digits });
    }
    return String(v);
  }
  function pct(v) {
    if (v == null) return '—';
    var p = Math.round(v * 10000) / 100;
    var s = p.toFixed(2);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s + '%';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : (parseFloat(x) || 0); }
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && /^[-\d.]+$/.test(v.trim()) && !isNaN(+v)); }
  var RATE_COL = /^(结课率|停课率|退费率|续费率|离职率|合格率|优秀率|进步率)$/;
  function scoreCell(v, header) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { if (RATE_COL.test(header) && v > 0 && v <= 1) return pct(v); return fmt(v); }
    var s = String(v).trim();
    if (isNum(s)) { var n = +s; if (RATE_COL.test(header) && n > 0 && n <= 1) return pct(n); return fmt(n); }
    return esc(s);
  }

  /* ---------- 人工月 / 周 日期助手（与 aggregate.js 口径完全一致） ---------- */
  function manualLastDay(Y, m) {
    var L = new Date(Y, m, 0);
    var dow = L.getDay();
    return new Date(L.getFullYear(), L.getMonth(), L.getDate() - dow);
  }
  function manualMonthOf(date) {
    var Y = date.getFullYear(), m = date.getMonth() + 1;
    var ML = manualLastDay(Y, m);
    if (date <= ML) {
      var pY = Y, pm0 = m - 1; if (pm0 < 1) { pm0 = 12; pY = Y - 1; }
      var prevML = manualLastDay(pY, pm0);
      if (date > prevML) return { year: Y, month: m };
      return { year: pY, month: pm0 };
    }
    var nY = Y, nm = m + 1; if (nm > 12) { nm = 1; nY = Y + 1; }
    return { year: nY, month: nm };
  }
  function manualMonthWeekCount(Y, m) {
    var pY = Y, pm0 = m - 1; if (pm0 < 1) { pm0 = 12; pY = Y - 1; }
    var prevML = manualLastDay(pY, pm0);
    var MS = new Date(prevML.getFullYear(), prevML.getMonth(), prevML.getDate() + 1);
    var ML = manualLastDay(Y, m);
    var diff = Math.round((ML - MS) / 86400000);
    return (diff + 1) / 7;
  }
  function currentManualWeek(date) {
    var mm = manualMonthOf(date);
    var pY = mm.year, pm0 = mm.month - 1; if (pm0 < 1) { pm0 = 12; pY = mm.year - 1; }
    var prevML = manualLastDay(pY, pm0);
    var MS = new Date(prevML.getFullYear(), prevML.getMonth(), prevML.getDate() + 1);
    var dayDiff = Math.round((date - MS) / 86400000);
    return { year: mm.year, month: mm.month, week: Math.floor(dayDiff / 7) + 1 };
  }
  function predMonth(y, m) { var mm = m + 1, yy = y; if (mm > 12) { mm = 1; yy += 1; } return { year: yy, month: mm }; }

  /* ---------- 科组生产指标核心算法（与核心看板 computeKezuTarget 一致） ---------- */
  function computeKezuTarget(depts, C) {
    var S = depts.reduce(function (a, d) { return a + (d.s || 0); }, 0);
    var H = depts.reduce(function (a, d) { return a + (d.h || 0); }, 0);
    var rows = depts.map(function (d) {
      var w = d.w > 0 ? d.w : 4;
      var a = S > 0 ? d.s / S : 0;
      var b = H > 0 ? d.h / H : 0;
      var predA = a * C;
      var predB = b * C;
      var avg = (predA + predB) / 2;
      var wAvg = d.s > 0 ? avg / d.s / w : 0;
      return { name: d.name, s: d.s, h: d.h, w: w, a: a, b: b, predA: predA, predB: predB, avg: avg, wAvg: wAvg };
    });
    var denom = rows.reduce(function (a, r) { return a + (r.s || 0) * r.w; }, 0);
    var meanW = rows.reduce(function (x, r) { return x + r.wAvg; }, 0) / (rows.length || 1);
    var sum0 = meanW * denom;
    var lower = denom > 0 ? C / denom : 0;
    var upper = denom > 0 ? (C + 30) / denom : 0;
    var commonW = meanW;
    var adjNote;
    if (denom <= 0) adjNote = '单科数×周数合计为 0，无法计算。';
    else if (sum0 < C) { commonW = lower; adjNote = '四科组预测之和（' + fmt(sum0) + '）＜ C，已上调共同周平均至区间下界，使之和达到 C。'; }
    else if (sum0 > C + 30) { commonW = upper; adjNote = '四科组预测之和（' + fmt(sum0) + '）＞ C+30，已压回区间上界。'; }
    else { adjNote = '四科组预测之和（' + fmt(sum0) + '）已落在 [C, C+30] 区间内，共同周平均取四科组均值。'; }
    var sumFinal = commonW * denom;
    var completion = C > 0 ? sumFinal / C : 0;
    var achieved = '未达标';
    if (completion >= 1.25) achieved = 'G3';
    else if (completion >= 1.10) achieved = 'G2';
    else if (completion >= 1.00) achieved = 'G1';
    var Gcfg = { G1: 1.00, G2: 1.10, G3: 1.25 };
    rows.forEach(function (r) {
      r.final = commonW * r.s * r.w;
      r.weekly = r.w > 0 ? r.final / r.w : 0;
      var share = (r.s * r.w) / (denom || 1);
      r.G1 = (C * Gcfg.G1) * share;
      r.G2 = (C * Gcfg.G2) * share;
      r.G3 = (C * Gcfg.G3) * share;
    });
    return { S: S, H: H, rows: rows, meanW: meanW, sum0: sum0, lower: lower, upper: upper, commonW: commonW, adjNote: adjNote, sumFinal: sumFinal, completion: completion, achieved: achieved, Gcfg: Gcfg };
  }

  /* ---------- 数据源 1v1 月生产课时（与核心看板口径一致） ---------- */
  function dataSourceProd(monthlyHistory, latestByMonth, y, m) {
    var rec = (monthlyHistory || []).find(function (r) { return r.year === y && r.month === m; });
    if (!rec && latestByMonth && latestByMonth.year === y && latestByMonth.month === m) rec = latestByMonth;
    if (!rec) return null;
    var v = rec.values && rec.values.v1MonthProduced;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* ---------- 实际生产聚合（按周） ---------- */
  function actualSummary(actuals, py, pm, uptoWeek) {
    var campusActual = 0, campusSched = 0, hasData = false;
    (actuals || []).forEach(function (r) {
      if (r.year !== py || r.month !== pm) return;
      var w = +r.week || 0;
      if (uptoWeek == null || w <= uptoWeek) {
        campusActual += num(r.values && r.values.produced);
        campusSched += num(r.values && r.values.scheduled);
        hasData = true;
      }
    });
    return { campusActual: campusActual, campusSched: campusSched, hasData: hasData };
  }

  /* ---------- 季度聚合（与 aggregate.js kezuQuarter 一致） ---------- */
  // 扁平化：把原始 bestkezu 记录 {dimension, values} 转成 subject/quarter 在顶层的结构（与核心看板/个人台 kezuFlat 一致）
  function kezuFlat(rec) { return Object.assign({ year: rec.year, month: rec.month, subject: rec.dimension }, rec.values || {}); }
  function kezuQuarter(rs) {
    var byKey = {};
    rs.forEach(function (r) {
      var key = r.subject + '|' + r.quarter;
      (byKey[key] = byKey[key] || []).push(r);
    });
    var out = [];
    Object.keys(byKey).forEach(function (key) {
      var g = byKey[key];
      var parts = key.split('|');
      var subj = parts[0], q = parts[1];
      var sum = function (k) { return g.reduce(function (a, r) { return a + (r[k] || 0); }, 0); };
      var n = g.length;
      var totalHours = sum('hours'), totalWeeks = sum('weeks');
      var avgSubjects = n ? sum('subjects') / n : 0;
      var xf = sum('xufei'), jk = sum('jieke'), tf = sum('tuifei'), tk = sum('tingke'), qt = sum('quit');
      var last = g.slice().sort(function (a, b) { return b.month - a.month; })[0];
      var lastTeachers = last.teachers || 0;
      out.push({
        subject: subj, quarter: +q, totalHours: totalHours, totalWeeks: totalWeeks,
        avgSubjects: Math.round(avgSubjects * 10) / 10,
        quarterWeekAvg: (totalWeeks && avgSubjects) ? totalHours / totalWeeks / avgSubjects : null,
        xf: xf, jk: jk, tf: tf, tk: tk, qt: qt,
        xufeiRate: avgSubjects ? xf / avgSubjects : null,
        jiekeRate: avgSubjects ? jk / avgSubjects : null,
        tuifeiRate: (tf + avgSubjects) ? tf / (tf + avgSubjects) : null,
        tingkeRate: (tk + avgSubjects) ? tk / (tk + avgSubjects) : null,
        quitRate: (qt + lastTeachers) ? qt / (qt + lastTeachers) : null,
        teachers: lastTeachers
      });
    });
    return out.sort(function (a, b) { return a.subject.localeCompare(b.subject) || (a.quarter - b.quarter); });
  }

  /* ---------- 把「科组月度汇总（按周展开）」算成结构化模型（纯数值，个人台只做模板） ---------- */
  function buildWideTableModel(res, actuals, campusC) {
    var rows = res.rows.map(function (r) { return { name: r.name, s: r.s, w: r.w || 0, weekly: r.weekly || 0, final: r.final || 0 }; });
    var bySubj = {};
    (actuals || []).forEach(function (r) { (bySubj[r.dimension] = bySubj[r.dimension] || []).push(r); });
    rows.forEach(function (r) {
      var list = (bySubj[r.name] || []).slice().sort(function (a, b) { return (a.week - b.week); });
      r._list = list; r._sched = 0; r._prod = 0;
      list.forEach(function (rec) { r._sched += num(rec.values && rec.values.scheduled); r._prod += num(rec.values && rec.values.produced); });
    });
    var maxW = Math.max.apply(null, rows.map(function (r) { return r.w; }).concat([0]));
    if (!maxW) return { maxW: 0, rows: [], wkIdx: [], campusSched: 0, campusProd: 0, campusCVal: campusC, campusPreRate: null, campusActRate: null };
    var wkIdx = [];
    for (var i = 1; i <= maxW; i++) {
      var weekTgt = 0, weekSched = 0, weekProd = 0;
      rows.forEach(function (r) {
        var rec = (r._list || []).find(function (x) { return x.week === i; });
        if (i <= r.w) weekTgt += r.weekly;
        weekSched += rec ? num(rec.values.scheduled) : 0;
        weekProd += rec ? num(rec.values.produced) : 0;
      });
      wkIdx.push({ week: i, weekTgt: weekTgt, weekSched: weekSched, weekProd: weekProd, rate: weekTgt > 0 ? weekProd / weekTgt : null });
    }
    var campusSched = 0, campusProd = 0;
    rows.forEach(function (r) { campusSched += r._sched; campusProd += r._prod; });
    var campusFinal = res.sumFinal || 0;
    var campusCVal = (typeof campusC === 'number' && isFinite(campusC)) ? campusC : campusFinal;
    var campusPreRate = campusCVal > 0 ? campusSched / campusCVal : null;
    var campusActRate = campusFinal > 0 ? campusProd / campusFinal : null;
    var outRows = rows.map(function (r) {
      var perWeek = [];
      for (var i = 1; i <= maxW; i++) {
        var rec = (r._list || []).find(function (x) { return x.week === i; });
        var hasWeek = i <= r.w;
        var tgt = hasWeek ? r.weekly : 0;
        var sched = rec ? num(rec.values.scheduled) : 0;
        var prod = rec ? num(rec.values.produced) : 0;
        perWeek.push({ week: i, hasWeek: hasWeek, tgt: tgt, sched: sched, prod: prod, rate: tgt > 0 ? prod / tgt : null });
      }
      return {
        name: r.name, w: r.w, weekly: r.weekly, final: r.final,
        perWeek: perWeek,
        sched: r._sched, prod: r._prod,
        preRate: r.final > 0 ? r._sched / r.final : null,
        actRate: r.final > 0 ? r._prod / r.final : null
      };
    });
    return { maxW: maxW, rows: outRows, wkIdx: wkIdx, campusSched: campusSched, campusProd: campusProd, campusCVal: campusCVal, campusPreRate: campusPreRate, campusActRate: campusActRate };
  }

  /* ============================================================
     主入口：根据原始记录组装「联动科组」完整模型（个人台只渲染）
     base = { detail, score, actual, C, monthlyHistory, latestByStream }
     ============================================================ */
  function buildLinkedKezu(base) {
    base = base || {};
    var detail = base.detail || [];
    var score = base.score || [];
    var actual = base.actual || [];
    var C = (typeof base.C === 'number' && isFinite(base.C)) ? base.C : null;
    var monthlyHistory = base.monthlyHistory || [];
    var latestByStream = base.latestByStream || {};

    // 参考月份（来自最佳科组明细）
    var mset = {};
    detail.forEach(function (r) { if (r.year && r.month) mset[r.year * 12 + r.month] = { year: r.year, month: r.month }; });
    var months = Object.keys(mset).map(function (k) { return mset[k]; }).sort(function (a, b) { return (a.year - b.year) || (a.month - b.month); });

    function loadMonth(y, m) {
      var recs = detail.filter(function (r) { return r.year === y && r.month === m; });
      if (!recs.length) return null;
      return recs.map(function (r) { var v = r.values || {}; return { name: r.dimension || '未命名', s: num(v.subjects), h: num(v.hours), w: num(v.weeks) || 4 }; });
    }

    // —— 每个参考月份的预测模型 ——
    var forecast = {};
    months.forEach(function (mm) {
      var y = mm.year, m = mm.month;
      var depts = loadMonth(y, m);
      var key = y + '-' + m;
      if (!depts) { forecast[key] = { refYear: y, refMonth: m, empty: true }; return; }
      var pm = predMonth(y, m);
      var predWeeks = manualMonthWeekCount(pm.year, pm.month);
      depts.forEach(function (d) { d.w = predWeeks; });
      if (C == null) {
        forecast[key] = {
          refYear: y, refMonth: m, predYear: pm.year, predMonth: pm.month, predWeeks: predWeeks,
          C: null, noC: true,
          consistHTML: '', stat: null
        };
        return;
      }
      var res = computeKezuTarget(depts, C);
      var actuals = actual.filter(function (r) { return r.year === pm.year && r.month === pm.month; });
      var wide = buildWideTableModel(res, actuals, C);

      // 一致性校验：最佳科组课时合计 vs 数据源 1v1 月生产课时
      var src = dataSourceProd(monthlyHistory, latestByStream.monthly, y, m);
      var consistHTML;
      if (src == null) consistHTML = '<span class="lk-tag warn">数据源无该月周报</span> <span class="preview-note">「1v1 月生产课时」校验需上传该月 DOS 周报。</span>';
      else {
        var diff = res.H - src, ok = Math.abs(diff) < 1;
        consistHTML = '最佳科组课时合计 <b>' + fmt(res.H) + '</b>　vs　数据源 1v1 月生产课时 <b>' + fmt(src) + '</b>　<span class="lk-tag ' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓ 一致' : '⚠ 不一致') + '</span>';
        if (src != null && src > 0) {
          var ratio = C / src;
          var cTone = ratio >= 0.9 && ratio <= 1.1 ? '≈ 参考月水平' : (ratio > 1.1 ? '高于参考月 ' + Math.round((ratio - 1) * 100) + '%' : '低于参考月 ' + Math.round((1 - ratio) * 100) + '%');
          consistHTML += '<div class="ai-insight-advice" style="margin-top:8px"><span class="ai-tag-local">本地智能参考</span> 参考月实际生产 <b>' + fmt(src) + '</b>，当前 C <b>' + fmt(Math.round(C)) + '</b>（' + cTone + '）。如需调整 C，请在数据分析台「科组生产预测」修改后重新推送。</div>';
        }
      }

      // 统计卡（本周完成率等依赖「当前日期」，由数据台在推送时定格）
      var latestV1 = (latestByStream.weekly && latestByStream.weekly.values && latestByStream.weekly.values.v1Students != null) ? num(latestByStream.weekly.values.v1Students) : null;
      var today = new Date();
      var cw = currentManualWeek(today);
      var reportWeek = 0;
      if (cw.year === pm.year && cw.month === pm.month) reportWeek = (today.getDay() === 0) ? cw.week : Math.max(1, cw.week - 1);
      else {
        var pmEnd = manualLastDay(pm.year, pm.month);
        if (today > pmEnd) reportWeek = currentManualWeek(pmEnd).week;
      }
      var done = actualSummary(actual, pm.year, pm.month, reportWeek);
      var whole = actualSummary(actual, pm.year, pm.month, null);
      var campusActual = done.campusActual;
      var campusSched = whole.campusSched;
      var hasData = whole.hasData;
      var actRate = res.sumFinal > 0 ? campusActual / res.sumFinal : 0;
      var gapG1 = C - campusSched;
      var gapG2 = C * 1.10 - campusSched;
      var gapG3 = C * 1.25 - campusSched;
      var weekLabel = reportWeek > 0 ? (pm.month + '月第' + reportWeek + '周完成率') : '本周完成率';
      var stat = {
        C: C, v1: latestV1, G2: C * 1.10, G3: C * 1.25,
        weekLabel: weekLabel, actRate: actRate, hasData: hasData,
        gapG1: gapG1, gapG2: gapG2, gapG3: gapG3, reportWeek: reportWeek
      };

      forecast[key] = {
        refYear: y, refMonth: m, predYear: pm.year, predMonth: pm.month, predWeeks: predWeeks,
        C: C, model: res, wide: wide, consistHTML: consistHTML, stat: stat,
        adjNote: res.adjNote, achieved: res.achieved, completion: res.completion, sumFinal: res.sumFinal
      };
    });

    // —— 横向对比：季度聚合由数据台预先算好（个人台只模板） ——
    var years = Array.from(new Set(detail.map(function (r) { return r.year; }))).sort(function (a, b) { return b - a; });
    var flatDetail = detail.map(kezuFlat);
    var compare = { byYear: {} };
    years.forEach(function (yr) {
      var recs = flatDetail.filter(function (r) { return r.year === yr; });
      var subjects = Array.from(new Set(recs.map(function (r) { return r.subject; }))).sort(function (a, b) { return a.localeCompare(b); });
      var monthsOfYear = Array.from(new Set(recs.map(function (r) { return r.month; }))).sort(function (a, b) { return a - b; });
      compare.byYear[yr] = {
        subjects: subjects,
        months: monthsOfYear,
        quarterAgg: kezuQuarter(recs)
      };
    });

    return {
      C: C,
      months: months,
      forecast: forecast,
      rank: { years: score.map(function (r) { return r.year; }).filter(function (y) { return y; }).sort(function (a, b) { return b - a; }) },
      compare: compare
    };
  }

  App.kezuCompute = {
    fmt: fmt, pct: pct, esc: esc, num: num, isNum: isNum, scoreCell: scoreCell,
    manualLastDay: manualLastDay, manualMonthOf: manualMonthOf, manualMonthWeekCount: manualMonthWeekCount,
    currentManualWeek: currentManualWeek, predMonth: predMonth,
    computeKezuTarget: computeKezuTarget, buildWideTableModel: buildWideTableModel,
    actualSummary: actualSummary, dataSourceProd: dataSourceProd, kezuQuarter: kezuQuarter,
    buildLinkedKezu: buildLinkedKezu
  };
})();
