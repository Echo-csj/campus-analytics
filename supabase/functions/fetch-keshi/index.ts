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

const FN_VERSION = "2026-09-05a";

// 91paike「科目」→ 本校「科组」聚合规则（业务口径）
// 数学=数学+生物；英语=英语；文综=语文+地理+历史+政治；理综=物理+化学
const GROUP_RULES: Record<string, string[]> = {
  "数学": ["数学", "生物"],
  "英语": ["英语"],
  "文综": ["语文", "地理", "历史", "政治"],
  "理综": ["物理", "化学"],
};

function env(k: string, d = ""): string {
  return (Deno.env.get(k) || d).trim();
}

// ── CORS ──
// 稳健做法：预检(OPTIONS)时把浏览器在 Access-Control-Request-Headers 里
// 声明的请求头原样回显，避免逐个枚举 apikey / x-client-info 等（打地鼠）。
function corsHeaders(req?: Request): Headers {
  const origin = req ? req.headers.get("origin") : null;
  const allow = env("KESHI_ALLOW_ORIGIN") || origin || "*";
  const requested = req ? req.headers.get("access-control-request-headers") : null;
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", allow);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    requested || "authorization, x-client-info, apikey, x-keshi-secret, content-type",
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
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
  // 仅当页面存在真实需要填写的验证码控件（input/img 的 name/id/src/alt/class 等属性里含验证码标记）才判定为需要验证码。
  // 避免页面文案、JS、隐藏 div 里的“验证码”字样误触发。
  const tags = html.match(/<(input|img)[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = (tag.match(/(?:name|id|type|src|alt|class|placeholder)\s*=\s*["']([^"']*)["']/gi) || []).join(" ").toLowerCase();
    if (/(captcha|txtcode|checkcode|verifycode|validatecode|vcode|验证码)/.test(attrs)) return true;
  }
  return false;
}

// ── 表头列匹配 ──
// 兼容两种表结构：
//  1) 月度/周度 91paike 统计表：科目、总排课时、已确认课时、老师请假课时、学生请假课时
//  2) 历史模板：科组、预排课时、实际生产课时
function matchColumns(header: string[]): Record<string, number> {
  const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, "");
  const subjectAliases = ["科目", "科组名称", "学科组名称", "教研组名称", "科组名", "学科组名", "小组名称", "科组", "学科组", "教研组", "学科"];
  // 月度表：总排课时 - 请假 = 预排
  const totalScheduledAliases = ["总排课时", "应排课时", "计划课时", "排课课时", "排课"];
  const teacherAbsentAliases = ["老师请假课时", "教师请假课时", "师请假课时", "教师请假"];
  const studentAbsentAliases = ["学生请假课时", "生请假课时", "学生请假"];
  // 模板式预排/生产（兼容历史）
  const scheduledAliases = ["预排课时", "实际预排课时", "实际预排", "预排", "周预排", "预排课时数"];
  const producedAliases = ["已确认课时", "实际生产课时", "实际生产", "生产课时", "实际课时", "实际产出", "已生产课时", "已产课时", "产出课时", "确认课时", "生产"];
  const weekAliases = ["周次", "周", "week"];
  const find = (aliases: string[]): number => {
    for (let idx = 0; idx < header.length; idx++) {
      const t = norm(header[idx]);
      if (!t) continue;
      if (aliases.some((a) => t === a || t.indexOf(a) >= 0)) return idx;
    }
    return -1;
  };
  const map: Record<string, number> = {};
  const s = find(subjectAliases); if (s >= 0) map.subject = s;
  const ts = find(totalScheduledAliases); if (ts >= 0) map.totalScheduled = ts;
  const ta = find(teacherAbsentAliases); if (ta >= 0) map.teacherAbsent = ta;
  const sa = find(studentAbsentAliases); if (sa >= 0) map.studentAbsent = sa;
  const sch = find(scheduledAliases); if (sch >= 0) map.scheduled = sch;
  const pr = find(producedAliases); if (pr >= 0) map.produced = pr;
  const wk = find(weekAliases); if (wk >= 0) map.week = wk;
  return map;
}
function toNum(v: unknown): number {
  const n = parseFloat(String(v == null ? "" : v).replace(/[, ]/g, ""));
  return isFinite(n) ? n : 0;
}
function isTotalRow(subject: string): boolean {
  return /合计|总计|汇总|小计|total|sum/i.test(subject);
}

// 将原始「科目」行聚合为「科组」行
function groupToKeshi(rawRows: any[]): { rows: any[]; groupErrors: string[] } {
  const groups: Record<string, { year: number; month: number; week: number; scheduled: number; produced: number; sources: string[] }> = {};
  const groupErrors: string[] = [];
  for (const r of rawRows) {
    const subject = String(r.subject || "").trim();
    if (!subject || isTotalRow(subject)) continue;
    const groupName = Object.entries(GROUP_RULES).find(([, subs]) => subs.includes(subject))?.[0];
    if (!groupName) {
      groupErrors.push("科目「" + subject + "」未匹配任何科组规则，已跳过");
      continue;
    }
    if (!groups[groupName]) {
      groups[groupName] = { year: r.year, month: r.month, week: r.week, scheduled: 0, produced: 0, sources: [] };
    }
    groups[groupName].scheduled += r.scheduled;
    groups[groupName].produced += r.produced;
    if (!groups[groupName].sources.includes(subject)) groups[groupName].sources.push(subject);
  }
  const rows = Object.entries(groups).map(([subject, g]) => ({
    year: g.year,
    month: g.month,
    week: g.week,
    subject,
    scheduled: Math.round(g.scheduled * 100) / 100,
    produced: Math.round(g.produced * 100) / 100,
  }));
  return { rows, groupErrors };
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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req), status: 204 });
  const origin = req.headers.get("origin");
  if (req.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST" }, 405, req);
  }
  // 共享密钥校验
  const secret = env("KESHI_FETCH_SECRET");
  const provided = req.headers.get("x-keshi-secret") || "";
  if (secret && provided !== secret) {
    return json({ ok: false, error: "未授权（共享密钥不符）" }, 403, req);
  }

  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const month = String(body.month || "").trim();          // YYYY-MM
  const week = parseInt(body.week == null ? "0" : body.week, 10) || 0;
  const mm = month.match(/^(\d{4})-(\d{1,2})$/);
  if (!mm) return json({ ok: false, error: "月份格式应为 YYYY-MM" }, 400, req);
  const year = +mm[1], mon = +mm[2];

  const baseUrl = env("KESHI_BASE_URL");
  const fixed = env("KESHI_FIXED_PARAMS");
  if (!baseUrl) return json({ ok: false, error: "缺少 KESHI_BASE_URL 配置" }, 500, req);

  const base: Record<string, string> = { "User-Agent": "Mozilla/5.0 (compatible; KeshiFetch/" + FN_VERSION + ")", "Accept": "text/html" };

  // 1) 登录（如需）
  const loginRes = await login(base);
  if (!loginRes.ok) return json({ ok: false, error: loginRes.error }, 502, req);

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
    return json({ ok: false, error: "抓取数据页失败：" + (e && (e as Error).message || String(e)) }, 502, req);
  }

  // 3) 解析表格
  const tables = extractTables(html);
  const errors: string[] = [];
  const debug: string[] = ["fnVersion=" + FN_VERSION, "url=" + url, "origin=" + (origin || "-"), "tablesFound=" + tables.length];
  let chosen: string[][] | null = null;
  let headerMap: Record<string, number> | null = null;
  let chosenHeaderIdx = 0;
  let chosenTableIdx = -1;
  let bestScore = 0;
  tables.forEach((t, ti) => {
    // 表内找「最佳表头行」：匹配列数最多的一行；数据从该行下一行起算
    let bestMap: Record<string, number> | null = null;
    let bestIdx = -1;
    let bScore = 0;
    for (let i = 0; i < t.length; i++) {
      const m = matchColumns(t[i]);
      const sc = (m.subject != null ? 1 : 0) +
        ((m.totalScheduled != null || m.scheduled != null) ? 1 : 0) +
        (m.produced != null ? 1 : 0);
      if (sc > bScore) { bScore = sc; bestMap = m; bestIdx = i; }
    }
    debug.push("table[" + ti + "] rows=" + t.length + " bestHeaderIdx=" + bestIdx + " score=" + bScore + " headers=" + JSON.stringify(t[bestIdx] || []));
    if (bestMap && bScore > bestScore) {
      bestScore = bScore; chosen = t; headerMap = bestMap; chosenHeaderIdx = bestIdx; chosenTableIdx = ti;
    }
  });
  if (!chosen || !headerMap) {
    return json({ ok: false, error: "未在页面找到含「科目/科组/预排/生产」的表格，可能登录失效或页面结构变化。", debug: debug.join("\n"), tablesFound: tables.length }, 422, req);
  }
  // 把选中表的表头与映射、以及前几行样本写入诊断
  debug.push("chosenTableIdx=" + chosenTableIdx + " chosenHeaderIdx=" + chosenHeaderIdx);
  debug.push("chosenHeaders=" + JSON.stringify(chosen[chosenHeaderIdx]));
  debug.push("chosenMap=" + JSON.stringify(headerMap));
  for (let i = chosenHeaderIdx + 1; i < Math.min(chosenHeaderIdx + 4, chosen.length); i++) {
    debug.push("sampleRow[" + i + "]=" + JSON.stringify(chosen[i]));
  }

  // 4) 提取原始「科目」行
  const rawRows: any[] = [];
  const monthlyMode = headerMap.totalScheduled != null;
  for (let i = chosenHeaderIdx + 1; i < chosen.length; i++) {
    const row = chosen[i];
    if (!row.length || row.every((c) => c === "")) continue;
    const get = (k: string) => row[headerMap![k]];
    const subject = (get("subject") || "").trim();
    if (!subject || isTotalRow(subject)) continue;

    let scheduled = 0;
    if (monthlyMode) {
      // 月度表：预排 = 总排 - 老师请假 - 学生请假
      scheduled = toNum(get("totalScheduled")) - toNum(get("teacherAbsent")) - toNum(get("studentAbsent"));
    } else if (headerMap.scheduled != null) {
      scheduled = toNum(get("scheduled"));
    }
    const produced = toNum(get("produced"));
    const wkCell = headerMap.week != null ? Math.round(toNum(get("week"))) : 0;

    rawRows.push({
      year, month: mon,
      week: wkCell || week,
      subject,
      scheduled: Math.round(scheduled * 100) / 100,
      produced: Math.round(produced * 100) / 100,
    });
  }

  // 5) 聚合成科组
  const { rows, groupErrors } = groupToKeshi(rawRows);
  errors.push(...groupErrors);

  debug.push("rawRows=" + rawRows.length + " groupedRows=" + rows.length);
  debug.push("grouped=" + JSON.stringify(rows));

  return json({ ok: true, rows, rawRows, errors, debug: debug.join("\n"), source: url, fnVersion: FN_VERSION, chosenTableIdx }, 200, req);
}

function json(obj: any, status: number, req?: Request): Response {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), {
    status,
    headers,
  });
}

serve(handle);
