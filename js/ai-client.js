/*
 * ai-client.js — AI 分析 · 统一编排层（对外接口）
 * ----------------------------------------------------------------------------
 * 职责：对上层 UI 提供单一入口 CA.ai.analyze()，屏蔽「本地引擎 / 云端 LLM」差异。
 *   - 若配置了直连模式（浏览器直接 fetch 兼容 OpenAI 的端点，如 Deepseek，Key 存浏览器），优先调用；
 *   - 否则若配置了云端 LLM（Edge Function ai-analyze，secret 在服务端），优先调用，能力更强；
 *   - 否则（默认）使用本地启发式引擎 CA.aiEngine，完全离线、无需 Key；
 *   - 云端/直连调用失败时自动降级到本地引擎，并附带降级说明，保证「始终有结果 / 始终有提示」。
 *
 * 对外接口（挂在 window.CA.ai）：
 *   CA.ai.listDatasets() -> [{ id, label, stream, note }]
 *   CA.ai.analyze({ query, stream }) -> Promise<AnalysisResult>
 *
 * AnalysisResult 契约（与 ai-engine / Edge Function 完全一致）：
 *   { ok, source:'local'|'edge', query, datasetLabel, summary,
 *     insights: Insight[], charts: ChartSpec[], meta:{}, error? }
 *   Insight  = { type, title, text, severity:'info'|'good'|'warn' }
 *   ChartSpec= { id, type:'line'|'bar'|'pie'|'doughnut'|'area', title,
 *                labels:[], datasets:[{label,data:[],color?}], format:'num'|'pct'|'money' }
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  const DATASETS = [
    { id: 'monthly', label: '月度汇总数据', stream: 'monthly', note: '校区月度核心指标（生产课时/现金/续费/退费/离职率/停课率等）' },
    { id: 'weekly', label: '周报数据', stream: 'weekly', note: 'DOS 周报各周明细' },
    { id: 'kezuActual', label: '科组实际生产', stream: 'kezuActual', note: '各科组预排/实际生产课时（按科组聚合）' },
    { id: 'bestkezu', label: '最佳科组', stream: 'bestkezu', note: '最佳科组评比数据' },
    { id: 'tkpi', label: '教师 KPI', stream: 'tkpi', note: '教师月度台账（课次/饱和度等）' },
  ];

  function listDatasets() { return DATASETS.slice(); }

  // 是否启用云端 LLM（默认关闭，纯本地运行）
  function edgeEnabled() {
    const cfg = global.APP_CONFIG || {};
    return !!(cfg.AI_USE_EDGE || global.CA_AI_USE_EDGE);
  }

  // 调用云端 Edge Function（OpenAI 兼容结构化输出）
  async function callEdge(query, stream, datasetPayload) {
    const cfg = global.APP_CONFIG || {};
    if (!cfg.SUPABASE_URL) throw new Error('未配置 SUPABASE_URL');
    const fn = cfg.AI_FUNCTION || 'ai-analyze';
    const url = cfg.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + fn;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.SUPABASE_ANON_KEY) headers['apikey'] = cfg.SUPABASE_ANON_KEY;
    if (cfg.AI_FETCH_SECRET) headers['x-ai-secret'] = cfg.AI_FETCH_SECRET;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, stream, dataset: datasetPayload }),
    });
    if (!res.ok) {
      let msg = '云端分析返回 ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || '云端分析无结果');
    return data;
  }

  // ───────────────────────── 直连模式（浏览器直连 OpenAI 兼容端点） ─────────────────────────
  // 用途：不想走 Supabase Edge Function 时，网站直接以浏览器 fetch 调用 Deepseek（或任何
  //       兼容 OpenAI /chat/completions 的端点）。API Key 仅存浏览器 localStorage，不进公开代码。
  // 前提：仅限个人/本地使用——Key 会出现在浏览器 Network 面板，切勿用于公开多用户场景。
  // 若浏览器跨域被拦（CORS），自动降级到本地引擎，不报错中断。
  const DIRECT_CFG_KEY = 'ca_ai_direct_v1';
  const DIRECT_DEFAULTS = { enabled: false, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: '' };

  function getDirectConfig() {
    try {
      const raw = global.localStorage.getItem(DIRECT_CFG_KEY);
      if (!raw) return Object.assign({}, DIRECT_DEFAULTS);
      return Object.assign({}, DIRECT_DEFAULTS, JSON.parse(raw));
    } catch (_) {
      return Object.assign({}, DIRECT_DEFAULTS);
    }
  }
  function setDirectConfig(patch) {
    const merged = Object.assign(getDirectConfig(), patch || {});
    try { global.localStorage.setItem(DIRECT_CFG_KEY, JSON.stringify(merged)); } catch (_) {}
    return merged;
  }
  function directEnabled() {
    const c = getDirectConfig();
    return !!(c && c.enabled && c.apiKey && c.baseUrl && c.model);
  }

  const DIRECT_SYSTEM_PROMPT = `你是校区教学数据分析助手。给定一个数据集（字段定义 fields、按时间或维度排列的行 rows）和自然语言问题 query，请输出 JSON，严格遵循以下结构（不要输出 JSON 以外的任何文字）：
{
  "summary": "一段中文自然语言摘要（含关键发现与建议，简洁专业）",
  "insights": [ { "type": "trend|anomaly|summary|compare", "title": "简短标题", "text": "中文说明", "severity": "info|good|warn" } ],
  "charts": [ {
      "id": "唯一串",
      "type": "line|bar|pie|doughnut|area",
      "title": "图表标题",
      "labels": ["X轴/类别标签"],
      "datasets": [ { "label": "系列名", "data": [数值数组], "color": "可选十六进制色" } ],
      "format": "num|pct|money"
  } ]
}
要求：
- 根据数据特征自动选择图表类型：时间序列用 line/area；类别对比用 bar；率类构成用 doughnut/pie。
- 至少给出 1 张图表与 2 条洞察；洞察须包含趋势预测（linear 外推下一期）、异常检测（z-score>2）、关键指标摘要三类中的相关项。
- 数值字段中 ratio 类型以小数存储（如 0.069 表示 6.9%），图表 format 标为 pct。
- 仅使用数据集提供的数据，不编造字段。`;

  async function callDirect(query, stream, datasetPayload) {
    const cfg = getDirectConfig();
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) throw new Error('直连配置不完整（需启用并填写 Base URL / 模型 / API Key）');
    const userContent = '问题：' + query + '\n数据集（' + stream + '）：\n' +
      JSON.stringify({ fields: datasetPayload.fields, rows: datasetPayload.rows, isTimeSeries: datasetPayload.isTimeSeries });
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DIRECT_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      let msg = '直连 LLM 返回 ' + res.status;
      try { const t = await res.text(); if (t) msg += ' ' + t.slice(0, 200); } catch (_) {}
      throw new Error(msg);
    }
    const j = await res.json();
    const content = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (_) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
    }
    if (!parsed || !Array.isArray(parsed.charts)) throw new Error('直连 LLM 返回结构异常');
    return {
      ok: true, source: 'direct', query, datasetLabel: datasetLabel(stream),
      summary: parsed.summary || '',
      insights: Array.isArray(parsed.insights) ? parsed.insights : [],
      charts: parsed.charts,
      meta: { source: 'direct', model: cfg.model, baseUrl: cfg.baseUrl },
    };
  }

  async function analyze({ query = '', stream = 'monthly' } = {}) {
    // 0) 本地引擎始终可用（先做数据集准备，用于云端/直连载荷 & 兜底）
    let payload = null;
    try { payload = CA.aiEngine.prepareDataset(stream); } catch (_) { payload = { ok: false }; }

    // 1) 直连模式（最高优先级）：浏览器直接调用兼容 OpenAI 的端点（如 Deepseek）
    if (directEnabled() && payload && payload.ok) {
      try {
        return await callDirect(query, stream, payload);
      } catch (e) {
        // 降级到本地，并记录原因（可能因 CORS / 网络 / Key 错误）
        const local = await CA.aiEngine.analyze({ query, stream });
        local.meta = Object.assign({}, local.meta, { degradedFromDirect: true, directError: String(e && e.message || e) });
        local.summary = '（直连 LLM 暂不可用，已自动切换为本地引擎）' + (local.summary || '');
        return local;
      }
    }

    // 2) 云端 Edge Function（若开启且载荷有效）
    if (edgeEnabled() && payload && payload.ok) {
      try {
        const data = await callEdge(query, stream, payload);
        return Object.assign({ ok: true, source: 'edge', query, datasetLabel: datasetLabel(stream) }, data,
          { meta: Object.assign({ source: 'edge' }, data.meta || {}) });
      } catch (e) {
        // 降级到本地，并记录原因
        const local = await CA.aiEngine.analyze({ query, stream });
        local.meta = Object.assign({}, local.meta, { degradedFromEdge: true, edgeError: String(e && e.message || e) });
        local.summary = '（云端分析暂不可用，已自动切换为本地引擎）' + (local.summary || '');
        return local;
      }
    }

    // 3) 默认：本地引擎
    try {
      const r = await CA.aiEngine.analyze({ query, stream });
      return r;
    } catch (e) {
      return {
        ok: false, source: 'local', query, datasetLabel: datasetLabel(stream),
        summary: '', insights: [], charts: [],
        error: '分析过程出错：' + String(e && e.message || e),
        meta: { source: 'local', exception: true },
      };
    }
  }

  function datasetLabel(stream) {
    const d = DATASETS.find(x => x.stream === stream);
    return d ? d.label : stream;
  }

  CA.ai = { analyze, listDatasets, edgeEnabled, directEnabled, getDirectConfig, setDirectConfig, version: '2026-11-15a' };
})(window);
