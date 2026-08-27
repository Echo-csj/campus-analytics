// config.js — 云端同步配置
// 在 Supabase 控制台 → Project Settings → API 中复制下面两项，替换占位符即可。
// 说明：publishable key（旧称 anon key）本就是公开的设计（数据安全靠 RLS 行级权限，不靠藏密钥），
//       所以把本文件提交到 GitHub 仓库也不泄露隐私。切勿填写 secret / service_role 密钥。
window.APP_CONFIG = {
  SUPABASE_URL: 'https://zxemcyngesgxpbevdxsu.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_b3iWR8Dd4Gng8PEeI98IWg_1cHuB2Dt',
  APP_NAME: 'campus-analytics'
};
