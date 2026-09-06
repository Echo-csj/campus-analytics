// supabase/functions/ai-analyze/index.ts
// ─────────────────────────────────────────────────────────────────────
// AI 数据分析 · 云端 LLM 代理（Supabase Edge Function / Deno）
//
// 前端「AI 分析」页在开启云端模式（config.js 设 AI_USE_EDGE=true）时调用本函数。
// 本函数把脱敏后的「数据集快照 + 自然语言问题」发给兼容 OpenAI 的 Chat
// Completion 接口，要求模型按统一契约返回结构化 JSON（摘要/洞察/图表），
// 前端按既有 ChartSpec 直接渲染——与本地引擎输出格式完全一致，可无缝替换。
//
// 所有敏感配置通过 Supabase Secrets 设置（部署：supabase secrets set）：
//   AI_API_KEY         LLM 提供方 API Key（必填；未设则返回 501 触发前端降级本地）
//   AI_BASE_URL        兼容 OpenAI 的 Base URL（缺省 https://api.openai.com/v1）
//   AI_MODEL           模型名（缺省 gpt-4o-mini）
//   AI_FETCH_SECRET    与前端约定的共享密钥（请求头 x-ai-secret），防公开滥用
//   AI_ALLOW_ORIGIN    允许来源，如 https://echo-csj.github.io （留空=不限制）
// ─────────────────────────────────────────────────────────────────────
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const FN_VERSION = "2026-09-06a";

function env(k: string, d = ""): string { return (Deno.env.get(k) || d).trim(); }

function corsHeaders(req?: Request): Headers {
  const origin = req ? req.headers.get("origin") : null;
  const allow = env("AI_ALLOW_ORIGIN") || origin || "*";
  const requested = req ? req.headers.get("access-control-request-headers") : null;
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", allow);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", requested || "authorization, x-client-info, apikey, x-ai-secret, content-type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}
function json(obj: any, status: number, req?: Request): Response {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers });
}

// 构造给 LLM 的系统提示：明确契约，要求只输出 JSON
const SYSTEM_PROMPT = `你是校区教学数据分析助手。给定一个数据集（字段定义 fields、按时间或维度排列的行 rows）和自然语言问题 query，请输出 JSON，严格遵循以下结构（不要输出 JSON 以外的任何文字）：
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

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req), status: 204 });
  if (req.method !== "POST") return json({ ok: false, error: "仅支持 POST" }, 405, req);

  const secret = env("AI_FETCH_SECRET");
  const provided = req.headers.get("x-ai-secret") || "";
  if (secret && provided !== secret) return json({ ok: false, error: "未授权" }, 403, req);

  const apiKey = env("AI_API_KEY");
  if (!apiKey) return json({ ok: false, error: "AI 未配置（缺少 AI_API_KEY）" }, 501, req);

  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const query = String(body.query || "请对数据做整体分析");
  const dataset = body.dataset || null;
  if (!dataset || !Array.isArray(dataset.rows) || !dataset.rows.length) {
    return json({ ok: false, error: "缺少有效数据集" }, 400, req);
  }

  const baseUrl = env("AI_BASE_URL") || "https://api.openai.com/v1";
  const model = env("AI_MODEL") || "gpt-4o-mini";
  const userContent = "问题：" + query + "\n数据集（" + (body.stream || "") + "）：\n" +
    JSON.stringify({ fields: dataset.fields, rows: dataset.rows, isTimeSeries: dataset.isTimeSeries });

  try {
    const upstream = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!upstream.ok) {
      const txt = await upstream.text();
      return json({ ok: false, error: "LLM 调用失败：" + upstream.status + " " + txt.slice(0, 300) }, 502, req);
    }
    const j = await upstream.json();
    const content = j?.choices?.[0]?.message?.content || "";
    let parsed: any = null;
    try { parsed = JSON.parse(content); } catch (_) {
      // 容错：尝试提取首个 { ... } 块
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
    }
    if (!parsed || !Array.isArray(parsed.charts)) {
      return json({ ok: false, error: "LLM 返回结构异常" }, 422, req);
    }
    return json({
      ok: true,
      summary: parsed.summary || "",
      insights: Array.isArray(parsed.insights) ? parsed.insights : [],
      charts: parsed.charts,
      meta: { source: "edge", model, fnVersion: FN_VERSION },
    }, 200, req);
  } catch (e) {
    return json({ ok: false, error: "LLM 请求异常：" + (e && (e as Error).message || String(e)) }, 502, req);
  }
}

serve(handle);
