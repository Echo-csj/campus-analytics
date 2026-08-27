/* sync.js — 云端同步（Supabase）· 数据分析工作台版
 * 设计：单用户 = 每库整文档。登录后拉取云端合并本地；每次保存 800ms 防抖后整份推送；
 *       订阅 Realtime 实现跨设备近实时；shared_link 用于向个人台推送分析快照。
 * 关键：未配置 APP_CONFIG（仍是 YOUR_ 占位符）时自动禁用 —— 站点行为与之前完全一致（纯本地）。
 */
(function (global) {
  'use strict';
  var CA = global.CA || (global.CA = {});
  var cfg = global.APP_CONFIG || {};
  var TABLE = 'campus_analytics';

  var disabled = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
    /YOUR_/.test(cfg.SUPABASE_URL) || /YOUR_/.test(cfg.SUPABASE_ANON_KEY);
  var client = null, session = null, channel = null, pushTimer = null;
  var applyingRemote = false;
  var status = disabled ? 'disabled' : 'signedout';
  var statusMsg = '';
  var statusListeners = [];

  function setStatus(s, msg) { status = s; statusMsg = msg || ''; statusListeners.forEach(function (f) { try { f(s, msg); } catch (e) {} }); }
  function ensureClient() {
    if (disabled || client) return client;
    if (global.supabase && global.supabase.createClient) {
      client = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    } else {
      console.error('[sync] Supabase JS SDK 未加载，请检查网络、CDN 可访问性或广告拦截插件');
    }
    return client;
  }
  function toast(msg) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function uid() { return session && session.user ? session.user.id : null; }

  // ---- 认证 ----
  async function handleRedirect() {
    if (disabled) return false;
    var c = ensureClient(); if (!c) return false;
    try {
      if (location.hash && location.hash.indexOf('access_token') !== -1) {
        var r = await c.auth.getSessionFromUrl();
        if (r.error) { console.warn('[sync] getSessionFromUrl', r.error); return false; }
        session = r.data.session;
        history.replaceState(null, '', location.pathname + location.search);
        return true;
      }
      var g = await c.auth.getSession();
      if (g.data && g.data.session) { session = g.data.session; return true; }
    } catch (e) { console.warn('[sync]', e); }
    return false;
  }
  var signingIn = false;
  var lastOtpSentAt = 0;
  async function signIn(email) {
    if (signingIn) return; // 请求返回前禁止再次点击
    var now = Date.now();
    if (now - lastOtpSentAt < 60000) { // 本地 60 秒冷却：避免触发 Supabase 免费档 429
      var waitSec = Math.ceil((60000 - (now - lastOtpSentAt)) / 1000);
      setStatus('error', '登录链接已发送，请检查邮箱；或等待 ' + waitSec + ' 秒后再试');
      renderWidget();
      return;
    }
    var c = ensureClient();
    if (!c) { setStatus('error', 'Supabase 客户端未加载，请检查网络或刷新页面'); renderWidget(); return; }
    signingIn = true;
    lastOtpSentAt = now; // 只要尝试发送，就记一次时间
    setStatus('signingin');
    try {
      var r = await c.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } });
      signingIn = false;
      if (r.error) {
        // 429 是免费档发送频次限制；服务端冷却时，本地也进入冷却，提示用户稍后再试
        if (/429/.test('' + (r.error.message || '')) || (r.error.status === 429)) {
          setStatus('error', '发送太频繁，请等待 1–2 分钟后再试');
        } else {
          setStatus('error', r.error.message);
        }
        renderWidget();
        return;
      }
      setStatus('checkemail', '已发送登录链接，请到邮箱点击完成登录');
      renderWidget();
    } catch (e) {
      signingIn = false;
      console.error('[sync] signIn', e);
      setStatus('error', '发送失败：' + (e.message || '网络/配置错误'));
      renderWidget();
    }
  }
  async function signOut() { if (client) { try { await client.auth.signOut(); } catch (e) {} } session = null; setStatus('signedout'); renderWidget(); }

  // ---- 数据 ----
  var pkOf = function (r) { return [r.stream, r.year, r.month, r.week, r.dimension || '_'].join('|'); };
  async function pull() {
    if (!session) return null;
    var c = ensureClient(); if (!c) return null;
    var r = await c.from(TABLE).select('data,updated_at').eq('user_id', uid()).maybeSingle();
    if (r.error) { console.warn('[sync] pull', r.error); return null; }
    return r.data;
  }
  async function push(arr) {
    if (!session) return;
    var c = ensureClient(); if (!c) return;
    var r = await c.from(TABLE).upsert({ user_id: uid(), data: arr, updated_at: new Date().toISOString() });
    if (r.error) { console.warn('[sync] push', r.error); setStatus('error', r.error.message); return; }
    setStatus('ok');
  }
  function schedulePush(arr) {
    if (disabled || !session) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(arr); }, 800);
  }
  async function applyRemote() {
    if (applyingRemote) return;
    var remote = await pull();
    var localArr = CA.store.readAll();
    if (!remote) {
      // 云端为空：把本机已有数据上传（首次登录即完成迁移）
      if (localArr && localArr.length) { await push(localArr); }
      setStatus('ok'); return;
    }
    var remoteArr = Array.isArray(remote.data) ? remote.data : [];
    applyingRemote = true;
    try {
      if (!localArr || localArr.length === 0) {
        CA.store.clearAll();
        remoteArr.forEach(function (r) { CA.store.upsert(r); });
      } else {
        var map = {};
        localArr.forEach(function (r) { map[pkOf(r)] = r; });
        remoteArr.forEach(function (r) { map[pkOf(r)] = r; });
        CA.store.clearAll();
        Object.keys(map).forEach(function (k) { CA.store.upsert(map[k]); });
      }
      setStatus('ok');
      if (CA.app && typeof CA.app.refresh === 'function') CA.app.refresh();
      else global.dispatchEvent(new Event('ca:sync-applied'));
    } finally { applyingRemote = false; }
  }
  function wrapWrites() {
    var ou = CA.store.upsert;
    CA.store.upsert = function (r) { var res = ou(r); if (!applyingRemote) schedulePush(CA.store.readAll()); return res; };
    var oi = CA.store.importJSON;
    CA.store.importJSON = function (t) { var n = oi(t); if (!applyingRemote) schedulePush(CA.store.readAll()); return n; };
    var orm = CA.store.remove;
    CA.store.remove = function () { var a = orm.apply(null, arguments); if (!applyingRemote) schedulePush(CA.store.readAll()); return a; };
    var ocl = CA.store.clearAll;
    CA.store.clearAll = function () { var a = ocl(); if (!applyingRemote) schedulePush(CA.store.readAll()); return a; };
  }
  function subscribeRealtime() {
    if (!session || !client) return;
    channel = client.channel(TABLE + ':' + uid())
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + uid() }, function () { applyRemote(); })
      .subscribe();
    document.addEventListener('visibilitychange', function () { if (!document.hidden && session) applyRemote(); });
  }

  // ---- 联动桥：推送分析快照到个人台 ----
  function buildSnapshot() {
    var all = CA.store.readAll();
    var byStream = {};
    var score = function (x) { return (x.year || 0) * 372 + (x.month || 0) * 31 + (x.week || 0); };
    all.forEach(function (r) {
      if (!byStream[r.stream] || score(r) > score(byStream[r.stream])) byStream[r.stream] = r;
    });
    return { generatedAt: new Date().toISOString(), totalRecords: all.length, latestByStream: byStream };
  }
  async function pushSharedSnapshot() {
    if (!session) { toast('请先登录以启用云端'); return; }
    var c = ensureClient(); if (!c) return;
    var snap = buildSnapshot();
    var r = await c.from('shared_link').upsert(
      { user_id: uid(), kind: 'analytics_snapshot', payload: snap, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,kind' });
    if (r.error) { console.warn('[sync] pushShared', r.error); toast('推送失败'); return; }
    toast('已推送最新分析快照到个人工作台');
  }
  async function readShared() {
    if (!session) return [];
    var c = ensureClient(); if (!c) return [];
    var r = await c.from('shared_link').select('*').eq('user_id', uid()).order('updated_at');
    if (r.error) { console.warn(r.error); return []; }
    return r.data || [];
  }

  // ---- 启动 ----
  async function start() {
    if (disabled) { setStatus('disabled'); renderWidget(); return; }
    var ok = await handleRedirect();
    if (ok) { setStatus('ok'); wrapWrites(); await applyRemote(); subscribeRealtime(); }
    else { setStatus('signedout'); }
    renderWidget();
  }

  // ---- 小组件 UI ----
  function el(id) { return document.getElementById(id); }
  function renderWidget() {
    var w = el('sync-widget');
    if (!w) { w = document.createElement('div'); w.id = 'sync-widget'; w.className = 'sync-widget'; document.body.appendChild(w); }
    if (status === 'disabled') {
      w.innerHTML = '<div class="sw-box"><span class="sw-dot grey"></span>云端同步未启用（可选）</div>';
      return;
    }
    if (status === 'signedout' || status === 'signingin') {
      w.innerHTML = '<div class="sw-box"><span class="sw-dot grey"></span>' +
        '<div class="sw-row"><input id="sync-email" type="email" placeholder="邮箱登录以同步" class="sw-input"/>' +
        '<button id="sync-login" class="sw-btn">登录</button></div>' +
        '<div class="sw-tip">开启后数据可在多设备同步（本机仍保留备份）</div></div>';
      el('sync-login').onclick = function () { var e = el('sync-email').value.trim(); if (e) signIn(e); };
      return;
    }
    if (status === 'checkemail') {
      w.innerHTML = '<div class="sw-box"><span class="sw-dot blue"></span>已发登录链接，请查收邮箱并点击</div>';
      return;
    }
    if (status === 'error') {
      var errMsg = statusMsg || '同步出错，请刷新重试';
      w.innerHTML = '<div class="sw-box"><span class="sw-dot red"></span>' + errMsg + '<a id="sync-retry" class="sw-link">重试</a></div>';
      el('sync-retry').onclick = function () { start(); };
      return;
    }
    var user = session && session.user && session.user.email ? session.user.email : '已同步';
    w.innerHTML = '<div class="sw-box"><span class="sw-dot green"></span>' +
      '<span class="sw-user">' + user + ' · 已同步</span>' +
      '<button id="sync-push" class="sw-btn small">推送分析到个人台</button>' +
      '<button id="sync-out" class="sw-link">退出</button></div>';
    el('sync-push').onclick = pushSharedSnapshot;
    el('sync-out').onclick = signOut;
  }

  CA.sync = {
    start: start, signIn: signIn, signOut: signOut,
    pushSharedSnapshot: pushSharedSnapshot, readShared: readShared,
    onStatus: function (f) { statusListeners.push(f); },
    getStatus: function () { return status; },
    applyRemote: applyRemote
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
