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
  function pct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
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
      STORE.upsert({ stream: 'weekly', year: pending.ctx.year, month: pending.ctx.month, week: pending.ctx.week, campus: v.campus || '泉山', values: v, importedAt: Date.now() });
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

  // —— 对比中心 ——
  function renderCompare() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    const yr = years.length ? Math.max(...years) : new Date().getFullYear();
    const now = new Date();
    let html = '<div class="panel"><div class="panel-title">对比中心</div>';
    html += '<div class="panel-desc">横向对比 = 下一层汇总单元并排：月度=当月各周｜季度=当季各月「月度周报」｜年度=全年各月「月度周报」。</div>';
    html += '<div class="row">';
    html += '<div class="field"><label>对比类型</label><select id="cmpType"><option value="month">月度对比（各周）</option><option value="quarter">季度对比（各月）</option><option value="year">年度对比（各月）</option></select></div>';
    html += '<div class="field"><label>年份</label><select id="cmpYear">' + years.concat([yr]).filter((v, i, a) => a.indexOf(v) === i).map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></div>';
    html += '<div class="field" id="cmpMonthField"><label>月份</label><select id="cmpMonth">' + Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === now.getMonth() + 1 ? ' selected' : '') + '>' + (i + 1) + '月</option>').join('') + '</select></div>';
    html += '<div class="field" id="cmpQuarterField" style="display:none"><label>季度</label><select id="cmpQuarter">' + [1, 2, 3, 4].map(q => '<option value="' + q + '">Q' + q + '</option>').join('') + '</select></div>';
    html += '</div>';
    html += '<div id="cmpResult"></div></div>';
    $('#content').innerHTML = html;

    const typeSel = $('#cmpType'), yrSel = $('#cmpYear'), moSel = $('#cmpMonth'), qSel = $('#cmpQuarter');
    function toggle() {
      $('#cmpMonthField').style.display = typeSel.value === 'month' ? '' : 'none';
      $('#cmpQuarterField').style.display = typeSel.value === 'quarter' ? '' : 'none';
    }
    typeSel.addEventListener('change', () => { toggle(); draw(); });
    [yrSel, moSel, qSel].forEach(s => s.addEventListener('change', draw));
    toggle();

    function draw() {
      const type = typeSel.value, y = parseInt(yrSel.value, 10);
      let cmp;
      if (type === 'month') cmp = AGG.compareMonthly(recs, y, parseInt(moSel.value, 10));
      else if (type === 'quarter') cmp = AGG.compareQuarter(recs, y, parseInt(qSel.value, 10));
      else cmp = AGG.compareYear(recs, y);
      renderCompareTable(cmp);
    }
    draw();
  }

  function renderCompareTable(cmp) {
    if (!cmp.columns.length) { $('#cmpResult').innerHTML = '<div class="empty">该范围暂无数据。</div>'; destroyChart('cmpChart'); return; }
    let html = '<div class="table-wrap"><table><thead><tr><th>指标</th>';
    cmp.columns.forEach(c => html += '<th class="num">' + c.label + '</th>');
    html += '</tr></thead><tbody>';
    cmp.rows.forEach(r => {
      html += '<tr><td>' + r.label + '</td>';
      r.values.forEach(val => html += '<td class="num">' + (r.type === 'ratio' ? pct(val) : fmt(val)) + '</td>');
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    // 选指标画柱状
    const metricKeys = cmp.rows.filter(r => r.type === 'num' || r.type === 'ratio').map(r => r.key);
    html += '<div class="section-h">柱状对比（选指标）</div><div class="field"><select id="cmpMetric">' +
      cmp.rows.map(r => '<option value="' + r.key + '">' + r.label + '</option>').join('') + '</select></div>';
    html += '<div class="chart-box"><canvas id="cmpChart"></canvas></div>';
    $('#cmpResult').innerHTML = html;
    const sel = $('#cmpMetric');
    function drawChart() {
      const row = cmp.rows.find(r => r.key === sel.value);
      destroyChart('cmpChart');
      if (!row) return;
      drawBar('cmpChart', cmp.columns.map(c => c.label), row.values.map(v => v == null ? null : (row.type === 'ratio' ? +(v * 100).toFixed(2) : v)), row.label, 'rgba(79,70,229,.8)');
    }
    sel.addEventListener('change', drawChart);
    drawChart();
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
})(window);
