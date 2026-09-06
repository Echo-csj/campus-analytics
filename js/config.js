// config.js — 云端同步配置
// 在 Supabase 控制台 → Project Settings → API 中复制下面两项，替换占位符即可。
// 说明：publishable key（旧称 anon key）本就是公开的设计（数据安全靠 RLS 行级权限，不靠藏密钥），
//       所以把本文件提交到 GitHub 仓库也不泄露隐私。切勿填写 secret / service_role 密钥。
window.APP_CONFIG = {
  SUPABASE_URL: 'https://zxemcyngesgxpbevdxsu.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_b3iWR8Dd4Gng8PEeI98IWg_1cHuB2Dt',
  APP_NAME: 'campus-analytics',
  // 91paike 自动拉取：与云端函数 fetch-keshi 约定的共享密钥（仅作防滥用闸门，非敏感密码）。
  // 已与 Supabase Secret KESHI_FETCH_SECRET 统一设为下方值；部署时 secrets set 用同一串即可。
  KESHI_FETCH_SECRET: 'keshigate-8d2f4a1c9b3e',
  KESHI_FUNCTION: 'fetch-keshi',
  // AI 数据分析：云端 LLM 代理（可选）。默认关闭，使用本地启发式引擎（完全离线、无需 Key）。
  // 已部署 Supabase Edge Function「ai-analyze」；在 Supabase Secrets 设置 AI_API_KEY 后，
  // 将下方 AI_USE_EDGE 改为 true 即可启用云端模式（无需改代码，函数会自动用 LLM 输出替换本地结果）。
  AI_USE_EDGE: true,
  AI_FUNCTION: 'ai-analyze',
  // 与 Supabase Secret AI_FETCH_SECRET 统一（仅作防滥用闸门，非敏感密码，可公开）
  AI_FETCH_SECRET: 'ai-gate-f31c3e3b5bd865d0d1'
};

