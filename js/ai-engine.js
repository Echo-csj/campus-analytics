/*
 * ai-engine.js — AI 数据分析 · 本地启发式引擎（无需后端 / API Key）
 * ----------------------------------------------------------------------------
 * 设计目标：在工作台纯静态、无后端的约束下，提供可用的「AI 分析」能力：
 *   - 自然语言意图识别（趋势 / 异常 / 对比 / 构成 / 摘要 / 自动）
 *   - 指标抽取（中文同义词 → 数据字段）
 *   - 自动识别数据特征并选择可视化类型（时序→折线、类别→柱状、率类→环图）
 *   - 智能洞察：趋势预测（线性回归外推）、异常检测（z-score）、关键指标摘要
 *
 * 对外接口（挂在 window.CA.aiEngine）：
 *   CA.aiEngine.prepareDataset(stream) -> { ok, rows, fields, isTimeSeries, ... }
 *   CA.aiEngine.analyze({ query, stream }) -> Promise<AnalysisResult>
 *
 * AnalysisResult 契约（与 ai-client / Edge Function 完全一致，便于后端替换）：
 *   { ok, source:'local'|'edge', query, datasetLabel, summary,
 *     insights: Insight[], charts: ChartSpec[], meta:{}, error? }
 *   Insight  = { type, title, text, severity:'info'|'good'|'warn' }
 *   ChartSpec= { id, type:'line'|'bar'|'pie'|'doughnut'|'area', title,
 *                labels:[], datasets:[{label,data:[],color?}], format:'num'|'pct'|'money' }
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});
  const store = CA.store;
  const SCHEMA = CA.SCHEMA || {};

  // ───────────────────────── 基础工具 ─────────────────────────
  function num(v) { const n = +v; return isFinite(n) ? n : null; }
  // 仅「率 / rate / ratio」视为 0–1 百分比（展示为 %）；「比」(如单科比=1.8) 是可能 >1 的真实比值，按原值展示。
  function fieldLabel(key) {
    const lists = [SCHEMA.weeklyFields, SCHEMA.kezuFields, SCHEMA.bestkezuFields, SCHEMA.tkpiFields, SCHEMA.satisfactionItems].filter(Boolean);
    for (const l of lists) {
      const f = l.find(x => x.key === key);
      if (f) return f.label || f.name || key;
    }
    return key;
  }
  function timeLabel(r) {
    const y = r.year, m = r.month;
    if (y == null || m == null) return (r.dimension || r.label || '?');
    if (r.week && r.week > 0) return y + '-' + m + ' 第' + r.week + '周';
    return y + '年' + m + '月';
  }
  function sortKey(r) { return (r.year || 0) * 10000 + (r.month || 0) * 100 + (r.week || 0); }

  // 中文同义词 → 字段 key（用于自然语言指标抽取）
  const SYNONYMS = [
    [/总现金|课时生产总现金|现金|产值/, 'monthCashTotal'],
    [/生产完成率|完成率|达成率/, 'v1MonthRate'],
    [/续费/, 'xfMonthNum'],
    [/推荐/, 'tjMonthNum'],
    [/结课/, 'jkMonthNum'],
    [/退费/, 'tfMonthNum'],
    [/停课率|停课/, 'tkNumRate'],
    [/离职率/, 'quitMonthRate'],
    [/离职人数|离职/, 'quitMonth'],
    [/饱和度/, 'monthSaturation'],
    [/效能|人均效能/, 'monthEff'],
    [/教师数|教师/, 'teacherCount'],
    [/总人数|校区人数|校区总人数/, 'campusTotal'],
    [/1v6.*生产课时|1v6.*课时|1v6生产/, 'v6MonthProduced'],
    [/1v1.*生产课时|1v1.*课时|1v1生产|生产课时/, 'v1MonthProduced'],
    [/1v1/, 'v1MonthProduced'],
    [/1v6/, 'v6MonthProduced'],
    [/在读学员|学员数|在读/, 'v1Students'],
    [/人均效能/, 'monthEff'],
  ];
  const DATASET_LABELS = {
    monthly: '月度汇总数据', weekly: '周报数据',
    kezuActual: '科组实际生产', bestkezu: '最佳科组', tkpi: '教师 KPI',
  };
  // 自动 / 缺省时优先关注的核心指标（按可用性裁剪）
  const CORE_METRICS = ['monthCashTotal', 'v1MonthRate', 'xfMonthNum', 'quitMonthRate', 'tkNumRate', 'tfMonthNum', 'monthSaturation', 'teacherCount', 'v1MonthProduced'];

  // ───────────────────────── 数据集准备 ─────────────────────────
  // 把任意 stream 的底层记录规整为统一结构：
  //   rows: [{ label, values:{key:number}, _sort }]
  //   fields: [{ key, label, type, unit }]
  function prepareDataset(stream) {
    if (!store || !store.list) return { ok: false };
    const recs = store.list(stream);
    if (!recs || !recs.length) return { ok: false };

    let rows, isTimeSeries;
    const isCategorical = (stream === 'kezuActual' || stream === 'bestkezu')
      && recs.some(r => r.dimension && r.dimension !== '_');

    if (isCategorical) {
      // 按维度（科组/教师）聚合求和
      const byDim = {};
      recs.forEach(r => {
        const d = r.dimension || r.label || '未命名';
        if (!byDim[d]) byDim[d] = { label: d, values: {} };
        const v = r.values || {};
        for (const k in v) { byDim[d].values[k] = (byDim[d].values[k] || 0) + (+v[k] || 0); }
      });
      rows = Object.keys(byDim).map(d => byDim[d]);
      isTimeSeries = false;
    } else {
      rows = recs.map(r => ({ label: timeLabel(r), _sort: sortKey(r), values: r.values || {} }))
        .sort((a, b) => a._sort - b._sort);
      isTimeSeries = rows.length > 1;
    }

    // 收集字段元信息（仅保留含数值的字段）；同时记录各字段绝对值最大值，
    // 用于「数据驱动」判定类型：最大值 ≤ 1 视为 0–1 比率（按 % 展示），否则为原值。
    // （命名不可靠：Ratio 既可能是 0–1 占比 coreTeacherRatio，也可能是 >1 的单科比 subjectRatio。）
    const seen = {}, fields = [], maxAbs = {};
    rows.forEach(r => {
      for (const k in r.values) {
        const v = num(r.values[k]);
        if (v == null) continue;
        if (maxAbs[k] == null || Math.abs(v) > maxAbs[k]) maxAbs[k] = Math.abs(v);
        if (seen[k]) continue;
        seen[k] = true;
        fields.push({ key: k, label: fieldLabel(k), type: 'num', unit: '' });
      }
    });
    fields.forEach(f => { f.type = (maxAbs[f.key] != null && maxAbs[f.key] <= 1.0001) ? 'ratio' : 'num'; });
    if (!fields.length) return { ok: false };

    return { ok: true, stream, rows, fields, isTimeSeries, timeLabel };
  }

  // ───────────────────────── 意图识别 ─────────────────────────
  function detectIntent(q) {
    const t = (q || '').toLowerCase();
    if (/异常|离群|波动大|突变|突增|突减|异常值| outlier/i.test(t)) return 'anomaly';
    if (/构成|占比|比例|分布|份额| composition| breakdown/i.test(t)) return 'composition';
    if (/对比|比较| vs | versus |环比|同比|差异|哪个|最高|最低|排名|排行|谁更/i.test(t)) return 'compare';
    if (/趋势|走势|增长|下降|变化|预测|展望|未来|下月|明年|走向| forecast| trend/i.test(t)) return 'trend';
    if (/摘要|总结|概述|概况|概览|关键指标|分析一下|帮我分析|整体|情况|怎么样|如何/i.test(t)) return 'summary';
    return 'auto';
  }

  // 从查询中抽取指标字段（中文同义词 + 字段名精确匹配），返回 key 数组
  function extractMetrics(q, fields) {
    const t = (q || '').toLowerCase();
    const matched = new Set();
    // 同义词
    SYNONYMS.forEach(([re, key]) => { if (re.test(t) && fields.some(f => f.key === key)) matched.add(key); });
    // 字段标签 / key 直接出现
    fields.forEach(f => {
      const label = (f.label || '').toLowerCase();
      const key = (f.key || '').toLowerCase().replace(/_/g, '');
      if (label && t.indexOf(label) >= 0) matched.add(f.key);
      else if (key && t.indexOf(key) >= 0) matched.add(f.key);
    });
    return [...matched].slice(0, 6);
  }

  function pickMetrics(intent, extracted, fields) {
    if (extracted.length) return extracted;
    if (intent === 'composition') {
      // 构成分析优先用率类字段
      const ratio = fields.filter(f => f.type === 'ratio').map(f => f.key);
      return ratio.length ? ratio.slice(0, 6) : fields.slice(0, 4).map(f => f.key);
    }
    // 自动 / 趋势 / 异常 / 对比：用核心指标（按可用性裁剪）
    const avail = fields.map(f => f.key);
    const core = CORE_METRICS.filter(k => avail.includes(k));
    return core.length ? core : avail.slice(0, 4);
  }

  // ───────────────────────── 统计：异常 / 趋势 ─────────────────────────
  function linreg(ys) {
    const n = ys.length; if (n < 2) return null;
    const xs = ys.map((_, i) => i);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let nume = 0, den = 0;
    for (let i = 0; i < n; i++) { nume += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den ? nume / den : 0;
    return { slope, intercept: my - slope * mx, predict: x => (my - slope * mx) + slope * x };
  }
  function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
  function std(a, m) { const mm = m == null ? mean(a) : m; return Math.sqrt(a.reduce((s, x) => s + (x - mm) ** 2, 0) / (a.length || 1)); }

  function seriesFor(ds, key) {
    const labels = [], values = [];
    ds.rows.forEach(r => { const v = num(r.values[key]); if (v != null) { labels.push(r.label); values.push(v); } });
    return { labels, values };
  }

  // ───────────────────────── 图表生成 ─────────────────────────
  function fmtVal(v, type) {
    if (v == null) return '—';
    if (type === 'ratio') return (v * 100).toFixed(1) + '%';
    if (Math.abs(v) >= 10000) return Math.round(v).toLocaleString('zh-CN');
    return (Math.round(v * 100) / 100).toLocaleString('zh-CN');
  }

  function buildCharts(ds, intent, metrics) {
    const charts = [];
    const palette = ['#4F46E5', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];

    if (!ds.isTimeSeries) {
      // 类别型（如科组/教师）→ 柱状图
      const mk = metrics.find(k => ds.fields.some(f => f.key === k)) || ds.fields[0].key;
      const f = ds.fields.find(x => x.key === mk) || ds.fields[0];
      const labels = ds.rows.map(r => r.label);
      const values = ds.rows.map(r => num(r.values[mk]) || 0);
      charts.push({
        id: 'cat_' + mk, type: 'bar', title: f.label + '（按' + (ds.rows[0].label ? '维度' : '') + '）',
        labels, format: f.type === 'ratio' ? 'pct' : 'num',
        datasets: [{ label: f.label, data: values, color: palette[0] }],
      });
      return charts;
    }

    if (intent === 'composition') {
      // 最新一期的率类构成 → 环图（优先月维度指标，避免混入周维度率）
      const last = ds.rows[ds.rows.length - 1];
      let ratioFields = ds.fields.filter(f => f.type === 'ratio' && num(last.values[f.key]) != null);
      const monthOnly = ratioFields.filter(f => /month/i.test(f.key));
      if (monthOnly.length) ratioFields = monthOnly;
      ratioFields = ratioFields.slice(0, 6);
      if (ratioFields.length) {
        charts.push({
          id: 'comp', type: 'doughnut', title: last.label + ' · 率类指标构成',
          labels: ratioFields.map(f => f.label),
          format: 'pct',
          datasets: [{ label: '占比', data: ratioFields.map(f => Math.round((num(last.values[f.key]) || 0) * 1000) / 10),
            color: palette }],
        });
        return charts;
      }
    }

    // 时序 → 折线（指标≤3 合并对比，否则各出一张，最多 4 张）
    const useMetrics = metrics.filter(k => ds.fields.some(f => f.key === k)).slice(0, 4);
    if (useMetrics.length <= 3 && useMetrics.length > 1) {
      const labels = ds.rows.map(r => r.label);
      const datasets = useMetrics.map((k, i) => {
        const f = ds.fields.find(x => x.key === k);
        return { label: f ? f.label : k, data: ds.rows.map(r => num(r.values[k]) || 0), color: palette[i % palette.length] };
      });
      const fmt = ds.fields.find(x => x.key === useMetrics[0]) || ds.fields[0];
      charts.push({ id: 'trend_multi', type: 'line', title: '指标趋势对比', labels, format: fmt.type === 'ratio' ? 'pct' : 'num', datasets });
    } else {
      useMetrics.forEach((k, i) => {
        const f = ds.fields.find(x => x.key === k) || ds.fields[0];
        const s = seriesFor(ds, k);
        charts.push({
          id: 'trend_' + k, type: 'line', title: f.label + ' · 趋势',
          labels: s.labels, format: f.type === 'ratio' ? 'pct' : 'num',
          datasets: [{ label: f.label, data: s.values, color: palette[i % palette.length] }],
        });
      });
    }
    return charts;
  }

  // ───────────────────────── 洞察生成 ─────────────────────────
  function buildInsights(ds, intent, metrics, query) {
    const insights = [];
    const keys = metrics.filter(k => ds.fields.some(f => f.key === k));

    // 1) 趋势预测（每个指标做线性回归，外推下一期）
    if (intent === 'trend' || intent === 'auto' || intent === 'summary') {
      keys.slice(0, 4).forEach(k => {
        const f = ds.fields.find(x => x.key === k); if (!f) return;
        const s = seriesFor(ds, k); if (s.values.length < 3) return;
        const reg = linreg(s.values); if (!reg) return;
        const next = reg.predict(s.values.length);
        const last = s.values[s.values.length - 1];
        const dir = reg.slope > 0 ? '上升' : (reg.slope < 0 ? '下降' : '持平');
        const goodForUp = ['v1MonthRate', 'xfMonthNum', 'tjMonthNum', 'jkMonthNum', 'monthCashTotal', 'v1MonthProduced', 'v6MonthProduced', 'teacherCount', 'monthSaturation', 'monthEff'].includes(k);
        const severity = reg.slope === 0 ? 'info' : (goodForUp === (reg.slope > 0) ? 'good' : 'warn');
        insights.push({
          type: 'trend', severity,
          title: f.label + ' · 趋势预测',
          text: '近 ' + s.values.length + ' 期' + f.label + '整体呈' + dir + '走势（每期约变动 ' + fmtVal(Math.abs(reg.slope), f.type) + '），按当前趋势预计下一期约 ' + fmtVal(next, f.type) + '（当前 ' + fmtVal(last, f.type) + '）。',
        });
      });
    }

    // 2) 异常检测（z-score > 2）
    if (intent === 'anomaly' || intent === 'auto' || intent === 'summary') {
      keys.slice(0, 4).forEach(k => {
        const f = ds.fields.find(x => x.key === k); if (!f) return;
        const s = seriesFor(ds, k); if (s.values.length < 4) return;
        const m = mean(s.values), sd = std(s.values, m); if (sd === 0) return;
        s.values.forEach((v, i) => {
          const z = (v - m) / sd;
          if (Math.abs(z) > 2) {
            insights.push({
              type: 'anomaly', severity: 'warn',
              title: f.label + ' · 异常点',
              text: s.labels[i] + ' 的' + f.label + '为 ' + fmtVal(v, f.type) + '，偏离均值 ' + fmtVal(m, f.type) + ' 约 ' + Math.abs(z).toFixed(1) + ' 个标准差，疑似异常波动，建议核查。',
            });
          }
        });
      });
    }

    // 3) 关键指标摘要（最新 vs 首期 / 极值 / 均值）
    const summaryKeys = keys.slice(0, 5);
    summaryKeys.forEach(k => {
      const f = ds.fields.find(x => x.key === k); if (!f) return;
      const s = seriesFor(ds, k); if (s.values.length < 2) return;
      const first = s.values[0], last = s.values[s.values.length - 1];
      const maxI = s.values.indexOf(Math.max(...s.values));
      const minI = s.values.indexOf(Math.min(...s.values));
      const avg = mean(s.values);
      const chg = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
      insights.push({
        type: 'summary', severity: 'info',
        title: f.label + ' · 关键摘要',
        text: '区间 ' + s.labels[0] + '→' + s.labels[s.labels.length - 1] + '：最新 ' + fmtVal(last, f.type) + '，均值 ' + fmtVal(avg, f.type) + '，最高 ' + s.labels[maxI] + '（' + fmtVal(s.values[maxI], f.type) + '），最低 ' + s.labels[minI] + '（' + fmtVal(s.values[minI], f.type) + '）；较期初' + (chg >= 0 ? '增长' : '下降') + ' ' + Math.abs(chg).toFixed(1) + '%。',
      });
    });

    return insights;
  }

  // ───────────────────────── 自然语言摘要 ─────────────────────────
  function buildSummary(ds, intent, insights, metrics) {
    const period = ds.rows.length
      ? (ds.rows[0].label + ' 至 ' + ds.rows[ds.rows.length - 1].label)
      : '—';
    const head = '基于「' + (DATASET_LABELS[ds.stream] || ds.stream) + '」共 ' + ds.rows.length + ' 条数据（' + period + '）的分析：';
    // 构成分析：聚焦最新一期的率类指标
    if (intent === 'composition' && ds.isTimeSeries && ds.rows.length) {
      const last = ds.rows[ds.rows.length - 1];
      const rf = ds.fields
        .filter(f => f.type === 'ratio' && num(last.values[f.key]) != null)
        .sort((a, b) => (num(last.values[b.key]) || 0) - (num(last.values[a.key]) || 0))
        .slice(0, 3);
      const body = rf.length
        ? '最新一期（' + last.label + '）率类指标构成：' + rf.map(f => f.label + ' ' + fmtVal(num(last.values[f.key]), 'ratio')).join('、') + '。'
        : '本期无可用率类指标。';
      return head + body;
    }
    const picked = insights.filter(i => i.type !== 'summary').slice(0, 3)
      .concat(insights.filter(i => i.type === 'summary').slice(0, 1));
    const body = picked.length
      ? picked.map(i => '· ' + i.text).join('；')
      : '数据特征已自动识别，下方图表展示了核心指标的走势与构成。';
    let advice = '';
    const anom = insights.find(i => i.type === 'anomaly');
    const badTrend = insights.find(i => i.type === 'trend' && i.severity === 'warn');
    if (anom) advice = ' 建议优先核查' + anom.title.replace(' · 异常点', '') + '的异常波动来源。';
    else if (badTrend) advice = ' 建议对' + badTrend.title.replace(' · 趋势预测', '') + '的下行趋势制定改善动作。';
    return head + body + advice;
  }

  // ───────────────────────── 对外 analyze ─────────────────────────
  async function analyze({ query = '', stream = 'monthly' } = {}) {
    const ds = prepareDataset(stream);
    if (!ds.ok) {
      return {
        ok: false, source: 'local', query, datasetLabel: DATASET_LABELS[stream] || stream,
        summary: '', insights: [], charts: [],
        error: '该数据集暂无数据，请先在对应模块上传 / 生成数据（如「数据源」入库周报并生成月度数据、「科组生产指标」拉取实际等），再来此分析。',
        meta: { source: 'local' },
      };
    }
    const intent = detectIntent(query);
    const extracted = extractMetrics(query, ds.fields);
    const metrics = pickMetrics(intent, extracted, ds.fields);
    const insights = buildInsights(ds, intent, metrics, query);
    const charts = buildCharts(ds, intent, metrics);
    const summary = buildSummary(ds, intent, insights, metrics);
    return {
      ok: true, source: 'local', query, datasetLabel: DATASET_LABELS[stream] || stream,
      summary, insights, charts,
      meta: { source: 'local', intent, metrics, isTimeSeries: ds.isTimeSeries, rows: ds.rows.length },
    };
  }

  CA.aiEngine = { prepareDataset, analyze, detectIntent, extractMetrics, version: '2026-09-06a' };
})(window);
