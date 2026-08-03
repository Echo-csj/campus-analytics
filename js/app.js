/*
 * app.js — UI 控制器
 * 三大板块（周报/最佳科组/教师KPI）+ 五项满意度 + 对比中心 + 模板中心 + 数据备份
 */
(function (global) {
  'use strict';
  const CA = global.CA;
  const SCHEMA = CA.SCHEMA, RB = CA.rulebook, TPL = CA.templates, STORE = CA.store, PARSER = CA.parser, AGG = CA.aggregate;

  let currentTab = 'weekly';
  let pending = null; // 待确认入库的解析结果
  const charts = {};

  // —— 工具 ——
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function fmt(v, digits) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    if (typeof v === 'number') {
      if (Math.abs(v) >= 10000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
      return v.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 2 : digits });
    }
    return String(v);
  }
  function pct(v) {
    if (v == null) return '—';
    // 百分数显示：先消除浮点噪声再取 2 位小数，去尾随 0（98% / 0.97% / 88.24%）
    const p = Math.round(v * 10000) / 100;
    let s = p.toFixed(2);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s + '%';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function parseFileWeek(name) {
    const m = String(name).match(/第\s*(\d+)\s*周/);
    return m ? parseInt(m[1], 10) : 4;
  }
  // 自动推断归属周期：报告针对「刚结束的那一周」——取本周日之前最近的一个周日（今天就是周日则用今天）
  function inferPeriod() {
    const now = new Date();
    const dow = now.getDay(); // 0=周日
    const ref = new Date(now);
    if (dow !== 0) ref.setDate(now.getDate() - dow);
    return { year: ref.getFullYear(), month: ref.getMonth() + 1, week: Math.ceil(ref.getDate() / 7) };
  }
  function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
  function updateCount() { $('#recordCount').textContent = STORE.readAll().length + ' 条记录'; }

  // —— 上传面板（通用）——
  function uploadPanelHTML(stream) {
    const names = { weekly: 'DOS 周报', kezu: '科组周报', kpi: '教师周报' };
    const desc = stream === 'weekly'
      ? '上传 DOS 周报 xlsx（含「数据统计表」工作表），按标签一键提取。'
      : '上传' + names[stream] + ' xlsx（首行表头，每行一个' + (stream === 'kezu' ? '科组' : '教师') + '），按表头一键提取。';
    const p = inferPeriod();
    const defaultLabel = (stream === 'weekly' ? (p.year + '年' + p.month + '月 ') : '') + '第' + p.week + '周';
    const uploadIco = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';
    return `
      <div class="panel">
        <div class="panel-title">上传并一键提取 · ${names[stream]}</div>
        <div class="panel-desc">${desc}</div>
        <div class="upload-bar" id="drop_${stream}">
          <div class="ub-left">
            <div class="ub-ico" id="ubico_${stream}">${uploadIco}</div>
            <div>
              <div class="ub-title">拖入或点击上传 ${names[stream]} xlsx</div>
              <div class="ub-sub" id="filelabel_${stream}">默认归属：<b>${defaultLabel}</b> · 可修改</div>
            </div>
          </div>
          <div class="ub-actions"><button class="btn primary" id="extract_${stream}">一键提取</button></div>
          <input type="file" id="file_${stream}" accept=".xlsx,.xls" hidden />
        </div>
        <div class="meta-row">
          <div class="field"><label>年份</label><input type="number" id="yr_${stream}" value="${p.year}" min="2000" max="2100" style="min-width:72px"/></div>
          <div class="field"><label>月份</label><input type="number" id="mo_${stream}" value="${p.month}" min="1" max="12" style="min-width:64px"/></div>
          <div class="field"><label>周序号</label><input type="number" id="wk_${stream}" value="${p.week}" min="1" max="6" style="min-width:64px"/></div>
        </div>
        <div id="preview_${stream}"></div>
      </div>`;
  }

  function markFile(stream, file) {
    const bar = $('#drop_' + stream), lbl = $('#filelabel_' + stream);
    if (bar) bar.classList.add('has-file');
    if (lbl) lbl.innerHTML = '已选文件：<b>' + file.name + '</b> · 点击重新选择';
  }
  function wireUpload(stream) {
    const drop = $('#drop_' + stream), fileInput = $('#file_' + stream);
    drop.addEventListener('click', e => { if (e.target.closest('button')) return; fileInput.click(); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) { markFile(stream, e.dataTransfer.files[0]); handleFile(stream, e.dataTransfer.files[0]); } });
    fileInput.addEventListener('change', e => { if (e.target.files[0]) { markFile(stream, e.target.files[0]); handleFile(stream, e.target.files[0]); } });
    $('#extract_' + stream).addEventListener('click', e => {
      e.stopPropagation();
      const f = fileInput.files[0];
      if (!f) { toast('请先选择文件'); return; }
      handleFile(stream, f);
    });
  }

  function handleFile(stream, file) {
    const yr = parseInt($('#yr_' + stream).value, 10);
    const mo = parseInt($('#mo_' + stream).value, 10);
    const wk = parseInt($('#wk_' + stream).value, 10);
    const ctx = { year: yr, month: mo, week: wk };
    const preview = $('#preview_' + stream);
    preview.innerHTML = '<div class="preview-note">解析中…</div>';
    const p = stream === 'weekly' ? PARSER.parseWeekly(file, ctx) : PARSER.parseDimension(file, stream, ctx);
    p.then(res => {
      if (stream === 'weekly') {
        pending = { stream, ctx, values: res.values, unmatched: res.unmatched, detected: res.detected };
        renderWeeklyPreview(stream, res);
      } else {
        pending = { stream, ctx, rows: res.rows, unmatchedCols: res.unmatchedCols };
        renderDimensionPreview(stream, res);
      }
    }).catch(err => { preview.innerHTML = '<div class="preview-note warn-cell">解析失败：' + err.message + '</div>'; });
  }

  function renderWeeklyPreview(stream, res) {
    const v = res.values;
    let html = '<div class="preview-note">已提取 <b>' + Object.keys(v).length + '</b> 项';
    if (res.detected.weekSeq != null) html += ' ｜ 第' + res.detected.weekSeq + '周 / 当月共' + res.detected.totalWeeksOfMonth + '周';
    if (res.detected.isMonthEnd) html += ' ｜ <span class="tag me">识别为月度周报（月末周）</span>';
    html += '</div>';
    if (res.unmatched.length) html += '<div class="preview-note warn-cell">⚠ 未匹配标签（可忽略或确认模板）：' + res.unmatched.join('、') + '</div>';
    // 分组展示
    SCHEMA.weeklyGroups.forEach(g => {
      const fs = SCHEMA.weeklyFields.filter(f => f.group === g && v[f.key] != null);
      if (!fs.length) return;
      html += '<div class="section-h">' + g + '</div><div class="table-wrap"><table><tbody>';
      fs.forEach(f => { html += '<tr><td>' + f.label + '</td><td class="num">' + (f.type === 'ratio' ? pct(v[f.key]) : fmt(v[f.key])) + '</td></tr>'; });
      html += '</tbody></table></div>';
    });
    html += '<div class="row" style="margin-top:14px"><button class="btn primary" id="confirm_' + stream + '">确认入库</button><button class="btn ghost" id="cancel_' + stream + '">取消</button></div>';
    $('#preview_' + stream).innerHTML = html;
    $('#confirm_' + stream).addEventListener('click', () => {
      STORE.upsert({ stream: 'weekly', year: pending.ctx.year, month: pending.ctx.month, week: pending.ctx.week, campus: v.campus || '泉山', values: v, rows: res.rows, importedAt: Date.now() });
      toast('周报已入库'); pending = null; renderWeekly();
    });
    $('#cancel_' + stream).addEventListener('click', () => { $('#preview_' + stream).innerHTML = ''; pending = null; });
  }

  function renderDimensionPreview(stream, res) {
    if (!res.rows.length) { $('#preview_' + stream).innerHTML = '<div class="preview-note warn-cell">未解析到数据行，请检查表头。</div>'; return; }
    let html = '<div class="preview-note">已提取 <b>' + res.rows.length + '</b> 条';
    if (res.unmatchedCols.length) html += ' ｜ <span class="warn-cell">未匹配列：' + res.unmatchedCols.join('、') + '</span>';
    html += '</div><div class="table-wrap"><table><thead><tr>';
    const cols = stream === 'kezu' ? SCHEMA.kezuFields : SCHEMA.kpiFields;
    html += '<th>' + (stream === 'kezu' ? '科组' : '教师') + '</th>';
    cols.filter(c => c.key !== 'subjectGroup' || stream === 'kpi').forEach(c => html += '<th class="num">' + c.label + '</th>');
    html += '</tr></thead><tbody>';
    res.rows.forEach(r => {
      html += '<tr><td>' + r.dimension + '</td>';
      cols.forEach(c => { if (c.key === 'subjectGroup' && stream !== 'kpi') return; html += '<td class="num">' + (c.type === 'ratio' ? pct(r.values[c.key]) : fmt(r.values[c.key])) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="row" style="margin-top:14px"><button class="btn primary" id="confirm_' + stream + '">确认入库（' + res.rows.length + ' 条）</button><button class="btn ghost" id="cancel_' + stream + '">取消</button></div>';
    $('#preview_' + stream).innerHTML = html;
    $('#confirm_' + stream).addEventListener('click', () => {
      let n = 0;
      pending.rows.forEach(r => { STORE.upsert({ stream: pending.stream, year: pending.ctx.year, month: pending.ctx.month, week: pending.ctx.week, dimension: r.dimension, values: r.values, importedAt: Date.now() }); n++; });
      toast(n + ' 条已入库'); pending = null;
      if (stream === 'kezu') renderKezu(); else renderKpi();
    });
    $('#cancel_' + stream).addEventListener('click', () => { $('#preview_' + stream).innerHTML = ''; pending = null; });
  }

  // —— 周报视图 ——
  function renderWeekly() {
    const recs = STORE.list('weekly').sort((a, b) => (b.year - a.year) || (b.month - b.month) || (b.week - b.week));
    let html = uploadPanelHTML('weekly');

    html += renderHeroStats(recs[0] || null, recs[1] || null);

    html += '<div class="panel"><div class="panel-title">已录入周报（' + recs.length + '）</div>';
    html += '<div class="panel-desc">每月最后一周（周序号=当月周数）自动标记为「月度周报」，供对比中心与五项满意度使用。</div>';
    const p = inferPeriod();
    if (!recs.length) {
      html += '<div class="empty">还没有 <b>' + p.year + '年' + p.month + '月 第' + p.week + '周</b> 的 DOS 周报。' +
        '<div class="empty-cta">上传一份周报，或去「数据备份 → 载入示例数据」查看效果。</div></div>';
    } else {
      html += '<div class="rec-list">';
      recs.forEach((r, i) => {
        const isME = r.values.weekSeq != null && r.values.totalWeeksOfMonth != null && r.values.weekSeq === r.values.totalWeeksOfMonth;
        html += '<div class="rec-row ' + (isME ? 'is-me' : '') + '" data-rec="' + i + '">' +
          '<div class="bar"></div>' +
          '<div class="period">' + r.year + '年' + r.month + '月 第' + r.week + '周<span class="sub">' + (r.campus || '—') + '</span></div>' +
          '<div>' + (isME ? '<span class="tag ok">月度周报</span>' : '<span class="tag">周报</span>') + '</div>' +
          '<div class="ops"><button class="btn sm ghost act-view">查看</button><button class="btn sm ghost act-del">删除</button></div>' +
          '</div>';
        html += '<div class="rec-detail" id="detail_' + i + '" style="display:none"></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    $('#content').innerHTML = html;
    wireUpload('weekly');
    $all('.act-view').forEach(b => b.addEventListener('click', () => {
      const i = b.closest('.rec-row').dataset.rec; const r = recs[i];
      const dr = $('#detail_' + i);
      dr.style.display = dr.style.display === 'none' ? 'block' : 'none';
      if (dr.style.display === 'block') dr.innerHTML = weeklyDetailHTML(r);
    }));
    $all('.act-del').forEach(b => b.addEventListener('click', () => {
      const i = b.closest('.rec-row').dataset.rec; const r = recs[i];
      STORE.remove('weekly', r.year, r.month, r.week); toast('已删除'); renderWeekly(); updateCount();
    }));
  }

  function heroStat(k, v, delta, isRatio, emptyNote) {
    let dClass = 'flat', dTxt = emptyNote || '— 暂无上周对比';
    if (delta != null) {
      const up = delta > 0, down = delta < 0;
      dClass = up ? 'up' : (down ? 'down' : 'flat');
      const dv = isRatio ? (delta * 100).toFixed(1) + ' pp' : (delta >= 0 ? '+' : '') + fmt(delta);
      dTxt = (up ? '▲ ' : down ? '▼ ' : '') + dv + ' 环比上周';
    }
    return '<div class="stat-card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="delta ' + dClass + '">' + dTxt + '</div></div>';
  }
  function renderHeroStats(latest, prev) {
    if (!latest) {
      const cards = [
        heroStat('周课时生产', '—', null, false, '上传周报后显示'),
        heroStat('周完成率（1V1）', '—', null, true, '上传周报后显示'),
        heroStat('周续费率（人数）', '—', null, true, '上传周报后显示'),
        heroStat('校周均', '—', null, false, '上传周报后显示'),
      ];
      return '<div class="stat-grid">' + cards.join('') + '</div>';
    }
    const v = latest.values, pv = prev ? prev.values : null;
    const produced = (v.v1WeekProduced || 0) + (v.v6WeekProduced || 0);
    const pProduced = pv ? ((pv.v1WeekProduced || 0) + (pv.v6WeekProduced || 0)) : null;
    const cards = [
      heroStat('周课时生产', fmt(produced), pProduced == null ? null : produced - pProduced, false),
      heroStat('周完成率（1V1）', pct(v.v1WeekRate), pv ? (v.v1WeekRate - pv.v1WeekRate) : null, true),
      heroStat('周续费率（人数）', pct(v.xfWeekNumRate), pv ? (v.xfWeekNumRate - pv.xfWeekNumRate) : null, true),
      heroStat('校周均', fmt(v.schoolWeekAvg, 1), pv ? (v.schoolWeekAvg - pv.schoolWeekAvg) : null, false),
    ];
    return '<div class="stat-grid">' + cards.join('') + '</div>';
  }

  function weeklyDetailHTML(r) {
    let h = '<div style="padding:10px 4px">';
    SCHEMA.weeklyGroups.forEach(g => {
      const fs = SCHEMA.weeklyFields.filter(f => f.group === g && r.values[f.key] != null);
      if (!fs.length) return;
      h += '<div class="section-h">' + g + '</div><div class="kpi-cards">';
      fs.forEach(f => { h += '<div class="kpi-card"><div class="k">' + f.label + '</div><div class="v small">' + (f.type === 'ratio' ? pct(r.values[f.key]) : fmt(r.values[f.key])) + '</div></div>'; });
      h += '</div>';
    });
    return h + '</div>';
  }

  // —— 最佳科组 ——
  function renderKezu() {
    let html = uploadPanelHTML('kezu');
    const recs = STORE.list('kezu');
    const monthly = AGG.kezuMonthly(recs);
    html += '<div class="panel"><div class="panel-title">月度自动汇总（按 年-月-科组）</div>';
    html += '<div class="panel-desc">周度提单科数/课时/结课/退费/停课/续费/推荐自动累加为月值；周平均 = 月课时 / 月单科数。</div>';
    if (!monthly.length) html += '<div class="empty">还没有科组周报，先上传「科组周报」。</div>';
    else {
      html += '<div class="table-wrap"><table><thead><tr><th>年</th><th>月</th><th>科组</th><th class="num">单科数</th><th class="num">课时</th><th class="num">周平均</th><th class="num">结课单科</th><th class="num">退费单科</th><th class="num">停课单科</th><th class="num">续费单科</th><th class="num">推荐单科</th><th class="num">教师数</th></tr></thead><tbody>';
      monthly.sort((a, b) => (b.year - a.year) || (b.month - b.month) || a.dimension.localeCompare(b.dimension)).forEach(r => {
        const v = r.values;
        html += '<tr><td>' + r.year + '</td><td>' + r.month + '</td><td>' + r.dimension + '</td>' +
          '<td class="num">' + fmt(v.subjects) + '</td><td class="num">' + fmt(v.hours) + '</td><td class="num">' + fmt(v.weekAvg, 2) + '</td>' +
          '<td class="num">' + fmt(v.jkSubj) + '</td><td class="num">' + fmt(v.tfSubj) + '</td><td class="num">' + fmt(v.tkSubj) + '</td>' +
          '<td class="num">' + fmt(v.xfSubj) + '</td><td class="num">' + fmt(v.tjSubj) + '</td><td class="num">' + fmt(v.teacherCount) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      // 排名图（按最新月周平均）
      const latest = monthly.filter(r => r.year === Math.max(...monthly.map(x => x.year)) && r.month === Math.max(...monthly.filter(x => x.year === Math.max(...monthly.map(y => y.year))).map(x => x.month)));
      if (latest.length) {
        html += '<div class="section-h">最新月 · 科组周平均排名</div><div class="chart-box"><canvas id="kezuChart"></canvas></div>';
      }
    }
    html += '</div>';
    $('#content').innerHTML = html;
    wireUpload('kezu');
    if (monthly.length) {
      const latest = monthly.filter(r => r.year === Math.max(...monthly.map(x => x.year)) && r.month === Math.max(...monthly.filter(x => x.year === Math.max(...monthly.map(y => y.year))).map(x => x.month)));
      drawBar('kezuChart', latest.map(r => r.dimension), latest.map(r => +r.values.weekAvg.toFixed(2)), '周平均', 'rgba(79,70,229,.8)');
    }
  }

  // —— 教师 KPI ——
  function renderKpi() {
    let html = uploadPanelHTML('kpi');
    const recs = STORE.list('kpi');
    const monthly = AGG.kpiMonthly(recs);
    html += '<div class="panel"><div class="panel-title">月度汇总（按 年-月-教师）</div>';
    html += '<div class="panel-desc">周课时/课次/参考课次累加；月饱和度 = 月课次 / 月参考课次。</div>';
    if (!monthly.length) html += '<div class="empty">还没有教师周报，先上传「教师周报」。</div>';
    else {
      html += '<div class="table-wrap"><table><thead><tr><th>年</th><th>月</th><th>教师</th><th>学科组</th><th class="num">月课时</th><th class="num">月课次</th><th class="num">月参考课次</th><th class="num">月饱和度</th></tr></thead><tbody>';
      monthly.sort((a, b) => (b.year - a.year) || (b.month - b.month) || a.dimension.localeCompare(b.dimension)).forEach(r => {
        const v = r.values;
        html += '<tr><td>' + r.year + '</td><td>' + r.month + '</td><td>' + r.dimension + '</td><td>' + (v.subjectGroup || '—') + '</td>' +
          '<td class="num">' + fmt(v.weekHours) + '</td><td class="num">' + fmt(v.weekSessions) + '</td><td class="num">' + fmt(v.weekRefSessions) + '</td>' +
          '<td class="num">' + pct(v.saturation) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';

    // 半年度
    const years = AGG.yearOptions(recs);
    const yr = years.length ? years[years.length - 1] : new Date().getFullYear();
    const half = Math.floor((new Date().getMonth()) / 6) + 1;
    const hy = AGG.kpiHalfYear(recs, yr, half);
    html += '<div class="panel"><div class="panel-title">半年度汇总与等级（' + yr + ' 年 H' + half + '）</div>';
    html += '<div class="panel-desc">半年度 = 月数据累计 + 半年进步率（取自季度考，留空的取最近录入）+ 饱和度；级别按 ZD-级别评定表（专业分默认0，可在半年复盘补）。</div>';
    if (!hy.length) html += '<div class="empty">暂无半年度数据（需先积累周报）。</div>';
    else {
      html += '<div class="table-wrap"><table><thead><tr><th>教师</th><th>学科组</th><th class="num">半年课时</th><th class="num">半年饱和度</th><th class="num">进步率</th><th class="num">总分</th><th>等级</th></tr></thead><tbody>';
      hy.sort((a, b) => b.level.total - a.level.total).forEach(r => {
        const lv = r.level.level;
        const lvColor = { A: 'ok', B: 'me', C: 'warn', D: 'warn' }[lv];
        html += '<tr><td>' + r.dimension + '</td><td>' + (r.values.subjectGroup || '—') + '</td>' +
          '<td class="num">' + fmt(r.totalHours) + '</td><td class="num">' + pct(r.values.saturation) + '</td>' +
          '<td class="num">' + pct(r.values.progressRate) + '</td><td class="num">' + fmt(r.level.total, 1) + '</td>' +
          '<td><span class="tag ' + lvColor + '">' + lv + '级</span></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    $('#content').innerHTML = html;
    wireUpload('kpi');
  }

  // —— 五项满意度 ——
  function renderSatisfaction() {
    const recs = STORE.list('weekly');
    const data = AGG.satisfactionFromMonthEnd(recs);
    let html = '<div class="panel"><div class="panel-title">五项满意度（月度，自动从月度周报提取）</div>';
    html += '<div class="panel-desc">取每月「月度周报」的月口径率：续费单科率 / 结课单科率 / 退费单科率 / 停课人数率 / 推荐单科率。</div>';
    if (!data.length) html += '<div class="empty">尚无月度周报数据。请先上传各月最后一周的 DOS 周报。</div>';
    else {
      html += '<div class="chart-box"><canvas id="satChart"></canvas></div>';
      html += '<div class="section-h">月度明细</div><div class="table-wrap"><table><thead><tr><th>年</th><th>月</th>';
      SCHEMA.satisfactionItems.forEach(it => html += '<th class="num">' + it.name + '</th>');
      html += '</tr></thead><tbody>';
      data.forEach(r => {
        html += '<tr><td>' + r.year + '</td><td>' + r.month + '</td>';
        SCHEMA.satisfactionItems.forEach(it => html += '<td class="num">' + pct(r[it.key]) + '</td>');
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    $('#content').innerHTML = html;
    if (data.length) {
      const labels = data.map(r => r.year + '/' + r.month);
      const ds = SCHEMA.satisfactionItems.map((it, idx) => ({
        label: it.name, data: data.map(r => (r[it.key] == null ? null : +(r[it.key] * 100).toFixed(2))),
        borderColor: ['#4F46E5', '#16a34a', '#dc2626', '#d97706', '#0ea5e9'][idx], backgroundColor: 'transparent', tension: .3, fill: false,
      }));
      drawLine('satChart', labels, ds);
    }
  }

  // —— 对比中心 · 历史周报批量入库 ——
  function compareUploadPanelHTML() {
    const p = inferPeriod();
    const uploadIco = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';
    return `
      <div class="upload-card" id="cmpUpload">
        <div class="uc-head">
          <div class="uc-ico">${uploadIco}</div>
          <div>
            <div class="uc-title">历史周报批量入库</div>
            <div class="uc-sub">一次性选入多份 DOS 周报（含各月「月度周报」），自动按文件名/内容判定年·月·周并入库，立即刷新下方对比。月度对比需同月多周；季度/年度对比需各月月度周报。</div>
          </div>
        </div>
        <div class="uc-files" id="cmpFileList"></div>
        <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap">
          <label class="btn primary">选择周报文件（可多选）<input type="file" id="cmpFiles" accept=".xlsx,.xls" multiple hidden/></label>
          <div class="field"><label>默认年</label><input type="number" id="cmpUYr" value="${p.year}" min="2000" max="2100" style="min-width:72px"/></div>
          <div class="field"><label>默认月</label><input type="number" id="cmpUMo" value="${p.month}" min="1" max="12" style="min-width:64px"/></div>
          <div class="field"><label>默认周</label><input type="number" id="cmpUWk" value="${p.week}" min="1" max="6" style="min-width:64px"/></div>
          <button class="btn" id="cmpParse">解析所选</button>
          <button class="btn primary" id="cmpCommit" disabled>确认入库</button>
        </div>
        <div class="uc-log" id="cmpUploadLog">尚未选择文件。选好后点「解析所选」预览，确认无误再入库。</div>
      </div>`;
  }

  function parseCmpFile(file, defYr, defMo, defWk) {
    const name = file.name || '';
    let year = defYr, month = defMo, week = defWk;
    let yearFromName = false, monthFromName = false;
    const ym = name.match(/(20\d{2})/); if (ym) { year = parseInt(ym[1], 10); yearFromName = true; }
    const mm = name.match(/(\d{1,2})\s*月/); if (mm) { const m = parseInt(mm[1], 10); if (m >= 1 && m <= 12) { month = m; monthFromName = true; } }
    const wm = name.match(/第\s*(\d+)\s*周/); if (wm) week = parseInt(wm[1], 10);
    return PARSER.parseWeekly(file, { year, month, week }).then(res => {
      let finalWeek = week;
      if (!wm && res.detected && res.detected.weekSeq != null) finalWeek = res.detected.weekSeq;
      const fields = Object.keys(res.values).length;
      return { period: { year, month, week: finalWeek }, values: res.values, rows: res.rows, unmatched: res.unmatched, detected: res.detected, fields, yearFromName, monthFromName };
    });
  }

  function renderCmpParseLog(results) {
    const ok = results.filter(r => r.ok);
    const fail = results.filter(r => !r.ok);
    let html = '解析完成：<b>' + ok.length + '</b> 份可入库，<b>' + fail.length + '</b> 份失败。<br/>';
    html += '<table><thead><tr><th>文件</th><th>判定周期</th><th class="num">原表事项</th><th>提示</th></tr></thead><tbody>';
    results.forEach(r => {
      if (r.ok) {
        const p = r.res.period;
        const tip = [];
        if (!r.res.values.campus) tip.push('未识别校区');
        if (r.res.unmatched && r.res.unmatched.length) {
          const show = r.res.unmatched.slice(0, 5).map(u => '「' + u + '」').join('、');
          const more = r.res.unmatched.length > 5 ? ' 等' + r.res.unmatched.length + '项' : '';
          tip.push('<span class="warn">未匹配 ' + show + more + '</span>');
        }
        if (!r.res.monthFromName) tip.push('<span class="warn">文件名未识别月份，已用默认月，请核对</span>');
        if (r.res.detected && r.res.detected.isMonthEnd) tip.push('<span class="ok">月度周报</span>');
        html += '<tr><td>' + r.file.name + '</td><td class="num">' + p.year + '/' + p.month + ' 第' + p.week + '周</td><td class="num">' + (r.res.rows ? r.res.rows.length : r.res.fields) + '</td><td>' + (tip.join('；') || '<span class="ok">正常</span>') + '</td></tr>';
      } else {
        html += '<tr><td>' + r.file.name + '</td><td colspan="3" class="warn">解析失败：' + (r.err || '未知错误') + '</td></tr>';
      }
    });
    html += '</tbody></table>';
    $('#cmpUploadLog').innerHTML = html;
  }

  function wireCompareUpload() {
    const fileInput = $('#cmpFiles');
    const listEl = $('#cmpFileList');
    const logEl = $('#cmpUploadLog');
    const commitBtn = $('#cmpCommit');
    const parseBtn = $('#cmpParse');
    let files = [];
    let pending = [];

    fileInput.addEventListener('change', e => {
      files = [...(e.target.files || [])];
      if (!files.length) { listEl.innerHTML = ''; commitBtn.disabled = true; logEl.textContent = '尚未选择文件。'; pending = []; return; }
      listEl.innerHTML = files.map(f => '<div class="uc-file">📄 ' + f.name + '</div>').join('');
      commitBtn.disabled = true; pending = [];
      logEl.textContent = '已选 ' + files.length + ' 份，点「解析所选」预览。';
    });

    parseBtn.addEventListener('click', () => {
      if (!files.length) { toast('请先选择文件'); return; }
      const defYr = parseInt($('#cmpUYr').value, 10);
      const defMo = parseInt($('#cmpUMo').value, 10);
      const defWk = parseInt($('#cmpUWk').value, 10);
      logEl.textContent = '解析中…';
      Promise.all(files.map(f => parseCmpFile(f, defYr, defMo, defWk)
        .then(res => ({ file: f, res, ok: true }))
        .catch(err => ({ file: f, err: err.message, ok: false }))))
        .then(results => { pending = results; renderCmpParseLog(results); commitBtn.disabled = results.filter(r => r.ok).length === 0; });
    });

    commitBtn.addEventListener('click', () => {
      const ok = pending.filter(r => r.ok);
      if (!ok.length) return;
      let n = 0;
      ok.forEach(r => {
        const p = r.res.period, v = r.res.values;
        STORE.upsert({ stream: 'weekly', year: p.year, month: p.month, week: p.week, campus: v.campus || '泉山', values: v, rows: r.res.rows, importedAt: Date.now() });
        n++;
      });
      toast('已入库 ' + n + ' 份历史周报');
      updateCount();
      tabs[currentTab].render();
    });
  }

  // —— 对比中心 ——
  function renderCompare() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    const yr = years.length ? Math.max(...years) : new Date().getFullYear();
    const now = new Date();
    let html = '<div class="panel"><div class="panel-title">对比中心</div>';
    html += '<div class="panel-desc">对比中心包含两类能力：<b>横向对比</b>（下一层汇总单元并排：月度=当月各周｜季度=当季各月「月度周报」｜年度=全年各月「月度周报」按《季度数据统计标准》列出的月度字段对齐）；<b>季度汇总</b>（将当季三月「月度周报」按《季度数据统计标准》汇总为一份季度数据）。若显示「暂无数据」，先用上方「历史周报批量入库」入库对应周期周报。</div>';
    html += compareUploadPanelHTML();
    html += '<div class="row">';
    html += '<div class="field"><label>对比类型</label><select id="cmpType"><option value="month">月度对比（各周）</option><option value="quarter">季度对比（各月）</option><option value="year">年度对比（各月）</option><option value="qsummary">季度汇总（季度数据汇总）</option></select></div>';
    html += '<div class="field"><label>年份</label><select id="cmpYear">' + years.concat([yr]).filter((v, i, a) => a.indexOf(v) === i).map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></div>';
    html += '<div class="field" id="cmpMonthField"><label>月份</label><select id="cmpMonth">' + Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === now.getMonth() + 1 ? ' selected' : '') + '>' + (i + 1) + '月</option>').join('') + '</select></div>';
    html += '<div class="field" id="cmpQuarterField" style="display:none"><label>季度</label><select id="cmpQuarter">' + [1, 2, 3, 4].map(q => '<option value="' + q + '">Q' + q + '</option>').join('') + '</select></div>';
    html += '<button class="btn" id="cmpQExport" style="display:none">导出季度汇总 xlsx</button>';
    html += '</div>';
    html += '<div id="cmpResult"></div></div>';
    $('#content').innerHTML = html;
    wireCompareUpload();

    const typeSel = $('#cmpType'), yrSel = $('#cmpYear'), moSel = $('#cmpMonth'), qSel = $('#cmpQuarter');
    function toggle() {
      const t = typeSel.value;
      $('#cmpMonthField').style.display = t === 'month' ? '' : 'none';
      $('#cmpQuarterField').style.display = (t === 'quarter' || t === 'qsummary') ? '' : 'none';
      $('#cmpQExport').style.display = t === 'qsummary' ? '' : 'none';
    }
    typeSel.addEventListener('change', () => { toggle(); draw(); });
    [yrSel, moSel, qSel].forEach(s => s.addEventListener('change', draw));
    toggle();

    $('#cmpQExport').addEventListener('click', () => {
      if (typeSel.value !== 'qsummary') return;
      exportQuarterXLSX(parseInt(yrSel.value, 10), parseInt(qSel.value, 10));
    });
    function draw() {
      const type = typeSel.value, y = parseInt(yrSel.value, 10);
      if (type === 'qsummary') { renderQuarterTable(y, parseInt(qSel.value, 10), '#cmpResult'); return; }
      let cmp;
      if (type === 'month') cmp = AGG.compareMonthly(recs, y, parseInt(moSel.value, 10));
      else if (type === 'quarter') cmp = AGG.compareQuarter(recs, y, parseInt(qSel.value, 10));
      else cmp = AGG.compareYearStandard(recs, y);
      renderCompareTable(cmp);
    }
    draw();
  }

  // 单元格显示：缺失（null）留空；百分比保留原表「%」文本；数值千分位
  function cellText(cell) {
    if (!cell) return '';
    if (cell.num != null) return cell.isPct ? cell.text : fmt(cell.num);
    return cell.text || '';
  }

  function renderCompareTable(cmp) {
    if (!cmp.columns.length) { $('#cmpResult').innerHTML = '<div class="empty">该范围暂无数据。</div>'; destroyChart('cmpChart'); return; }
    let html = '<div class="table-wrap"><table><thead><tr><th>表格事项（原表）</th>';
    cmp.columns.forEach(c => html += '<th class="num">' + c.label + '</th>');
    html += '</tr></thead><tbody>';
    cmp.rows.forEach(r => {
      html += '<tr><td>' + esc(r.label) + '</td>';
      r.values.forEach(cell => html += '<td class="num">' + cellText(cell) + '</td>');
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="preview-note">说明：月度/季度对比按各周报「数据统计表」原始事项对齐；年度对比仅展示《季度数据统计标准》列出的月度字段，并保持与该标准一致的顺序。某列未出现的项留空。</div>';
    // 选指标画柱状（仅含数值的对比项）
    const metricRows = cmp.rows.filter(r => r.values.some(c => c && c.num != null));
    html += '<div class="section-h">柱状对比（选指标）</div><div class="field"><select id="cmpMetric">' +
      metricRows.map(r => '<option value="' + esc(r.key) + '">' + r.label + '</option>').join('') + '</select></div>';
    html += '<div class="chart-box"><canvas id="cmpChart"></canvas></div>';
    $('#cmpResult').innerHTML = html;
    const sel = $('#cmpMetric');
    function drawChart() {
      const row = cmp.rows.find(r => r.key === sel.value);
      destroyChart('cmpChart');
      if (!row) return;
      const data = row.values.map(c => (c && c.num != null) ? c.num : null);
      drawBar('cmpChart', cmp.columns.map(c => c.label), data, row.label, 'rgba(79,70,229,.8)');
    }
    sel.addEventListener('change', drawChart);
    drawChart();
  }

  // 季度字段显示：比值类(比)按小数；比率类按百分数；其余千分位
  function fmtQ(key, val) {
    if (val == null) return '—';
    const f = SCHEMA.weeklyFields.find(x => x.key === key);
    if (f && f.type === 'ratio' && f.unit === '比') return fmt(val, 2);
    if (f && f.type === 'ratio') return pct(val);
    return fmt(val);
  }

  // —— 季度汇总（按《季度数据统计标准》）—— 已并入「对比中心」的「季度汇总」对比类型

  function renderQuarterTable(year, quarter, target) {
    const el = $(target || '#cmpResult');
    const recs = STORE.list('weekly');
    const g = AGG.quarterlyAggregate(recs).find(x => x.year === year && x.quarter === quarter);
    if (!g) { el.innerHTML = '<div class="empty">该季度暂无数据（需先有该季各月月度周报）。</div>'; return; }
    const v = g.values;
    const heroes = [
      heroStat('季度1V1生产课时', fmt(v.v1MonthProduced), null, false),
      heroStat('季度课时生产总现金', fmt(v.monthCashTotal), null, false),
      heroStat('季度生产完成率', pct(v.v1MonthRate), null, true),
      heroStat('季度1V1续费人数', fmt(v.xfMonthNum), null, false),
    ];
    let html = '<div class="stat-grid">' + heroes.join('') + '</div>';
    let note = '数据来源：' + year + '年 ' + g.sourceMonths.map(m => m + '月').join('、') + ' 月度周报。';
    if (g.missingMonths.length) note += ' <span class="warn-cell">⚠ 缺 ' + g.missingMonths.map(m => m + '月').join('、') + ' 月度周报，当前按现有月汇总，结果可能不完整。</span>';
    html += '<div class="preview-note">' + note + '</div>';
    html += '<div class="table-wrap"><table><thead><tr><th>季度数据（名称）</th><th class="num">季度数据值</th><th>季度数据填写标准</th></tr></thead><tbody>';
    AGG.QUARTERLY_RULES.forEach(r => {
      html += '<tr><td><div class="q-name">' + esc(r.label) + '</div><div class="q-src">月度原数据：' + esc(r.src) + '</div></td><td class="num">' + fmtQ(r.key, v[r.key]) + '</td>' +
        '<td style="color:#71717a;font-size:12.5px">' + esc(r.ruleText) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="preview-note">说明：依你最新标准——<span class="ok">续/推/结/退各率、停课率、骨干/双三占比、现金均价、停课/骨干/双三人数、月人均效能值</span>均为<b>三个月平均</b>；仅<b>生产完成率、课时生产总现金、金额占比、离职人数率</b>四项仍按原表公式（=C…）计算。第一列「季度数据（名称）」取自标准表第二列，下方小字为第一列对应的月度原表名称。</div>';
    el.innerHTML = html;
  }

  function exportQuarterXLSX(year, quarter) {
    const g = AGG.quarterlyAggregate(STORE.list('weekly')).find(x => x.year === year && x.quarter === quarter);
    if (!g) { toast('该季度暂无数据'); return; }
    const v = g.values;
    const aoa = [['季度数据（名称）', '季度数据值', '月度原数据对应', '季度数据填写标准']];
    AGG.QUARTERLY_RULES.forEach(r => {
      let cv = v[r.key];
      if (cv != null) {
        const f = SCHEMA.weeklyFields.find(x => x.key === r.key);
        if (f && f.type === 'ratio' && f.unit !== '比') cv = (cv * 100).toFixed(2) + '%';
        else if (f && f.type === 'ratio' && f.unit === '比') cv = +cv.toFixed(2);
      }
      aoa.push([r.label, cv == null ? '' : cv, r.src, r.ruleText]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '数据统计表');
    XLSX.writeFile(wb, '季度数据汇总_' + year + 'Q' + quarter + '.xlsx');
    toast('已导出 ' + year + 'Q' + quarter + ' 季度汇总');
  }

  // —— 核心数据看板 ——
  // 仪表盘式卡片：大号数值 + 进度环 + 单位标签
  function gaugeCard(label, value, unit, pctVal, color) {
    const v = value == null ? '<span class="gv-empty">—</span>' : '<span class="gv-num">' + value + '</span>';
    const u = unit ? '<span class="gv-unit">' + unit + '</span>' : '';
    const ring = pctVal != null && pctVal >= 0
      ? '<div class="gauge-ring" style="--p:' + Math.min(pctVal, 100) + ';--c:' + (color || 'var(--indigo)') + '">' +
        '<svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--border)" stroke-width="4"/>' +
        '<circle cx="22" cy="22" r="18" fill="none" stroke="' + (color || 'var(--indigo)') + '" stroke-width="4" ' +
        'stroke-linecap="round" stroke-dasharray="' + (Math.min(pctVal, 100) * 1.13) + ' 113.1" ' +
        'transform="rotate(-90 22 22)"/></svg></div>'
      : '';
    return '<div class="gauge-card">' + ring + '<div class="gc-body"><div class="gc-k">' + label + '</div><div class="gc-v">' + v + u + '</div></div></div>';
  }

  function renderDashboard() {
    let html = '<div class="panel"><div class="panel-title">核心数据看板</div>';
    html += '<div class="panel-desc">基于《年度数据统计标准》和《季度数据统计标准》汇总，以仪表盘形式直观呈现年度核心指标和各季度对比趋势。数据源为各月「月度周报」。</div>';
    html += '<div class="dash-tabs"><button class="dash-tab active" data-sub="year">年度汇总数据看板</button><button class="dash-tab" data-sub="quarter">季度汇总数据对比看板</button></div>';
    html += '<div id="dashBody"></div></div>';
    $('#content').innerHTML = html;
    $all('.dash-tab').forEach(b => b.addEventListener('click', () => {
      $all('.dash-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.sub === 'year') renderYearDashboard();
      else renderQuarterDashboard();
    }));
    renderYearDashboard();
  }

  function renderYearDashboard() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「对比中心」入库各月月度周报。</div>'; return; }
    const yr = Math.max(...years);
    let html = '<div class="row" style="margin-bottom:16px"><div class="field"><label>年份</label><select id="dashYr">' +
      years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div></div>';
    html += '<div id="ydashResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#dashYr').addEventListener('change', () => drawYearDash());
    drawYearDash();

    function drawYearDash() {
      const y = parseInt($('#dashYr').value, 10);
      const yd = AGG.yearlyAggregate(recs, y);
      if (!yd) { $('#ydashResult').innerHTML = '<div class="empty">' + y + '年暂无月度周报数据。</div>'; return; }
      const v = yd.values;
      // 核心指标仪表盘卡片
      const gauges = [
        gaugeCard('年度课时生产总现金', fmt(v.monthCashTotal), '元', null, null),
        gaugeCard('年度生产完成率', pct(v.v1MonthRate), '', v.v1MonthRate != null ? v.v1MonthRate * 100 : null, 'var(--indigo)'),
        gaugeCard('年度1V1生产课时', fmt(v.v1MonthProduced), '课时', null, null),
        gaugeCard('年度1V6生产课时', fmt(v.v6MonthProduced), '课时', null, null),
        gaugeCard('年度人均效能值', fmt(v.monthEff, 0), '', null, null),
        gaugeCard('年度饱和度', pct(v.monthSaturation), '', v.monthSaturation != null ? v.monthSaturation * 100 : null, 'var(--green)'),
        gaugeCard('年度续费人数', fmt(v.xfMonthNum), '人', null, null),
        gaugeCard('年度骨干教师占比', pct(v.coreTeacherRatio), '', v.coreTeacherRatio != null ? v.coreTeacherRatio * 100 : null, 'var(--amber)'),
      ];
      let h = '<div class="gauge-grid">' + gauges.join('') + '</div>';
      // 缺失月份提示
      let note = '数据来源：' + y + '年 ' + (yd.sourceMonths.length ? yd.sourceMonths.map(m => m + '月').join('、') : '无') + ' 月度周报。';
      if (yd.missingMonths.length) note += ' <span class="warn-cell">⚠ 缺 ' + yd.missingMonths.map(m => m + '月').join('、') + '，结果可能不完整。</span>';
      h += '<div class="preview-note">' + note + '</div>';
      // 对比图表：各月趋势（课时生产现金 + 完成率双轴）
      const me = AGG.monthEndWeeklies(recs).filter(r => r.year === y).sort((a, b) => a.month - b.month);
      h += '<div class="section-h">年度月度趋势</div><div class="chart-box"><canvas id="yrTrendChart"></canvas></div>';
      // 完整数据表
      h += '<div class="section-h">完整年度数据</div><div class="table-wrap"><table><thead><tr><th>年度数据（名称）</th><th class="num">年度数据值</th><th>年度数据填写标准</th></tr></thead><tbody>';
      AGG.YEARLY_RULES.forEach(r => {
        h += '<tr><td><div class="q-name">' + esc(r.label) + '</div><div class="q-src">月度原数据：' + esc(r.src) + '</div></td><td class="num">' + fmtQ(r.key, v[r.key]) + '</td>' +
          '<td style="color:#71717a;font-size:12.5px">' + esc(r.ruleText) + '</td></tr>';
      });
      h += '</tbody></table></div>';
      h += '<div class="preview-note">说明：率/均价/停课/骨干/双三/人均效能值等为<b>全年各月平均</b>；仅生产完成率、课时生产总现金、金额占比、离职人数率四项按原表公式计算。</div>';
      $('#ydashResult').innerHTML = h;
      // 月度趋势图
      destroyChart('yrTrendChart');
      const ctx = $('#yrTrendChart'); if (ctx) {
        const labels = me.map(r => r.month + '月');
        const cashData = me.map(r => { const c = (r.values.v1MonthCash || 0) + (r.values.v6MonthCash || 0); return c || null; });
        const rateData = me.map(r => r.values.v1MonthRate != null ? r.values.v1MonthRate * 100 : null);
        charts['yrTrendChart'] = new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [
            { label: '月课时生产现金', data: cashData, backgroundColor: 'rgba(79,70,229,.7)', borderRadius: 4, yAxisID: 'y' },
            { label: '1V1生产完成率', data: rateData, type: 'line', borderColor: 'rgba(22,163,74,.9)', backgroundColor: 'rgba(22,163,74,.1)', borderWidth: 2, pointRadius: 4, yAxisID: 'y1', tension: .3 },
          ] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } },
            scales: { y: { beginAtZero: true, title: { display: true, text: '现金(元)' } }, y1: { position: 'right', beginAtZero: true, max: 120, title: { display: true, text: '完成率(%)' }, grid: { drawOnChartArea: false } } } },
        });
      }
    }
  }

  function renderQuarterDashboard() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「对比中心」入库各月月度周报。</div>'; return; }
    const yr = Math.max(...years);
    let html = '<div class="row" style="margin-bottom:16px"><div class="field"><label>年份</label><select id="dashQYr">' +
      years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div></div>';
    html += '<div id="qdashResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#dashQYr').addEventListener('change', () => drawQuarterDash());
    drawQuarterDash();

    function drawQuarterDash() {
      const y = parseInt($('#dashQYr').value, 10);
      const qAll = AGG.quarterlyAggregate(recs).filter(x => x.year === y).sort((a, b) => a.quarter - b.quarter);
      if (!qAll.length) { $('#qdashResult').innerHTML = '<div class="empty">' + y + '年暂无季度数据。</div>'; return; }
      // 核心指标对比卡片（每季度一组）
      let h = '<div class="section-h">各季度核心指标仪表盘</div>';
      qAll.forEach(q => {
        const v = q.values;
        const gauges = [
          gaugeCard('Q' + q.quarter + '课时生产总现金', fmt(v.monthCashTotal), '元', null, null),
          gaugeCard('Q' + q.quarter + '生产完成率', pct(v.v1MonthRate), '', v.v1MonthRate != null ? v.v1MonthRate * 100 : null, 'var(--indigo)'),
          gaugeCard('Q' + q.quarter + '续费人数', fmt(v.xfMonthNum), '人', null, null),
          gaugeCard('Q' + q.quarter + '饱和度', pct(v.monthSaturation), '', v.monthSaturation != null ? v.monthSaturation * 100 : null, 'var(--green)'),
        ];
        h += '<div class="qtr-block"><div class="qtr-head">Q' + q.quarter + (q.missingMonths.length ? ' <span class="tag warn">缺' + q.missingMonths.map(m => m + '月').join('') + '</span>' : '') + '</div><div class="gauge-grid gauges-4">' + gauges.join('') + '</div></div>';
      });
      // 对比图表
      h += '<div class="section-h">各季度指标对比</div>';
      h += '<div class="field" style="margin-bottom:10px"><label>选择对比指标</label><select id="qCmpMetric">' +
        '<option value="monthCashTotal">课时生产总现金</option><option value="v1MonthProduced">1V1生产课时</option><option value="v6MonthProduced">1V6生产课时</option>' +
        '<option value="v1MonthRate">生产完成率</option><option value="monthSaturation">饱和度</option><option value="xfMonthNum">续费人数</option>' +
        '<option value="xfMonthNumRate">续费人数率</option><option value="monthEff">人均效能值</option><option value="coreTeacherRatio">骨干教师占比</option>' +
        '<option value="quitMonthRate">离职人数率</option></select></div>';
      h += '<div class="chart-box"><canvas id="qCmpChart"></canvas></div>';
      // 完整季度对比表
      h += '<div class="section-h">完整季度数据对比</div><div class="table-wrap"><table><thead><tr><th>季度数据（名称）</th>';
      qAll.forEach(q => h += '<th class="num">Q' + q.quarter + '</th>');
      h += '</tr></thead><tbody>';
      AGG.QUARTERLY_RULES.forEach(r => {
        h += '<tr><td><div class="q-name">' + esc(r.label) + '</div><div class="q-src">' + esc(r.src) + '</div></td>';
        qAll.forEach(q => h += '<td class="num">' + fmtQ(r.key, q.values[r.key]) + '</td>');
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      h += '<div class="preview-note">说明：各季度汇总口径完全一致（率/均价取三月平均，生产完成率/总现金/金额占比/离职率按公式），便于横向比较。</div>';
      $('#qdashResult').innerHTML = h;
      // 对比柱状图
      const sel = $('#qCmpMetric');
      function drawCmp() {
        destroyChart('qCmpChart');
        const ctx = $('#qCmpChart'); if (!ctx) return;
        const rule = AGG.QUARTERLY_RULES.find(r => r.key === sel.value);
        const f = SCHEMA.weeklyFields.find(x => x.key === sel.value);
        const isPct = f && f.type === 'ratio' && f.unit !== '比';
        const data = qAll.map(q => {
          const val = q.values[sel.value];
          return (val != null && isFinite(val)) ? (isPct ? val * 100 : val) : null;
        });
        const labels = qAll.map(q => 'Q' + q.quarter);
        charts['qCmpChart'] = new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [{ label: rule ? rule.label : sel.value, data, backgroundColor: 'rgba(79,70,229,.75)', borderRadius: 5 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => isPct ? v + '%' : fmt(v) } } } },
        });
      }
      sel.addEventListener('change', drawCmp);
      drawCmp();
    }
  }

  // —— 模板中心 ——
  function renderTemplates() {
    let html = '<div class="panel"><div class="panel-title">模板中心</div>';
    html += '<div class="panel-desc">科组周报 / 教师周报为「按周独立台账」。你可上传自己的 xlsx（首行表头）覆盖默认列映射；或下载起步模板填数。</div>';
    ['kezu', 'kpi'].forEach(stream => {
      const map = TPL.getMapping(stream);
      const name = stream === 'kezu' ? '科组周报' : '教师周报';
      html += '<div class="section-h">' + name + ' · 当前映射</div><div class="table-wrap"><table><thead><tr><th>表头</th><th>→ 内部字段</th></tr></thead><tbody>';
      Object.entries(map.map).forEach(([h, k]) => { html += '<tr><td>' + h + '</td><td><code>' + k + '</code></td></tr>'; });
      html += '</tbody></table></div>';
      html += '<div class="row" style="margin:8px 0 4px"><button class="btn sm" data-dl="' + stream + '">下载' + name + '起步模板</button>' +
        '<label class="btn sm ghost">上传映射表覆盖<input type="file" accept=".xlsx,.xls" data-map="' + stream + '" hidden/></label></div>';
    });
    html += '</div>';
    $('#content').innerHTML = html;
    $all('[data-dl]').forEach(b => b.addEventListener('click', () => downloadTemplate(b.dataset.dl)));
    $all('[data-map]').forEach(inp => inp.addEventListener('change', e => uploadMapping(inp.dataset.map, e.target.files[0])));
  }

  function downloadTemplate(stream) {
    const cols = TPL.starterColumns[stream];
    const aoa = [cols, cols.map(() => '')];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '模板');
    XLSX.writeFile(wb, (stream === 'kezu' ? '科组周报模板' : '教师周报模板') + '.xlsx');
    toast('已下载模板');
  }

  function uploadMapping(stream, file) {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1 });
      const headers = (matrix[0] || []).map(c => c == null ? '' : String(c).trim());
      const allFields = (stream === 'kezu' ? SCHEMA.kezuFields : SCHEMA.kpiFields).map(f => f.key);
      const map = { dimensionHeader: headers[0], map: {} };
      headers.forEach(h => { if (allFields.includes(h)) map.map[h] = h; });
      // 维度列（科组/教师）
      map.map[headers[0]] = 'dimension';
      TPL.saveOverride(stream, map);
      toast('已覆盖「' + (stream === 'kezu' ? '科组' : '教师') + '」映射，刷新后生效');
      renderTemplates();
    };
    reader.readAsArrayBuffer(file);
  }

  // —— 数据备份 ——
  function renderData() {
    const all = STORE.readAll();
    const byStream = { weekly: 0, kezu: 0, kpi: 0 };
    all.forEach(r => byStream[r.stream]++);
    let html = '<div class="panel"><div class="panel-title">数据备份 / 恢复</div>';
    html += '<div class="panel-desc">数据保存在本浏览器 localStorage。导出为 data.json 可备份、跨设备迁移、或历史补录（导入会按主键覆盖）。</div>';
    html += '<div class="kpi-cards"><div class="kpi-card"><div class="k">周报</div><div class="v">' + byStream.weekly + '</div></div>' +
      '<div class="kpi-card"><div class="k">科组周报</div><div class="v">' + byStream.kezu + '</div></div>' +
      '<div class="kpi-card"><div class="k">教师周报</div><div class="v">' + byStream.kpi + '</div></div>' +
      '<div class="kpi-card"><div class="k">合计</div><div class="v">' + all.length + '</div></div></div>';
    html += '<div class="row" style="margin-top:14px"><button class="btn" id="dlData">导出 data.json</button>' +
      '<label class="btn ghost">导入 data.json<input type="file" id="upData" accept=".json" hidden/></label>' +
      '<button class="btn ghost" id="demoData">载入示例数据（演示）</button>' +
      '<button class="btn ghost" id="clrData">清空全部</button></div>';
    html += '<div class="preview-note" style="margin-top:10px">提示：GitHub Pages 部署后，数据仍只存在你当前浏览器。换设备/清缓存前请先导出备份。「载入示例数据」会注入一份演示数据（含 2026 年 4-6 月周报/科组/教师），可随时「清空全部」。</div>';
    html += '</div>';
    $('#content').innerHTML = html;
    $('#demoData').addEventListener('click', () => {
      if (!window.CA_SAMPLE) { toast('未找到示例数据'); return; }
      if (confirm('载入示例数据将覆盖同名主键记录，确定继续？（演示用）')) {
        let n = 0; window.CA_SAMPLE.forEach(r => { STORE.upsert(r); n++; });
        toast('已载入 ' + n + ' 条示例'); renderData(); updateCount();
      }
    });
    $('#dlData').addEventListener('click', () => {
      const blob = new Blob([STORE.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'data.json'; a.click();
      toast('已导出 data.json');
    });
    $('#upData').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { try { const n = STORE.importJSON(rd.result); toast('已导入 ' + n + ' 条'); renderData(); updateCount(); } catch (err) { toast('导入失败：' + err.message); } };
      rd.readAsText(f);
    });
    $('#clrData').addEventListener('click', () => { if (confirm('确定清空全部数据？不可恢复（请先导出备份）。')) { STORE.clearAll(); toast('已清空'); renderData(); updateCount(); } });
  }

  // —— 图表 ——
  function drawBar(id, labels, data, label, color) {
    destroyChart(id);
    const ctx = document.getElementById(id); if (!ctx) return;
    charts[id] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label, data, backgroundColor: color, borderRadius: 5 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }
  function drawLine(id, labels, datasets) {
    destroyChart(id);
    const ctx = document.getElementById(id); if (!ctx) return;
    charts[id] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: v => v + '%' } } } },
    });
  }

  // —— 路由 ——
  const tabs = {
    weekly: { title: '周报', render: renderWeekly },
    kezu: { title: '最佳科组', render: renderKezu },
    kpi: { title: '教师 KPI', render: renderKpi },
    satisfaction: { title: '五项满意度', render: renderSatisfaction },
    compare: { title: '对比中心', render: renderCompare },
    dashboard: { title: '核心看板', render: renderDashboard },
    templates: { title: '模板中心', render: renderTemplates },
    data: { title: '数据备份', render: renderData },
  };
  function go(tab) {
    currentTab = tab;
    $all('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#tabTitle').textContent = tabs[tab].title;
    Object.values(charts).forEach(c => c.destroy()); for (const k in charts) delete charts[k];
    tabs[tab].render();
  }

  function init() {
    $all('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
    go('weekly');
    updateCount();
  }

  document.addEventListener('DOMContentLoaded', init);
  CA.go = go; // 调试/测试出口，生产环境无副作用
})(window);
