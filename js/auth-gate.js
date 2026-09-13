/* ============================================
   auth-gate.js — 访问控制（前端门禁）· 数据分析工作台版
   未登录时锁定整个应用：隐藏侧栏/顶栏/内容区，仅显示登录屏，
   登录成功后恢复完整内容。与 Supabase RLS（后端已拒匿名读取）配合，
   杜绝未登录用户看到任何界面/数据。

   依赖：App.sync（由 sync.js 暴露：getStatus / signIn / onStatus）。
   登录屏 DOM 约定（见 index.html）：
     #ag-login #ag-email #ag-pass #ag-remember #ag-err #ag-offline #ag-ok
     .ag-btn-label .ag-spinner
   ============================================ */
(function (global) {
  'use strict';
  var App = global.App || (global.App = {});

  var REMEMBER_KEY = 'ca_remember';   // 仅存邮箱（不存密码）
  var prevStatus = null;

  function status() {
    return (App.sync && App.sync.getStatus) ? App.sync.getStatus() : 'signedout';
  }
  function isAuthed() { return status() === 'ok'; }

  /* ---------------- 记住邮箱（本地持久化，只存邮箱） ---------------- */
  function loadRemember() {
    try {
      var raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.password) {
        var clean = { email: typeof o.email === 'string' ? o.email : '' };
        try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(clean)); } catch (e) {}
        return clean;
      }
      if (o && typeof o.email === 'string') return o;
    } catch (e) {}
    return null;
  }
  function saveRemember(email) {
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: email })); } catch (e) {}
  }
  function clearRemember() {
    try { localStorage.removeItem(REMEMBER_KEY); } catch (e) {}
  }

  /* ---------------- 视觉反馈 ---------------- */
  function setLoading(on) {
    var btn = document.getElementById('ag-login');
    var label = btn && btn.querySelector('.ag-btn-label');
    var spin = btn && btn.querySelector('.ag-spinner');
    if (!btn) return;
    btn.disabled = !!on;
    if (btn.classList) btn.classList.toggle('loading', !!on);
    if (label) label.textContent = on ? '登录中…' : '登录';
    if (spin) spin.style.display = on ? '' : 'none';
  }
  function showError(msg) {
    setLoading(false);
    var err = document.getElementById('ag-err');
    var ok = document.getElementById('ag-ok');
    if (ok) ok.style.display = 'none';
    if (err) { err.textContent = msg || '登录失败，请重试'; err.style.display = ''; }
  }
  function showSuccess() {
    var btn = document.getElementById('ag-login');
    var label = btn && btn.querySelector('.ag-btn-label');
    var spin = btn && btn.querySelector('.ag-spinner');
    var ok = document.getElementById('ag-ok');
    var err = document.getElementById('ag-err');
    if (err) err.style.display = 'none';
    if (btn && btn.classList) btn.classList.add('success');
    if (label) label.textContent = '登录成功';
    if (spin) spin.style.display = 'none';
    if (ok) { ok.textContent = '登录成功 ✓ 正在进入…'; ok.style.display = ''; }
  }

  function signIn() {
    var e = document.getElementById('ag-email');
    var p = document.getElementById('ag-pass');
    var rem = document.getElementById('ag-remember');
    var email = e ? e.value.trim() : '';
    var pass = p ? p.value : '';
    if (!email || !pass) { showError('请填写邮箱和密码'); return; }
    var err = document.getElementById('ag-err');
    if (err) err.style.display = 'none';
    setLoading(true);   // 立即进入加载态，避免“点击无响应”
    if (rem && rem.checked) saveRemember(email);
    else clearRemember();
    App.sync.signIn(email, pass);
  }

  function renderDisabled() {
    var form = document.getElementById('ag-form');
    var off = document.getElementById('ag-offline');
    if (form) form.style.display = 'none';
    if (off) off.style.display = '';
  }

  function init() {
    var btn = document.getElementById('ag-login');
    if (btn) btn.onclick = signIn;
    var pass = document.getElementById('ag-pass');
    if (pass) pass.onkeydown = function (ev) { if (ev.key === 'Enter') signIn(); };

    var rem = loadRemember();
    if (rem && rem.email) {
      var e = document.getElementById('ag-email');
      var cb = document.getElementById('ag-remember');
      if (e) e.value = rem.email;
      if (cb) cb.checked = true;
    }

    if (status() === 'disabled') renderDisabled();

    if (App.sync && App.sync.onStatus) {
      App.sync.onStatus(function (s, msg) {
        if (s === 'disabled') renderDisabled();
        if (s === 'signingin') { setLoading(true); }
        else if (s === 'error') { showError(msg); }
        else if (s === 'ok') {
          if (prevStatus === 'signingin') {
            showSuccess();
            setTimeout(function () { apply(); }, 650);
          } else {
            apply();
          }
        }
        else if (s === 'signedout') {
          setLoading(false);
          apply();
        }
        prevStatus = s;
      });
    }
    apply();
  }

  function apply() {
    var locked = !isAuthed();
    if (locked) {
      document.body.classList.add('auth-locked');
      // 清除已渲染内容，避免残留
      var vc = document.getElementById('view-container') || document.getElementById('content');
      if (vc) vc.innerHTML = '';
      var btn = document.getElementById('ag-login');
      if (btn && btn.classList) btn.classList.remove('success', 'loading');
      setLoading(false);
      var pass = document.getElementById('ag-pass');
      if (pass) pass.value = '';
    } else {
      document.body.classList.remove('auth-locked');
      try { if (App.router && App.router.resolve) App.router.resolve(); } catch (e) {}
    }
  }

  App.auth = { isAuthed: isAuthed, apply: apply };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
