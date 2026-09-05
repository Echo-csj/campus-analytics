// supabase/functions/fetch-keshi/index.ts
// ─────────────────────────────────────────────────────────────────────
// 91paike 科组课时统计 · 自动登录抓取（Supabase Edge Function / Deno）
// 前端「科组生产指标 → 实际跟踪」面板点「拉取」→ 调用本函数 →
// 本函数用存储在 Secrets 里的 91paike 账号密码自动登录，抓取 StatisticKeshi.aspx
// 的月/周数据，解析表格为统一结构返回。密码不进前端、不进仓库。
//
// 所有敏感配置均通过 Supabase Secrets 设置（部署时 `supabase secrets set`）：
//   KESHI_BASE_URL      数据页基址，如 http://zyg.91paike.com/StatisticKeshi.aspx
//   KESHI_FIXED_PARAMS  固定查询参数（不含月/周），如 module=401002&s_ad_department_id=1004&s_ue_user_study_type=01
//   KESHI_LOGIN_URL     登录页地址（用于取 __VIEWSTATE 并提交登录表单）
//   KESHI_USER          91paike 登录账号
//   KESHI_PASS          91paike 登录密码
//   KESHI_FETCH_SECRET  与前端约定的共享密钥（请求头 x-keshi-secret），防公开滥用
//   KESHI_ALLOW_ORIGIN  允许调用本函数的前端来源，如 https://echo-csj.github.io （留空=不限制）
//
// 可选覆盖（一般无需改，函数会自动探测登录表单）：
//   KESHI_LOGIN_FIELDS  JSON，如 {"user":"txtUserName","pass":"txtPassword","submit":"btnLogin"}
// ─────────────────────────────────────────────────────────────────────
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const FN_VERSION = "2026-09-05";

function env(k: string, d = ""): string {
  return (Deno.env.get(k) || d).trim();
}

// ── CORS ──
function corsHeaders(origin?: string | null): Record<string, string> {
  const allow = env("KESHI_ALLOW_ORIGIN") || origin || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-keshi-secret, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ── 极简 Cookie Jar（Deno fetch 不自动管理 cookie）──
const jar: Record<string, string> = {};
function ingestCookies(res: Response) {
  const h = res.headers.get("set-cookie");
  if (!h) return;
  // set-cookie 可能含多个，用逗号但在属性间无逗号分割；简单按 "; " 切后再按 "," 粗分
  h.split(/,(?=\s*[A-Za-z_-]+=)/).forEach((part) => {
    const seg = part.split(";")[0];
    const i = seg.indexOf("=");
    if (i > 0) jar[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  });
}
function cookieHeader(): string {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}

// ── HTML 工具 ──
function htmlDecode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// 提取所有 <table> 为二维单元格（已去标签、解码）
function extractTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tre = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tre.exec(html))) {
    const tbl = tm[0];
    const rows: string[][] = [];
    const rre = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rre.exec(tbl))) {
      const cells: string[] = [];
      const cre = /<t[hd][\s\S]*?<\/t[hd]>/gi;
      let cm;
      while ((cm = cre.exec(rm[0]))) cells.push(htmlDecode(cm[0]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}
// 收集页面所有 <input name value>（用于复制 __VIEWSTATE 等隐藏字段）
function collectInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = (tag.match(/name\s*=\s*["']([^"']*)["']/i) || [])[1];
    let val = (tag.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    if (name) out[name] = val;
  }
  return out;
}
function hasCaptcha(html: string): boolean {
  return /captcha|验证码|txtCode|checkcode/i.test(html);
}

// ── 表头列匹配（与前端 parseActualFile 对齐）──
function matchColumns(header: string[]): Record<string, number> {
  const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, string[]> = {
    subject: ["科组", "学科", "科目", "subject"],
    scheduled: ["实际预排", "预排", "排课", "计划课时", "预排课时", "预排生产"],
    produced: ["实际生产", "生产课时", "实际生产课时", "实际产出", "produced"],
    week: ["周次", "周", "week"],
  };
  const map: Record<string, number> = {};
  header.forEach((cell, idx) => {
    const t = norm(cell);
    if (!t) return;
    for (const key in aliases) {
      if (map[key] != null) continue;
      if (aliases[key].some((a) => t === a || t.indexOf(a) >= 0)) { map[key] = idx; break; }
    }
  });
  return map;
}
function toNum(v: unknown): number {
  const n = parseFloat(String(v == null ? "" : v).replace(/[, ]/g, ""));
  return isFinite(n) ? n : 0;
}

// ── 自动探测登录表单字段 ──
function detectLoginFields(html: string): { user: string; pass: string; submit: string } {
  const override = env("KESHI_LOGIN_FIELDS");
  if (override) {
    try { return JSON.parse(override); } catch (_) { /* fall through */ }
  }
  let pass = "", user = "", submit = "";
  const re = /<input\b[^>]*>/gi;
  let m;
  const inputs: { name: string; type: string }[] = [];
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = (tag.match(/name\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    const type = (tag.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || "text";
    if (name) inputs.push({ name, type });
  }
  const p = inputs.find((i) => i.type === "password");
  if (p) {
    pass = p.name;
    // 用户名取密码前最近的 text 输入框
    const pi = inputs.indexOf(p);
    for (let i = pi - 1; i >= 0; i--) {
      if (inputs[i].type === "text") { user = inputs[i].name; break; }
    }
    if (!user) user = inputs[0]?.name || "txtUserName";
  }
  const sb = inputs.find((i) => /submit|button|登录|login/i.test(i.type + i.name));
  if (sb) submit = sb.name;
  return { user: user || "txtUserName", pass: pass || "txtPassword", submit: submit || "btnLogin" };
}

// ── 登录并取 Cookie ──
async function login(base: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const loginUrl = env("KESHI_LOGIN_URL");
  const user = env("KESHI_USER");
  const pass = env("KESHI_PASS");
  if (!loginUrl || !user || !pass) {
    return { ok: false, error: "缺少登录配置（KESHI_LOGIN_URL / KESHI_USER / KESHI_PASS 未设置）" };
  }
  try {
    const getRes = await fetch(loginUrl, { headers: { ...base, "Cookie": cookieHeader() } });
    const html = await getRes.text();
    ingestCookies(getRes);
    if (hasCaptcha(html)) {
      return { ok: false, error: "登录页存在验证码，无法自动登录。请改用马维斯在浏览器导出（方案兜底）。" };
    }
    const fields = detectLoginFields(html);
    const form = new URLSearchParams();
    const hidden = collectInputs(html);
    for (const k in hidden) form.set(k, hidden[k]); // 复制 __VIEWSTATE 等
    form.set(fields.user, user);
    form.set(fields.pass, pass);
    form.set(fields.submit, "登录");
    const postRes = await fetch(loginUrl, {
      method: "POST",
      headers: { ...base, "Cookie": cookieHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    ingestCookies(postRes);
    // 登录后通常会 302 跳回；无论是否跳转，只要拿到 cookie 即视为成功
    if (!cookieHeader()) return { ok: false, error: "登录后未获得会话 Cookie" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "登录请求异常：" + (e && (e as Error).message || String(e)) };
  }
}

// ── 主流程 ──
async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin), status: 204 });
  if (req.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST" }, 405, origin);
  }
  // 共享密钥校验
  const secret = env("KESHI_FETCH_SECRET");
  const provided = req.headers.get("x-keshi-secret") || "";
  if (secret && provided !== secret) {
    return json({ ok: false, error: "未授权（共享密钥不符）" }, 403, origin);
  }

  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const month = String(body.month || "").trim();          // YYYY-MM
  const week = parseInt(body.week == null ? "0" : body.week, 10) || 0;
  const mm = month.match(/^(\d{4})-(\d{1,2})$/);
  if (!mm) return json({ ok: false, error: "月份格式应为 YYYY-MM" }, 400, origin);
  const year = +mm[1], mon = +mm[2];

  const baseUrl = env("KESHI_BASE_URL");
  const fixed = env("KESHI_FIXED_PARAMS");
  if (!baseUrl) return json({ ok: false, error: "缺少 KESHI_BASE_URL 配置" }, 500, origin);

  const base: Record<string, string> = { "User-Agent": "Mozilla/5.0 (compatible; KeshiFetch/" + FN_VERSION + ")", "Accept": "text/html" };

  // 1) 登录（如需）
  const loginRes = await login(base);
  if (!loginRes.ok) return json({ ok: false, error: loginRes.error }, 502, origin);

  // 2) 抓取数据页
  const params = new URLSearchParams();
  if (fixed) fixed.split("&").forEach((p) => { const i = p.indexOf("="); if (i > 0) params.set(p.slice(0, i), p.slice(i + 1)); });
  params.set("s_date_manth", month);     // 注意：源站参数名拼写为 manth
  params.set("s_date_week", String(week));
  const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + params.toString();

  let html = "";
  try {
    const res = await fetch(url, { headers: { ...base, "Cookie": cookieHeader() } });
    ingestCookies(res);
    html = await res.text();
  } catch (e) {
    return json({ ok: false, error: "抓取数据页失败：" + (e && (e as Error).message || String(e)) }, 502, origin);
  }

  // 3) 解析表格
  const tables = extractTables(html);
  const errors: string[] = [];
  let chosen: string[][] | null = null;
  let headerMap: Record<string, number> | null = null;
  for (const t of tables) {
    for (let i = 0; i < t.length; i++) {
      const m = matchColumns(t[i]);
      if (m.subject != null && (m.scheduled != null || m.produced != null)) { chosen = t; headerMap = m; break; }
    }
    if (chosen) break;
  }
  if (!chosen || !headerMap) {
    return json({ ok: false, error: "未在页面找到含「科组/预排/生产」的表格，可能登录失效或页面结构变化。", tablesFound: tables.length }, 422, origin);
  }
  const rows: any[] = [];
  for (let i = (chosen.indexOf(chosen.find((r) => r === chosen[0])) || 0) + 1; i < chosen.length; i++) {
    const row = chosen[i];
    if (!row.length || row.every((c) => c === "")) continue;
    const get = (k: string) => row[headerMap![k]];
    const subject = (get("subject") || "").trim();
    if (!subject) { errors.push("第 " + (i + 1) + " 行缺少科组，已跳过"); continue; }
    const wkCell = headerMap.week != null ? Math.round(toNum(get("week"))) : 0;
    rows.push({
      year, month: mon,
      week: wkCell || week,
      subject,
      scheduled: toNum(get("scheduled")),
      produced: toNum(get("produced")),
    });
  }
  return json({ ok: true, rows, errors, source: url, fnVersion: FN_VERSION }, 200, origin);
}

function json(obj: any, status: number, origin?: string | null): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

serve(handle);
