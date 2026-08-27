# 云端同步配置指引（非技术版）

两个工作台（数据分析台 + 个人台）已内置同步能力，但默认关闭。**只有填好下面两步的密钥后才会启用**；在此之前，网站和你现在一模一样（纯本地、纯离线）。

---

## 一、只需要做一次的事

### 1. 注册 Supabase（免费）
1. 打开 https://supabase.com ，点右上角 **Start your project**（或 Sign Up）。
2. 用邮箱注册即可（也可以用 GitHub 账号登录，你已有 GitHub 账号）。
3. 注册完进入控制台，点 **New project**（新建项目）：
   - Name：随便起，比如 `quanshan-sync`
   - Database Password：设一个你能记住的密码（**截图保存**，丢了要重置）
   - Region：选 **Northeast Asia (Tokyo)** 或 **Singapore**（离国内近、快）
   - 点 Create。

### 2. 建数据表（复制粘贴即可）
1. 左侧菜单点 **SQL Editor** → **New query**。
2. 打开本仓库里的 `supabase/schema.sql`，**全选复制**，粘进编辑器。
3. 点 **Run**（右上角 ▶）。看到成功提示即可。
   - 这会建三张表：`campus_analytics`、`dos_workbench`、`shared_link`，并开启「行级安全」（你的数据只有你能看）。

### 3. 拿两个密钥
1. 左侧菜单 **Project Settings** → **API**。
2. 复制这两项（后面要用）：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon public key**（一长串 `eyJ...`）

### 4. 填进两个工作台
分别打开两个仓库的 `js/config.js`，把占位符替换掉：
```js
window.APP_CONFIG = {
  SUPABASE_URL: '粘贴你的 Project URL',
  SUPABASE_ANON_KEY: '粘贴你的 anon public key',
  APP_NAME: 'campus-analytics'   // 个人台那个写 'dos-workbench'，别改错
};
```
> 说明：anon key 本就是公开设计，数据安全靠「行级权限」而非藏密钥，所以提交到 GitHub 也不泄露隐私。

### 5. 登录配置（回调 + 设密码）
> ⚠️ **踩坑经验**：Supabase 免费档对「发送登录邮件（魔法链接 / 验证码）」有严格频次限制，反复调试极易触发 429，导致一直登不进去。**推荐用「邮箱 + 密码」登录 —— 完全不发邮件，最稳。**

1. **登录回调（可选保留）**：Supabase 控制台 → **Authentication** → **URL Configuration**，把两个站点地址加进 Redirect URLs（每行一个），Site URL 填其一。密码登录不依赖邮件回调，不配也能用，但保留无害：
   - `https://echo-csj.github.io/quanshan-dos-workbench/`
   - `https://echo-csj.github.io/campus-analytics/`（数据分析台）
2. **设置登录密码（必做）**：此前只用了魔法链接，账号可能还没有密码；后台「Reset password」也会发邮件、同样会被限流。所以**直接用 SQL 设密码（不发任何邮件）**：
   1. Supabase 控制台 → **SQL Editor** → **New query**。
   2. 粘贴并执行（把邮箱、密码换成你自己的；密码建议用英文小写字母+数字，避开中文/全角符号）：
      ```sql
      update auth.users
      set encrypted_password = crypt('你想设的密码', gen_salt('bf')),
          email_confirmed_at = now()
      where email = '你的邮箱';
      ```
   3. 显示执行成功即生效，无需收邮件。

---

## 二、部署到 GitHub Pages
两个仓库各自推送更新（和之前一样的发布流程）。注意：每次改完代码，**缓存参数 `?v=` 已自动 +1**，用户刷新即可拿到新版。

---

## 三、日常怎么用
- 打开网站，右下角会出现同步小组件：
  - 显示「未启用」= 你还没填密钥，纯本地。
  - 显示「邮箱 / 密码登录」= 填了密钥，输入**邮箱 + 密码** → 点登录 → 立即登录并把本机数据上传云端（首次即完成迁移）。
- 之后在任何设备打开同一网址、用同一邮箱+密码登录，数据自动拉取 → **跨设备同步**。
- 在一台改了数据，另一台切到该标签页（或刷新）即看到更新（近实时）。
- **联动**：在数据分析台点「推送分析到个人台」→ 在个人台点「查看联动数据」即可看到分析快照。
- 退出登录：小组件点「退出」。

> 登录方式说明：前端用的是 `signInWithPassword`（邮箱+密码），不发邮件、不撞限流。若以后想改成魔法链接，需同步改 `js/sync.js` 的 `signIn`，并注意 Supabase 免费档邮件限流问题。

---

## 四、成本与安全（重申）
- **成本**：单人免费档足够，日常 **¥0/月**。仅当你想用自己域名时才可能花钱（约 ¥60–100/年，可选）。
- **安全**：传输 HTTPS 加密；服务端静态加密；每条数据带「主人标签」，他人账号看不到（行级安全）。本机浏览器永远留一份，随时可导出备份。
- **建议**：Supabase 账号开启两步验证（Settings → Sign-in / MFA）。
- **兜底**：即使 Supabase 停服，你的数据本地还在、也能随时导出，不绑定。

---

## 五、常见问题
- **登录后没同步？** 检查第 5 步的 Redirect URL 是否填了正确的线上地址；检查 `js/config.js` 两个值是否填对、有无多余空格。
- **想完全不用云端？** 不改 `js/config.js`（保持 `YOUR_...` 占位符）即可，网站维持纯本地。
- **换电脑/清了浏览器缓存？** 只要云端已登录过并上传过数据，新设备登录同一邮箱即可恢复。
- **登录提示 Invalid credentials / 429？** 多半是账号没密码或邮箱未确认、或此前邮件通道被限流。回第 5.2 步用 SQL Editor 重设一次密码并置 `email_confirmed_at = now()` 即可，无需收邮件。
