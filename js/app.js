/*
 * app.js — UI 控制器
 * 板块：最佳科组 / 教师KPI / 数据源（历史周报批量入库 + 数据库视图：年度各月对比）/ 核心看板（年度·季度·五项满意度）/ 数据备份
 * 数据链路：所有汇总数据统一由 CA.aggregate 聚合层从 store 的月度周报派生，UI 不散算。
 */
(function (global) {
  'use strict';
  const CA = global.CA;
  const SCHEMA = CA.SCHEMA, STORE = CA.store, PARSER = CA.parser, AGG = CA.aggregate;

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
  const TARGET_C_KEY = 'ca_kezu_target_C';
  function loadTargetC(def) {
    try { const v = localStorage.getItem(TARGET_C_KEY); if (v != null && v !== '') { const n = parseFloat(v); if (isFinite(n) && n >= 0) return n; } } catch (e) {}
    return def == null ? 1000 : def;
  }
  function saveTargetC(v) {
    try { localStorage.setItem(TARGET_C_KEY, String(v)); } catch (e) {}
  }
  // 把当前 C 值同步到 CA.store，确保「推送分析到个人台」时能把 C 带下去
  function persistTargetC(v) {
    saveTargetC(v);
    try {
      CA.store.upsert({ stream: 'kezuTargetC', year: 0, month: 0, week: 0, dimension: 'C', values: { C: +v || 0 }, importedAt: Date.now() });
    } catch (e2) { console.warn('[app] persistTargetC failed', e2); }
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
    const cmp = AGG.compareYearStandard(getMonthlyRecords(), year);
    if (!cmp.columns.length) { toast('该年暂无数据'); return; }
    const header = ['月度原数据（字段）'].concat(cmp.columns.map(c => c.label));
    const rows = cmp.rows.map(r => [r.label].concat(r.values.map(c => (c == null ? '' : (c.num != null ? c.num : c.text)))));
    exportSheets('数据源_年度各月对比_' + year + '年.xlsx', [{ name: '年度各月对比', header, rows }]);
  }

  // —— 导出：核心看板 · 年度汇总 ——
  function exportYearDashboard(recs, year) {
    const yd = AGG.yearlyAggregate(recs, year, getMonthlyRecords());
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
    const qAll = AGG.quarterlyAggregate(recs, getMonthlyRecords()).filter(x => x.year === year).sort((a, b) => a.quarter - b.quarter);
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

  // 当月「合理最大周次」上限：以模板「当月周数」(totalWeeksOfMonth) 的【最小声明值】为权威上限，
  // 其次取含 weekSeq 记录的最小周次，最后兜底 5（DOS 月份通常 ≤5 周，超出者视为月末周被误标为第5/6周的脏数据）。
  // 取【最小】而非【最大】：误标脏数据会把周数"撑大"（如把月末周存成第5周且模板写当月5周），
  // 真实月长应取各记录中最小的声明值，从而把超出者判定为脏数据过滤/清理。
  // 用于 latestV1 与周报对比看板过滤/清理异常周次，避免脏记录污染"最新一周"判定。
  function legitMaxWeek(recs) {
    const tots = (recs || []).map(r => r.values && r.values.totalWeeksOfMonth != null ? r.values.totalWeeksOfMonth : null).filter(x => x != null);
    if (tots.length) return Math.min.apply(null, tots);
    const seqs = (recs || []).map(r => r.values && r.values.weekSeq != null ? r.values.weekSeq : null).filter(x => x != null);
    if (seqs.length) return Math.min.apply(null, seqs);
    return 5;
  }

  // —— 上传面板（通用）——
  function uploadPanelHTML(stream) {
    const p = inferPeriod();
    const defaultLabel = '第' + p.week + '周';
    const uploadIco = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';
    return `
      <div class="panel">
        <div class="panel-title">上传并一键提取 · 教师周报</div>
        <div class="panel-desc">上传教师周报 xlsx（首行表头，每行一个教师），按表头一键提取。</div>
        <div class="upload-bar" id="drop_${stream}">
          <div class="ub-left">
            <div class="ub-ico" id="ubico_${stream}">${uploadIco}</div>
            <div>
              <div class="ub-title">拖入或点击上传 教师周报 xlsx</div>
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
    // 周报入库已统一在「数据源 → 历史周报批量入库」完成；此处仅处理教师(KPI)维度周报
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
    const cols = SCHEMA.kpiFields;
    html += '<th>教师</th>';
    cols.forEach(c => html += '<th class="num">' + c.label + '</th>');
    html += '</tr></thead><tbody>';
    res.rows.forEach(r => {
      html += '<tr><td>' + r.dimension + '</td>';
      cols.forEach(c => { html += '<td class="num">' + (c.type === 'ratio' ? pct(r.values[c.key]) : fmt(r.values[c.key])) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="row" style="margin-top:14px"><button class="btn primary" id="confirm_' + stream + '">确认入库（' + res.rows.length + ' 条）</button><button class="btn ghost" id="cancel_' + stream + '">取消</button></div>';
    $('#preview_' + stream).innerHTML = html;
    $('#confirm_' + stream).addEventListener('click', () => {
      let n = 0;
      pending.rows.forEach(r => { STORE.upsert({ stream: pending.stream, year: pending.ctx.year, month: pending.ctx.month, week: pending.ctx.week, dimension: r.dimension, values: r.values, importedAt: Date.now() }); n++; });
      toast(n + ' 条已入库'); pending = null;
      renderKpi();
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

  // 科组年度汇总已迁移至 CA.aggregate.kezuAnnual（聚合逻辑集中在聚合层）
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

  // 科组季度汇总已迁移至 CA.aggregate.kezuQuarter（聚合逻辑集中在聚合层）
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
    } else {
      html += '<div class="preview-note warn-cell">⚠ 未识别到评比相关表（全年汇总透视 / 季度考试数据 / 最佳科组评比汇总）。若需核心看板呈现排名，请上传含这些表的全量文件；如 sheet 名不同，系统会尝试按关键词/Sheet5 兜底匹配。</div>';
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

  // 最佳科组 · 月度数据 vs 季度汇总 横向对比
  // 支持按「月份」或「季度」筛选；月度明细与季度汇总并排对照，并附趋势图（按对比维度）。
  // 横向对比：维度元数据（同项目 · 跨时间粒度）
  const KEZU_CMP_DIMS = [
    { k: 'hours', l: '课时', kind: 'num', d: 0 },
    { k: 'subjects', l: '单科数', kind: 'num', d: 1 },
    { k: 'weekAvg', l: '周平均', kind: 'num', d: 2 },
    { k: 'xufeiRate', l: '续费率', kind: 'rate' },
    { k: 'jiekeRate', l: '结课率', kind: 'rate' },
    { k: 'tuifeiRate', l: '退费率', kind: 'rate' },
    { k: 'tingkeRate', l: '停课率', kind: 'rate' },
    { k: 'quitRate', l: '离职率', kind: 'rate' },
  ];
  const CMP_COLORS = ['#4F46E5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

  // 取某条记录在指定维度上的数值（月度明细 / 季度聚合通用）
  function kezuCmpVal(rec, dim, isQuarter) {
    if (!rec) return null;
    if (isQuarter) {
      if (dim === 'hours') return rec.totalHours != null ? rec.totalHours : null;
      if (dim === 'subjects') return rec.avgSubjects != null ? rec.avgSubjects : null;
      if (dim === 'weekAvg') return rec.quarterWeekAvg != null ? rec.quarterWeekAvg : null;
    } else {
      if (dim === 'hours') return rec.hours != null ? rec.hours : null;
      if (dim === 'subjects') return rec.subjects != null ? rec.subjects : null;
      if (dim === 'weekAvg') return rec.weekAvg != null ? rec.weekAvg : null;
    }
    if (['xufeiRate', 'jiekeRate', 'tuifeiRate', 'tingkeRate', 'quitRate'].includes(dim)) {
      return rec[dim] != null ? rec[dim] : null;
    }
    return null;
  }

  // 科组横向对比：同一科组跨不同月份（月度横向）或跨不同季度（季度横向）
  // 两种模式均仅限同项目维度，互不包含对方的时间粒度数据。
  function renderKezuCompare(containerId) {
    containerId = containerId || 'bk_compare_wrap';
    const stored = STORE.list('bestkezu').map(kezuFlat);
    if (!stored.length) {
      $('#' + containerId).innerHTML = '<div class="empty">还没有最佳科组月度数据，先上传并入库后在上方查看标准化数据。</div>';
      return;
    }
    const years = [...new Set(stored.map(r => r.year))].sort((a, b) => b - a);
    const curYear = years[0];

    let h = '<div class="panel"><div class="panel-title">科组横向对比（同项目 · 跨时间）</div>';
    h += '<div class="panel-desc">对同一科组在不同时间粒度间做横向对比：<b>月度横向对比</b>＝同一科组跨各月份比较（不含任何季度汇总）；<b>季度横向对比</b>＝同一科组跨各季度比较（不含任何月度明细）。两种模式均仅限同项目维度，互不包含对方的时间粒度数据。</div>';
    h += '<div class="toolbar" style="margin-bottom:12px">';
    h += '<label>年份</label><select id="cmpYear">' + years.map(y => '<option value="' + y + '"' + (y === curYear ? ' selected' : '') + '>' + y + ' 年</option>').join('') + '</select>';
    h += '<label>对比模式</label><div class="seg" id="cmpMode"><button data-m="month" class="active">月度横向对比</button><button data-m="quarter">季度横向对比</button></div>';
    h += '<label>对比维度</label><select id="cmpDim">' + KEZU_CMP_DIMS.map(d => '<option value="' + d.k + '">' + d.l + '</option>').join('') + '</select>';
    h += '</div>';
    h += '<div id="cmpTableWrap"></div>';
    h += '<div class="chart-box" style="margin-top:16px"><canvas id="cmpChart"></canvas></div>';
    h += '</div>';
    $('#' + containerId).innerHTML = h;

    function draw() {
      const year = +$('#cmpYear').value;
      const mode = $('#cmpMode').dataset.m;
      const dim = $('#cmpDim').value;
      const dimMeta = KEZU_CMP_DIMS.find(d => d.k === dim);
      const recs = stored.filter(r => r.year === year);
      const subjects = [...new Set(recs.map(r => r.subject))].sort((a, b) => a.localeCompare(b));
      const isQuarter = mode === 'quarter';

      // 构建 科组 × 时间 矩阵
      let periods, pLabel, matrix;
      if (!isQuarter) {
        // 月度横向：仅列出该年有数据的月份（升序），数据来自科组月度明细
        periods = [...new Set(recs.map(r => r.month))].sort((a, b) => a - b);
        pLabel = m => m + '月';
        const mMap = {};
        recs.forEach(r => { (mMap[r.subject] = mMap[r.subject] || {})[r.month] = r; });
        matrix = {};
        subjects.forEach(s => { matrix[s] = {}; periods.forEach(m => { matrix[s][m] = mMap[s] ? mMap[s][m] : null; }); });
      } else {
        // 季度横向：基于 kezuQuarter 聚合，仅列出有数据的季度
        const qAgg = AGG.kezuQuarter(recs);
        periods = [...new Set(qAgg.map(q => q.quarter))].sort((a, b) => a - b);
        pLabel = q => 'Q' + q;
        const qMap = {};
        qAgg.forEach(q => { (qMap[q.subject] = qMap[q.subject] || {})[q.quarter] = q; });
        matrix = {};
        subjects.forEach(s => { matrix[s] = {}; periods.forEach(q => { matrix[s][q] = qMap[s] ? qMap[s][q] : null; }); });
      }

      const avgLabel = isQuarter ? '季均' : '月均';
      const unit = dimMeta.kind === 'rate' ? '（%）' : '';

      // —— 横向对比表：每科组一行，列为各时间粒度 ——
      let th = '<div class="table-wrap"><table><thead><tr>';
      th += '<th>' + (isQuarter ? '科组 \\ 季度' : '科组 \\ 月份') + '</th>';
      periods.forEach(p => th += '<th class="num">' + pLabel(p) + '</th>');
      th += '<th class="num">' + avgLabel + '</th>';
      th += '</tr></thead><tbody>';
      if (!subjects.length) {
        th += '<tr><td colspan="' + (periods.length + 2) + '" class="empty">该年暂无科组数据</td></tr>';
      } else {
        subjects.forEach(subj => {
          th += '<tr><td>' + esc(subj) + '</td>';
          let sumV = 0, cnt = 0;
          periods.forEach(p => {
            const rec = matrix[subj][p];
            const v = kezuCmpVal(rec, dim, isQuarter);
            if (v != null) { sumV += v; cnt++; }
            if (v == null) th += '<td class="num muted">—</td>';
            else if (dimMeta.kind === 'rate') th += '<td class="num">' + pct(v) + '</td>';
            else th += '<td class="num">' + fmt(v, dimMeta.d) + '</td>';
          });
          const avg = cnt ? sumV / cnt : null;
          th += '<td class="num" style="font-weight:600">' + (avg == null ? '—' : (dimMeta.kind === 'rate' ? pct(avg) : fmt(avg, dimMeta.d))) + '</td>';
          th += '</tr>';
        });
      }
      th += '</tbody></table></div>';
      th += '<div class="preview-note">' + (isQuarter
        ? '季度横向对比：同一科组跨各季度的「' + dimMeta.l + unit + '」对比，数据来自季度聚合（课时累加、单科数取月均、周平均/各率按口径重算），<b>不含任何月度明细</b>。末列「' + avgLabel + '」为该年所列各季度的算术平均。'
        : '月度横向对比：同一科组跨各月份的「' + dimMeta.l + unit + '」对比，数据来自科组月度明细，<b>不含任何季度汇总</b>。末列「' + avgLabel + '」为该年所列各月份的算术平均。') + '</div>';
      $('#cmpTableWrap').innerHTML = th;

      // 趋势图：每个科组一条线，X 轴为对应时间粒度
      const datasets = subjects.map((subj, i) => {
        const color = CMP_COLORS[i % CMP_COLORS.length];
        const data = periods.map(p => {
          const v = kezuCmpVal(matrix[subj][p], dim, isQuarter);
          if (v == null) return null;
          return dimMeta.kind === 'rate' ? +(v * 100).toFixed(2) : v;
        });
        return { label: subj, data, borderColor: color, backgroundColor: color, tension: .25, fill: false, spanGaps: true, pointRadius: 3 };
      });
      drawLine('cmpChart', periods.map(pLabel), datasets, dimMeta.kind === 'rate' ? '%' : '');
    }

    $('#cmpYear').addEventListener('change', draw);
    $('#cmpDim').addEventListener('change', draw);
    $all('#cmpMode button').forEach(b => b.addEventListener('click', () => {
      $all('#cmpMode button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#cmpMode').dataset.m = b.dataset.m;
      draw();
    }));
    $('#cmpMode').dataset.m = 'month';
    draw();
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
      html += '<div class="section-h">科组横向对比（同项目 · 跨时间）</div><div id="bk_compare_wrap"></div>';
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
        $('#bk_quarter_wrap').innerHTML = kezuQuarterHTML(AGG.kezuQuarter(rs));
        const ann = AGG.kezuAnnual(rs);
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
    renderKezuCompare();
  }

  // —— 教师 KPI（新版：教师个人月度台账，横表导入）——
  // 数据：stream='tkpi'，每行 = 一位教师 × 一个月。
  // 派生（不落库，统一由 AGG.tkpiMonthDerived 计算）：总学员数=1V1+1V6；参考课次=周次×16；
  //   月饱和度=月度课次÷参考课次；月度周平均=1V1课次×3÷1V1学员数÷周次。
  // 半年度：上半年=3-8月，下半年=9-2月（跨年）；半年内无数据的月份按 0 计。
  const TKPI_STREAM = 'tkpi';
  const TKPI_HEADER_ALIAS = {
    teacher: ['教师', '姓名', '名字', '名称', '老师', '任课教师'],
    month: ['月份', '年月', '统计月份', '统计月', '日期', '月度'],
    subjectGroup: ['学科组', '科组', '科目组', '组别', '学科'],
    v1Students: ['1V1学员数', '1v1学员数', '1V1在读', '1v1在读', '1V1在读学员数', '1V1在读单科', '1V1在读单科数', '1v1在读单科数', '1对1学员数', '1对1在读', '1V1人数', '1v1人数', '1V1在读人数'],
    v6Students: ['1V6学员数', '1v6学员数', '1V6在读', '1v6在读', '1V6在读学员数', '1V6在读单科', '1V6在读单科数', '1v6在读单科数', '1对6学员数', '1V6人数', '1v6人数', '1V6在读人数'],
    monthSessions: ['月度课次', '月课次', '本月课次', '当月课次', '月度课时', '月课时', '课次'],
    weekSeq: ['周次', '参考周次', '当月周次', '当月周数', '月周数', '周数'],
    v1Sessions: ['月度1V1课次', '1V1月度课次', '1V1课次', '1v1课次', '月1V1课次', '1V1月课次', '1V1课时'],
    stopCount: ['1V1停课人数', '1V1停课', '停课人数', '1v1停课人数', '停课'],
    gradCount: ['1V1结课人数', '1V1结课', '结课人数', '1v1结课人数', '结课'],
    refundCount: ['1V1退费人数', '1V1退费', '退费人数', '1v1退费人数', '退费'],
    renewCount: ['1V1续费人数', '1V1续费', '续费人数', '1v1续费人数', '续费'],
    examScore: ['专业考分数', '专业考分', '专业分', '专业考成绩', '专业考试分数'],
    examRank: ['专业考排名', '专业考名次', '专业排名', '专业名次', '排名'],
    examResult: ['优秀/及格', '优秀及格', '优秀', '及格', '考试结果', '考核结果'],
    progressRate: ['进步率', '成绩进步率', '进步幅度'],
    evalSubjects: ['参评单科数', '参评单科', '参评科数', '单科数'],
  };
  const TKPI_ALIAS_IDX = {};
  Object.keys(TKPI_HEADER_ALIAS).forEach(k => TKPI_HEADER_ALIAS[k].forEach(a => { TKPI_ALIAS_IDX[tkpiNorm(a)] = k; }));

  function tkpiNorm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s（）()【】\[\]：:]/g, '');
  }
  function mapTKpiHeader(row) {
    const map = {};
    if (!row) return map;
    row.forEach((v, c) => {
      if (v == null || String(v).trim() === '') return;
      const k = TKPI_ALIAS_IDX[tkpiNorm(v)];
      if (k && map[k] == null) map[k] = c;
    });
    return map;
  }
  function tkpiParseMonth(v, defYear) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return { y: v.getFullYear(), mo: v.getMonth() + 1 };
    if (typeof v === 'number' && isFinite(v)) {
      if (v >= 200001 && v <= 210012) return { y: Math.floor(v / 100), mo: v % 100 };
      if (v >= 1 && v <= 12) return { y: defYear, mo: v };
      return null;
    }
    const s = String(v).trim();
    let m = s.match(/(\d{4})[年.\-/](\d{1,2})月?/);
    if (m) return { y: +m[1], mo: +m[2] };
    m = s.match(/^(\d{4})(\d{2})月?$/);
    if (m) return { y: +m[1], mo: +m[2] };
    m = s.match(/^(\d{1,2})月?$/);
    if (m) return { y: defYear, mo: +m[1] };
    return null;
  }
  function tkpiNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = parseFloat(String(v).trim().replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function tkpiRatio(v) {
    if (v == null || v === '') return null;
    const isPctStr = typeof v === 'string' && v.trim().endsWith('%');
    const n = (typeof v === 'number') ? v : parseFloat(String(v).trim().replace(/,/g, '').replace(/%$/, ''));
    if (!isFinite(n)) return null;
    if (isPctStr || Math.abs(n) > 1) return n / 100; // 35% / 35 → 0.35；0.35 → 0.35
    return n;
  }
  // 周次解析：Excel 列 > 月度数据源当月周数 > 默认 4（调用方标注）
  function tkpiWeekOfMonth(y, m, excelVal) {
    if (excelVal != null && excelVal !== '') {
      const n = tkpiNum(excelVal);
      if (n != null && n > 0) return n;
    }
    const rec = getMonthlyRecords().find(r => r.year === y && r.month === m);
    const w = rec && rec.values ? (rec.values.totalWeeksOfMonth || rec.values.weekSeq) : null;
    return (w != null && w > 0) ? w : null;
  }
  // 半年度下拉选项（按 年份/半年 倒序）
  function tkpiHalfOptions(recs) {
    const set = new Set();
    recs.forEach(r => set.add(AGG.tkpiHalfLabel(r.year, r.month).label));
    return [...set].map(label => {
      const m = label.match(/^(\d{4})(上半年|下半年)$/);
      return { label, year: +m[1], half: m[2] === '上半年' ? 1 : 2 };
    }).sort((a, b) => (b.year - a.year) || (b.half - a.half));
  }
  // 迁移：旧版「周度教师 KPI」直接替换清空（一次性）
  function migrateOldKpi() {
    const FLAG = 'ca_tkpi_migrated_v20260826c';
    try { if (localStorage.getItem(FLAG)) return; } catch (e) { return; }
    const old = STORE.list('kpi');
    if (old.length) {
      old.forEach(r => STORE.remove('kpi', r.year, r.month, r.week, r.dimension));
      toast('已清空旧版「周度教师 KPI」' + old.length + ' 条，由新版月度台账接管');
    }
    try { localStorage.setItem(FLAG, '1'); } catch (e) {}
  }
  function clearTKpi() {
    const recs = STORE.list(TKPI_STREAM);
    if (!recs.length) { toast('暂无数据'); return; }
    if (!confirm('确定清空全部教师 KPI 台账（' + recs.length + ' 条）？此操作不可撤销，建议先「导出台账」备份。')) return;
    recs.forEach(r => STORE.remove(TKPI_STREAM, r.year, r.month, 0, r.dimension));
    toast('已清空全部教师 KPI');
    renderKpi();
  }
  function tkpiCurrentFiltered() {
    const recs = STORE.list(TKPI_STREAM);
    const teacher = $('#tkpi_teacher') ? $('#tkpi_teacher').value : '';
    const half = $('#tkpi_half') ? $('#tkpi_half').value : '';
    let list = recs;
    if (teacher) list = list.filter(r => r.dimension === teacher);
    if (half) list = list.filter(r => AGG.tkpiHalfLabel(r.year, r.month).label === half);
    return list;
  }

  // —— 导入（横表 Excel/CSV）——
  function importTKpi(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
        let headIdx = -1, colMap = null;
        for (let i = 0; i < Math.min(matrix.length, 60); i++) {
          const mm = mapTKpiHeader(matrix[i]);
          if (Object.keys(mm).length >= 3) { headIdx = i; colMap = mm; break; }
        }
        if (headIdx < 0) {
          showTKpiResult({ ok: 0, upd: 0, fail: 0, weekFallback: 0, dupFile: 0, errors: ['未识别到表头：请确认首行含「教师 / 1V1学员数 / 月度课次」等列名，或用「下载导入模板」生成的文件。'] });
          return;
        }
        const existing = new Set(STORE.list(TKPI_STREAM).map(r => r.year + '-' + r.month + '-' + r.dimension));
        const seen = new Set();
        let ok = 0, upd = 0, fail = 0, weekFallback = 0, dupFile = 0;
        const errors = [];
        const defYear = new Date().getFullYear();
        for (let i = headIdx + 1; i < matrix.length; i++) {
          const row = matrix[i];
          if (!row || !row.some(c => c != null && String(c).trim() !== '')) continue;
          const cell = c => (c != null ? row[c] : null);
          const teacher = cell(colMap.teacher);
          if (teacher == null || String(teacher).trim() === '') continue; // 空行 / 无教师行（模板公式行）跳过
          const tname = String(teacher).trim();
          const pm = tkpiParseMonth(cell(colMap.month), defYear);
          if (!pm) { fail++; errors.push('第' + (i + 1) + '行「' + tname + '」：月份无法识别（' + (cell(colMap.month) == null ? '空' : JSON.stringify(cell(colMap.month))) + '），请用 2026-03 格式'); continue; }
          if (pm.mo < 1 || pm.mo > 12) { fail++; errors.push('第' + (i + 1) + '行「' + tname + '」：月份 ' + pm.mo + ' 超出 1-12'); continue; }
          const vals = {};
          vals.subjectGroup = cell(colMap.subjectGroup) != null ? String(cell(colMap.subjectGroup)).trim() : '';
          const numCols = ['v1Students', 'v6Students', 'monthSessions', 'v1Sessions', 'stopCount', 'gradCount', 'refundCount', 'renewCount', 'evalSubjects'];
          let bad = null;
          numCols.forEach(k => {
            if (bad) return;
            const v = tkpiNum(cell(colMap[k]));
            if (v == null) { bad = '第' + (i + 1) + '行「' + tname + '」：' + (TKPI_HEADER_ALIAS[k] ? TKPI_HEADER_ALIAS[k][0] : k) + ' 不是有效数字（' + JSON.stringify(cell(colMap[k])) + '）'; return; }
            vals[k] = v;
          });
          if (bad) { fail++; errors.push(bad); continue; }
          const wk = tkpiWeekOfMonth(pm.y, pm.mo, colMap.weekSeq != null ? cell(colMap.weekSeq) : null);
          vals.weekSeq = wk || 4;
          if (!wk) weekFallback++;
          const q = (k, conv) => {
            const v = cell(colMap[k]);
            if (v == null || String(v).trim() === '') return null;
            return conv ? conv(v) : String(v).trim();
          };
          vals.examScore = q('examScore', tkpiNum);
          vals.examRank = q('examRank', tkpiNum);
          vals.examResult = q('examResult', null);
          vals.progressRate = q('progressRate', tkpiRatio);
          const key = pm.y + '-' + pm.mo + '-' + tname;
          if (seen.has(key)) dupFile++; else seen.add(key);
          const isNew = !existing.has(key);
          STORE.upsert({ stream: TKPI_STREAM, year: pm.y, month: pm.mo, week: 0, dimension: tname, values: vals, importedAt: Date.now() });
          if (isNew) ok++; else upd++;
        }
        showTKpiResult({ ok, upd, fail, weekFallback, dupFile, errors });
        renderKpi();
      } catch (err) {
        showTKpiResult({ ok: 0, upd: 0, fail: 0, weekFallback: 0, dupFile: 0, errors: ['文件解析失败：' + err.message] });
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function showTKpiResult(res) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay show';
    const parts = ['<span class="ok">新增 ' + res.ok + '</span>', '<span class="upd">更新 ' + res.upd + '</span>'];
    if (res.fail) parts.push('<span class="bad">失败 ' + res.fail + '</span>');
    let html = '<div class="modal"><div class="modal-head"><span>教师 KPI 导入结果</span><button class="modal-x" id="tkpiResX">×</button></div><div class="modal-body">';
    html += '<div class="import-summary">' + parts.join('') + '</div>';
    if (res.weekFallback) html += '<div class="import-note">' + res.weekFallback + ' 行未匹配到「月度数据源」当月周数，已按默认 4 周计算参考课次。</div>';
    if (res.dupFile) html += '<div class="import-note">' + res.dupFile + ' 行与文件内前面的行重复（教师+月份），以最后一行覆盖。</div>';
    if (res.errors.length) html += '<div class="import-err-title">失败明细：</div><div class="import-err-list">' + res.errors.map(x => '<div class="import-err-item">' + esc(x) + '</div>').join('') + '</div>';
    else html += '<div class="import-note ok-note">全部通过校验。</div>';
    html += '</div><div class="modal-foot"><button class="btn primary" id="tkpiResOk">知道了</button></div></div>';
    ov.innerHTML = html;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    $('#tkpiResX', ov).addEventListener('click', close);
    $('#tkpiResOk', ov).addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
  }

  // —— 模板下载 / 台账导出 ——
  function downloadTKpiTemplate() {
    const header = ['教师', '月份', '学科组', '1V1学员数', '1V6学员数', '总学员数', '月度课次', '周次', '参考课次', '月饱和度', '月度1V1课次', '月度周平均', '1V1停课人数', '1V1结课人数', '1V1退费人数', '1V1续费人数', '专业考分数', '专业考排名', '优秀/及格', '进步率', '参评单科数'];
    // 第2行为公式示例行（无教师名，导入时自动跳过）：派生列填写数据后自动计算
    const formulaRow = ['', '', '', '', '', '=D2+E2', '', '', '=IF(H2="","",H2*16)', '=IF(I2="","",G2/I2)', '', '=IF(OR(D2="",H2="",K2=""),"",K2*3/D2/H2)', '', '', '', '', '', '', '', '', ''];
    const note = [
      ['1. 每行 = 一位教师 × 一个月；「月份」建议 2026-03 格式（也支持 2026/3、2026年3月、202603、3月）。'],
      ['2. 第2行为公式示例行（无教师名，导入时自动跳过）：填好 B~E/G/H/K 列后，总学员数 / 参考课次 / 月饱和度 / 月度周平均 自动计算；导入时系统按同一口径重算。'],
      ['3. 「周次」可留空：导入时自动取「月度数据源」当月周数；该月无月度数据时默认按 4 周计算。'],
      ['4. 季度字段：专业考分数 / 专业考排名 / 优秀及格 / 参评单科数 仅 3、6、9、12 月填写；进步率 仅 1、4、6、11 月填写（35% 或 0.35 均可）。'],
      ['5. 重复导入同一「教师 + 月份」= 覆盖更新；同一文件内重复行以最后一行覆盖。'],
    ];
    exportSheets('教师KPI导入模板.xlsx', [
      { name: '教师KPI台账', header, rows: [formulaRow] },
      { name: '填写说明', header: ['说明'], rows: note },
    ]);
  }
  function exportTKpi(recs) {
    if (!recs.length) { toast('暂无数据可导出'); return; }
    const header = ['年', '月', '教师', '学科组', '总学员数', '1V1学员数', '1V6学员数', '月度课次', '周次', '参考课次', '月饱和度(%)', '月度1V1课次', '月度周平均', '1V1停课人数', '1V1结课人数', '1V1退费人数', '1V1续费人数', '专业考分数', '专业考排名', '优秀/及格', '进步率(%)', '参评单科数'];
    const rows = recs.slice().sort((a, b) => (a.year - b.year) || (a.month - b.month) || a.dimension.localeCompare(b.dimension, 'zh-CN')).map(r => {
      const d = AGG.tkpiMonthDerived(r.values), v = r.values;
      return [r.year, r.month, r.dimension, v.subjectGroup || '', d.totalStudents, v.v1Students || 0, v.v6Students || 0, v.monthSessions || 0, v.weekSeq || '', d.refSessions,
        d.saturation == null ? '' : +(d.saturation * 100).toFixed(2), v.v1Sessions || 0, d.weekAvg == null ? '' : +d.weekAvg.toFixed(2),
        v.stopCount || 0, v.gradCount || 0, v.refundCount || 0, v.renewCount || 0,
        v.examScore == null ? '' : v.examScore, v.examRank == null ? '' : v.examRank, v.examResult == null ? '' : v.examResult,
        v.progressRate == null ? '' : +(v.progressRate * 100).toFixed(2), v.evalSubjects || 0];
    });
    exportSheets('教师KPI台账.xlsx', [{ name: '教师KPI台账', header, rows }]);
  }

  // —— 页面渲染 ——
  function renderKpi() {
    migrateOldKpi();
    const recs = STORE.list(TKPI_STREAM);
    const teachers = [...new Set(recs.map(r => r.dimension))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const halfOpts = tkpiHalfOptions(recs);

    let html = '<div class="panel"><div class="panel-title">教师 KPI · 月度台账（教师个人维度）</div>';
    html += '<div class="panel-desc">每行 = 一位教师 × 一个月（横表导入）。总学员数 = 1V1学员数 + 1V6学员数；参考课次 = 周次 × 16；月饱和度 = 月度课次 ÷ 参考课次；月度周平均 = 月度1V1课次 × 3 ÷ 1V1学员数 ÷ 周次。专业考分数/排名/优秀及格/参评单科数 仅 3·6·9·12 月、进步率 仅 1·4·6·11 月填写。</div>';
    html += '<div class="row" style="margin-bottom:14px">';
    html += '<button class="btn primary" id="tkpi_import_btn">⬆ 导入 Excel/CSV</button>';
    html += '<button class="btn" id="tkpi_tpl_btn">⬇ 下载导入模板</button>';
    html += '<button class="btn" id="tkpi_export_btn">⬇ 导出台账（当前筛选）</button>';
    html += '<button class="btn ghost" id="tkpi_clear_btn">清空全部</button>';
    html += '<input type="file" id="tkpi_file" accept=".xlsx,.xls,.csv" hidden />';
    html += '</div>';
    html += '<div class="row" style="margin-bottom:4px">';
    html += '<div class="field"><label>教师</label><select id="tkpi_teacher"><option value="">全部教师</option>' + teachers.map(t => '<option>' + esc(t) + '</option>').join('') + '</select></div>';
    html += '<div class="field"><label>半年度</label><select id="tkpi_half"><option value="">全部月份</option>' + halfOpts.map(h => '<option>' + h.label + '</option>').join('') + '</select></div>';
    html += '</div>';
    html += '<div id="tkpi_chart_wrap"></div>';
    html += '<div id="tkpi_monthly_body"></div>';
    html += '</div>';

    html += '<div class="panel"><div class="panel-title">半年度汇总（上半年 = 3-8月；下半年 = 9-2月）</div>';
    html += '<div class="panel-desc">总/1V1/1V6学员数 = 半年内最新月份值；课次/参考课次/结课/退费/续费 = 累计；饱和度 = 累计课次 ÷ 累计参考课次；周平均/停课人数 = 各月平均；优秀/及格 = 两次专业考结果直接体现；进步率 = 两次进步率平均。半年内无数据的月份按 0 计。</div>';
    html += '<div class="row" style="margin-bottom:4px"><div class="field"><label>选择半年度</label><select id="tkpi_half_sel">' + halfOpts.map(h => '<option>' + h.label + '</option>').join('') + '</select></div></div>';
    html += '<div id="tkpi_half_body"></div></div>';

    $('#content').innerHTML = html;
    $('#tkpi_import_btn').addEventListener('click', () => $('#tkpi_file').click());
    $('#tkpi_file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importTKpi(f); e.target.value = ''; });
    $('#tkpi_tpl_btn').addEventListener('click', downloadTKpiTemplate);
    $('#tkpi_export_btn').addEventListener('click', () => exportTKpi(tkpiCurrentFiltered()));
    $('#tkpi_clear_btn').addEventListener('click', clearTKpi);
    $('#tkpi_teacher').addEventListener('change', renderTKpiMonthly);
    $('#tkpi_half').addEventListener('change', renderTKpiMonthly);
    $('#tkpi_half_sel').addEventListener('change', renderTKpiHalfBody);
    renderTKpiMonthly();
    renderTKpiHalfBody();
  }

  // 月度台账（含单教师趋势图）
  function renderTKpiMonthly() {
    const teacher = $('#tkpi_teacher').value;
    const half = $('#tkpi_half').value;
    const list = tkpiCurrentFiltered().map(r => ({ r, d: AGG.tkpiMonthDerived(r.values) }));
    list.sort((a, b) => (a.r.year - b.r.year) || (a.r.month - b.r.month) || a.r.dimension.localeCompare(b.r.dimension, 'zh-CN'));

    const wrap = $('#tkpi_chart_wrap');
    if (teacher && list.length >= 2) {
      wrap.innerHTML = '<div class="section-h">' + esc(teacher) + ' · 月度趋势</div><div class="chart-box" style="height:230px"><canvas id="tkpiChart"></canvas></div>';
      const labels = list.map(x => x.r.year + '/' + x.r.month);
      const mk = (label, data, color) => ({ label, data: data.map(v => v == null ? null : +(+v).toFixed(2)), borderColor: color, backgroundColor: 'transparent', tension: .3, fill: false, pointRadius: 3, pointBackgroundColor: color });
      drawLine('tkpiChart', labels, [
        mk('月度课次', list.map(x => x.r.values.monthSessions || 0), '#4F46E5'),
        mk('月度1V1课次', list.map(x => x.r.values.v1Sessions || 0), '#0ea5e9'),
        mk('月饱和度%', list.map(x => x.d.saturation == null ? null : x.d.saturation * 100), '#16a34a'),
        mk('1V1学员数', list.map(x => x.r.values.v1Students || 0), '#d97706'),
      ], '');
    } else wrap.innerHTML = '';

    let html = '';
    if (!list.length) html += '<div class="empty">暂无数据。点击「导入 Excel/CSV」批量导入，或先「下载导入模板」按格式填写。</div>';
    else {
      html += '<div class="table-wrap"><table><thead><tr><th>年</th><th>月</th><th>教师</th><th>学科组</th><th class="num">总学员数</th><th class="num">1V1学员数</th><th class="num">1V6学员数</th><th class="num">月度课次</th><th class="num">参考课次</th><th class="num">月饱和度</th><th class="num">月度1V1课次</th><th class="num">月度周平均</th><th class="num">1V1停课</th><th class="num">1V1结课</th><th class="num">1V1退费</th><th class="num">1V1续费</th><th class="num">专业考分数</th><th class="num">专业考排名</th><th>优秀/及格</th><th class="num">进步率</th><th class="num">参评单科数</th><th></th></tr></thead><tbody>';
      list.forEach(x => {
        const r = x.r, v = r.values, d = x.d;
        html += '<tr><td class="num">' + r.year + '</td><td class="num">' + r.month + '</td><td>' + esc(r.dimension) + '</td><td>' + esc(v.subjectGroup || '—') + '</td>' +
          '<td class="num">' + d.totalStudents + '</td><td class="num">' + fmt(v.v1Students) + '</td><td class="num">' + fmt(v.v6Students) + '</td>' +
          '<td class="num">' + fmt(v.monthSessions) + '</td><td class="num">' + d.refSessions + '</td><td class="num">' + pct(d.saturation) + '</td>' +
          '<td class="num">' + fmt(v.v1Sessions) + '</td><td class="num">' + fmt(d.weekAvg, 2) + '</td>' +
          '<td class="num">' + fmt(v.stopCount) + '</td><td class="num">' + fmt(v.gradCount) + '</td><td class="num">' + fmt(v.refundCount) + '</td><td class="num">' + fmt(v.renewCount) + '</td>' +
          '<td class="num">' + (v.examScore == null ? '—' : fmt(v.examScore)) + '</td><td class="num">' + (v.examRank == null ? '—' : fmt(v.examRank)) + '</td><td>' + esc(v.examResult || '—') + '</td>' +
          '<td class="num">' + pct(v.progressRate) + '</td><td class="num">' + (v.evalSubjects == null ? '—' : fmt(v.evalSubjects)) + '</td>' +
          '<td><button class="btn xs ghost" data-del="' + JSON.stringify([r.year, r.month, r.dimension]).replace(/"/g, '&quot;') + '">删</button></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    $('#tkpi_monthly_body').innerHTML = html;
    $all('#tkpi_monthly_body [data-del]').forEach(btn => btn.addEventListener('click', () => {
      const [y, m, name] = JSON.parse(btn.dataset.del);
      if (!confirm('删除 ' + name + ' ' + y + '-' + m + ' 这条记录？')) return;
      STORE.remove(TKPI_STREAM, +y, +m, 0, name);
      toast('已删除');
      renderKpi();
    }));
  }

  // 半年度汇总表
  function renderTKpiHalfBody() {
    const recs = STORE.list(TKPI_STREAM);
    const roster = [...new Set(recs.map(r => r.dimension))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const hy = AGG.tkpiHalfYear(recs);
    const opts = tkpiHalfOptions(recs);
    const sel = $('#tkpi_half_sel');
    if (!opts.length) { $('#tkpi_half_body').innerHTML = '<div class="empty">暂无数据，导入后自动生成半年度汇总。</div>'; return; }
    if (!sel.value || !opts.some(o => o.label === sel.value)) sel.value = opts[0].label;
    const cur = sel.value;
    const byKey = {};
    hy.forEach(h => { byKey[h.label + '|' + h.dimension] = h; });
    const cols = ['教师', '学科组', '总学员数', '1V1学员数', '1V6学员数', '累计课次', '累计参考课次', '饱和度', '周平均', '1V1停课(均)', '结课(累)', '退费(累)', '续费(累)', '优秀/及格(两次)', '进步率(均)'];
    let html = '<div class="table-wrap"><table><thead><tr><th>' + esc(cur) + '</th>' + cols.slice(1).map(t => '<th class="num">' + t + '</th>').join('') + '</tr></thead><tbody>';
    roster.forEach(name => {
      const h = byKey[cur + '|' + name];
      const v = h ? h.values : { totalStudents: 0, v1Students: 0, v6Students: 0, sessions: 0, refSessions: 0, saturation: null, weekAvg: 0, stopCount: 0, gradCount: 0, refundCount: 0, renewCount: 0, examResults: [], progressRate: 0, subjectGroup: '' };
      const examTxt = v.examResults.length ? v.examResults.map(x => x.m + '月 ' + x.r).join(' ｜ ') : '—';
      html += '<tr><td>' + esc(name) + '</td><td>' + esc(v.subjectGroup || '—') + '</td>' +
        '<td class="num">' + fmt(v.totalStudents) + '</td><td class="num">' + fmt(v.v1Students) + '</td><td class="num">' + fmt(v.v6Students) + '</td>' +
        '<td class="num">' + fmt(v.sessions) + '</td><td class="num">' + fmt(v.refSessions) + '</td><td class="num">' + pct(v.saturation == null ? 0 : v.saturation) + '</td>' +
        '<td class="num">' + fmt(v.weekAvg, 2) + '</td><td class="num">' + fmt(v.stopCount, 1) + '</td>' +
        '<td class="num">' + fmt(v.gradCount) + '</td><td class="num">' + fmt(v.refundCount) + '</td><td class="num">' + fmt(v.renewCount) + '</td>' +
        '<td>' + examTxt + '</td><td class="num">' + pct(v.progressRate) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    $('#tkpi_half_body').innerHTML = html;
  }

  // —— 五项满意度（核心看板子页签）——
  function renderSatDashboard() {
    const monthly = getMonthlyRecords();
    const data = AGG.satisfactionFromMonthEnd(monthly);
    let html = '<div class="row" style="margin-bottom:12px"><button class="btn sm" id="satExportBtn">⬇ 导出 Excel</button></div>';
    html += '<div class="section-h">五项满意度（月度，自动从月度周报提取）</div>';
    html += '<div class="panel-desc">取每月「月度周报」（月度数据体系）的月口径率：续费单科率 / 结课单科率 / 退费单科率 / 停课人数率 / 推荐单科率。</div>';
    if (!data.length) html += '<div class="empty">尚无月度周报数据。请先在「数据源」页从周报生成各月月度数据。</div>';
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
    $('#satExportBtn').addEventListener('click', () => exportSatDashboard(monthly));
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
            <div class="uc-sub">上传 DOS 周报（各周），自动按文件名/内容判定年·月·周并写入<b>周度数据</b>（用于「周报对比」）。系统会按文件名「第X周」或报表内「第几周/当月周数」自动判定周次，并预填到「默认周」；如判定有误，请在入库前直接修改「默认周」输入框。<b>月度数据无需在此上传</b>——校区层单一源头为周报，请在「月度数据」面板点「从周报生成月度数据」由周报显式派生。</div>
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

  function parseCmpFile(file, defYr, defMo, defWk, userSetWk) {
    const name = file.name || '';
    let year = defYr, month = defMo, week = defWk;
    let yearFromName = false, monthFromName = false;
    const ym = name.match(/(20\d{2})/); if (ym) { year = parseInt(ym[1], 10); yearFromName = true; }
    const mm = name.match(/(\d{1,2})\s*月/); if (mm) { const m = parseInt(mm[1], 10); if (m >= 1 && m <= 12) { month = m; monthFromName = true; } }
    const wm = name.match(/第\s*(\d+)\s*周/); if (wm) week = parseInt(wm[1], 10);
    return PARSER.parseWeekly(file, { year, month, week }).then(res => {
      const det = res.detected || {};
      // 周序号判定：
      // - 用户显式改过「默认周」输入框(userSetWk=true) → 以用户输入为准（权威覆盖，含月末周纠偏）；
      // - 否则自动推断优先级：文件名「第X周」> 报表 weekSeq > 月末周 totalWeeksOfMonth > 面板默认(inferPeriod)。
      //   面板默认(inferPeriod 的 ceil(日期/7)) 仅作最后兜底，月末报告不依赖它，避免被误算为第5周。
      let finalWeek;
      if (userSetWk) finalWeek = defWk;
      else if (wm) finalWeek = parseInt(wm[1], 10);
      else if (det.weekSeq != null) finalWeek = det.weekSeq;
      else if (det.isMonthEnd && det.totalWeeksOfMonth != null) finalWeek = det.totalWeeksOfMonth;
      else finalWeek = week;
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
    // 记录「默认周」初始值（面板渲染时的 inferPeriod 默认），用于判断用户是否显式改过周次
    const initWk = parseInt($('#cmpUWk').value, 10);

    fileInput.addEventListener('change', e => {
      files = [...(e.target.files || [])];
      if (!files.length) { listEl.innerHTML = ''; commitBtn.disabled = true; logEl.textContent = '尚未选择文件。'; pending = []; return; }
      listEl.innerHTML = files.map(f => '<div class="uc-file">📄 ' + f.name + '</div>').join('');
      commitBtn.disabled = true; pending = [];
      logEl.textContent = '已选 ' + files.length + ' 份，点「解析所选」预览。';
      // 若文件名含「第X周」，自动把「默认周」预填为该周次，减少手动改；用户仍可改输入框覆盖
      const wkFromName = files.map(f => { const m = (f.name || '').match(/第\s*(\d+)\s*周/); return m ? parseInt(m[1], 10) : null; }).find(x => x != null);
      if (wkFromName != null) { const wkEl = document.getElementById('cmpUWk'); if (wkEl) wkEl.value = wkFromName; }
    });

    parseBtn.addEventListener('click', () => {
      if (!files.length) { toast('请先选择文件'); return; }
      const defYr = parseInt($('#cmpUYr').value, 10);
      const defMo = parseInt($('#cmpUMo').value, 10);
      const defWk = parseInt($('#cmpUWk').value, 10);
      const userSetWk = defWk !== initWk; // 用户改过「默认周」→ 以用户输入为准；否则用自动推断
      logEl.textContent = '解析中…';
      Promise.all(files.map(f => parseCmpFile(f, defYr, defMo, defWk, userSetWk)
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
        // 仅写入周度数据(weekly 流)。月度数据由独立的「月度数据」上传入口单独手动上传，二者互不干扰。
        STORE.upsert({ stream: 'weekly', year: p.year, month: p.month, week: p.week, campus: v.campus || '泉山', values: v, rows: r.res.rows, importedAt: Date.now() });
        n++;
      });
      toast('已入库 ' + n + ' 份周报（仅写入周度数据）');
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

  // 清理异常周次：按 (campus,year,month) 分组，删除周序号 > 当月合理最大周数(legitMaxWeek) 的脏周报记录。
  // legitMaxWeek 以模板「当月周数」(totalWeeksOfMonth) 为权威上限，故误标为第5/6周的月末周报会被判定为脏数据并删除。
  function cleanupStrayWeeks() {
    const rs = CA.overrides.rawRecords('weekly');
    const groups = {};
    rs.forEach(r => { const k = (r.campus || '泉山') + '|' + r.year + '|' + r.month; (groups[k] = groups[k] || []).push(r); });
    const toRemove = [];
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      const legitMax = legitMaxWeek(g);
      g.forEach(r => { if ((r.week || 0) > legitMax) toRemove.push(r); });
    });
    if (!toRemove.length) { const n = $('#cleanupWkNote'); if (n) n.innerHTML = '<span class="ok-cell">未检测到异常周次，无需清理。</span>'; const d = $('#cleanupWkDetail'); if (d) { d.style.display = 'none'; d.innerHTML = ''; } return; }
    const detail = toRemove.map(r => '• ' + (r.campus || '泉山') + ' ' + r.year + '年' + r.month + '月 第' + (r.week || 0) + '周' + (r.values && r.values.v1Students != null ? '（1V1=' + r.values.v1Students + '）' : '')).join('<br>');
    if (!confirm('将删除以下 ' + toRemove.length + ' 条异常周次记录：\n\n' + toRemove.map(r => (r.campus || '泉山') + ' ' + r.year + '/' + r.month + ' 第' + (r.week || 0) + '周').join('\n') + '\n\n确认删除？（删除后可在周报对比上传面板以正确周次重新上传；正常周次不受影响）')) return;
    toRemove.forEach(r => STORE.remove('weekly', r.year, r.month, r.week, r.dimension || '_', r.campus));
    const n = $('#cleanupWkNote'); if (n) n.innerHTML = '<span class="ok-cell">已清理 ' + toRemove.length + ' 条异常周次。</span>';
    const d = $('#cleanupWkDetail'); if (d) { d.style.display = 'block'; d.innerHTML = '<b>已删除：</b><br>' + detail; }
    toast('已清理 ' + toRemove.length + ' 条异常周次');
    renderCmpCompare();
  }

  function renderCmpCompare() {
    const recs = CA.overrides.rawRecords('weekly'); // 原始上传清单（诊断 / 回填用）
    const monthly = getMonthlyRecords();
    const years = AGG.yearOptions(monthly);
    const yr = years.length ? Math.max(...years) : new Date().getFullYear();
    let html = '<div class="row" style="align-items:flex-end">';
    html += '<div class="field"><label>年份</label><select id="cmpYear">' + years.concat([yr]).filter((v, i, a) => a.indexOf(v) === i).map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>';
    html += '<button class="btn sm" id="cmpExportBtn">⬇ 导出 Excel</button>';
    html += '</div>';
    html += '<div id="cmpResult"></div>';
    // —— 数据修复：用已存储的原始行(rows)重新匹配，补回因大小写/缺映射而缺失的字段 ——
    html += '<div class="panel" style="margin-top:14px"><div class="panel-title">数据修复（字段匹配回填）</div>';
    html += '<div class="panel-desc">若早期上传的周报因字段名大小写（如 1V1/1v1、1V6/1v6）差异，或报表使用「生产课时」等写法导致部分字段未被解析（值为空），可点下方按钮：系统用每条记录上传时保留的原始行（rows）重新匹配字段并补回缺失项，<b>无需重新上传文件</b>；已有值不会被覆盖。</div>';
    html += '<div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><button class="btn" id="reparseBtn">⟳ 重新解析 / 回填缺失字段</button><button class="btn ghost" id="reparseForceBtn">强制重解析（覆盖已有值）</button><span class="preview-note" id="reparseNote"></span></div>';
    html += '<div id="reparseDetail" class="uc-log" style="margin-top:8px;display:none"></div></div>';
    // —— 清理异常周次：删除周序号超出当月合理周数(模板当月周数)的脏周报记录 ——
    html += '<div class="panel" style="margin-top:14px"><div class="panel-title">清理异常周次（误标脏数据）</div>';
    html += '<div class="panel-desc">若某月周报因上传时被误判为「第5/6周」（如月末周按日期推算错位），会污染「周报对比」并产生幻影周次、导致科组预测 1V1 人数取错。点下方按钮：系统按每月模板「当月周数」(totalWeeksOfMonth) 为上限，删除周序号超出的脏周报记录（安全：仅删超标周次，不删正常周次；删除前会列出将清理的项供确认）。</div>';
    html += '<div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><button class="btn warn" id="cleanupWkBtn">🧹 清理异常周次</button><span class="preview-note" id="cleanupWkNote"></span></div>';
    html += '<div id="cleanupWkDetail" class="uc-log" style="margin-top:8px;display:none"></div></div>';
    // —— 月度数据（由周报显式派生）管理面板 ——
    html += '<div class="panel" style="margin-top:18px"><div class="panel-title">月度数据（由周报显式派生）</div>';
    html += '<div class="panel-desc">月度数据 = 每月「最后一周」周报，是 <b>季度汇总 / 年度汇总 / 五项满意度 / 数据库视图</b> 的唯一数据来源。校区层单一源头为周报：点下方按钮，系统读取已入库的周报（weekly 流），自动取每月「月末周」（报表周次 weekSeq === 当月总周数 totalWeeksOfMonth）生成月度数据并写入，<b>无需再次手动上传文件</b>。重新上传周报后可再次点击以刷新。</div>';
    html += '<div class="row" style="align-items:center;gap:10px;flex-wrap:wrap">';
    html += '<button class="btn primary" id="deriveMonthlyBtn">⟳ 从周报生成月度数据</button>';
    html += '<button class="btn ghost" id="clearMonthlyBtn">清空月度数据</button>';
    html += '<span class="preview-note" id="monthlyCount"></span></div>';
    html += '<div class="uc-log" id="monthlyUploadLog">点击「从周报生成月度数据」：系统将基于已上传的周报自动派生各月月度数据（取每月月末周）。</div>';
    html += '<div id="monthlyList" style="margin-top:10px"></div></div>';
    // —— 数据关联对账（R3 双向哨兵）：校区层 ↔ 科组层 一致性 ——
    html += '<div class="panel" style="margin-top:18px"><div class="panel-title">数据关联对账（校区 ↔ 科组）</div>';
    html += '<div class="panel-desc">系统按「最近有数据的月份」自动核对：① 科组实际生产课时合计 ↔ 校区月度生产课时（来源：周报派生的月度数据）；② 校区生产总盘 C ↔ 科组预排课时合计。偏差超容差将告警，提示补录或核对；某侧数据缺失则跳过该条判定，不直接报错。</div>';
    html += '<div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><button class="btn" id="linkageCheckBtn">🔍 立即对账</button><span class="preview-note" id="linkageNote"></span></div>';
    html += '<div id="linkageResult" class="uc-log" style="margin-top:8px"></div></div>';
    html += compareUploadPanelHTML();
    $('#cmpBody').innerHTML = html;
    wireCompareUpload();
    renderMonthlyPanel();

    const yrSel = $('#cmpYear');
    $('#cmpExportBtn').addEventListener('click', () => { const y = parseInt(yrSel.value, 10); exportDataSource(monthly, y); });
    $('#clearMonthlyBtn').addEventListener('click', () => {
      if (!confirm('确认清空全部月度数据？此操作仅删除月度数据，不影响周报（周度）数据。')) return;
      STORE.list('monthly').forEach(r => STORE.remove('monthly', r.year, r.month, r.week, r.dimension));
      toast('已清空月度数据');
      renderCmpCompare();
    });
    wireDeriveMonthly();
    renderLinkageCheck();
    $('#linkageCheckBtn').addEventListener('click', renderLinkageCheck);
    // 清理异常周次（删除周序号超出当月合理周数的脏周报记录）
    $('#cleanupWkBtn').addEventListener('click', cleanupStrayWeeks);
    function draw() {
      const y = parseInt(yrSel.value, 10);
      if (!years.length) { $('#cmpResult').innerHTML = '<div class="empty">暂无数据。请先点上方「从周报生成月度数据」派生各月月度数据（校区层单一源头为周报）。</div>'; destroyChart('cmpChart'); return; }
      const cmp = AGG.compareYearStandard(monthly, y);
      renderCompareTable(cmp);
    }
    yrSel.addEventListener('change', draw);
    draw();
    // 数据修复：遍历 weekly/monthly 记录，用保留的 rows 重新匹配，补回缺失字段
    function doReparse(overwrite) {
      const r = reparseStoredData(overwrite);
      const note = $('#reparseNote');
      if (note) note.innerHTML = '已处理 <b>' + r.records + '</b> 条记录，补回 <b>' + r.fields + '</b> 个字段（' + r.added + ' 条有更新）' +
        (r.rekeyed ? '；<b class="ok-cell">' + r.rekeyed + ' 条已纠正周序号</b>（月末周报误存为第5周等已归位）' : '') +
        (r.noRows ? '；<span class="warn-cell">' + r.noRows + ' 条<b>无原始行</b>，无法回填（需重传文件）</span>' : '') +
        (r.withUnmatched ? '；<span class="warn-cell">' + r.withUnmatched + ' 条有<b>未匹配表头</b>（见下方明细）</span>' : '');
      // 诊断明细：列出有未匹配表头 / 无原始行的记录，便于定位缺映射 vs 缺原始行
      const box = $('#reparseDetail');
      if (box) {
        const bad = r.details.filter(d => !d.hasRows || d.unmatched.length);
        if (bad.length) {
          box.style.display = 'block';
          box.innerHTML = '<b>诊断明细（需关注 ' + bad.length + ' 条）</b><br>' + bad.map(d => {
            const tag = d.y + '年' + d.m + '月 第' + (d.w || 0) + '周 [' + d.stream + ']';
            if (!d.hasRows) return '• ' + tag + '：<span class="warn-cell">无原始行 rows，无法回填，需重传该文件</span>';
            return '• ' + tag + '：未匹配表头 → <code>' + d.unmatched.join('、') + '</code>';
          }).join('<br>');
        } else if (box) { box.style.display = 'none'; box.innerHTML = ''; }
      }
      toast('回填完成：' + r.records + ' 条记录，补回 ' + r.fields + ' 个字段');
      renderCmpCompare();
    }
    $('#reparseBtn').addEventListener('click', () => {
      if (!confirm('将用各记录上传时保留的原始行重新匹配字段，补回缺失项（已有值不覆盖）。是否继续？')) return;
      doReparse(false);
    });
    $('#reparseForceBtn').addEventListener('click', () => {
      if (!confirm('将用原始行<b>重新解析并覆盖</b>所有字段（含已有值），用于旧数据解析存在偏差的情况。是否继续？')) return;
      doReparse(true);
    });
  }

  // 用已存储记录中的 rows 重新匹配字段，补回缺失值。
  // overwrite=true 时覆盖已有值（用于旧数据解析存在偏差的整体重解析）；否则只补缺失(null)项。
  // 直接修复老构建上传、因大小写/缺映射而缺失字段的历史数据，无需重传文件。
  // 返回明细：每条记录是否保留原始行、哪些原始表头未匹配（用于区分「缺映射」vs「缺原始行」）。
  function reparseStoredData(overwrite) {
    let records = 0, fields = 0, added = 0, noRows = 0, withUnmatched = 0, rekeyed = 0;
    const details = [];
    ['weekly', 'monthly'].forEach(stream => {
      CA.overrides.rawRecords(stream).forEach(r => {
        records++;
        if (!r.rows || !r.rows.length) {
          // 无原始行：若 values 中已有 weekSeq 且与入库 week 不符，仍可直接重定周（提升修复覆盖率）
          if (stream === 'weekly' && r.values && r.values.weekSeq != null && r.values.weekSeq !== r.week) {
            STORE.remove('weekly', r.year, r.month, r.week, r.dimension, r.campus);
            STORE.upsert(Object.assign({}, r, { week: r.values.weekSeq }));
            rekeyed++;
            details.push({ y: r.year, m: r.month, w: r.values.weekSeq, stream, hasRows: true, unmatched: [] });
            return;
          }
          noRows++; details.push({ y: r.year, m: r.month, w: r.week, stream, hasRows: false, unmatched: [] }); return;
        }
        const res = CA.parser.reparseRows(r.rows);
        const existing = r.values || {};
        let changed = false;
        Object.keys(res.values).forEach(k => {
          if (overwrite || existing[k] == null) {
            if (existing[k] !== res.values[k]) { existing[k] = res.values[k]; fields++; changed = true; }
          }
        });
        // 周序号纠正（仅 weekly 流）：报表 weekSeq 与入库 week 不符时，以 weekSeq 重新定周，
        // 修复被 ceil(日期/7) 误算的幻影周（如月末周报误存为「第5周」）。目标周已存在则覆盖（月末周权威）。
        if (stream === 'weekly' && res.values.weekSeq != null && res.values.weekSeq !== r.week) {
          STORE.remove('weekly', r.year, r.month, r.week, r.dimension, r.campus);
          STORE.upsert(Object.assign({}, r, { week: res.values.weekSeq, values: existing }));
          rekeyed++;
          details.push({ y: r.year, m: r.month, w: res.values.weekSeq, stream, hasRows: true, unmatched: (res.unmatched || []).filter(Boolean) });
          return;
        }
        if (changed) { STORE.upsert(Object.assign({}, r, { values: existing })); added++; }
        const um = (res.unmatched || []).filter(Boolean);
        if (um.length) withUnmatched++;
        details.push({ y: r.year, m: r.month, w: r.week, stream, hasRows: true, unmatched: um });
      });
    });
    return { records, fields, added, noRows, withUnmatched, rekeyed, details };
  }

  // 月度数据面板：展示 monthly 流清单与计数（独立体系，与 weekly 流无关）
  function renderMonthlyPanel() {
    const list = STORE.list('monthly');
    const cnt = $('#monthlyCount');
    if (cnt) cnt.innerHTML = '当前月度数据：<b>' + list.length + '</b> 条' + (list.length ? '（年份：' + [...new Set(list.map(r => r.year))].sort((a, b) => a - b).join('、') + '）' : '（请点上方「从周报生成月度数据」）');
    const box = $('#monthlyList');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="preview-note">尚无月度数据。请在下方「历史周报批量入库」上传各月周报，再点上方「从周报生成月度数据」即可自动派生（取每月月末周）。</div>'; return; }
    const rows = list.slice().sort((a, b) => (a.year - b.year) || (a.month - b.month)).map(r => {
      const c = CA.aggregate.monthCashOf(r);
      // 每条记录自查：原始行是否保留 + 哪些表头未匹配（区分「缺映射」vs「缺原始行」）
      let diag = '';
      if (!r.rows || !r.rows.length) {
        diag = '<span class="warn-cell">无原始行（早期版本上传，无法回填，需重传）</span>';
      } else {
        const um = r.rows.map(x => x.label).filter(lab => !CA.parser.matchWeeklyLabel(lab));
        if (um.length) diag = '<span class="warn-cell">未匹配表头：' + um.join('、') + '</span>';
      }
      const diagHtml = diag ? '<tr class="diag-row"><td colspan="4" style="font-size:12px;color:#71717a;border-top:1px dashed #e4e4e7">' + diag + '</td></tr>' : '';
      return '<tr><td>' + r.year + '年' + r.month + '月</td><td>' + (r.campus || '') + '</td><td class="num">' + (c != null ? fmt(c) : '—') + '</td><td>' + (r.sourceWeek != null ? '第' + r.sourceWeek + '周' : '—') + '</td></tr>' + diagHtml;
    }).join('');
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>年月</th><th>校区</th><th class="num">月课时生产总现金</th><th>来源周</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // 月度数据 = 周报月末周，由周报【显式派生】（校区层单一源头 = DOS 周报）。
  // 「从周报生成月度数据」按钮：读取已入库周报(weekly 流)，取每月月末周(weekSeq===totalWeeksOfMonth)
  // 生成月度数据写入 monthly 流，带生成日志（可审计、可重跑）。不再提供手动上传入口。
  function wireDeriveMonthly() {
    const btn = $('#deriveMonthlyBtn');
    const logEl = $('#monthlyUploadLog');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const weekly = CA.overrides.rawRecords('weekly'); // 派生应基于原始周报（weekSeq 口径）
      if (!weekly.length) { toast('尚无周报数据，请先在下方「历史周报批量入库」上传 DOS 周报'); return; }
      const derived = AGG.materializeMonthlyFromWeekly(weekly);
      if (!derived.length) {
        const msg = '未从周报中检测到任何「月末周」（需报表含 weekSeq / totalWeeksOfMonth 周次字段）。请确认周报已上传且包含周次信息。';
        if (logEl) logEl.textContent = msg;
        toast(msg);
        return;
      }
      const preview = CA.store.previewUpsert(derived);
      derived.forEach(materializeMonthly);
      let log = '已生成 <b>' + derived.length + ' 条月度数据（覆盖 ' + preview.overwrite.length + ' 条、新增 ' + preview.insert.length + ' 条）。各月来源：<br/>';
      log += derived.slice().sort((a, b) => (a.year - b.year) || (a.month - b.month)).map(r =>
        '• ' + r.year + '年' + r.month + '月 ← 周报第 ' + (r.sourceWeek != null ? r.sourceWeek : '?') + ' 周' +
        (r.campus && r.campus !== '泉山' ? '（' + r.campus + '）' : '')
      ).join('<br/>');
      if (logEl) logEl.innerHTML = log;
      toast('从周报生成月度数据完成：' + derived.length + ' 条');
      renderCmpCompare();
    });
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
    html += '<div class="preview-note">说明：年度各月对比按模板《数据统计表》sheet1 第一列字段顺序，原样展示各月「月度周报」的月度原数据字段，保持与数据源报表一致的排列顺序；某月未出现的项留空。</div>';
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

  // 核心看板子页：科组生产预测（用已完成月数据，预测下月指标）
  // 根据当前日期，按"自然周(周一至周日)+人工月"规则推算 X月第X周
  // 规则：自然月最后一天若在周一/周二 -> 该周归新月份(本月止于上一周日)；
  //       若在周三及之后 -> 该周归本月(止于本周日)。周日即月度最后一天。
  // 人工月最后一天（自然周周日）：自然月最后一天若在当周周二及之前则归上月，周三及之后归本月
  function currentManualWeek(date) {
    const mm = AGG.manualMonthOf(date);
    let pY = mm.year, pm0 = mm.month - 1; if (pm0 < 1) { pm0 = 12; pY = mm.year - 1; }
    const prevML = AGG.manualLastDay(pY, pm0);
    const MS = new Date(prevML.getFullYear(), prevML.getMonth(), prevML.getDate() + 1); // 人工月首周一
    const dayDiff = Math.round((date - MS) / 86400000);
    return { year: mm.year, month: mm.month, week: Math.floor(dayDiff / 7) + 1 };
  }

  // 预测月 = 参考月 + 1（跨年归到次年 1 月）。模块级共享，renderKezuTargetDash 与 renderTarget 均使用。
  function predMonth(y, m) { let mm = m + 1, yy = y; if (mm > 12) { mm = 1; yy += 1; } return { year: yy, month: mm }; }

  // 「科组生产预测」相关模块（核心看板 / 科组生产指标）共用的助手，提升为模块级以避免重复实现
  const num = x => (typeof x === 'number' && isFinite(x)) ? x : (parseFloat(x) || 0);
  function kezuMonths() {
    const set = {};
    STORE.list('bestkezu').forEach(r => { if (r.year && r.month) set[r.year * 12 + r.month] = { year: r.year, month: r.month }; });
    return Object.values(set).sort((a, b) => (a.year - b.year) || (a.month - b.month));
  }
  function loadMonth(y, m) {
    const recs = STORE.list('bestkezu').filter(r => r.year === y && r.month === m);
    if (!recs.length) return null;
    return recs.map(r => { const v = r.values || {}; return { name: r.dimension || '未命名', s: num(v.subjects), h: num(v.hours), w: num(v.weeks) || 4 }; });
  }
  // —— 数据关联对账（R3 双向哨兵）渲染 ——
  function renderLinkageCheck() {
    const box = $('#linkageResult');
    const note = $('#linkageNote');
    if (!box) return;
    // 取最近有数据的月份（优先 monthly，其次 kezuActual/kezuTargetC 的最近月）
    const monthly = getMonthlyRecords();
    const kezuA = STORE.list('kezuActual');
    const targetC = STORE.list('kezuTargetC');
    const ymFrom = arr => arr.map(r => ({ y: r.year, m: r.month }));
    const all = [...ymFrom(monthly), ...ymFrom(kezuA), ...ymFrom(targetC)]
      .sort((a, b) => (b.y - a.y) || (b.m - a.m));
    if (!all.length) {
      box.innerHTML = '<div class="preview-note">尚无可用于对账的数据（需先有月度数据或科组生产数据）。</div>';
      if (note) note.textContent = '';
      return;
    }
    const { y, m } = all[0];
    const res = AGG.linkageCheck('泉山', y, m);
    if (!res.hasData) {
      box.innerHTML = '<div class="preview-note">尚无可用于对账的数据。</div>';
      if (note) note.textContent = '';
      return;
    }
    const fmt = v => (v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString());
    let html = '<b>' + y + '年' + m + '月</b> 关联对账：<br/>';
    html += '<table><thead><tr><th>对账项</th><th>科组侧</th><th>校区侧</th><th>判定</th></tr></thead><tbody>';
    res.checks.forEach(c => {
      const tag = c.ok === true ? '<span class="tag ok">✓ 一致</span>'
        : c.ok === false ? '<span class="tag warn">⚠ 不一致</span>'
        : '<span class="tag">— 校区侧缺数据</span>';
      html += '<tr><td>' + c.name + '</td><td class="num">' + fmt(c.kezuVal) + '</td><td class="num">' + fmt(c.campusVal) + '</td><td>' + tag + '</td></tr>';
    });
    html += '</tbody></table>';
    const verdict = res.ok === true ? '<span class="tag ok">全部一致</span>'
      : res.ok === false ? '<span class="tag warn">存在差异，请核对补录</span>'
      : '<span class="tag">部分缺失，仅做可用项比对</span>';
    box.innerHTML = html + '<div style="margin-top:6px">结论：' + verdict + '</div>';
    if (note) note.innerHTML = '已对 ' + y + '年' + m + '月 完成关联对账';
  }

  function dataSourceProd(y, m) {
    const me = getMonthlyRecords();
    const rec = me.find(r => r.year === y && r.month === m);
    if (!rec) return null;
    const v = rec.values && rec.values.v1MonthProduced;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // —— 两套数据源体系：月度数据(monthly 流) 的获取 ——
  // 月度数据 = 每月最后一周周报，是 季度/年度/满意度/数据库视图/科组月度跟踪 的唯一来源。
  // 周度数据(weekly 流) 仅用于「周报对比」，与此体系相互独立、互不干扰。
  // 月度数据 = 每月最后一周周报，由周报显式派生（见 wireDeriveMonthly）写入 monthly 流；
  // 是季度/年度/满意度/数据库视图的唯一来源，与 weekly 流相互独立。
  function getMonthlyRecords() {
    return STORE.list('monthly');
  }
  // 将派生得到的月度记录写入 monthly 流（year-month-week0 为主键，与 weekly 流互不干扰）
  function materializeMonthly(rec) {
    STORE.upsert({
      stream: 'monthly', campus: (rec.campus || '泉山'), year: rec.year, month: rec.month, week: 0, dimension: '_',
      values: rec.values, rows: rec.rows || null, importedAt: Date.now(), sourceWeek: rec.sourceWeek,
    });
  }

  function renderKezuTargetDash() {
    function actualSummary(py, pm, uptoWeek) {
      const actuals = STORE.list('kezuActual').filter(r => r.year === py && r.month === pm);
      let campusActual = 0, campusSched = 0, hasData = false;
      actuals.forEach(r => {
        const w = +r.week || 0;
        if (uptoWeek == null || w <= uptoWeek) {
          campusActual += num(r.values && r.values.produced);
          campusSched += num(r.values && r.values.scheduled);
          hasData = true;
        }
      });
      return { campusActual, campusSched, hasData };
    }

    const months = kezuMonths();
    // 月份推进：以当前日期(人工月)为锚（AGG.kezuTargetFrame），预测月自动指向当前人工月，
    // 参考月 = bestkezu 中「≤ 上一个人工月」的最近数据月；数据滞后/缺失时给出补录指引。
    // 不再使用硬编码兜底 {year:2026,month:7}，也不再仅依赖「bestkezu 最新月 + 1」导致预测停在过期月份。
    const frame = AGG.kezuTargetFrame(months, new Date());
    const state = { C: loadTargetC(1000), year: 0, month: 0 };
    if (frame.ref) { state.year = frame.ref.year; state.month = frame.ref.month; }
    else if (months.length) { state.year = months[months.length - 1].year; state.month = months[months.length - 1].month; }

    $('#dashBody').innerHTML =
      '<div class="panel"><div class="panel-title">科组生产预测（下月指标）</div>' +
      '<div class="panel-desc">底层逻辑：用<b>已完成月份</b>（参考月份）的最佳科组数据，预测<b>下个月</b>（预测月份）的生产指标。预测目标月随当前日期自动推进到<b>当前人工月</b>；月度数据完成后，在此输入校区生产指标即可一键获得各科的预测下达值。</div>' +
      '<div id="dtFrameNote" class="field-note" style="margin-bottom:10px"></div>' +
      '<div class="grid grid-3" style="margin-bottom:10px">' +
        '<div class="field"><label>校区生产指标（总盘 C）</label><input type="number" id="dtC" class="mono" min="0" step="any" value="' + state.C + '"></div>' +
        '<div class="field"><label>参考月份（已完成月）</label><select id="dtMonthSel" class="mono"></select></div>' +
        '<div class="field"><label>预测月份</label><input type="text" id="dtPred" class="mono" readonly></div>' +
      '</div>' +
      '<div id="dtConsist" class="field-note"></div>' +
      '<div id="dtResult"></div></div>';

    function fillMonths() {
      const ys = [...new Set(months.map(m => m.year))];
      if (!ys.includes(state.year) && ys.length) state.year = ys[ys.length - 1];
      const ms = months.filter(m => m.year === state.year).map(m => m.month);
      if (!ms.includes(state.month) && ms.length) state.month = ms[ms.length - 1];
      $('#dtMonthSel').innerHTML = months.map(m => '<option value="' + m.year + '-' + m.month + '"' + (m.year === state.year && m.month === state.month ? ' selected' : '') + '>' + m.year + ' 年 ' + m.month + ' 月</option>').join('');
    }

    function draw() {
      const depts = loadMonth(state.year, state.month);
      if (!depts) {
        $('#dtPred').value = '';
        $('#dtConsist').innerHTML = '';
        $('#dtResult').innerHTML = (state.year ? '<div class="empty">「最佳科组」' + state.year + ' 年 ' + state.month + ' 月 暂无数据，无法预测。请先在「最佳科组」模块上传该月数据，或切换到有数据的参考月份。</div>' : '<div class="empty">暂无「最佳科组」数据。请先在「最佳科组」模块上传数据（参考上方提示的应上传月份），系统将自动生成科组生产预测。</div>');
        return;
      }
      const pm = predMonth(state.year, state.month);
      const predWeeks = AGG.manualMonthWeekCount(pm.year, pm.month);
      depts.forEach(d => { d.w = predWeeks; }); // 周数取【预测月】实际自然周数，不再沿用参考月
      $('#dtPred').value = pm.year + ' 年 ' + pm.month + ' 月';
      const res = computeKezuTarget(depts, state.C);
      const { S, H, rows, commonW, sumFinal, completion, achieved, Gcfg } = res;

      // 当前 1V1 人数 = 数据源中最新一周（year/month/week 最大）的「1v1在读学员」
      const latestV1 = (function () {
        const rs = STORE.list('weekly');
        if (!rs.length) return null;
        // 最新数据月（year/month 最大）
        let latestKey = -1, latestY = 0, latestM = 0;
        rs.forEach(r => { const k = (r.year || 0) * 100 + (r.month || 0); if (k > latestKey) { latestKey = k; latestY = r.year || 0; latestM = r.month || 0; } });
        const monthRecs = rs.filter(r => r.year === latestY && r.month === latestM);
        // 过滤异常周次（week 超出当月合理最大周数），优先取月末周(weekSeq===totalWeeksOfMonth)
        const legitMax = legitMaxWeek(monthRecs);
        const cand = monthRecs.filter(r => (r.week || 0) <= legitMax);
        const pool = cand.length ? cand : monthRecs;
        let best = null;
        pool.forEach(r => {
          const key = (r.year || 0) * 10000 + (r.month || 0) * 100 + (r.week || 0);
          const isME = r.values && r.values.weekSeq != null && r.values.totalWeeksOfMonth != null && r.values.weekSeq === r.values.totalWeeksOfMonth;
          const score = key + (isME ? 0.5 : 0); // 月末周优先
          if (!best || score > best.score) best = { score, v: (r.values && r.values.v1Students != null) ? num(r.values.v1Students) : null };
        });
        return best ? best.v : null;
      })();

      const src = dataSourceProd(state.year, state.month);
      let consistHtml;
      if (src == null) consistHtml = '<span class="tag warn">数据源无该月周报</span> <span class="preview-note">「1v1 月生产课时」校验需上传该月 DOS 周报。</span>';
      else { const diff = H - src, ok = Math.abs(diff) < 1; consistHtml = '最佳科组课时合计 <b>' + fmt(H) + '</b>　vs　数据源 1v1 月生产课时 <b>' + fmt(src) + '</b>　<span class="tag ' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓ 一致' : '⚠ 不一致') + '</span>'; }
      $('#dtConsist').innerHTML = consistHtml;

      // 报告周 = 已完成的周（当前周未结束则取上一周；周日为当周最后一天）
      const today = new Date();
      const cw = currentManualWeek(today);
      let reportWeek = 0;
      if (cw.year === pm.year && cw.month === pm.month) {
        // 今天落在本预测月内：未到周日则本周未完成，取上一周
        reportWeek = (today.getDay() === 0) ? cw.week : Math.max(1, cw.week - 1);
      } else {
        const pmEnd = AGG.manualLastDay(pm.year, pm.month);
        if (today > pmEnd) reportWeek = currentManualWeek(pmEnd).week; // 预测月已结束→全部周完成
      }
      // 完成率：按已完成周实产；差距课时：固定减去「整月已预排」（不再随日期按已完成周漂移）
      const done = actualSummary(pm.year, pm.month, reportWeek);
      const whole = actualSummary(pm.year, pm.month, null);
      const campusActual = done.campusActual;
      const campusSched = whole.campusSched;
      const hasData = whole.hasData;
      const actRate = sumFinal > 0 ? campusActual / sumFinal : 0;
      // 校区生产差距课时 = 生产指标（对应 G 档）− 整月已预排总数据
      const gapG1 = state.C - campusSched;
      const gapG2 = state.C * 1.10 - campusSched;
      const gapG3 = state.C * 1.25 - campusSched;
      const gapText = v => v <= 0 ? '<span class="tag ok">已达成</span>' : '<span class="num" style="font-weight:600">' + fmt(v) + '</span>';

      const weekLabel = reportWeek > 0 ? (pm.month + '月第' + reportWeek + '周完成率') : '本周完成率';
      let h = '<div class="stat-grid" style="margin:6px 0 14px">' +
        '<div class="stat-card"><div class="k">校区生产指标 C</div><div class="v">' + fmt(state.C) + '</div></div>' +
        '<div class="stat-card"><div class="k">当前1V1人数</div><div class="v">' + (latestV1 != null ? fmt(latestV1) + ' 人' : '<span class="muted">—</span>') + '</div></div>' +
        '<div class="stat-card"><div class="k">校区生产 G2 指标</div><div class="v" style="color:#7c3aed">' + fmt(state.C * 1.10) + '</div></div>' +
        '<div class="stat-card"><div class="k">校区生产 G3 指标</div><div class="v" style="color:#4F46E5">' + fmt(state.C * 1.25) + '</div></div>' +
        '<div class="stat-card"><div class="k">' + weekLabel + '</div><div class="v" style="color:var(--indigo)">' + (hasData ? pct(actRate) : '<span class="muted">—</span>') + '</div></div>' +
        '<div class="stat-card"><div class="k">校区生产 G1 差距课时</div><div class="v">' + (hasData ? gapText(gapG1) : '<span class="muted">—</span>') + '</div></div>' +
        '<div class="stat-card"><div class="k">校区生产 G2 差距课时</div><div class="v">' + (hasData ? gapText(gapG2) : '<span class="muted">—</span>') + '</div></div>' +
        '<div class="stat-card"><div class="k">校区生产 G3 差距课时</div><div class="v">' + (hasData ? gapText(gapG3) : '<span class="muted">—</span>') + '</div></div>' +
        '</div>';

      const maxW = Math.max(...rows.map(r => r.w), 0);
      const actuals = STORE.list('kezuActual').filter(r => r.year === pm.year && r.month === pm.month);
      const trackTable = maxW > 0
        ? kezuTargetWideTableHTML(res, actuals, state.C)
        : '<div class="preview-note">请先在「科组生产指标」中确认科组周数，再上传实际数据生成汇总表。</div>';
      const hasTrack = maxW > 0 && actuals.length > 0;
      h += '<div id="dtExportWrap">' +
        '<div class="section-h-flex">' +
          '<div class="section-h">科组月度汇总（按周展开）</div>' +
          (hasTrack ? '<button class="btn sm" id="dtExportImg">⬇ 导出图片</button>' : '') +
        '</div>' +
        '<div id="dtTrackPanel">' + trackTable + '</div>' +
      '</div>';
      $('#dtResult').innerHTML = h;
      if (hasTrack) {
        $('#dtExportImg').addEventListener('click', () => {
          const btn = $('#dtExportImg'); if (btn) btn.style.visibility = 'hidden';
          exportElementImage('#dtExportWrap', '科组月度汇总_' + pm.year + '_' + pm.month + '.png').then(() => { if (btn) btn.style.visibility = ''; });
        });
      }
    }

    fillMonths();
    draw();
    // 目标帧提示：正常时轻提示；数据滞后/缺失时醒目告知"当前已是哪个月、缺哪个月数据、如何自动推进"
    const fnEl = $('#dtFrameNote');
    if (fnEl && frame.note) {
      fnEl.innerHTML = frame.state === 'ok'
        ? '<span class="muted">' + esc(frame.note) + '</span>'
        : '<span style="color:#b45309;font-weight:600">⚠ ' + esc(frame.note) + '</span>';
    }
    // 初始化时就把当前 C（含默认值）同步到 store，避免用户未修改直接推送时丢失
    persistTargetC(state.C);

    $('#dtC').addEventListener('input', e => { state.C = parseFloat(e.target.value) || 0; persistTargetC(state.C); draw(); });
    $('#dtMonthSel').addEventListener('change', e => { const p = e.target.value.split('-'); state.year = +p[0]; state.month = +p[1]; draw(); });
  }

  function renderDashboard() {
    let html = '<div class="panel"><div class="panel-title">核心数据看板</div>';
    html += '<div class="panel-desc">基于《年度数据统计标准》和《季度数据统计标准》汇总，以仪表盘形式直观呈现年度核心指标和各季度对比趋势。数据源为各月「月度周报」。</div>';
    html += '<div class="dash-tabs"><button class="dash-tab active" data-sub="year">年度汇总数据看板</button><button class="dash-tab" data-sub="quarter">季度汇总数据对比看板</button><button class="dash-tab" data-sub="weekly">周报对比</button><button class="dash-tab" data-sub="sat">五项满意度</button><button class="dash-tab" data-sub="kezu">最佳科组排名</button><button class="dash-tab" data-sub="target">科组生产预测</button></div>';
    html += '<div id="dashBody"></div></div>';
    $('#content').innerHTML = html;
    $all('.dash-tab').forEach(b => b.addEventListener('click', () => {
      $all('.dash-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.sub === 'year') renderYearDashboard();
      else if (b.dataset.sub === 'quarter') renderQuarterDashboard();
      else if (b.dataset.sub === 'kezu') renderKezuRankDashboard();
      else if (b.dataset.sub === 'target') renderKezuTargetDash();
      else if (b.dataset.sub === 'weekly') renderWeeklyCompareDashboard();
      else renderSatDashboard();
    }));
    renderYearDashboard();
  }

  function renderYearDashboard() {
    const recs = STORE.list('weekly');
    const monthly = getMonthlyRecords();
    const years = AGG.yearOptions(monthly);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「数据源」页从周报生成各月月度数据（校区层单一源头为周报）。</div>'; return; }
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
      const yd = AGG.yearlyAggregate(recs, y, monthly);
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
      const me = monthly.filter(r => r.year === y).sort((a, b) => a.month - b.month);
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
        const cashData = me.map(r => { const c = CA.aggregate.monthCashOf(r); return (c != null && c !== 0) ? c : null; });
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
    const monthly = getMonthlyRecords();
    const years = AGG.yearOptions(monthly);
    if (!years.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「数据源」页从周报生成各月月度数据（校区层单一源头为周报）。</div>'; return; }
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
      const qAll = AGG.quarterlyAggregate(recs, monthly).filter(x => x.year === y).sort((a, b) => a.quarter - b.quarter);
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

  // —— 核心看板 · 周报对比（某月各周横向对比，数据源于数据源 DOS 周报）——
  function renderWeeklyCompareDashboard() {
    const recs = STORE.list('weekly');
    if (!recs.length) { $('#dashBody').innerHTML = '<div class="empty">暂无数据。请先在「数据源」入库 DOS 周报（各周）。</div>'; return; }
    // 可用月份（周报按自然月存储，故以自然月为选择维度）
    const set = {}, months = [];
    recs.forEach(r => { const k = r.year + '-' + r.month; if (!set[k]) { set[k] = true; months.push({ year: r.year, month: r.month }); } });
    months.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    const now = new Date();
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    const hasCur = months.some(m => m.year === cur.year && m.month === cur.month);
    // 默认：优先当前月份（若有数据），否则取最新有数据的月份，避免停留在过期月份
    const def = hasCur ? cur : months[months.length - 1];
    const curLabel = cur.year + '年' + cur.month + '月';
    const latestLabel = months.length ? (months[months.length - 1].year + '年' + months[months.length - 1].month + '月') : '—';
    const monthNote = hasCur
      ? '当前月份：<b>' + curLabel + '</b>（已显示）'
      : '当前月份：<b>' + curLabel + '</b>；最新数据：<b>' + latestLabel + '</b>（已显示，可在上方切换）';
    let html = '<div class="row" style="margin-bottom:16px;align-items:flex-end"><div class="field"><label>月份（当前 ' + curLabel + '）</label><select id="wcMonth">' +
      months.map(m => '<option value="' + m.year + '-' + m.month + '"' + (m.year === def.year && m.month === def.month ? ' selected' : '') + '>' + m.year + '年' + m.month + '月</option>').join('') + '</select></div>' +
      '<div class="preview-note" style="margin-left:8px">数据来源：周度数据（DOS 周报）。' + monthNote + '。仅做该月各周度数据横向对比——周度数据只关联本页，不进入月度 / 季度 / 年度 / 满意度计算。</div></div>';
    html += '<div id="wcResult"></div>';
    $('#dashBody').innerHTML = html;
    $('#wcMonth').addEventListener('change', draw);

    function draw() {
      const [yy, mm] = $('#wcMonth').value.split('-').map(Number);
      let wkRecs = recs.filter(r => r.year === yy && r.month === mm).sort((a, b) => (a.week || 0) - (b.week || 0));
      if (!wkRecs.length) { $('#wcResult').innerHTML = '<div class="empty">该月暂无周报数据。</div>'; return; }
      // 过滤异常周次（周序号超出当月合理最大周数，如月末周被误标为第5/6周），避免幻影周次干扰对比；
      // 若全部为异常周次则退化为展示全部，保证不空白。
      const legitMax = legitMaxWeek(wkRecs);
      const stray = wkRecs.filter(r => (r.week || 0) > legitMax);
      const clean = wkRecs.filter(r => (r.week || 0) <= legitMax);
      const wkDisp = clean.length ? clean : wkRecs;
      const strayNote = stray.length ? '<div class="warn" style="margin-bottom:10px">⚠ 检测到 ' + stray.length + ' 条异常周次（第' + stray.map(r => r.week).join('、') + '周，超出当月合理周数 ' + legitMax + '），已隐藏。可在「数据源 → 清理异常周次」删除。</div>' : '';
      wkRecs = wkDisp;
      const weeks = wkRecs.map(r => '第' + (r.week || '?') + '周');
      const keys = ['teacherCount', 'campusTotal', 'coreTeacherCount', 'doubleThreeCount', 'v1Students', 'v1Subjects', 'v6Students', 'v6Subjects',
        'v1WeekTarget', 'v1WeekProduced', 'v1WeekRate', 'v6WeekProduced', 'weekCashTotal', 'v1WeekCash', 'v6WeekCash',
        'weekEff', 'weekSaturation', 'v1WeekXiexiao', 'xfWeekNum', 'jkWeekNum', 'tfWeekNum', 'tkNum', 'entryWeek', 'quitWeek'];
      const getv = (r, k) => (r.values && r.values[k] != null) ? r.values[k] : null;
      let h = strayNote + '<div class="preview-note">共 ' + wkRecs.length + ' 周数据。</div>';
      h += '<div class="section-h">周度数据横向对比</div><div class="table-wrap"><table><thead><tr><th>指标</th>';
      weeks.forEach(w => h += '<th class="num">' + w + '</th>');
      h += '</tr></thead><tbody>';
      keys.forEach(k => {
        const f = SCHEMA.weeklyFields.find(x => x.key === k);
        const isRatio = f && f.type === 'ratio' && f.unit !== '比';
        h += '<tr><td>' + (f ? esc(f.label) : k) + '</td>';
        wkRecs.forEach(r => {
          const v = getv(r, k);
          h += '<td class="num">' + (v == null ? '<span class="muted">—</span>' : (isRatio ? pct(v) : fmt(v))) + '</td>';
        });
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      // 选指标周度趋势图
      h += '<div class="section-h">指标周度趋势</div><div class="field" style="margin-bottom:10px"><label>选择对比指标</label><select id="wcMetric">' +
        keys.map(k => { const f = SCHEMA.weeklyFields.find(x => x.key === k); return '<option value="' + k + '">' + (f ? f.label : k) + '</option>'; }).join('') + '</select></div>';
      h += '<div class="chart-box"><canvas id="wcChart"></canvas></div>';
      $('#wcResult').innerHTML = h;
      const sel = $('#wcMetric');
      function drawChart() {
        destroyChart('wcChart');
        const ctx = $('#wcChart'); if (!ctx) return;
        const k = sel.value;
        const f = SCHEMA.weeklyFields.find(x => x.key === k);
        const isRatio = f && f.type === 'ratio' && f.unit !== '比';
        const data = wkRecs.map(r => { const v = getv(r, k); return (v != null && isFinite(v)) ? (isRatio ? v * 100 : v) : null; });
        charts['wcChart'] = new Chart(ctx, {
          type: 'bar',
          data: { labels: weeks, datasets: [{ label: f ? f.label : k, data, backgroundColor: 'rgba(79,70,229,.75)', borderRadius: 5 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => isRatio ? v + '%' : fmt(v) } } } },
        });
      }
      sel.addEventListener('change', drawChart);
      drawChart();
    }
    draw();
  }

  // —— 核心看板 · 最佳科组排名（基于季度评比数据）——
  function renderKezuRankDashboard() {
    const scoreRecs = STORE.list('bestkezu_score');
    const monthly = STORE.list('bestkezu');
    if (!scoreRecs.length && !monthly.length) {
      let msg = '<div class="empty">';
      msg += '<div style="font-weight:600;margin-bottom:8px">暂无最佳科组数据</div>';
      if (monthly.length) {
        msg += '<div>检测到「最佳科组」板块已有 <b>' + monthly.length + '</b> 条科组×月度数据，但缺少「评比结果」数据。</div>';
        msg += '<div style="margin-top:8px">原因通常是：</div><ul style="text-align:left;display:inline-block;margin:6px 0">';
        msg += '<li>上传的文件里<strong>没有 Sheet5『最佳科组评比汇总』</strong>，或该 sheet 名称不包含“评比/排名/最佳科组”等关键词；</li>';
        msg += '<li>有评比表，但解析后<strong>未点击「确认入库」</strong>；</li>';
        msg += '<li>之后点击了「清空本科组数据」，把评比数据一起清除了。</li></ul>';
        msg += '<div>请重新上传含评比汇总的原始全量文件，并在「最佳科组」模块点击<strong>确认入库</strong>。</div>';
      } else {
        msg += '<div>请先在「最佳科组」模块上传含『最佳科组评比汇总』(Sheet5) 的全量文件并入库，即可在此查看各季度排名、全年排名与横向对比。</div>';
      }
      msg += '</div>';
      $('#dashBody').innerHTML = msg;
      return;
    }

    let html = '';
    // 排名部分：依赖评比汇总数据（bestkezu_score）
    if (scoreRecs.length) {
      const years = scoreRecs.map(r => r.year).filter(y => y).sort((a, b) => b - a);
      const yr = years[0];
      html += '<div class="row" style="margin-bottom:16px;align-items:flex-end"><div class="field"><label>年份</label><select id="kezuRankYr">' +
        years.map(y => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '年</option>').join('') + '</select></div>' +
        '<div class="preview-note" style="margin-left:8px">数据来源：最佳科组评比汇总（季度排名 / 全年累计排名）。含「总分」的评分表按总分降序并标记最佳科组。</div></div>';
      html += '<div id="kezuRankResult"></div>';
    } else {
      html += '<div class="preview-note" style="margin-bottom:12px">⚠ 当前仅有科组月度明细，缺少「最佳科组评比汇总」(Sheet5)，暂无法呈现季度/全年排名；下方为可用的横向对比数据。</div>';
    }
    // 横向对比部分：依赖科组月度明细（bestkezu），与排名互不耦合
    if (monthly.length) {
      html += '<div id="kezuCmpDashWrap"></div>';
    }
    $('#dashBody').innerHTML = html;

    function draw() {
      const y = parseInt($('#kezuRankYr').value, 10);
      const rec = scoreRecs.find(r => r.year === y) || scoreRecs[0];
      const score = rec.values || {};
      const rating = score.rating;
      let h = '';
      const banner = kezuBestBanner(rating);
      if (banner) h += banner;
      if (rating && rating.blocks && rating.blocks.length) {
        // 仅呈现「二、季度排名」与「三、全年累计排名」两块，剔除 Q1–Q4/全年 评分明细，避免信息过密、Q2 之后显示不全
        const rankBlocks = rating.blocks.filter(b => b.title && /排名/.test(b.title));
        if (rankBlocks.length) {
          const cnNums = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
          rankBlocks.forEach((b, idx) => {
            const canRank = b.header.filter(hh => /总分/.test(hh)).length === 1 && !b.header.some(hh => /名次/.test(hh));
            const totCol = b.header.findIndex(hh => /总分/.test(hh));
            const usable = totCol >= 0 ? b.rows.some(r => isNum(r[totCol]) && +r[totCol] > 0) : b.rows.some(r => r[1] != null && r[1] !== '' && isNum(r[1]));
            const blockTitle = (b.title || '').replace(/^[一二三四五六七八九十]、/, cnNums[idx + 1] + '、');
            h += '<div class="sub-h">' + esc(blockTitle) + '</div>';
            if (!b.rows.length || !usable) h += '<div class="preview-note">（该排名暂无数据）</div>';
            else h += kezuScoreBlockHTML(b, canRank);
          });
        } else {
          h += '<div class="empty">该年评比数据中暂无排名信息。</div>';
        }
      } else {
        h += '<div class="empty">该年评比数据中暂无排名信息。</div>';
      }
      $('#kezuRankResult').innerHTML = h;
    }
    if (scoreRecs.length) {
      $('#kezuRankYr').addEventListener('change', draw);
      draw();
    }
    if (monthly.length) {
      renderKezuCompare('kezuCmpDashWrap');
    }
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

  // —— 生产指标下达（科组生产指标计算器）——
  // 科组生产指标（7 步算法）
  // 1) A 法：单科占比 × 校区生产指标
  // 2) B 法：上月课时占比 × 校区生产指标（并对比数据源 1v1 月生产课时）
  // 3) 两次预测求均值
  // 4) 预测周平均 = 均值 / 单科 / 月周数（周数取自最佳科组）；取四科组均值，区间控制 [C, C+30] 反推对齐
  // 5) 完成率 = 四科组预测之和 / C；G1=100% G2=110% G3=125%，倒推各档指标
  // 6) 周度预测 = 月预测 / 周数；呈现周度 / 月度 / 完成率 / 达到级别
  // 7) 校区汇总

  // 科组生产指标核心算法（「科组生产指标」tab 与「核心看板·科组生产预测」共用）
  function computeKezuTarget(depts, C) {
    const S = depts.reduce((a, d) => a + (d.s || 0), 0);
    const H = depts.reduce((a, d) => a + (d.h || 0), 0);
    const rows = depts.map(d => {
      const w = d.w > 0 ? d.w : 4;             // 月周数（缺失按 4 周兜底，与看板一致）；可在最佳科组提取
      const a = S > 0 ? d.s / S : 0;          // A 法占比（单科占比）
      const b = H > 0 ? d.h / H : 0;          // B 法占比（课时占比）
      const predA = a * C;
      const predB = b * C;
      const avg = (predA + predB) / 2;         // ③ 两步均值（预测课时数）
      // ④ 预测周平均 = 对应课时数 / 对应单科数 / 对应月周数
      const wAvg = d.s > 0 ? avg / d.s / w : 0;
      return { name: d.name, s: d.s, h: d.h, w, a, b, predA, predB, avg, wAvg };
    });
    // 分母 = Σ(单科数 × 月周数)；周数相同时退化为 Σ单科数
    const denom = rows.reduce((a, r) => a + (r.s || 0) * r.w, 0);
    const meanW = rows.reduce((x, r) => x + r.wAvg, 0) / (rows.length || 1);
    const sum0 = meanW * denom;
    const lower = denom > 0 ? C / denom : 0;
    const upper = denom > 0 ? (C + 30) / denom : 0;
    let commonW = meanW;
    let adjNote;
    if (denom <= 0) adjNote = '单科数×周数合计为 0，无法计算。';
    else if (sum0 < C) { commonW = lower; adjNote = '四科组预测之和（' + fmt(sum0) + '）＜ C，已上调共同周平均至区间下界，使之和达到 C。'; }
    else if (sum0 > C + 30) { commonW = upper; adjNote = '四科组预测之和（' + fmt(sum0) + '）＞ C+30，已压回区间上界。'; }
    else { adjNote = '四科组预测之和（' + fmt(sum0) + '）已落在 [C, C+30] 区间内，共同周平均取四科组均值。'; }
    const sumFinal = commonW * denom;
    const completion = C > 0 ? sumFinal / C : 0;
    let achieved = '未达标';
    if (completion >= 1.25) achieved = 'G3';
    else if (completion >= 1.10) achieved = 'G2';
    else if (completion >= 1.00) achieved = 'G1';
    const Gcfg = { G1: 1.00, G2: 1.10, G3: 1.25 };
    rows.forEach(r => {
      r.final = commonW * r.s * r.w;          // 最终月度预测 = 共同周平均 × 单科 × 周数
      r.weekly = r.w > 0 ? r.final / r.w : 0; // 周度生产预测 = 月度预测 / 周数
      const share = (r.s * r.w) / (denom || 1); // 按 单科×周数 分配（周数相同即按单科）
      r.G1 = (C * Gcfg.G1) * share;
      r.G2 = (C * Gcfg.G2) * share;
      r.G3 = (C * Gcfg.G3) * share;
    });
    return { S, H, rows, meanW, sum0, lower, upper, commonW, adjNote, sumFinal, completion, achieved, Gcfg };
  }

  // 解析「科组每周实际生产 / 预排」Excel/CSV（长表：周次 × 科组 × 实际预排 × 实际生产）
  function parseActualFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
          const norm = c => (c == null ? '' : String(c)).trim().toLowerCase().replace(/\s+/g, '');
          const aliases = {
            week: ['周次', '周', 'week'],
            subject: ['科组', '学科', '科目', 'subject'],
            scheduled: ['实际预排', '预排', '排课', '计划课时', '预排课时', '预排生产'],
            produced: ['实际生产', '生产课时', '实际生产课时', '实际产出', 'produced'],
            year: ['年份', '年', 'year'],
            month: ['月份', '月', 'month'],
          };
          function matchCol(cells) {
            const map = {};
            cells.forEach((cell, idx) => {
              const t = norm(cell);
              if (!t) return;
              for (const key in aliases) {
                if (map[key] != null) continue;
                if (aliases[key].some(a => t === a || t.indexOf(a) >= 0)) { map[key] = idx; break; }
              }
            });
            return map;
          }
          let headerIdx = -1, headerMap = null;
          for (let i = 0; i < Math.min(12, aoa.length); i++) {
            const m = matchCol(aoa[i]);
            if (m.subject != null && m.week != null && (m.scheduled != null || m.produced != null)) { headerIdx = i; headerMap = m; break; }
          }
          if (headerIdx < 0) { reject(new Error('未找到含「周次 / 科组 / 实际预排 / 实际生产」的表头行（前 12 行内）')); return; }
          const toNum = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[, ]/g, '')); return isFinite(n) ? n : 0; };
          const records = [], errors = [], warnings = [];
          for (let i = headerIdx + 1; i < aoa.length; i++) {
            const row = aoa[i];
            if (!row || row.every(c => c == null || String(c).trim() === '')) continue;
            const get = k => row[headerMap[k]];
            const subject = (get('subject') == null ? '' : String(get('subject')).trim());
            const week = Math.round(toNum(get('week')));
            const scheduled = toNum(get('scheduled'));
            const produced = toNum(get('produced'));
            const year = get('year') != null && /\d{4}/.test(String(get('year'))) ? +String(get('year')).match(/\d{4}/)[0] : null;
            const month = get('month') != null ? Math.round(toNum(get('month'))) : null;
            if (!subject) { errors.push({ msg: '第 ' + (i + 1) + ' 行：缺少科组名称，已跳过' }); continue; }
            if (!week || week < 1) { errors.push({ msg: '第 ' + (i + 1) + ' 行（' + subject + '）：周次无效，已跳过' }); continue; }
            records.push({ year, month, week, subject, scheduled: scheduled || 0, produced: produced || 0 });
          }
          resolve({ records, errors, warnings });
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }
  function levelOf(c) { return c >= 1.25 ? 'G3' : c >= 1.10 ? 'G2' : c >= 1.00 ? 'G1' : '未达标'; }
  function levelBadgeOf(c) {
    const lv = levelOf(c);
    if (lv === 'G3') return '<span class="tag" style="background:#4F46E5;color:#fff">G3（125%）</span>';
    if (lv === 'G2') return '<span class="tag warn">G2（110%）</span>';
    if (lv === 'G1') return '<span class="tag ok">G1（100%）</span>';
    return '<span class="tag warn">未达标</span>';
  }

  // 将 DOM 元素导出为 PNG（本地 vendor/html2canvas.min.js）
  function exportElementImage(sel, filename) {
    const el = $(sel);
    if (!el) { toast('未找到要导出的元素'); return Promise.resolve(); }
    if (typeof html2canvas === 'undefined') { toast('图片导出组件未加载，请刷新页面后重试'); return Promise.resolve(); }
    toast('正在生成图片…');
    // 计算完整内容宽度：宽表可能超出视口，需取内部 table 的真实宽度
    let fullWidth = Math.max(el.scrollWidth, el.offsetWidth);
    const innerTable = el.querySelector('table');
    if (innerTable) fullWidth = Math.max(fullWidth, innerTable.scrollWidth, innerTable.offsetWidth);
    fullWidth = Math.ceil(fullWidth) + 2;
    // 克隆到离屏容器，解除宽度/overflow 约束，保证整表渲染（避免只截到可视部分）
    const clone = el.cloneNode(true);
    clone.style.width = fullWidth + 'px';
    clone.querySelectorAll('.table-wrap').forEach(tw => { tw.style.overflow = 'visible'; });
    clone.querySelectorAll('button').forEach(b => { b.style.visibility = 'hidden'; });
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + fullWidth + 'px;background:#ffffff;padding:0;z-index:-1;';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    return html2canvas(clone, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: fullWidth, windowWidth: fullWidth }).then(canvas => {
      if (holder.parentNode) document.body.removeChild(holder);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename || '看板.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('图片已导出');
    }).catch(err => { if (holder.parentNode) document.body.removeChild(holder); toast('导出失败：' + (err && err.message ? err.message : String(err))); });
  }

  // 生成并下载「科组周度实际数据」Excel 模板（标准表头，与 parseActualFile 对齐）
  function downloadActualTemplate() {
    if (typeof XLSX === 'undefined') { toast('表格组件未加载，请刷新页面'); return; }
    const header = ['年份', '月份', '周次', '科组', '实际预排', '实际生产'];
    const subjects = ['数学', '英语', '文综', '理综'];
    const data = [header];
    // 示例两周（年份/月份按实际跟踪月填写；此处仅作格式示例，可删改）
    subjects.forEach(s => data.push([2026, 8, 1, s, null, null]));
    subjects.forEach(s => data.push([2026, 8, 2, s, null, null]));
    // 额外空白行，便于继续填写
    for (let i = 0; i < 8; i++) data.push([null, null, null, null, null, null]);
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = header.map(h => ({ wch: Math.max(8, h.length * 2 + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '周度实际数据');
    const inst = XLSX.utils.aoa_to_sheet([
      ['填写说明'],
      ['1. 在「周度实际数据」表中填写每周实际数据，不要修改第 1 行表头。'],
      ['2. 年份 / 月份：填写跟踪月份（如 2026、8）；留空则上传时自动用「预测月」填充。'],
      ['3. 周次：填 1、2、3… 表示第几周。'],
      ['4. 科组：数学 / 英语 / 文综 / 理综（须与「最佳科组」中的科组名称一致）。'],
      ['5. 实际预排：该科组该周的实际排课课时（填数字）。'],
      ['6. 实际生产：该科组该周的实际生产课时（填数字）。'],
      ['7. 填写完成后，回到系统「科组生产指标 → ⑧ 实际跟踪」上传此文件即可。'],
    ]);
    inst['!cols'] = [{ wch: 70 }];
    XLSX.utils.book_append_sheet(wb, inst, '填写说明');
    XLSX.writeFile(wb, '科组周度实际数据模板.xlsx');
    toast('模板已下载：科组周度实际数据模板.xlsx');
  }

    // 生成「科组月度汇总（按周展开）」宽表 HTML（复用于核心看板与 target tab）
    // 月度预排完成率 = 月度预排(sched) ÷ 月度生产指标：逐行分母为各科目月度生产目标(r.final)，
    // 校区总计行分母为「校区生产指标 C」（页面用户输入总盘）。
    function kezuTargetWideTableHTML(res, actuals, campusC) {
    const rows = res.rows.map(r => ({
      name: r.name, s: r.s, w: r.w || 0, weekly: r.weekly || 0, final: r.final || 0
    }));
    const bySubj = {};
    actuals.forEach(r => { (bySubj[r.dimension] = bySubj[r.dimension] || []).push(r); });

    rows.forEach(r => {
      const list = (bySubj[r.name] || []).slice().sort((a, b) => (a.week - b.week));
      r._list = list;
      r._sched = 0; r._prod = 0;
      list.forEach(rec => { r._sched += num(rec.values && rec.values.scheduled); r._prod += num(rec.values && rec.values.produced); });
    });

    const maxW = Math.max(...rows.map(r => r.w), 0);
    if (!maxW) return '<div class="preview-note">请先在「科组生产指标」中确认科组周数，再上传实际数据生成汇总表。</div>';

    const wkIdx = [];
    for (let i = 1; i <= maxW; i++) {
      let weekTgt = 0, weekSched = 0, weekProd = 0;
      rows.forEach(r => {
        const rec = (r._list || []).find(x => x.week === i);
        if (i <= r.w) weekTgt += r.weekly;
        weekSched += rec ? num(rec.values.scheduled) : 0;
        weekProd += rec ? num(rec.values.produced) : 0;
      });
      wkIdx.push({ weekTgt, weekSched, weekProd });
    }

    let campusSched = 0, campusProd = 0;
    rows.forEach(r => { campusSched += r._sched; campusProd += r._prod; });
    const campusFinal = res.sumFinal || 0;
    const campusCVal = (typeof campusC === 'number' && isFinite(campusC)) ? campusC : campusFinal;
    const campusPreRate = campusCVal > 0 ? campusSched / campusCVal : null;
    const campusActRate = campusFinal > 0 ? campusProd / campusFinal : null;

    let h = '<div class="table-wrap"><table><thead>';
    let head = '<tr><th rowspan="2">科组</th>';
    for (let i = 1; i <= maxW; i++) head += '<th class="num" colspan="4">W' + i + '</th>';
    head += '<th class="num" rowspan="2">月度预排</th><th class="num" rowspan="2">月度实际</th><th class="num" rowspan="2">月度预排<br>完成率</th><th class="num" rowspan="2">月度实际<br>完成率</th></tr>';
    let sub = '<tr>';
    for (let i = 1; i <= maxW; i++) sub += '<th class="num">指标</th><th class="num">预排</th><th class="num">实际</th><th class="num">完成率</th>';
    sub += '</tr>';
    h += head + sub + '</thead><tbody>';

    rows.forEach(r => {
      let tr = '<tr><td>' + esc(r.name) + '</td>';
      for (let i = 1; i <= maxW; i++) {
        const rec = (r._list || []).find(x => x.week === i);
        const hasWeek = i <= r.w;
        const tgt = hasWeek ? r.weekly : 0;
        const sched = rec ? num(rec.values.scheduled) : 0;
        const prod = rec ? num(rec.values.produced) : 0;
        const wkRate = tgt > 0 ? prod / tgt : null;
        tr += '<td class="num">' + (hasWeek ? fmt(tgt, 1) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num">' + (sched > 0 ? fmt(sched, 1) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num" style="font-weight:600">' + (prod > 0 ? fmt(prod, 1) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num">' + (wkRate == null ? '<span class="muted">—</span>' : pct(wkRate)) + '</td>';
      }
      const preRate = r.final > 0 ? r._sched / r.final : null;
      const actRate = r.final > 0 ? r._prod / r.final : null;
      tr += '<td class="num">' + (r._sched > 0 ? fmt(r._sched, 1) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num" style="font-weight:600">' + (r._prod > 0 ? fmt(r._prod, 1) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (preRate == null ? '<span class="muted">—</span>' : pct(preRate)) + '</td>' +
        '<td class="num">' + (actRate == null ? '<span class="muted">—</span>' : pct(actRate)) + '</td></tr>';
      h += tr;
    });

    let tfoot = '<tr><td class="total-label">校区总计</td>';
    for (let i = 1; i <= maxW; i++) {
      const { weekTgt, weekSched, weekProd } = wkIdx[i - 1];
      const wkRate = weekTgt > 0 ? weekProd / weekTgt : null;
      tfoot += '<td class="num">' + fmt(weekTgt, 1) + '</td>' +
        '<td class="num">' + fmt(weekSched, 1) + '</td>' +
        '<td class="num" style="font-weight:600">' + fmt(weekProd, 1) + '</td>' +
        '<td class="num">' + (wkRate == null ? '<span class="muted">—</span>' : pct(wkRate)) + '</td>';
    }
    tfoot += '<td class="num" style="font-weight:600">' + (campusSched > 0 ? fmt(campusSched, 1) : '<span class="muted">—</span>') + '</td>' +
      '<td class="num" style="font-weight:600">' + (campusProd > 0 ? fmt(campusProd, 1) : '<span class="muted">—</span>') + '</td>' +
      '<td class="num">' + (campusPreRate == null ? '<span class="muted">—</span>' : pct(campusPreRate)) + '</td>' +
      '<td class="num">' + (campusActRate == null ? '<span class="muted">—</span>' : pct(campusActRate)) + '</td></tr>';
    h += '</tbody><tfoot>' + tfoot + '</tfoot></table></div>';
    h += '<div class="preview-note">月度预排完成率 = 月度预排 ÷ 月度生产指标；校区总计 = 校区月度预排 ÷ 校区生产指标 C。</div>';
    return h;
  }

  function renderTarget() {
    const state = { C: loadTargetC(1000), year: 0, month: 0, depts: [] };
    let calc = null;
    let html = `
      <div class="panel">
        <div class="panel-title">参数设置与数据源校验</div>
        <div class="panel-desc">① 校区生产指标（总盘 C）为人工输入；② 参考月份 = 取「最佳科组」中该月数据（即上月单科数 / 课时），预测目标月随当前日期自动推进到<b>当前人工月</b>；③ 系统自动用最佳科组课时合计数与数据源「1v1 月生产课时」做一致性校验。</div>
        <div id="tFrameNote" class="field-note" style="margin-bottom:12px"></div>
        <div class="grid grid-3" style="margin-bottom:12px">
          <div class="field"><label>校区生产指标（总盘 C）</label><input type="number" id="tC" class="mono" min="0" step="any" value="${state.C}"></div>
          <div class="field"><label>参考年份</label><select id="tYearSel" class="mono"></select></div>
          <div class="field"><label>参考月份（上月数据）</label><select id="tMonthSel" class="mono"></select></div>
        </div>
        <div id="tConsist" class="field-note"></div>
        <div class="row" style="margin-top:10px">
          <button class="btn" id="tLoad">↻ 读入该月科组数据</button>
          <button class="btn ghost" id="tClear">清空科组</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">科组输入（来自最佳科组，可编辑）</div>
        <div class="panel-desc">单科数 / 课时取自参考月「最佳科组」；周数默认为【预测月】的自然周数（用于周度分解），可微调。可增删科组或在表格内直接修改。</div>
        <div id="tDeptWrap"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="tAdd">＋ 添加科组</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">① ＋ ② 两步预测：A 法（单科占比）与 B 法（课时占比）</div>
        <div class="panel-desc">A 法预测ᵢ = (单科ᵢ / 校区总单科) × C；B 法预测ᵢ = (课时ᵢ / 校区总课时) × C。两步均值 = (Aᵢ + Bᵢ) / 2。</div>
        <div id="tCalcWrap"></div>
      </div>

      <div class="panel">
        <div class="panel-title">③ ＋ ④ 预测周平均 · 对齐 · 区间控制</div>
        <div class="panel-desc">预测周平均ᵢ = 两步均值ᵢ / 单科ᵢ / 月周数ᵢ（月周数取自最佳科组）；取四科组预测周平均之均值作为「共同周平均」，最终月度预测ᵢ = 共同周平均 × 单科ᵢ × 月周数ᵢ。四科组预测之和须落在区间 [C, C+30]：不足则上调共同周平均直至达到 C；超出 +30 则压回。</div>
        <div id="tAlignWrap"></div>
      </div>

      <div class="panel">
        <div class="panel-title">⑤ G1 / G2 / G3 倒推目标（每科组）</div>
        <div class="panel-desc">完成率 = 四科组预测之和 / C；100%→G1，110%→G2，125%→G3。各档总盘 = C × 档位，按单科占比分解到每科组。</div>
        <div id="tGWrap"></div>
      </div>

      <div class="panel">
        <div class="panel-title">⑥ 最终预测结果（周度 / 月度 / 完成率 / 达到级别）</div>
        <div class="panel-desc">周度生产预测ᵢ = 月度预测ᵢ / 该科组周数（按周均摊）。月度完成率与达到级别为校区级口径（分配 ∝ 单科数×周数；同月周数相同即 ∝ 单科数，各组完成率一致）。</div>
        <div id="tFinalWrap"></div>
        <div class="panel-subtitle" style="margin-top:16px">每周分解（按周均摊）</div>
        <div id="tWeeklyWrap"></div>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="tCopy">⧉ 复制结果表</button>
          <button class="btn" id="tCsv">⬇ 导出 CSV</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">⑦ 校区汇总</div>
        <div class="panel-desc">校区级关键指标一览。</div>
        <div id="tSummaryWrap"></div>
      </div>

      <div class="panel">
        <div class="panel-title">⑧ 实际跟踪 · 预测 vs 实际（科组生产达成）</div>
        <div class="panel-desc">上传科组每周实际数据后，系统按当前「参考月份 + 1」所对应的<b>预测月</b>叠加对比：预测周目标 = 月度预测 ÷ 周数；对比实际预排与实际生产，算周达成率与预排达成率，并预测月末达成。上传表头需含：周次、科组、实际预排、实际生产（年份/月份可选，缺省用预测月）。</div>
        <div class="meta-row" style="margin-bottom:10px">
          <div class="field"><label>跟踪月份（预测月 = 参考月 + 1）</label><span id="atYM" class="mono" style="font-weight:600"></span></div>
        </div>
        <div class="upload-bar" id="at_drop">
          <div class="ub-left">
            <div class="ub-ico" id="at_ubico">${UPLOAD_SVG}</div>
            <div>
              <div class="ub-title">拖入或点击上传 xlsx / xls / csv（每周实际数据）</div>
              <div class="ub-sub" id="at_filelabel">未选择文件</div>
            </div>
          </div>
          <div class="ub-actions"><button class="btn primary" id="at_parse">解析</button><button class="btn ghost" id="at_tpl">下载模板</button><button class="btn ghost" id="at_clear">清空本月</button></div>
          <input type="file" id="at_file" accept=".xlsx,.xls,.csv" hidden />
        </div>
        <div id="at_preview"></div>
        <div id="atTrackWrap"></div>
      </div>`;
    $('#content').innerHTML = html;

    function renderDeptInputs() {
      const wrap = $('#tDeptWrap');
      if (!state.depts.length) { wrap.innerHTML = '<div class="preview-note">暂无科组，请点击「读入该月科组数据」或「添加科组」。</div>'; return; }
      const S = state.depts.reduce((a, d) => a + (d.s || 0), 0);
      const H = state.depts.reduce((a, d) => a + (d.h || 0), 0);
      let h = '<div class="table-wrap"><table><thead><tr><th>科组名称</th><th class="num">单科数 sᵢ</th><th class="num">上月课时 hᵢ</th><th class="num">周数 wᵢ</th><th></th></tr></thead><tbody>';
      state.depts.forEach((d, i) => {
        h += '<tr>' +
          '<td><input class="cell-in" data-i="' + i + '" data-k="name" value="' + esc(d.name) + '"></td>' +
          '<td class="num"><input class="cell-in mono" data-i="' + i + '" data-k="s" type="number" min="0" step="any" value="' + d.s + '"></td>' +
          '<td class="num"><input class="cell-in mono" data-i="' + i + '" data-k="h" type="number" min="0" step="any" value="' + d.h + '"></td>' +
          '<td class="num"><input class="cell-in mono" data-i="' + i + '" data-k="w" type="number" min="1" step="any" value="' + d.w + '"></td>' +
          '<td><button class="row-del" data-i="' + i + '" title="删除">×</button></td></tr>';
      });
      h += '</tbody>';
      h += '<tfoot><tr><td class="total-label">校区总计</td>' +
        '<td class="num">' + fmt(S) + '</td>' +
        '<td class="num">' + fmt(H) + '</td>' +
        '<td class="num">—</td>' +
        '<td></td></tr></tfoot>';
      h += '</table></div>';
      wrap.innerHTML = h;
      wrap.querySelectorAll('input').forEach(inp => inp.addEventListener('input', onDeptInput));
      wrap.querySelectorAll('.row-del').forEach(b => b.addEventListener('click', () => {
        if (state.depts.length <= 1) { toast('至少保留一个科组'); return; }
        state.depts.splice(+b.dataset.i, 1); renderDeptInputs(); recompute();
      }));
    }
    function onDeptInput(e) {
      const i = +e.target.dataset.i, k = e.target.dataset.k;
      if (k === 'name') state.depts[i].name = e.target.value;
      else state.depts[i][k] = parseFloat(e.target.value) || 0;
      recompute();
    }

    function recompute() {
      const C = state.C;
      const res = computeKezuTarget(state.depts, C);
      const S = res.S, H = res.H, rows = res.rows;
      const src = dataSourceProd(state.year, state.month);

      // 数据源一致性校验（步骤②）
      let consistHtml;
      if (src == null) {
        consistHtml = '<span class="tag warn">数据源无该月周报</span> <span class="preview-note">请在「数据源」上传该月 DOS 周报后，1v1 月生产课时将自动参与校验。</span>';
      } else {
        const diff = H - src;
        const ok = Math.abs(diff) < 1;
        const diffTxt = (diff >= 0 ? '+' : '') + fmt(diff);
        consistHtml = '最佳科组课时合计 <b>' + fmt(H) + '</b>　vs　数据源 1v1 月生产课时 <b>' + fmt(src) + '</b>　' +
          '<span class="tag ' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓ 一致' : '⚠ 不一致') + '</span>' +
          '<span class="preview-note" style="margin-left:6px">差值 ' + diffTxt + ' 课时' + (ok ? '' : '（B 法占比以最佳科组课时为准）') + '</span>';
      }
      $('#tConsist').innerHTML = consistHtml;

      // ① + ② 两步预测
      let ch = '<div class="table-wrap"><table><thead><tr><th>科组</th><th class="num">单科数</th><th class="num">A 法占比</th><th class="num">A 法预测</th><th class="num">课时</th><th class="num">B 法占比</th><th class="num">B 法预测</th><th class="num">两步均值</th></tr></thead><tbody>';
      rows.forEach(r => {
        ch += '<tr><td>' + esc(r.name) + '</td>' +
          '<td class="num">' + fmt(r.s) + '</td>' +
          '<td class="num">' + pct(r.a) + '</td>' +
          '<td class="num">' + fmt(r.predA) + '</td>' +
          '<td class="num">' + fmt(r.h) + '</td>' +
          '<td class="num">' + pct(r.b) + '</td>' +
          '<td class="num">' + fmt(r.predB) + '</td>' +
          '<td class="num" style="color:var(--indigo);font-weight:600">' + fmt(r.avg) + '</td></tr>';
      });
      ch += '</tbody>';
      ch += '<tfoot><tr><td class="total-label">校区总计</td>' +
        '<td class="num">' + fmt(S) + '</td>' +
        '<td class="num">—</td>' +
        '<td class="num">' + fmt(C) + '</td>' +
        '<td class="num">' + fmt(H) + '</td>' +
        '<td class="num">—</td>' +
        '<td class="num">' + fmt(C) + '</td>' +
        '<td class="num" style="color:var(--indigo);font-weight:600">' + fmt(C) + '</td></tr></tfoot>';
      ch += '</table></div>';
      $('#tCalcWrap').innerHTML = ch;

      // ④ 对齐与区间控制
      const meanW = res.meanW, sum0 = res.sum0, commonW = res.commonW, adjNote = res.adjNote, sumFinal = res.sumFinal;

      let ah = '<div class="stat-grid" style="margin-bottom:10px">' +
        '<div class="stat-card"><div class="k">四科组预测周平均均值</div><div class="v">' + fmt(meanW, 2) + '</div></div>' +
        '<div class="stat-card"><div class="k">共同周平均（对齐后）</div><div class="v" style="color:var(--indigo)">' + fmt(commonW, 2) + '</div></div>' +
        '<div class="stat-card"><div class="k">校区总单科 S</div><div class="v">' + fmt(S) + '</div></div>' +
        '<div class="stat-card"><div class="k">区间 [C, C+30]</div><div class="v">' + fmt(C) + ' ~ ' + fmt(C + 30) + '</div></div>' +
        '</div>';
      ah += '<div class="preview-note" style="margin-bottom:8px">' + adjNote + '</div>';
      ah += '<div class="table-wrap"><table><thead><tr><th>科组</th><th class="num">预测周平均</th><th class="num">共同周平均</th><th class="num">最终月度预测</th></tr></thead><tbody>';
      rows.forEach(r => {
        const final_i = r.final;
        ah += '<tr><td>' + esc(r.name) + '</td>' +
          '<td class="num">' + fmt(r.wAvg, 2) + '</td>' +
          '<td class="num" style="color:var(--green);font-weight:600">' + fmt(commonW, 2) + '</td>' +
          '<td class="num" style="font-weight:600">' + fmt(final_i) + '</td></tr>';
      });
      ah += '</tbody>';
      ah += '<tfoot><tr><td class="total-label">校区总计</td>' +
        '<td class="num">—</td>' +
        '<td class="num" style="color:var(--green);font-weight:600">' + fmt(commonW, 2) + '</td>' +
        '<td class="num" style="font-weight:600">' + fmt(sumFinal) + '</td></tr></tfoot>';
      ah += '</table></div>';
      $('#tAlignWrap').innerHTML = ah;

      // ⑤ G 档倒推 + 完成率 / 达到级别
      const completion = res.completion, achieved = res.achieved, Gcfg = res.Gcfg;

      let gh = '<div class="table-wrap"><table><thead><tr><th>科组</th><th class="num">单科数</th><th class="num">G1 指标（100%）</th><th class="num">G2 指标（110%）</th><th class="num">G3 指标（125%）</th></tr></thead><tbody>';
      rows.forEach(r => {
        gh += '<tr><td>' + esc(r.name) + '</td>' +
          '<td class="num">' + fmt(r.s) + '</td>' +
          '<td class="num">' + fmt(r.G1) + '</td>' +
          '<td class="num">' + fmt(r.G2) + '</td>' +
          '<td class="num">' + fmt(r.G3) + '</td></tr>';
      });
      gh += '</tbody>';
      gh += '<tfoot><tr><td class="total-label">校区总计</td>' +
        '<td class="num">' + fmt(S) + '</td>' +
        '<td class="num">' + fmt(C * Gcfg.G1) + '</td>' +
        '<td class="num">' + fmt(C * Gcfg.G2) + '</td>' +
        '<td class="num">' + fmt(C * Gcfg.G3) + '</td></tr></tfoot>';
      gh += '</table></div>';
      $('#tGWrap').innerHTML = gh;

      // ⑥ 最终预测结果
      const levelBadge = achieved === 'G3'
        ? '<span class="tag" style="background:#4F46E5;color:#fff">G3（125%）</span>'
        : achieved === 'G2'
          ? '<span class="tag warn">G2（110%）</span>'
          : achieved === 'G1'
            ? '<span class="tag ok">G1（100%）</span>'
            : '<span class="tag warn">未达标</span>';
      let fh = '<div class="stat-grid" style="margin-bottom:10px">' +
        '<div class="stat-card"><div class="k">校区预测总盘</div><div class="v">' + fmt(sumFinal) + '</div></div>' +
        '<div class="stat-card"><div class="k">月度完成率</div><div class="v" style="color:var(--indigo)">' + pct(completion) + '</div></div>' +
        '<div class="stat-card"><div class="k">达到级别</div><div class="v">' + levelBadge + '</div></div>' +
        '</div>';
      fh += '<div class="table-wrap"><table><thead><tr><th>科组</th><th class="num">周度生产预测</th><th class="num">月度生产预测</th><th class="num">月度完成率</th><th class="num">达到级别</th></tr></thead><tbody>';
      rows.forEach(r => {
        fh += '<tr><td>' + esc(r.name) + '</td>' +
          '<td class="num">' + fmt(r.weekly, 1) + '</td>' +
          '<td class="num" style="font-weight:600">' + fmt(r.final) + '</td>' +
          '<td class="num">' + pct(completion) + '</td>' +
          '<td class="num">' + levelBadge + '</td></tr>';
      });
      const sumWeeklyFinal = rows.reduce((a, r) => a + r.weekly, 0);
      fh += '</tbody>';
      fh += '<tfoot><tr><td class="total-label">校区总计</td>' +
        '<td class="num">' + fmt(sumWeeklyFinal, 1) + '</td>' +
        '<td class="num" style="font-weight:600">' + fmt(sumFinal) + '</td>' +
        '<td class="num">' + pct(completion) + '</td>' +
        '<td class="num">' + levelBadge + '</td></tr></tfoot>';
      fh += '</table></div>';
      $('#tFinalWrap').innerHTML = fh;

      // 每周分解
      const maxW = Math.max(...rows.map(r => r.w), 0);
      if (maxW > 0) {
        let wh = '<div class="table-wrap"><table><thead><tr><th>科组</th>';
        for (let i = 1; i <= maxW; i++) wh += '<th class="num">第' + i + '周</th>';
        wh += '</tr></thead><tbody>';
        rows.forEach(r => {
          wh += '<td>' + esc(r.name) + '</td>';
          for (let i = 1; i <= maxW; i++) wh += '<td class="num">' + (i <= r.w ? fmt(r.weekly, 1) : '<span class="muted">—</span>') + '</td>';
          wh += '</tr>';
        });
        const wkTotals = [];
        for (let i = 1; i <= maxW; i++) { let t = 0; rows.forEach(r => { if (i <= r.w) t += r.weekly; }); wkTotals.push(t); }
        wh += '</tbody>';
        wh += '<tfoot><tr><td class="total-label">校区总计</td>';
        for (let i = 1; i <= maxW; i++) wh += '<td class="num">' + fmt(wkTotals[i - 1], 1) + '</td>';
        wh += '</tr></tfoot>';
        wh += '</table></div>';
        $('#tWeeklyWrap').innerHTML = wh;
      } else {
        $('#tWeeklyWrap').innerHTML = '<div class="preview-note">请填写科组周数以生成每周分解。</div>';
      }

      // ⑦ 校区汇总
      const srcLine = src == null
        ? '<div class="stat-card"><div class="k">数据源 1v1 月生产课时</div><div class="v muted">无该月周报</div></div>'
        : (function () {
            const diff = H - src; const ok = Math.abs(diff) < 1;
            return '<div class="stat-card"><div class="k">数据源 1v1 月生产课时</div><div class="v">' + fmt(src) + '</div></div>' +
              '<div class="stat-card"><div class="k">与最佳科组课时一致性</div><div class="v">' + (ok ? '<span class="tag ok">一致</span>' : '<span class="tag warn">差 ' + fmt(diff) + '</span>') + '</div></div>';
          })();
      let sh = '<div class="stat-grid">' +
        '<div class="stat-card"><div class="k">校区生产指标 C</div><div class="v">' + fmt(C) + '</div></div>' +
        '<div class="stat-card"><div class="k">校区总单科 S</div><div class="v">' + fmt(S) + '</div></div>' +
        '<div class="stat-card"><div class="k">校区总课时 H（最佳科组）</div><div class="v">' + fmt(H) + '</div></div>' +
        srcLine +
        '<div class="stat-card"><div class="k">共同周平均</div><div class="v" style="color:var(--indigo)">' + fmt(commonW, 2) + '</div></div>' +
        '<div class="stat-card"><div class="k">校区预测总盘</div><div class="v">' + fmt(sumFinal) + '</div></div>' +
        '<div class="stat-card"><div class="k">月度完成率</div><div class="v" style="color:var(--indigo)">' + pct(completion) + '</div></div>' +
        '<div class="stat-card"><div class="k">达到级别</div><div class="v">' + levelBadge + '</div></div>' +
        '</div>';
      $('#tSummaryWrap').innerHTML = sh;

      calc = { rows, C, S, H, commonW, sumFinal, completion, achieved, src, sumWeeklyFinal: rows.reduce((a, r) => a + r.weekly, 0) };
      renderTrack();
    }

    function predictedYM() {
      let y = state.year, m = state.month + 1;
      if (m > 12) { m = 1; y++; }
      return { y, m };
    }

    function renderTrack() {
      const tw = $('#atTrackWrap'); if (!tw) return;
      const { y: py, m: pm } = predictedYM();
      const ymEl = $('#atYM'); if (ymEl) ymEl.textContent = py + ' 年 ' + pm + ' 月';
      const res = computeKezuTarget(state.depts, state.C);
      const rows = res.rows;
      const actuals = STORE.list('kezuActual').filter(r => r.year === py && r.month === pm);
      const bySubj = {};
      actuals.forEach(r => { (bySubj[r.dimension] = bySubj[r.dimension] || []).push(r); });

      let campusActual = 0, campusFinal = res.sumFinal, campusMonthEnd = 0;
      rows.forEach(r => {
        const list = (bySubj[r.name] || []).slice().sort((a, b) => (a.week - b.week));
        let subjActual = 0;
        list.forEach(rec => { subjActual += num(rec.values && rec.values.produced); });
        const cumRate = r.final > 0 ? subjActual / r.final : 0;
        const actualWeeks = list.length;
        const remaining = Math.max(0, (r.w || 0) - actualWeeks);
        const monthEnd = subjActual + remaining * r.weekly;
        r._list = list; r._actual = subjActual; r._cumRate = cumRate;
        r._monthEnd = monthEnd; r._meRate = r.final > 0 ? monthEnd / r.final : 0; r._actualWeeks = actualWeeks;
        campusActual += subjActual; campusMonthEnd += monthEnd;
      });

      const campusCum = campusFinal > 0 ? campusActual / campusFinal : 0;
      const campusME = campusFinal > 0 ? campusMonthEnd / campusFinal : 0;
      let top = '<div class="stat-grid" style="margin:6px 0 14px">';
      top += '<div class="stat-card"><div class="k">跟踪月份</div><div class="v">' + py + '/' + pm + '</div></div>';
      top += '<div class="stat-card"><div class="k">校区累计完成率</div><div class="v" style="color:var(--indigo)">' + pct(campusCum) + '</div></div>';
      top += '<div class="stat-card"><div class="k">校区月末预测完成率</div><div class="v" style="color:var(--indigo)">' + pct(campusME) + '</div></div>';
      top += '<div class="stat-card"><div class="k">月末预测达到级别</div><div class="v">' + levelBadgeOf(campusME) + '</div></div>';
      top += '</div>';

      let detail = '<div class="section-h">周度明细（科组 × 周）</div>';
      detail += '<div class="table-wrap"><table><thead><tr><th>科组</th><th class="num">周次</th><th class="num">预测周目标</th><th class="num">实际预排</th><th class="num">实际生产</th><th class="num">周达成率</th><th class="num">预排达成率</th></tr></thead><tbody>';
      let hasDetail = false;
      rows.forEach(r => {
        (r._list || []).forEach(rec => {
          hasDetail = true;
          const sched = num(rec.values && rec.values.scheduled);
          const prod = num(rec.values && rec.values.produced);
          const tgt = r.weekly;
          const wkRate = tgt > 0 ? prod / tgt : 0;
          const schRate = sched > 0 ? prod / sched : null;
          detail += '<tr><td>' + esc(r.name) + '</td>' +
            '<td class="num">第' + rec.week + '周</td>' +
            '<td class="num">' + fmt(tgt, 1) + '</td>' +
            '<td class="num">' + fmt(sched, 1) + '</td>' +
            '<td class="num" style="font-weight:600">' + fmt(prod, 1) + '</td>' +
            '<td class="num">' + pct(wkRate) + '</td>' +
            '<td class="num">' + (schRate == null ? '<span class="muted">—</span>' : pct(schRate)) + '</td></tr>';
        });
      });
      detail += '</tbody></table></div>';
      if (!hasDetail) detail = '<div class="preview-note">预测月 ' + py + ' 年 ' + pm + ' 月 暂无实际上传数据。上传「周次 / 科组 / 实际预排 / 实际生产」表后，此处显示每周达成跟踪。</div>';

      // 月度汇总宽表：科组 × 周次（W1~Wn）+ 月度预排/实际/完成率
      const maxW = Math.max(...rows.map(r => r.w || 0), 0);
      const wkIdx = [];
      for (let i = 1; i <= maxW; i++) {
        let weekTgt = 0, weekSched = 0, weekProd = 0;
        rows.forEach(r => {
          const rec = (r._list || []).find(x => x.week === i);
          if (i <= (r.w || 0)) weekTgt += (r.weekly || 0);
          weekSched += rec ? num(rec.values.scheduled) : 0;
          weekProd += rec ? num(rec.values.produced) : 0;
        });
        wkIdx.push({ weekTgt, weekSched, weekProd });
      }

      let sum = '<div class="section-h">科组月度汇总（按周展开）</div>';
      sum += '<div class="table-wrap"><table><thead>';
      let sumHead = '<tr><th rowspan="2">科组</th>';
      for (let i = 1; i <= maxW; i++) sumHead += '<th class="num" colspan="4">W' + i + '</th>';
      sumHead += '<th class="num" rowspan="2">月度预排</th><th class="num" rowspan="2">月度实际</th><th class="num" rowspan="2">月度预排<br>完成率</th><th class="num" rowspan="2">月度实际<br>完成率</th></tr>';
      let sumSubHead = '<tr>';
      for (let i = 1; i <= maxW; i++) sumSubHead += '<th class="num">指标</th><th class="num">预排</th><th class="num">实际</th><th class="num">完成率</th>';
      sumSubHead += '</tr>';
      sum += sumHead + sumSubHead + '</thead><tbody>';

      rows.forEach(r => {
        let subjSched = 0, subjProd = 0;
        let tr = '<tr><td>' + esc(r.name) + '</td>';
        for (let i = 1; i <= maxW; i++) {
          const rec = (r._list || []).find(x => x.week === i);
          const hasWeek = i <= (r.w || 0);
          const tgt = hasWeek ? (r.weekly || 0) : 0;
          const sched = rec ? num(rec.values.scheduled) : 0;
          const prod = rec ? num(rec.values.produced) : 0;
          subjSched += sched; subjProd += prod;
          const wkRate = (tgt > 0) ? prod / tgt : null;
          tr += '<td class="num">' + (hasWeek ? fmt(tgt, 1) : '<span class="muted">—</span>') + '</td>' +
            '<td class="num">' + (sched > 0 ? fmt(sched, 1) : '<span class="muted">—</span>') + '</td>' +
            '<td class="num" style="font-weight:600">' + (prod > 0 ? fmt(prod, 1) : '<span class="muted">—</span>') + '</td>' +
            '<td class="num">' + (wkRate == null ? '<span class="muted">—</span>' : pct(wkRate)) + '</td>';
        }
        const preRate = r.final > 0 ? subjSched / r.final : null;
        const actRate = r.final > 0 ? subjProd / r.final : null;
        tr += '<td class="num">' + fmt(subjSched, 1) + '</td>' +
          '<td class="num" style="font-weight:600">' + fmt(subjProd, 1) + '</td>' +
          '<td class="num">' + (preRate == null ? '<span class="muted">—</span>' : pct(preRate)) + '</td>' +
          '<td class="num">' + (actRate == null ? '<span class="muted">—</span>' : pct(actRate)) + '</td></tr>';
        sum += tr;
      });

      let campusSched = 0, campusProd = 0;
      rows.forEach(r => { (r._list || []).forEach(rec => { campusSched += num(rec.values.scheduled); campusProd += num(rec.values.produced); }); });
      let tfoot = '<tr><td class="total-label">校区总计</td>';
      for (let i = 1; i <= maxW; i++) {
        const { weekTgt, weekSched, weekProd } = wkIdx[i - 1];
        const wkRate = weekTgt > 0 ? weekProd / weekTgt : null;
        tfoot += '<td class="num">' + fmt(weekTgt, 1) + '</td>' +
          '<td class="num">' + fmt(weekSched, 1) + '</td>' +
          '<td class="num" style="font-weight:600">' + fmt(weekProd, 1) + '</td>' +
          '<td class="num">' + (wkRate == null ? '<span class="muted">—</span>' : pct(wkRate)) + '</td>';
      }
      const campusCVal = (typeof state.C === 'number' && isFinite(state.C)) ? state.C : campusFinal;
      const campusPreRate = campusCVal > 0 ? campusSched / campusCVal : null;
      const campusActRate = campusFinal > 0 ? campusProd / campusFinal : null;
      tfoot += '<td class="num" style="font-weight:600">' + fmt(campusSched, 1) + '</td>' +
        '<td class="num" style="font-weight:600">' + fmt(campusProd, 1) + '</td>' +
        '<td class="num">' + (campusPreRate == null ? '<span class="muted">—</span>' : pct(campusPreRate)) + '</td>' +
        '<td class="num">' + (campusActRate == null ? '<span class="muted">—</span>' : pct(campusActRate)) + '</td></tr>';
      sum += '</tbody><tfoot>' + tfoot + '</tfoot></table></div>';
      sum += '<div class="preview-note">月度预排完成率 = 月度预排 ÷ 月度生产指标；校区总计 = 校区月度预排 ÷ 校区生产指标 C。</div>';

      tw.innerHTML = top + detail + sum;
    }

    function handleActualFile(file) {
      const pv = $('#at_preview'); if (!pv) return;
      pv.innerHTML = '<div class="preview-note">解析中…</div>';
      parseActualFile(file).then(res => {
        const { y, m } = predictedYM();
        if (res.records.length) res.records.forEach(r => { if (!r.year) r.year = y; if (!r.month) r.month = m; });
        renderActualPreview(res);
      }).catch(err => { pv.innerHTML = '<div class="preview-note warn-cell">解析失败：' + esc(err && err.message ? err.message : String(err)) + '</div>'; });
    }
    function renderActualPreview(res) {
      const { records, errors } = res;
      const { y, m } = predictedYM();
      let h = '<div class="bk-validate">';
      if (errors.length) h += '<div class="bk-err"><b>✕ 校验提示（' + errors.length + ' 项）</b><ul>' + errors.slice(0, 20).map(e => '<li>' + esc(e.msg) + '</li>').join('') + '</ul></div>';
      else h += '<div class="bk-ok">✓ 无错误</div>';
      h += '</div>';
      h += '<div class="preview-note">已解析 <b>' + records.length + '</b> 条（预测月 = ' + y + ' 年 ' + m + ' 月；缺年份/月份自动填充）</div>';
      h += '<div class="row" style="margin-top:10px"><button class="btn primary" id="at_confirm"' + (errors.length ? ' disabled' : '') + '>确认入库（' + records.length + ' 条）</button><button class="btn ghost" id="at_cancel">取消</button></div>';
      const pv = $('#at_preview'); pv.innerHTML = h;
      const cb = $('#at_confirm');
      if (cb && !errors.length) cb.addEventListener('click', () => {
        const ym = records.length ? (records[0].year + ' 年 ' + records[0].month + ' 月') : '';
        let n = 0;
        records.forEach(r => {
          STORE.upsert({ stream: 'kezuActual', year: r.year, month: r.month, week: r.week, dimension: r.subject, values: { scheduled: r.scheduled, produced: r.produced }, importedAt: Date.now() });
          n++;
        });
        toast(n + ' 条实际数据已入库（' + ym + '）');
        pv.innerHTML = '';
        renderTrack();
      });
      const xb = $('#at_cancel'); if (xb) xb.addEventListener('click', () => { pv.innerHTML = ''; });
    }

    function exportFinal() {
      if (!calc) return '﻿';
      const head = ['科组', '单科数', '周数', '周度预测', '月度预测', '月度完成率', '达到级别', 'G1', 'G2', 'G3'];
      const lines = [head.join(',')];
      const r2 = n => Math.round(n * 100) / 100;
      calc.rows.forEach(r => {
        lines.push([r.name, r.s, r.w, r2(r.weekly), r2(r.final), Math.round(calc.completion * 10000) / 100 + '%', calc.achieved, r2(r.G1), r2(r.G2), r2(r.G3)].join(','));
      });
      lines.push(['校区总计', calc.S, '', r2(calc.sumWeeklyFinal), r2(calc.sumFinal), Math.round(calc.completion * 10000) / 100 + '%', calc.achieved, r2(calc.C * 1.0), r2(calc.C * 1.1), r2(calc.C * 1.25)].join(','));
      lines.push(['', '', '', '校区预测总盘', r2(calc.sumFinal), '校区生产指标C', r2(calc.C), '', '', ''].join(','));
      return '﻿' + lines.join('\n');
    }
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('已复制结果表到剪贴板'), () => fallbackCopy(text));
      else fallbackCopy(text);
    }
    function fallbackCopy(text) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制结果表到剪贴板'); } catch (e) { toast('复制失败，请手动选择'); }
      document.body.removeChild(ta);
    }
    function downloadCSV(text) {
      const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = '科组生产指标预测表.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      toast('已导出 CSV');
    }
    function fillMonthSelects() {
      const months = kezuMonths();
      const ys = [...new Set(months.map(m => m.year))];
      if (!ys.includes(state.year) && ys.length) state.year = ys[ys.length - 1];
      $('#tYearSel').innerHTML = ys.map(y => '<option value="' + y + '"' + (y === state.year ? ' selected' : '') + '>' + y + ' 年</option>').join('');
      const ms = months.filter(m => m.year === state.year).map(m => m.month);
      if (!ms.includes(state.month) && ms.length) state.month = ms[ms.length - 1];
      $('#tMonthSel').innerHTML = ms.map(mo => '<option value="' + mo + '"' + (mo === state.month ? ' selected' : '') + '>' + mo + ' 月</option>').join('');
    }
    function loadCurrentMonth() {
      const loaded = loadMonth(state.year, state.month);
      if (loaded) {
        const pm = predMonth(state.year, state.month);
        const predWeeks = AGG.manualMonthWeekCount(pm.year, pm.month);
        loaded.forEach(d => { d.w = predWeeks; }); // 周数取【预测月】实际自然周数，不再沿用参考月
        state.depts = loaded; toast('已读入 ' + loaded.length + ' 个科组（' + state.year + ' 年 ' + state.month + ' 月）');
      }
      else { state.depts = []; toast(state.year ? '「最佳科组」' + state.year + ' 年 ' + state.month + ' 月 暂无数据' : '暂无「最佳科组」数据，请先到「最佳科组」上传月度数据'); }
      renderDeptInputs(); recompute();
    }

    // 初始化：默认参考月随当前日期自动推进（AGG.kezuTargetFrame），预测 = 当前人工月；
    // 数据滞后/缺失时回退最近可用参考月，并显示补录指引（不再硬编码 2026/7、不再停在过期月份无提示）
    const months = kezuMonths();
    const frame = AGG.kezuTargetFrame(months, new Date());
    if (frame.ref) { state.year = frame.ref.year; state.month = frame.ref.month; }
    else if (months.length) { state.year = months[months.length - 1].year; state.month = months[months.length - 1].month; }
    const fnEl2 = $('#tFrameNote');
    if (fnEl2 && frame.note) {
      fnEl2.innerHTML = frame.state === 'ok'
        ? '<span class="muted">' + esc(frame.note) + '</span>'
        : '<span style="color:#b45309;font-weight:600">⚠ ' + esc(frame.note) + '</span>';
    }
    fillMonthSelects();
    loadCurrentMonth();
    // 初始化时同步 C 到 store，避免只在此页填写后推送失败
    persistTargetC(state.C);

    $('#tC').addEventListener('input', e => { state.C = parseFloat(e.target.value) || 0; persistTargetC(state.C); recompute(); });
    $('#tYearSel').addEventListener('change', e => {
      state.year = parseInt(e.target.value, 10); fillMonthSelects(); loadCurrentMonth();
    });
    $('#tMonthSel').addEventListener('change', e => {
      state.month = parseInt(e.target.value, 10); loadCurrentMonth();
    });
    $('#tLoad').addEventListener('click', loadCurrentMonth);
    $('#tClear').addEventListener('click', () => { state.depts = []; renderDeptInputs(); recompute(); });
    $('#tAdd').addEventListener('click', () => { state.depts.push({ name: '新科组', s: 1, h: 0, w: 4 }); renderDeptInputs(); recompute(); });
    $('#tCopy').addEventListener('click', () => copyText(exportFinal()));
    $('#tCsv').addEventListener('click', () => downloadCSV(exportFinal()));

    // —— ⑧ 实际跟踪：上传每周实际数据 ——
    const atDrop = $('#at_drop'), atFile = $('#at_file');
    function markActualFile(file) {
      const lbl = $('#at_filelabel');
      if (atDrop) atDrop.classList.add('has-file');
      if (lbl) lbl.innerHTML = '已选文件：<b>' + esc(file.name) + '</b> · 点击重新选择';
    }
    if (atDrop) {
      atDrop.addEventListener('click', e => { if (e.target.closest('button')) return; atFile.click(); });
      atDrop.addEventListener('dragover', e => { e.preventDefault(); atDrop.classList.add('drag'); });
      atDrop.addEventListener('dragleave', () => atDrop.classList.remove('drag'));
      atDrop.addEventListener('drop', e => { e.preventDefault(); atDrop.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) { markActualFile(f); handleActualFile(f); } });
      atFile.addEventListener('change', e => { const f = e.target.files[0]; if (f) { markActualFile(f); handleActualFile(f); } });
      $('#at_parse').addEventListener('click', e => { e.stopPropagation(); const f = atFile.files[0]; if (!f) { toast('请先选择文件'); return; } handleActualFile(f); });
      const atTpl = $('#at_tpl'); if (atTpl) atTpl.addEventListener('click', e => { e.stopPropagation(); downloadActualTemplate(); });
      $('#at_clear').addEventListener('click', () => {
        const { y, m } = predictedYM();
        const list = STORE.list('kezuActual').filter(r => r.year === y && r.month === m);
        if (!list.length) { toast('本月暂无实际数据'); return; }
        if (window.confirm('确认清空 ' + y + ' 年 ' + m + ' 月 的全部实际数据（' + list.length + ' 条）？')) {
          list.forEach(r => STORE.remove('kezuActual', r.year, r.month, r.week, r.dimension));
          toast('已清空本月实际数据');
          renderTrack();
        }
      });
    }
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
  function drawLine(id, labels, datasets, ySuffix) {
    destroyChart(id);
    const ctx = document.getElementById(id); if (!ctx) return;
    const suf = (ySuffix == null) ? '%' : ySuffix;
    charts[id] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: v => v + suf } } } },
    });
  }

  // —— 数据修正中心（档A：引导式修正规则 + 自动诊断）——
  // 修正以「规则」形式持久化（ca_overrides_v1），在读取 / 聚合时由 CA.applyOverrides 即插即用套用，
  // 不改动原始上传数据。本面板提供自动诊断 + 引导式建规则。
  function renderFixCenter() {
    const OV = CA.overrides;
    const STREAMS = ['weekly', 'monthly', 'bestkezu', 'bestkezu_score', 'kezuActual', 'kezuTargetC', 'tkpi', 'kpi'];

    // 记录身份标签：stream|campus|year|month|week|dimension
    function recKey(r) { return [r.stream, r.campus || '泉山', r.year, r.month, r.week, r.dimension || '_'].join('|'); }
    function recLabel(r) {
      const v1 = r.values && r.values.v1Students != null ? '（1V1=' + r.values.v1Students + '）' : '';
      return (r.campus || '泉山') + ' · ' + r.year + '-' + (r.month < 10 ? '0' + r.month : r.month) +
        ' 第' + (r.week || 0) + '周' + (r.dimension && r.dimension !== '_' ? ' [' + r.dimension + ']' : '') + v1;
    }
    // 字段候选（周报数值字段，供字段值修正引导）
    const FIELDS = (CA.SCHEMA && CA.SCHEMA.weeklyFields ? CA.SCHEMA.weeklyFields.map(x => x.key) : [])
      .concat(['v1MonthProduced', 'v6MonthProduced', 'monthCash', 'xfMonthNum', 'coreTeacherRatio', 'monthEff', 'monthSaturation'])
      .filter((v, i, a) => a.indexOf(v) === i);

    function refresh() { renderFixCenter(); }

    function addRule(rule) {
      OV.add(rule);
      toast('已添加修正规则，即时生效');
      refresh();
    }

    // —— 自动诊断：检测"异常周次"（week > 当月合理最大周数 legitMaxWeek）——
    const weekly = OV.rawRecords('weekly');
    const groups = {};
    weekly.forEach(r => { const k = (r.campus || '泉山') + '|' + r.year + '|' + r.month; (groups[k] = groups[k] || []).push(r); });
    const suggestions = [];
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      const legitMax = legitMaxWeek(g);
      g.forEach(r => { if ((r.week || 0) > legitMax) suggestions.push({ r, legitMax }); });
    });

    // 当前对账容差（%）
    const tolPct = Math.round(OV.tolerance('linkage') * 10000) / 100;

    // —— 规则列表 ——
    const rules = OV.all();
    const ruleRows = rules.length ? rules.slice().reverse().map(r => {
      let desc = '';
      if (r.type === 'weekRemap') desc = '周次重映射：' + recLabel(r) + ' → 第' + r.to + '周';
      else if (r.type === 'ignore') desc = '忽略记录：' + recLabel(r);
      else if (r.type === 'fieldOverride') desc = '字段值修正：' + recLabel(r) + ' 的 ' + r.field + ' = ' + r.value + (r.asNumber === false ? '（文本）' : '');
      else if (r.type === 'tolerance') desc = '对账容差：' + (r.scope || '全部') + ' = ' + (r.value * 100).toFixed(2) + '%';
      return '<tr><td>' + esc(desc) + '</td><td style="white-space:nowrap"><button class="btn ghost sm" data-del="' + r.id + '">删除</button></td></tr>';
    }).join('') : '<tr><td colspan="2" class="preview-note">暂无修正规则。下方诊断或手动添加后即可生效。</td></tr>';

    let html = '';
    html += '<div class="panel"><div class="panel-title">数据修正中心 · 自动诊断</div>';
    html += '<div class="panel-desc">系统扫描周报数据，自动发现"异常周次"（周序号超出该月模板「当月周数」的脏周报，如月末周误存为第 5 周）。这类数据会污染「周报对比」、产生幻影周次、并导致科组预测 1V1 人数取错。你可一键将其<b>重映射到正确周次</b>（不删原始数据）。</div>';
    if (suggestions.length) {
      html += '<div class="uc-log" style="margin-top:8px">' +
        suggestions.map((s, i) => '• ' + esc(recLabel(s.r)) + ' ⇒ 建议映射到 <b>第' + s.legitMax + '周</b>').join('<br>') + '</div>';
      html += '<div class="row" style="align-items:center;gap:10px;margin-top:10px"><button class="btn primary" id="fixApplyAll">✓ 全部应用重映射</button>' +
        '<span class="preview-note">共 ' + suggestions.length + ' 条异常周次</span></div>';
    } else {
      html += '<div class="uc-log ok-cell" style="margin-top:8px">✓ 未检测到异常周次，周报数据周次正常。</div>';
    }
    html += '</div>';

    // —— 引导式建规则 ——
    html += '<div class="panel" style="margin-top:18px"><div class="panel-title">引导式修正规则</div>';
    html += '<div class="panel-desc">选择一条数据 + 修正方式，系统生成修正规则。规则在<b>读取 / 聚合时即插即用</b>套用，原始上传数据保持不变；可随时在下方"已生效规则"中删除。</div>';
    html += '<div class="grid grid-2" style="margin-top:6px">';
    html += '<div class="field"><label>数据类型</label><select id="fixStream" class="mono">' + STREAMS.map(s => '<option value="' + s + '">' + s + '</option>').join('') + '</select></div>';
    html += '<div class="field"><label>选择数据记录</label><select id="fixRec" class="mono"></select></div>';
    html += '</div>';
    html += '<div class="field" style="margin-top:6px"><label>修正方式</label><select id="fixType" class="mono">' +
      '<option value="weekRemap">周次重映射（改写到正确周次）</option>' +
      '<option value="ignore">忽略该记录（读取时不参与计算）</option>' +
      '<option value="fieldOverride">字段值修正（覆盖某字段）</option>' +
      '</select></div>';
    html += '<div id="fixExtra"></div>';
    html += '<div class="row" style="margin-top:10px"><button class="btn primary" id="fixAdd">＋ 添加修正规则</button></div>';
    html += '<datalist id="fixFieldList">' + FIELDS.map(f => '<option value="' + f + '">').join('') + '</datalist>';
    html += '</div>';

    // —— 对账容差 ——
    html += '<div class="panel" style="margin-top:18px"><div class="panel-title">数据关联对账 · 容差</div>';
    html += '<div class="panel-desc">「数据源」页的"数据关联对账（校区 ↔ 科组）"默认容差 1%。如两系统存在合理误差，可调高容差避免误报不一致。</div>';
    html += '<div class="row" style="align-items:center;gap:10px;margin-top:6px">' +
      '<div class="field" style="margin:0"><label>容差（%）</label><input type="number" id="fixTol" class="mono" min="0" step="0.1" value="' + tolPct + '" style="width:120px"></div>' +
      '<button class="btn" id="fixTolBtn">保存容差</button>' +
      '<span class="preview-note">当前：' + tolPct + '%</span></div></div>';

    // —— 已生效规则 ——
    html += '<div class="panel" style="margin-top:18px"><div class="panel-title">已生效规则（' + rules.length + '）</div>';
    html += '<div class="table-wrap"><table><thead><tr><th>规则</th><th style="width:80px">操作</th></tr></thead><tbody id="fixRules">' + ruleRows + '</tbody></table></div>';
    html += '<div class="panel-desc" style="margin-top:8px">提示：规则即时生效。切换到「核心看板 / 数据源 / 科组生产指标」等对应看板即可看到修正后的结果；原始数据不受影响。</div>';
    html += '</div>';

    $('#content').innerHTML = html;

    // 记录下拉填充
    const recSel = $('#fixRec');
    function fillRecs() {
      const stream = $('#fixStream').value;
      const recs = OV.rawRecords(stream).slice().sort((a, b) => (b.year - a.year) || (b.month - a.month) || ((b.week || 0) - (a.week || 0)));
      recSel.innerHTML = recs.map(r => '<option value="' + recKey(r) + '">' + esc(recLabel(r)) + '</option>').join('') || '<option value="">（该类型暂无数据）</option>';
    }
    function fillExtra() {
      const type = $('#fixType').value;
      const box = $('#fixExtra');
      if (type === 'weekRemap') {
        box.innerHTML = '<div class="field" style="margin-top:6px"><label>目标周次</label><input type="number" id="fixToWeek" class="mono" min="1" max="6" value="4" style="width:120px"></div>';
      } else if (type === 'fieldOverride') {
        box.innerHTML = '<div class="grid grid-2" style="margin-top:6px">' +
          '<div class="field"><label>字段名</label><input id="fixField" class="mono" list="fixFieldList" placeholder="如 v1MonthProduced"></div>' +
          '<div class="field"><label>修正值</label><input id="fixValue" class="mono"></div></div>' +
          '<label class="check" style="margin-top:6px"><input type="checkbox" id="fixAsText"> 按文本保存（不转为数字）</label>';
      } else {
        box.innerHTML = '';
      }
    }
    fillRecs(); fillExtra();
    $('#fixStream').addEventListener('change', fillRecs);
    $('#fixType').addEventListener('change', fillExtra);

    // 全部应用重映射
    const applyAll = $('#fixApplyAll');
    if (applyAll) applyAll.addEventListener('click', () => {
      if (!confirm('将对 ' + suggestions.length + ' 条异常周次添加"重映射"规则（不改原始数据），是否继续？')) return;
      suggestions.forEach(s => OV.add({ type: 'weekRemap', stream: s.r.stream, campus: s.r.campus || '泉山', year: s.r.year, month: s.r.month, week: s.r.week, dimension: s.r.dimension || '_', to: s.legitMax, note: '自动诊断' }));
      toast('已应用 ' + suggestions.length + ' 条重映射规则');
      refresh();
    });

    // 添加单条规则
    $('#fixAdd').addEventListener('click', () => {
      const kv = recSel.value.split('|');
      if (kv.length < 6 || !kv[0]) { toast('请先选择一条数据记录'); return; }
      const base = { stream: kv[0], campus: kv[1], year: +kv[2], month: +kv[3], week: +kv[4], dimension: kv[5] || '_' };
      const type = $('#fixType').value;
      if (type === 'weekRemap') {
        const to = parseInt($('#fixToWeek').value, 10);
        if (!to || to < 1) { toast('请填写正确的目标周次'); return; }
        if (to === base.week) { toast('目标周次与当前相同，无需修正'); return; }
        addRule(Object.assign({ type: 'weekRemap', to, note: '手动' }, base));
      } else if (type === 'ignore') {
        if (!confirm('将忽略该记录（读取时不参与任何计算，但原始数据保留）。是否继续？')) return;
        addRule(Object.assign({ type: 'ignore', note: '手动' }, base));
      } else if (type === 'fieldOverride') {
        const field = $('#fixField').value.trim();
        const val = $('#fixValue').value;
        if (!field) { toast('请填写字段名'); return; }
        if (val === '' || val == null) { toast('请填写修正值'); return; }
        const asText = $('#fixAsText') && $('#fixAsText').checked;
        addRule(Object.assign({ type: 'fieldOverride', field, value: val, asNumber: !asText, note: '手动' }, base));
      }
    });

    // 保存容差
    $('#fixTolBtn').addEventListener('click', () => {
      const pct = parseFloat($('#fixTol').value);
      if (!isFinite(pct) || pct < 0) { toast('请填写有效的容差百分比'); return; }
      OV.add({ type: 'tolerance', scope: 'linkage', value: pct / 100, note: '手动' });
      toast('已保存对账容差 ' + pct + '%');
      refresh();
    });

    // 删除规则
    $all('#fixRules [data-del]').forEach(b => b.addEventListener('click', () => {
      OV.remove(parseInt(b.getAttribute('data-del'), 10));
      toast('已删除该规则');
      refresh();
    }));
  }

  // —— 路由 ——
  const tabs = {
    kezu: { title: '最佳科组', render: renderKezu },
    target: { title: '科组生产指标', render: renderTarget },
    kpi: { title: '教师 KPI', render: renderKpi },
    compare: { title: '数据源', render: renderCompare },
    fix: { title: '数据修正', render: renderFixCenter },
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
