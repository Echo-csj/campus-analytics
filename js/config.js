// config.js — 云端同步配置
// 说明：publishable key（旧称 anon key）本就是公开的设计（数据安全靠 RLS 行级权限，不靠藏密钥），
//       所以把本文件提交到 GitHub 仓库也不泄露隐私。切勿填写 secret / service_role 密钥。
window.APP_CONFIG = {
  // === 认证 + 数据同步：统一接入自建 Supabase（与主工作台同一后端，账号互通） ===
  SUPABASE_URL: 'https://supabase.dosworkbench.top',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg5MTk1Mzk5LCJleHAiOjQxMDI0NDQ4MDB9.Yejt5D7n9lzPzORBa9nUYJrzccPgxk3i5-sihrn-AV4',
  APP_NAME: 'campus-analytics',
  // === 边缘函数（fetch-keshi / ai-analyze）仍走云项目：自建暂未部署函数，避免功能回退 ===
  EDGE_URL: 'https://zxemcyngesgxpbevdxsu.supabase.co',
  // 91paike 自动拉取：与云端函数 fetch-keshi 约定的共享密钥（仅作防滥用闸门，非敏感密码）。
  KESHI_FETCH_SECRET: 'keshigate-8d2f4a1c9b3e',
  KESHI_FUNCTION: 'fetch-keshi',
  // AI 数据分析：云端 LLM 代理（可选）。默认开启，使用云端 ai-analyze 函数。
  AI_USE_EDGE: true,
  AI_FUNCTION: 'ai-analyze',
  // 与 Supabase Secret AI_FETCH_SECRET 统一（仅作防滥用闸门，非敏感密码，可公开）
  AI_FETCH_SECRET: 'ai-gate-f31c3e3b5bd865d0d1'
};
