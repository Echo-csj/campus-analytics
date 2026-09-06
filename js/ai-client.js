/*
 * ai-client.js — AI 分析 · 统一编排层（对外接口）
 * ----------------------------------------------------------------------------
 * 职责：对上层 UI 提供单一入口 CA.ai.analyze()，屏蔽「本地引擎 / 云端 LLM」差异。
 *   - 若配置了云端 LLM（Edge Function ai-analyze，secret 在服务端），优先调用，能力更强；
 *   - 否则（默认）使用本地启发式引擎 CA.aiEngine，完全离线、无需 Key；
 *   - 云端调用失败时自动降级到本地引擎，并附带降级说明，保证「始终有结果 / 始终有提示」。
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

  async function analyze({ query = '', stream = 'monthly' } = {}) {
    // 1) 本地引擎始终可用（先做数据集准备，用于云端载荷 & 兜底）
    let payload = null;
    try { payload = CA.aiEngine.prepareDataset(stream); } catch (_) { payload = { ok: false }; }

    // 2) 优先云端（若开启且载荷有效）
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

  CA.ai = { analyze, listDatasets, edgeEnabled, version: '2026-09-06a' };
})(window);
