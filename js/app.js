/*
 * app.js — UI 控制器
 * 板块：最佳科组 / 教师KPI / 数据源（历史周报批量入库 + 数据库视图：年度各月对比）/ 核心看板（年度·季度·五项满意度）/ 数据备份
 * 数据链路：所有汇总数据统一由 CA.aggregate 聚合层从 store 的月度周报派生，UI 不散算。
 */
(function (global) {
  'use strict';
  const CA = global.CA;
  const SCHEMA = CA.SCHEMA, RB = CA.rulebook, STORE = CA.store, PARSER = CA.parser, AGG = CA.aggregate;

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

  // 导出数值格式化：比例(率)以百分数数值(×100)呈现，比类保持原倍数，其余保持数值
  function fmtExport(key, val) {
    if (val == null || (typeof val === 'number' && !isFinite(val))) return '';
    const f = SCHEMA.weeklyFields.find(x => x.key === key);
    if (f && f.type === 'ratio' && f.unit === '比') return +(+val).toFixed(4);
    if (f && f.type === 'ratio') return +(val * 100).toFixed(2);
    if (typeof val === 'number') return val;
    return val;
  }

  // 通用多 sheet Excel 导出（基于 SheetJS / XLSX）
  function exportSheets(filename, sheets) {
    if (typeof XLSX === 'undefined') { toast('导出组件未加载，请刷新重试'); return; }
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => {
      const aoa = [s.header];
      (s.rows || []).forEach(r => aoa.push(r));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // 表头加粗 + 浅色底
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c });
        if (!ws[addr]) ws[addr] = {};
        ws[addr].s = { font: { bold: true, color: '1E293B' }, fill: { fgColor: 'EEF2FF' }, alignment: { vertical: 'center', wrapText: true } };
      }
      // 列宽自适应
      const wscols = s.header.map((h, i) => {
        let max = String(h == null ? '' : h).length;
        (s.rows || []).forEach(r => { const v = r[i]; if (v != null) max = Math.max(max, String(v).length); });
        return { wch: Math.min(42, Math.max(10, max + 2)) };
      });
      ws['!cols'] = wscols;
      XLSX.utils.book_append_sheet(wb, ws, String(s.name).slice(0, 31));
    });
    XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : filename + '.xlsx');
    toast('已导出 ' + filename);
  }

  // —— 导出：数据源 · 数据库视图（年度各月对比原始数据）——
  function exportDataSource(recs, year) {
    const cmp = AGG.compareYearStandard(recs, year);
    if (!cmp.columns.length) { toast('该年暂无数据'); return; }
    const header = ['月度原数据（字段）'].concat(cmp.columns.map(c => c.label));
    const rows = cmp.rows.map(r => [r.label].concat(r.values.map(c => (c == null ? '' : (c.num != null ? c.num : c.text)))));
    exportSheets('数据源_年度各月对比_' + year + '年.xlsx', [{ name: '年度各月对比', header, rows }]);
  }

  // —— 导出：核心看板 · 年度汇总 ——
  function exportYearDashboard(recs, year) {
    const yd = AGG.yearlyAggregate(recs, year);
    if (!yd) { toast('该年暂无数据'); return; }
    const v = yd.values;
    const header1 = ['年度数据（名称）', '年度数据值', '月度原数据', '年度数据填写标准'];
    const rows1 = AGG.YEARLY_RULES.map(r => [r.label, fmtExport(r.key, v[r.key]), r.src, r.ruleText]);
    const header2 = ['核心指标', '数值'];
    const rows2 = [
      ['年度课时生产总现金(元)', v.monthCashTotal != null ? Math.round(v.monthCashTotal) : ''],
      ['年度生产完成率(%)', v.v1MonthRate != null ? +(v.v1MonthRate * 100).toFixed(2) : ''],
      ['年度1V1生产课时', v.v1MonthProduced != null ? Math.round(v.v1MonthProduced) : ''],
      ['年度1V6生产课时', v.v6MonthProduced != null ? Math.round(v.v6MonthProduced) : ''],
      ['年度人均效能值', v.monthEff != null ? +v.monthEff.toFixed(2) : ''],
      ['年度饱和度(%)', v.monthSaturation != null ? +(v.monthSaturation * 100).toFixed(2) : ''],
      ['年度续费人数', v.xfMonthNum != null ? Math.round(v.xfMonthNum) : ''],
      ['年度骨干教师占比(%)', v.coreTeacherRatio != null ? +(v.coreTeacherRatio * 100).toFixed(2) : ''],
    ];
    exportSheets('核心看板_年度汇总_' + year + '年.xlsx', [
      { name: '年度数据明细', header: header1, rows: rows1 },
      { name: '核心指标', header: header2, rows: rows2 },
    ]);
  }

  // —— 导出：核心看板 · 季度对比 ——
  function exportQuarterDashboard(recs, year) {
    const qAll = AGG.quarterlyAggregate(recs).filter(x => x.year === year).sort((a, b) => a.quarter - b.quarter);
    if (!qAll.length) { toast('该年暂无季度数据'); return; }
    const header = ['季度数据（名称）', '月度原数据'].concat(qAll.map(q => 'Q' + q.quarter));
    const rows = AGG.QUARTERLY_RULES.map(r => [r.label, r.src].concat(qAll.map(q => fmtExport(r.key, q.values[r.key]))));
    exportSheets('核心看板_季度对比_' + year + '年.xlsx', [{ name: '季度数据对比', header, rows }]);
  }

  // —— 导出：核心看板 · 五项满意度 ——
  function exportSatDashboard(recs) {
    const data = AGG.satisfactionFromMonthEnd(recs);
    if (!data.length) { toast('暂无满意度数据'); return; }
    const header = ['年', '月'].concat(SCHEMA.satisfactionItems.map(it => it.name + '(%)'));
    const rows = data.map(r => [r.year, r.month].concat(SCHEMA.satisfactionItems.map(it => r[it.key] != null ? +(r[it.key] * 100).toFixed(2) : '')));
    exportSheets('核心看板_五项满意度.xlsx', [{ name: '五项满意度', header, rows }]);
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
    // 周报入库已统一在「数据源 → 历史周报批量入库」完成；此处仅处理科组/教师维度周报
    PARSER.parseDimension(file, stream, ctx).then(res => {
      pending = { stream, ctx, rows: res.rows, unmatchedCols: res.unmatchedCols };
      renderDimensionPreview(stream, res);
    }).catch(err => { preview.innerHTML = '<div class="preview-note warn-cell">解析失败：' + err.message + '</div>'; });
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

  // —— 最佳科组（月度数据 · 标准化解析）——
  const BK = CA.BESTKEZU;
  const UPLOAD_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';

  // STORE 记录（dimension=subject）→ 扁平 {year,month,subject,...values}
  function kezuFlat(rec) {
    return Object.assign({ year: rec.year, month: rec.month, subject: rec.dimension }, rec.values || {});
  }
  // 落库时只保留标准化字段
  function kezuStoredValues(r) {
    const out = {};
    ['hours', 'subjects', 'weeks', 'jieke', 'tingke', 'tuifei', 'xufei', 'teachers', 'quit',
      'weekAvg', 'jiekeRate', 'tingkeRate', 'tuifeiRate', 'xufeiRate', 'quitRate', 'quarter']
      .forEach(k => { if (r[k] != null) out[k] = r[k]; });
    return out;
  }

  // 标准化长表（科组 × 月）
  function kezuTableHTML(records) {
    const cols = [
      { k: 'year', l: '年' }, { k: 'month', l: '月' }, { k: 'subject', l: '科组', s: true },
      { k: 'hours', l: '课时' }, { k: 'subjects', l: '单科数' }, { k: 'weeks', l: '周数' },
      { k: 'jieke', l: '结课' }, { k: 'tingke', l: '停课' }, { k: 'tuifei', l: '退费' }, { k: 'xufei', l: '续费' },
      { k: 'teachers', l: '教师数' }, { k: 'quit', l: '离职' },
      { k: 'weekAvg', l: '周平均', d: 2 }, { k: 'jiekeRate', l: '结课率', p: 1 }, { k: 'tingkeRate', l: '停课率', p: 1 },
      { k: 'tuifeiRate', l: '退费率', p: 1 }, { k: 'xufeiRate', l: '续费率', p: 1 }, { k: 'quitRate', l: '离职率', p: 1 },
      { k: 'quarter', l: '季度' }
    ];
    const rs = records.slice().sort((a, b) => (a.year - b.year) || a.subject.localeCompare(b.subject) || (a.month - b.month));
    let h = '<div class="table-wrap"><table><thead><tr>';
    cols.forEach(c => h += '<th class="' + (c.s ? '' : 'num') + '">' + c.l + '</th>');
    h += '</tr></thead><tbody>';
    rs.forEach(r => {
      h += '<tr>';
      cols.forEach(c => {
        if (c.s) h += '<td>' + esc(r.subject) + '</td>';
        else if (c.p) h += '<td class="num">' + pct(r[c.k]) + '</td>';
        else h += '<td class="num">' + fmt(r[c.k], c.d) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  // 科组年度汇总（全年口径）
  function kezuAnnual(rs) {
    const bySubj = {};
    rs.forEach(r => { (bySubj[r.subject] = bySubj[r.subject] || []).push(r); });
    const out = [];
    Object.keys(bySubj).forEach(subj => {
      const g = bySubj[subj];
      const sum = k => g.reduce((a, r) => a + (r[k] || 0), 0);
      const n = g.length;
      const totalHours = sum('hours'), totalWeeks = sum('weeks');
      const avgSubjects = n ? sum('subjects') / n : 0;
      const xf = sum('xufei'), jk = sum('jieke'), tf = sum('tuifei'), tk = sum('tingke'), qt = sum('quit');
      const last = g.slice().sort((a, b) => b.month - a.month)[0];
      const lastTeachers = last.teachers || 0;
      out.push({
        subject: subj, totalHours, totalWeeks,
        avgSubjects: Math.round(avgSubjects * 10) / 10,
        yearWeekAvg: (totalWeeks && avgSubjects) ? totalHours / totalWeeks / avgSubjects : null,
        xf, jk, tf, tk, qt,
        xufeiRate: avgSubjects ? xf / avgSubjects : null,
        jiekeRate: avgSubjects ? jk / avgSubjects : null,
        tuifeiRate: (tf + avgSubjects) ? tf / (tf + avgSubjects) : null,
        tingkeRate: (tk + avgSubjects) ? tk / (tk + avgSubjects) : null,
        quitRate: (qt + lastTeachers) ? qt / (qt + lastTeachers) : null,
        teachers: lastTeachers
      });
    });
    return out.sort((a, b) => b.totalHours - a.totalHours);
  }
  function kezuAnnualHTML(ann) {
    const cols = [
      { l: '科组', s: true }, { l: '全年课时', k: 'totalHours' }, { l: '全年周数', k: 'totalWeeks' },
      { l: '平均单科数', k: 'avgSubjects', d: 1 }, { l: '年均周平均', k: 'yearWeekAvg', d: 2 },
      { l: '续费', k: 'xf' }, { l: '结课', k: 'jk' }, { l: '退费', k: 'tf' }, { l: '停课', k: 'tk' }, { l: '离职', k: 'qt' },
      { l: '续费率', k: 'xufeiRate', p: 1 }, { l: '结课率', k: 'jiekeRate', p: 1 }, { l: '退费率', k: 'tuifeiRate', p: 1 }, { l: '停课率', k: 'tingkeRate', p: 1 }, { l: '离职率', k: 'quitRate', p: 1 },
      { l: '年末教师数', k: 'teachers' }
    ];
    let h = '<div class="table-wrap"><table><thead><tr>';
    cols.forEach(c => h += '<th class="' + (c.s ? '' : 'num') + '">' + c.l + '</th>');
    h += '</tr></thead><tbody>';
    ann.forEach(a => {
      h += '<tr>';
      cols.forEach(c => {
        if (c.s) h += '<td>' + esc(a.subject) + '</td>';
        else if (c.p) h += '<td class="num">' + pct(a[c.k]) + '</td>';
        else h += '<td class="num">' + fmt(a[c.k], c.d) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  // 科组季度汇总（年内 科组×季度 口径）；聚合逻辑与年度一致，仅按季度（年+科组+季度）分组
  function kezuQuarter(rs) {
    const byKey = {};
    rs.forEach(r => {
      const key = r.subject + '|' + r.quarter;
      (byKey[key] = byKey[key] || []).push(r);
    });
    const out = [];
    Object.keys(byKey).forEach(key => {
      const g = byKey[key];
      const [subj, q] = key.split('|');
      const sum = k => g.reduce((a, r) => a + (r[k] || 0), 0);
      const n = g.length;
      const totalHours = sum('hours'), totalWeeks = sum('weeks');
      const avgSubjects = n ? sum('subjects') / n : 0;
      const xf = sum('xufei'), jk = sum('jieke'), tf = sum('tuifei'), tk = sum('tingke'), qt = sum('quit');
      const last = g.slice().sort((a, b) => b.month - a.month)[0];
      const lastTeachers = last.teachers || 0;
      out.push({
        subject: subj, quarter: +q, totalHours, totalWeeks,
        avgSubjects: Math.round(avgSubjects * 10) / 10,
        quarterWeekAvg: (totalWeeks && avgSubjects) ? totalHours / totalWeeks / avgSubjects : null,
        xf, jk, tf, tk, qt,
        xufeiRate: avgSubjects ? xf / avgSubjects : null,
        jiekeRate: avgSubjects ? jk / avgSubjects : null,
        tuifeiRate: (tf + avgSubjects) ? tf / (tf + avgSubjects) : null,
        tingkeRate: (tk + avgSubjects) ? tk / (tk + avgSubjects) : null,
        quitRate: (qt + lastTeachers) ? qt / (qt + lastTeachers) : null,
        teachers: lastTeachers
      });
    });
    return out.sort((a, b) => a.subject.localeCompare(b.subject) || (a.quarter - b.quarter));
  }
  function kezuQuarterHTML(q) {
    const cols = [
      { l: '科组', s: true }, { l: '季度', k: 'quarter', q: true },
      { l: '季度课时', k: 'totalHours' }, { l: '季度周数', k: 'totalWeeks' },
      { l: '平均单科数', k: 'avgSubjects', d: 1 }, { l: '季度周平均', k: 'quarterWeekAvg', d: 2 },
      { l: '续费', k: 'xf' }, { l: '结课', k: 'jk' }, { l: '退费', k: 'tf' }, { l: '停课', k: 'tk' }, { l: '离职', k: 'qt' },
      { l: '续费率', k: 'xufeiRate', p: 1 }, { l: '结课率', k: 'jiekeRate', p: 1 }, { l: '退费率', k: 'tuifeiRate', p: 1 },
      { l: '停课率', k: 'tingkeRate', p: 1 }, { l: '离职率', k: 'quitRate', p: 1 }, { l: '季末教师数', k: 'teachers' }
    ];
    q = q.filter(x => x.totalHours || x.xf || x.jk || x.tf || x.tk || x.qt || x.teachers); // 跳过全空季度
    let h = '<div class="table-wrap"><table><thead><tr>';
    cols.forEach(c => h += '<th class="' + (c.s ? '' : 'num') + '">' + c.l + '</th>');
    h += '</tr></thead><tbody>';
    if (!q.length) {
      h += '<tr><td colspan="' + cols.length + '" class="empty">该年各季度暂无数据</td></tr>';
    } else {
      q.forEach(a => {
        h += '<tr>';
        cols.forEach(c => {
          if (c.s) h += '<td>' + esc(a.subject) + '</td>';
          else if (c.q) h += '<td class="num">Q' + a[c.k] + '</td>';
          else if (c.p) h += '<td class="num">' + pct(a[c.k]) + '</td>';
          else h += '<td class="num">' + fmt(a[c.k], c.d) + '</td>';
        });
        h += '</tr>';
      });
    }
    h += '</tbody></table></div>';
    return h;
  }

  function exportBestKezu(stored) {
    const header = ['年份', '月份', '科组', '课时', '单科数', '周数', '结课', '停课', '退费', '续费', '教师数', '离职', '周平均', '结课率', '停课率', '退费率', '续费率', '离职率', '季度'];
    const keys = ['year', 'month', 'subject', 'hours', 'subjects', 'weeks', 'jieke', 'tingke', 'tuifei', 'xufei', 'teachers', 'quit', 'weekAvg', 'jiekeRate', 'tingkeRate', 'tuifeiRate', 'xufeiRate', 'quitRate', 'quarter'];
    const rows = stored.slice().sort((a, b) => (a.year - b.year) || a.subject.localeCompare(b.subject) || (a.month - b.month)).map(r => keys.map(k => r[k] == null ? '' : r[k]));
    exportSheets('最佳科组_标准化数据.xlsx', [{ name: '标准化数据', header, rows }]);
  }

  // —— 最佳科组 · 评比结果呈现（Sheet3 全年汇总透视 / Sheet4 季度考试数据 / Sheet5 最佳科组评比汇总）——
  const RATE_COL = /^(结课率|停课率|退费率|续费率|离职率|合格率|优秀率|进步率)$/;
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && /^[-\d.]+$/.test(v.trim()) && !isNaN(+v)); }
  function scoreCell(v, header) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { if (RATE_COL.test(header) && v > 0 && v <= 1) return pct(v); return fmt(v); }
    const s = String(v).trim();
    if (isNum(s)) { const n = +s; if (RATE_COL.test(header) && n > 0 && n <= 1) return pct(n); return fmt(n); }
    return esc(s);
  }
  // 通用块表格；rank=true 时按唯一「总分」列降序并标记最佳科组
  function kezuScoreBlockHTML(block, rank) {
    const header = block.header || [];
    if (!header.length) return '';
    let rows = block.rows.map(r => header.map((_, i) => (i < r.length ? r[i] : null)));
    let totalIdx = -1;
    if (rank) {
      const tot = header.map((h, i) => (/总分/.test(h) ? i : -1)).filter(i => i >= 0);
      if (tot.length === 1 && !header.some(h => /名次/.test(h))) totalIdx = tot[0];
    }
    if (totalIdx >= 0) {
      const sc = row => { const v = row[totalIdx]; return isNum(v) ? +v : -Infinity; };
      rows = rows.slice().sort((a, b) => sc(b) - sc(a));
    }
    let h = '<div class="table-wrap"><table><thead><tr>';
    header.forEach((hd, i) => h += '<th class="' + (i === 0 ? '' : 'num') + '">' + esc(hd) + '</th>');
    h += '</tr></thead><tbody>';
    rows.forEach((row, ri) => {
      const win = totalIdx >= 0 && ri === 0 && isNum(row[totalIdx]);
      h += '<tr' + (win ? ' class="winner"' : '') + '>';
      row.forEach((v, i) => {
        if (i === 0) h += '<td>' + (win ? '<span class="badge-best">最佳</span> ' : '') + esc(v == null ? '' : v) + '</td>';
        else h += '<td class="num">' + scoreCell(v, header[i]) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }
  function kezuBestBanner(rating) {
    if (!rating || !rating.blocks) return '';
    const blk = rating.blocks.find(b => b.header && b.header[0] === '科组' && b.header.some(h => /全年总分/.test(h)));
    if (!blk || !blk.rows.length) return '';
    const tIdx = blk.header.findIndex(h => /全年总分/.test(h));
    const rIdx = blk.header.findIndex(h => /全年名次/.test(h));
    let best = null;
    blk.rows.forEach(r => { const v = r[tIdx]; if (isNum(v)) { if (!best || +v > best.score) best = { name: r[0], score: +v, rank: rIdx >= 0 ? r[rIdx] : '' }; } });
    if (!best) return '';
    return '<div class="bk-best-banner"><span class="badge-best">年度最佳科组</span> <b>' + esc(best.name) + '</b>　全年总分 ' + fmt(best.score) + (best.rank !== '' && best.rank != null ? '　名次 ' + esc(best.rank) : '') + '</div>';
  }
  function kezuScoreHTML(score) {
    if (!score || (!score.pivot && !score.exam && !score.rating)) return '';
    const hasData = (score.pivot && score.pivot.blocks.some(b => b.rows.length)) ||
      (score.exam && score.exam.blocks.some(b => b.rows.length)) ||
      (score.rating && score.rating.blocks.some(b => b.rows.length));
    if (!hasData) return '<div class="panel"><div class="panel-title">最佳科组 · 比照分析</div><div class="empty">已识别评比相关表，但当前上传文件中这些表暂无可呈现的数据行（如 Q3/Q4 季度考试与评分多为预留空行）。上传含完整数据的全量文件即可查看。</div></div>';
    let h = '<div class="panel"><div class="panel-title">最佳科组 · 比照分析（汇总透视 / 季度考试 / 评比排名）</div>';
    h += '<div class="panel-desc">以下数据来自上传文件中的『全年汇总透视』『季度考试数据』『最佳科组评比汇总』三张表，原样呈现；含「总分」的评分表按总分降序并标记最佳科组。</div>';
    const banner = kezuBestBanner(score.rating);
    if (banner) h += banner;
    if (score.pivot) {
      h += '<div class="section-h">全年汇总透视</div>';
      score.pivot.blocks.forEach(b => { h += '<div class="sub-h">' + esc(b.title || '') + '</div>'; h += b.rows.length ? kezuScoreBlockHTML(b, false) : '<div class="preview-note">（无数据）</div>'; });
    }
    if (score.exam) {
      h += '<div class="section-h">季度考试数据</div>';
      score.exam.blocks.forEach(b => { h += '<div class="sub-h">' + esc(b.title || '') + '</div>'; h += b.rows.length ? kezuScoreBlockHTML(b, false) : '<div class="preview-note">（该季度暂无考试数据）</div>'; });
    }
    if (score.rating) {
      h += '<div class="section-h">最佳科组评比汇总（评分明细 / 排名）</div>';
      score.rating.blocks.forEach(b => {
        const canRank = b.header.filter(hh => /总分/.test(hh)).length === 1 && !b.header.some(hh => /名次/.test(hh));
        const totCol = b.header.findIndex(hh => /总分/.test(hh));
        const usable = totCol >= 0 && b.rows.some(r => isNum(r[totCol]) && +r[totCol] > 0);
        h += '<div class="sub-h">' + esc(b.title || '') + '</div>';
        if (!b.rows.length || !usable) h += '<div class="preview-note">（该季度/年度暂无评分数据）</div>';
        else h += kezuScoreBlockHTML(b, canRank);
      });
    }
    h += '</div>';
    return h;
  }

  function wireBestKezuUpload() {
    const drop = $('#bk_drop'), fileInput = $('#bk_file');
    if (!drop) return;
    drop.addEventListener('click', e => { if (e.target.closest('button')) return; fileInput.click(); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) { markBestKezuFile(f); handleBestKezuFile(f); } });
    fileInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) { markBestKezuFile(f); handleBestKezuFile(f); } });
    const btn = $('#bk_parse');
    if (btn) btn.addEventListener('click', e => { e.stopPropagation(); const f = fileInput.files[0]; if (!f) { toast('请先选择文件'); return; } handleBestKezuFile(f); });
  }
  function markBestKezuFile(file) {
    const lbl = $('#bk_filelabel'), drop = $('#bk_drop');
    if (drop) drop.classList.add('has-file');
    if (lbl) lbl.innerHTML = '已选文件：<b>' + esc(file.name) + '</b> · 点击重新选择';
  }
  function handleBestKezuFile(file) {
    const preview = $('#bk_preview');
    if (!preview) return;
    preview.innerHTML = '<div class="preview-note">解析中…</div>';
    BK.parseFile(file).then(res => {
      const yv = (($('#bk_year') && $('#bk_year').value) || '').trim();
      if (/^\d{4}$/.test(yv)) res.records.forEach(r => { r.year = +yv; });
      renderBestKezuPreview(res);
    }).catch(err => { preview.innerHTML = '<div class="preview-note warn-cell">解析失败：' + esc(err && err.message ? err.message : String(err)) + '</div>'; });
  }
  function renderBestKezuPreview(res) {
    const { records, errors, warnings } = res;
    let html = '<div class="bk-validate">';
    if (errors.length) {
      html += '<div class="bk-err"><b>✕ 校验未通过（' + errors.length + ' 项错误）</b><ul>';
      errors.slice(0, 30).forEach(e => html += '<li>' + esc(e.msg) + '</li>');
      if (errors.length > 30) html += '<li>…其余 ' + (errors.length - 30) + ' 项</li>';
      html += '</ul></div>';
    } else {
      html += '<div class="bk-ok">✓ 校验通过，无错误</div>';
    }
    if (warnings.length) {
      html += '<details class="bk-warn"><summary>⚠ 提示（' + warnings.length + ' 项，点击展开）</summary><ul>';
      warnings.slice(0, 40).forEach(w => html += '<li>' + esc(w.msg) + '</li>');
      html += '</ul></details>';
    }
    html += '</div>';
    if (!records.length) {
      html += '<div class="preview-note warn-cell">未解析到有效数据行，请检查表格结构（需含「月份」「科组」列，且每行有课时/单科数等指标）。</div>';
      $('#bk_preview').innerHTML = html;
      return;
    }
    html += '<div class="preview-note">已生成 <b>' + records.length + '</b> 条标准化记录（科组 × 月）</div>';
    if (res.score && (res.score.pivot || res.score.exam || res.score.rating)) {
      const parts = [];
      if (res.score.pivot) parts.push('全年汇总透视');
      if (res.score.exam) parts.push('季度考试数据');
      if (res.score.rating) parts.push('最佳科组评比汇总');
      html += '<div class="preview-note">同时识别到评比相关表：<b>' + parts.join('、') + '</b>，确认后将一并入库并在下方呈现排名。</div>';
    }
    html += kezuTableHTML(records);
    html += '<div class="row" style="margin-top:14px">';
    html += '<button class="btn primary" id="bk_confirm"' + (errors.length ? ' disabled' : '') + '>确认入库（' + records.length + ' 条）</button>';
    if (errors.length) html += '<span class="hint" style="margin-left:10px">存在错误，请修正后重新上传</span>';
    html += '<button class="btn ghost" id="bk_cancel">取消</button></div>';
    $('#bk_preview').innerHTML = html;
    const confirmBtn = $('#bk_confirm');
    if (confirmBtn && !errors.length) {
      confirmBtn.addEventListener('click', () => {
        let n = 0;
        records.forEach(r => {
          STORE.upsert({ stream: 'bestkezu', year: r.year, month: r.month, week: 0, dimension: r.subject, values: kezuStoredValues(r), importedAt: Date.now() });
          n++;
        });
        const yv = (($('#bk_year') && $('#bk_year').value) || '').trim();
        const sy = /^\d{4}$/.test(yv) ? +yv : 2026;
        if (res.score && (res.score.pivot || res.score.exam || res.score.rating)) {
          STORE.upsert({ stream: 'bestkezu_score', year: sy, month: 0, week: 0, dimension: 'score', values: res.score, importedAt: Date.now() });
        }
        toast(n + ' 条已入库' + (res.score ? '，评比数据已同步' : ''));
        renderKezu();
      });
    }
    const cancelBtn = $('#bk_cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { $('#bk_preview').innerHTML = ''; });
  }

  function renderKezu() {
    const stored = STORE.list('bestkezu').map(kezuFlat);
    let html = `
      <div class="panel">
        <div class="panel-title">上传并一键解析 · 最佳科组月度数据</div>
        <div class="panel-desc">支持 Excel / CSV。自动识别「长表（科组×月一行）」或「宽表（科组×月×指标）」，按表头模糊匹配字段，统一重算周平均与各率，并给出校验提示。若上传含『全年汇总透视』『季度考试数据』『最佳科组评比汇总』三张表的全量文件，还会自动呈现科组评比结果与排名。</div>
        <div class="upload-bar" id="bk_drop">
          <div class="ub-left">
            <div class="ub-ico" id="bk_ubico">${UPLOAD_SVG}</div>
            <div>
              <div class="ub-title">拖入或点击上传 xlsx / xls / csv</div>
              <div class="ub-sub" id="bk_filelabel">未选择文件</div>
            </div>
          </div>
          <div class="ub-actions"><button class="btn primary" id="bk_parse">一键解析</button></div>
          <input type="file" id="bk_file" accept=".xlsx,.xls,.csv" hidden />
        </div>
        <div class="meta-row">
          <div class="field"><label>年份(覆盖)</label><input type="number" id="bk_year" value="2026" min="2000" max="2100" style="min-width:84px"/><span class="hint">文件无年份时默认 2026；留空则不覆盖</span></div>
        </div>
        <div id="bk_preview"></div>
      </div>`;

    if (stored.length) {
      const years = [...new Set(stored.map(r => r.year))].sort((a, b) => b - a);
      const curYear = years[0];
      html += '<div class="panel"><div class="panel-title">最佳科组 · 标准化数据（共 ' + stored.length + ' 条）</div>';
      html += '<div class="toolbar"><label>年份</label><select id="bk_year_sel">' + years.map(y => '<option value="' + y + '"' + (y === curYear ? ' selected' : '') + '>' + y + ' 年</option>').join('') + '</select>';
      html += '<button class="btn ghost" id="bk_export">导出标准化 Excel</button>';
      html += '<button class="btn ghost" id="bk_clear">清空本科组数据</button></div>';
      html += '<div class="section-h">月度明细（科组 × 月）</div><div id="bk_monthly_wrap"></div>';
      html += '<div class="section-h">科组季度汇总（' + curYear + ' 年口径）</div><div id="bk_quarter_wrap"></div>';
      html += '<div class="section-h">科组年度汇总（' + curYear + ' 年口径）</div><div id="bk_annual_wrap"></div>';
      html += '<div class="chart-box"><canvas id="bkAnnualChart"></canvas></div></div>';
    } else {
      html += '<div class="panel"><div class="empty">还没有最佳科组数据。上传「泉山2026最佳科组_全年汇总」这类文件，系统会自动解析为标准格式。</div></div>';
    }
    // 评比结果面板（来自上传文件中的 Sheet3/4/5）
    const scoreRecs = STORE.list('bestkezu_score');
    const curYear = stored.length ? [...new Set(stored.map(r => r.year))].sort((a, b) => b - a)[0] : null;
    const scoreRec = (curYear != null && scoreRecs.find(r => r.year === curYear)) || scoreRecs[0];
    const score = scoreRec ? scoreRec.values : null;
    html += kezuScoreHTML(score);
    $('#content').innerHTML = html;

    if (stored.length) {
      const fill = (year) => {
        const rs = stored.filter(r => r.year === year);
        $('#bk_monthly_wrap').innerHTML = kezuTableHTML(rs);
        $('#bk_quarter_wrap').innerHTML = kezuQuarterHTML(kezuQuarter(rs));
        const ann = kezuAnnual(rs);
        $('#bk_annual_wrap').innerHTML = kezuAnnualHTML(ann);
        if (ann.length) drawBar('bkAnnualChart', ann.map(a => a.subject), ann.map(a => a.totalHours), '全年课时', 'rgba(79,70,229,.8)');
      };
      fill(curYear);
      $('#bk_year_sel').addEventListener('change', e => fill(+e.target.value));
      $('#bk_export').addEventListener('click', () => exportBestKezu(stored));
      $('#bk_clear').addEventListener('click', () => {
        if (window.confirm('确认清空所有最佳科组数据（含评比结果）？此操作不可撤销。')) {
          stored.forEach(r => STORE.remove('bestkezu', r.year, r.month, 0, r.subject));
          scoreRecs.forEach(r => STORE.remove('bestkezu_score', r.year, 0, 0, 'score'));
          toast('已清空本科组及评比数据');
          renderKezu();
        }
      });
    }
    wireBestKezuUpload();
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

  // —— 五项满意度（核心看板子页签）——
  function renderSatDashboard() {
    const recs = STORE.list('weekly');
    const data = AGG.satisfactionFromMonthEnd(recs);
    let html = '<div class="row" style="margin-bottom:12px"><button class="btn sm" id="satExportBtn">⬇ 导出 Excel</button></div>';
    html += '<div class="section-h">五项满意度（月度，自动从月度周报提取）</div>';
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
    $('#dashBody').innerHTML = html;
    $('#satExportBtn').addEventListener('click', () => exportSatDashboard(recs));
    if (data.length) {
      const labels = data.map(r => r.year + '/' + r.month);
      const ds = SCHEMA.satisfactionItems.map((it, idx) => ({
        label: it.name, data: data.map(r => (r[it.key] == null ? null : +(r[it.key] * 100).toFixed(2))),
        borderColor: ['#4F46E5', '#16a34a', '#dc2626', '#d97706', '#0ea5e9'][idx], backgroundColor: 'transparent', tension: .3, fill: false,
      }));
      drawLine('satChart', labels, ds);
    }
  }

  // —— 数据源 · 历史周报批量入库 ——
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

  // —— 数据源（含「数据库」单子页签，呈现年度各月情况）——
  function renderCompare() {
    let html = '<div class="panel"><div class="panel-title">数据源</div>';
    html += '<div class="panel-desc">数据源提供「数据库」视图：按年份呈现年度各月「月度周报」的对比明细与柱状对比，并可在此上传周报（下方「历史周报批量入库」）。</div>';
    html += '<div class="dash-tabs"><button class="dash-tab active" data-sub="cmp">数据库</button></div>';
    html += '<div id="cmpBody"></div></div>';
    $('#content').innerHTML = html;
    renderCmpCompare();
  }

  function renderCmpCompare() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    const yr = years.length ? Math.max(...years) : new Date().getFullYear();
    let html = '<div class="row" style="align-items:flex-end">';
    html += '<div class="field"><label>年份</label><select id="cmpYear">' + years.concat([yr]).filter((v, i, a) => a.indexOf(v) === i).map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>';
    html += '<button class="btn sm" id="cmpExportBtn">⬇ 导出 Excel</button>';
    html += '</div>';
    html += '<div id="cmpResult"></div>';
    html += compareUploadPanelHTML();
    $('#cmpBody').innerHTML = html;
    wireCompareUpload();

    const yrSel = $('#cmpYear');
    $('#cmpExportBtn').addEventListener('click', () => { const y = parseInt(yrSel.value, 10); exportDataSource(recs, y); });
    function draw() {
      const y = parseInt(yrSel.value, 10);
      if (!years.length) { $('#cmpResult').innerHTML = '<div class="empty">暂无数据。请先用下方「历史周报批量入库」上传各月月度周报。</div>'; destroyChart('cmpChart'); return; }
      const cmp = AGG.compareYearStandard(recs, y);
      renderCompareTable(cmp);
    }
    yrSel.addEventListener('change', draw);
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
    // 选指标画柱状（仅含数值的对比项）—— 置于对比结果最上方
    const metricRows = cmp.rows.filter(r => r.values.some(c => c && c.num != null));
    let html = '<div class="section-h">柱状对比（选指标）</div><div class="field"><select id="cmpMetric">' +
      metricRows.map(r => '<option value="' + esc(r.key) + '">' + r.label + '</option>').join('') + '</select></div>';
    html += '<div class="chart-box"><canvas id="cmpChart"></canvas></div>';
    html += '<div class="preview-note">说明：柱状对比按所选指标并排展示各对比列数值；下方为完整对比明细表。</div>';
    html += '<div class="table-wrap"><table><thead><tr><th>表格事项（原表）</th>';
    cmp.columns.forEach(c => html += '<th class="num">' + c.label + '</th>');
    html += '</tr></thead><tbody>';
    cmp.rows.forEach(r => {
      html += '<tr><td>' + esc(r.label) + '</td>';
      r.values.forEach(cell => html += '<td class="num">' + cellText(cell) + '</td>');
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="preview-note">说明：年度各月对比按各月「月度周报」展示《季度数据统计标准》列出的月度字段，并保持与该标准一致的顺序。某月未出现的项留空。</div>';
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
    html += '<div class="dash-tabs"><button class="dash-tab active" data-sub="year">年度汇总数据看板</button><button class="dash-tab" data-sub="quarter">季度汇总数据对比看板</button><button class="dash-tab" data-sub="sat">五项满意度</button><button class="dash-tab" data-sub="kezu">最佳科组排名</button></div>';
    html += '<div id="dashBody"></div></div>';
    $('#content').innerHTML = html;
    $all('.dash-tab').forEach(b => b.addEventListener('click', () => {
      $all('.dash-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.sub === 'year') renderYearDashboard();
      else if (b.dataset.sub === 'quarter') renderQuarterDashboard();
      else if (b.dataset.sub === 'kezu') renderKezuRankDashboard();
      else renderSatDashboard();
    }));
    renderYearDashboard();
  }

  function renderYearDashboard() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「数据源」入库各月月度周报。</div>'; return; }
    const yr = Math.max(...years);
    let html = '<div class="row" style="margin-bottom:16px;align-items:flex-end"><div class="field"><label>年份</label><select id="dashYr">' +
      years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>' +
      '<button class="btn sm" id="yrExportBtn">⬇ 导出 Excel</button></div>';
    html += '<div id="ydashResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#dashYr').addEventListener('change', () => drawYearDash());
    $('#yrExportBtn').addEventListener('click', () => { const y = parseInt($('#dashYr').value, 10); exportYearDashboard(recs, y); });
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
        // 完成率右轴自适应：避免写死 max:120 导致超额月份被天花板裁切，或完成率集中高位时折线被压扁
        const validRates = rateData.filter(x => x != null);
        let y1Min = 0, y1Max = 100;
        if (validRates.length) {
          const rMax = Math.max(...validRates), rMin = Math.min(...validRates);
          y1Max = Math.max(100, Math.ceil((rMax + 10) / 10) * 10);
          y1Min = rMin >= 50 ? Math.floor((rMin - 10) / 10) * 10 : 0;
          if (y1Min < 0) y1Min = 0;
        }
        charts['yrTrendChart'] = new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [
            { label: '月课时生产现金', data: cashData, backgroundColor: 'rgba(79,70,229,.7)', borderRadius: 4, yAxisID: 'y' },
            { label: '1V1生产完成率', data: rateData, type: 'line', borderColor: 'rgba(22,163,74,.9)', backgroundColor: 'rgba(22,163,74,.1)', borderWidth: 2, pointRadius: 4, yAxisID: 'y1', tension: .3 },
          ] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } },
            scales: {
              y: { beginAtZero: true, title: { display: true, text: '现金(元)' } },
              y1: { position: 'right', min: y1Min, max: y1Max, title: { display: true, text: '完成率(%)' }, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } },
            } },
        });
      }
    }
  }

  function renderQuarterDashboard() {
    const recs = STORE.list('weekly');
    const years = AGG.yearOptions(recs);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「数据源」入库各月月度周报。</div>'; return; }
    const yr = Math.max(...years);
    let html = '<div class="row" style="margin-bottom:16px;align-items:flex-end"><div class="field"><label>年份</label><select id="dashQYr">' +
      years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>' +
      '<button class="btn sm" id="qExportBtn">⬇ 导出 Excel</button></div>';
    html += '<div id="qdashResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#dashQYr').addEventListener('change', () => drawQuarterDash());
    $('#qExportBtn').addEventListener('click', () => { const y = parseInt($('#dashQYr').value, 10); exportQuarterDashboard(recs, y); });
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

  // —— 核心看板 · 最佳科组排名（基于季度评比数据）——
  function renderKezuRankDashboard() {
    const recs = STORE.list('bestkezu_score');
    if (!recs.length) {
      $('#dashBody').innerHTML = '<div class="empty">暂无最佳科组评比数据。请先在「最佳科组」模块上传含『最佳科组评比汇总』(Sheet5) 的全量文件并入库，即可在此查看各季度与全年排名。</div>';
      return;
    }
    const years = recs.map(r => r.year).filter(y => y).sort((a, b) => b - a);
    const yr = years[0];
    let html = '<div class="row" style="margin-bottom:16px;align-items:flex-end"><div class="field"><label>年份</label><select id="kezuRankYr">' +
      years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>' +
      '<div class="preview-note" style="margin-left:8px">数据来源：最佳科组评比汇总（季度排名 / 全年累计排名）。含「总分」的评分表按总分降序并标记最佳科组。</div></div>';
    html += '<div id="kezuRankResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#kezuRankYr').addEventListener('change', draw);
    function draw() {
      const y = parseInt($('#kezuRankYr').value, 10);
      const rec = recs.find(r => r.year === y) || recs[0];
      const score = rec.values || {};
      const rating = score.rating;
      let h = '';
      const banner = kezuBestBanner(rating);
      if (banner) h += banner;
      if (rating && rating.blocks && rating.blocks.length) {
        h += '<div class="section-h">最佳科组 · 季度与全年排名</div>';
        rating.blocks.forEach(b => {
          const canRank = b.header.filter(hh => /总分/.test(hh)).length === 1 && !b.header.some(hh => /名次/.test(hh));
          const totCol = b.header.findIndex(hh => /总分/.test(hh));
          const usable = totCol >= 0 ? b.rows.some(r => isNum(r[totCol]) && +r[totCol] > 0) : b.rows.some(r => r[1] != null && r[1] !== '' && isNum(r[1]));
          h += '<div class="sub-h">' + esc(b.title || '') + '</div>';
          if (!b.rows.length || !usable) h += '<div class="preview-note">（该季度/年度暂无评分数据）</div>';
          else h += kezuScoreBlockHTML(b, canRank);
        });
      } else {
        h += '<div class="empty">该年评比数据中暂无排名信息。</div>';
      }
      $('#kezuRankResult').innerHTML = h;
    }
    draw();
  }


  // —— 数据备份 ——
  function renderData() {
    const all = STORE.readAll();
    const byStream = { weekly: 0, bestkezu: 0, kpi: 0 };
    all.forEach(r => byStream[r.stream]++);
    let html = '<div class="panel"><div class="panel-title">数据备份 / 恢复</div>';
    html += '<div class="panel-desc">数据保存在本浏览器 localStorage。导出为 data.json 可备份、跨设备迁移、或历史补录（导入会按主键覆盖）。</div>';
    html += '<div class="kpi-cards"><div class="kpi-card"><div class="k">周报</div><div class="v">' + byStream.weekly + '</div></div>' +
      '<div class="kpi-card"><div class="k">最佳科组</div><div class="v">' + byStream.bestkezu + '</div></div>' +
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
    kezu: { title: '最佳科组', render: renderKezu },
    kpi: { title: '教师 KPI', render: renderKpi },
    compare: { title: '数据源', render: renderCompare },
    dashboard: { title: '核心看板', render: renderDashboard },
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
    go('dashboard');
    updateCount();
  }

  document.addEventListener('DOMContentLoaded', init);
  CA.go = go; // 调试/测试出口，生产环境无副作用
})(window);
