/*
 * kezu-parser.js — 最佳科组「月度数据」上传解析引擎
 * 能力：
 *   1. 读取 Excel/CSV（浏览器 FileReader + SheetJS）
 *   2. 布局识别：长表（科组×月，一行一条）/ 宽表（科组行 × 月×指标列）自动逆透视
 *   3. 字段别名模糊匹配（月份/科组/课时/单科数/各项人数/教师/离职…）
 *   4. 派生计算（周平均、各率，统一口径）
 *   5. 数据校验（缺失/类型/口径/重复）+ 错误提示
 * 纯函数 parseMatrix(sheets) 不依赖浏览器，便于 Node 测试。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});
  const BK = CA.BESTKEZU;
  const SUBJECTS = BK.SUBJECTS;

  // —— 基础工具 ——
  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    let s = String(v).trim().replace(/,/g, '');
    if (s === '' || s === '-' || s === '—' || s === '—' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'na') return null;
    let pct = false;
    if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return pct ? n / 100 : n;
  }

  function parseMonth(v) {
    if (v == null) return { year: null, month: null };
    if (typeof v === 'number') { const m = Math.round(v); return { year: null, month: (m >= 1 && m <= 12) ? m : null }; }
    const s = String(v).trim();
    let year = null, month = null;
    const ym = s.match(/(\d{4})\s*[-/年]\s*(\d{1,2})/);
    if (ym) { year = +ym[1]; month = +ym[2]; }
    else {
      const justM = s.match(/(\d{1,2})\s*月?/);
      if (justM) month = +justM[1];
      else {
        const en = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
        const low = s.toLowerCase();
        for (const k in en) if (low.includes(k)) { month = en[k]; break; }
      }
    }
    if (month && (month < 1 || month > 12)) month = null;
    return { year, month };
  }

  function parseSubject(v) {
    if (v == null) return null;
    const s = String(v).trim();
    const map = { '数学': '数学', '英语': '英语', '文综': '文综', '理综': '理综',
      '数学组': '数学', '英语组': '英语', '文综组': '文综', '理综组': '理综',
      '数': '数学', '英': '英语', '文': '文综', '理': '理综',
      'math': '数学', 'english': '英语', 'shuxue': '数学' };
    if (map[s]) return map[s];
    for (const k of SUBJECTS) if (s.includes(k)) return k;
    return s; // 未知，交校验
  }

  // 列标题 → 字段 key（精确 label / 精确别名 / 关键词，关键词排除单字“月”“周”防误配）
  function matchField(header) {
    if (!header) return null;
    const s = String(header).trim();
    if (!s) return null;
    const byLabel = BK.FIELDS.find(f => f.label === s);
    if (byLabel) return byLabel.key;
    const norm = s.toLowerCase().replace(/\s+/g, '').replace(/[（）()]/g, '').replace(/[数数量个人员次]/g, '');
    for (const key in BK.ALIASES) {
      for (const a of BK.ALIASES[key]) {
        const an = a.toLowerCase().replace(/\s+/g, '').replace(/[（）()]/g, '').replace(/[数数量个人员次]/g, '');
        if (norm === an) return key;
      }
    }
    const kw = {
      month: ['月份'], subject: ['科组', '学科', '科目'], hours: ['课时'], subjects: ['单科数', '学科数'],
      weeks: ['周数'], jieke: ['结课'], tingke: ['停课'], tuifei: ['退费'], xufei: ['续费'],
      teachers: ['教师数', '教师'], quit: ['离职'], weekAvg: ['周平均'],
      jiekeRate: ['结课率'], tingkeRate: ['停课率'], tuifeiRate: ['退费率'], xufeiRate: ['续费率'], quitRate: ['离职率'],
    };
    const cands = [];
    // 关键词兜底仅作用于「短表头」，避免长标题（如“全年科组数据明细…”）误命中
    if (s.length <= 8) {
      for (const key in kw) for (const k of kw[key]) if (s.includes(k)) cands.push({ key, len: k.length });
    }
    if (cands.length) { cands.sort((a, b) => b.len - a.len); return cands[0].key; }
    return null;
  }

  // 在表前若干行中定位真正的表头行：要求命中全部 needKeys（如 month+subject）
  function findHeader(aoa, needKeys) {
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const map = {};
      aoa[i].forEach((h, c) => { const k = matchField(h); if (k) map[c] = k; });
      if (needKeys.every(k => Object.values(map).includes(k))) return { idx: i, map };
    }
    return null;
  }

  function extractMonth(text) {
    if (!text) return null;
    const cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
    let m = text.match(/(\d{1,2})\s*月/);
    if (m) { const v = +m[1]; return (v >= 1 && v <= 12) ? v : null; }
    for (const k in cn) if (text.includes(k + '月')) return cn[k];
    return null;
  }

  // 展开合并单元格（块标题传播到子列）
  function expandMerges(aoaRaw, merges) {
    const grid = aoaRaw.map(r => r.slice());
    if (merges) merges.forEach(m => {
      const { r: top, c: left } = m.s, bottom = m.e.r, right = m.e.c;
      const val = (grid[top] && grid[top][left] != null) ? grid[top][left] : null;
      for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
        if (!grid[r]) grid[r] = [];
        if (grid[r][c] == null) grid[r][c] = val;
      }
    });
    return grid;
  }

  // —— 长表解析 ——
  function detectLong(rows) {
    const hdr = findHeader(rows, ['month', 'subject']);
    if (hdr) return { headerMap: hdr.map, dataRows: rows.slice(hdr.idx + 1) };
    return null;
  }
  function parseLong({ headerMap, dataRows }) {
    const recs = [];
    dataRows.forEach(row => {
      const r = {};
      let hasAny = false;
      for (const ci in headerMap) {
        const key = headerMap[ci], raw = row[ci];
        if (raw == null || String(raw).trim() === '') continue;
        hasAny = true;
        if (key === 'month') { const pm = parseMonth(raw); if (pm.year != null) r.year = pm.year; r.month = pm.month; }
        else if (key === 'subject') r.subject = parseSubject(raw);
        else { const n = toNum(raw); if (n != null) r[key] = n; }
      }
      const hasMetric = ['hours', 'subjects', 'jieke', 'tingke', 'tuifei', 'xufei', 'teachers', 'quit'].some(k => r[k] != null);
      if (hasAny && (r.subject || r.month != null) && hasMetric) recs.push(r);
    });
    return recs;
  }

  // —— 宽表解析（逆透视）——
  function detectWide(rows) {
    const hdr = findHeader(rows, ['subject']);
    if (!hdr) return null;
    const headerRow = hdr.idx;
    const subjMap = hdr.map;
    let subjCol = -1;
    for (const c in subjMap) if (subjMap[c] === 'subject') { subjCol = +c; break; }
    if (subjCol < 0) {
      for (let c = 0; c < rows[headerRow].length; c++) {
        let cnt = 0, tot = 0;
        for (let r = headerRow + 1; r < rows.length; r++) { const v = rows[r][c]; if (v == null) continue; tot++; if (SUBJECTS.includes(parseSubject(v))) cnt++; }
        if (tot > 0 && cnt / tot > 0.6) { subjCol = c; break; }
      }
    }
    if (subjCol < 0) return null;
    // 列分类（带月份继承）：标题行为 headerRow 之上各行
    const colInfo = [];
    let currentMonth = null;
    for (let c = 0; c < rows[headerRow].length; c++) {
      if (c === subjCol) continue;
      let text = '';
      for (let r = 0; r < headerRow; r++) if (rows[r][c] != null) text += String(rows[r][c]);
      if (!text.trim()) continue;
      const m = extractMonth(text);
      if (m != null) currentMonth = m;
      const f = matchField(rows[headerRow][c]);
      if (f) colInfo.push({ col: c, month: m != null ? m : currentMonth, field: f });
    }
    const usable = colInfo.filter(x => x.month != null).map(x => ({ col: x.col, month: x.month, field: x.field }));
    if (!usable.length) return null;
    // 数据行：按 (科组, 月) 拆分
    const recs = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const subjRaw = rows[r][subjCol];
      if (subjRaw == null || String(subjRaw).trim() === '') continue;
      const subject = parseSubject(subjRaw);
      if (!subject || !SUBJECTS.includes(subject)) continue;
      const byMonth = {};
      usable.forEach(x => {
        const raw = rows[r][x.col];
        if (raw == null || String(raw).trim() === '') return;
        const n = toNum(raw);
        if (n == null) return;
        byMonth[x.month] = byMonth[x.month] || { subject, month: x.month };
        byMonth[x.month][x.field] = n;
      });
      Object.values(byMonth).forEach(rec => { if (Object.keys(rec).length > 2) recs.push(rec); });
    }
    return recs.length ? recs : null;
  }

  // —— 派生 + 校验 ——
  function deriveRecord(r) {
    const s = r.subjects, w = r.weeks, h = r.hours;
    r.weekAvg = (h != null && s && w) ? h / w / s : null;
    r.jiekeRate = (r.jieke != null && s) ? r.jieke / s : null;
    r.tingkeRate = (r.tingke != null && (r.tingke + s)) ? r.tingke / (r.tingke + s) : null;
    r.tuifeiRate = (r.tuifei != null && (r.tuifei + s)) ? r.tuifei / (r.tuifei + s) : null;
    r.xufeiRate = (r.xufei != null && s) ? r.xufei / s : null;
    r.quitRate = (r.quit != null && (r.quit + (r.teachers || 0))) ? r.quit / (r.quit + (r.teachers || 0)) : null;
    r.quarter = r.month ? Math.floor((r.month - 1) / 3) + 1 : null;
    return r;
  }

  function validate(records) {
    const errors = [], warnings = [];
    const seen = new Set();
    records.forEach((r, idx) => {
      const line = '第 ' + (idx + 1) + ' 行';
      if (r.month == null) errors.push({ row: idx, msg: line + '：缺失「月份」' });
      else if (r.month < 1 || r.month > 12) errors.push({ row: idx, msg: line + '：月份 ' + r.month + ' 超出 1–12' });
      if (!r.subject) errors.push({ row: idx, msg: line + '：缺失「科组」' });
      else if (!SUBJECTS.includes(r.subject)) errors.push({ row: idx, msg: line + '：科组「' + r.subject + '」不在 {数学, 英语, 文综, 理综}' });
      ['hours', 'subjects', 'weeks', 'jieke', 'tingke', 'tuifei', 'xufei', 'teachers', 'quit'].forEach(k => {
        if (r[k] != null && r[k] < 0) errors.push({ row: idx, msg: line + '：' + k + ' 为负值（' + r[k] + '）' });
      });
      if (r.weeks == null) warnings.push({ row: idx, msg: line + '：缺失「周数」，周平均无法计算（保留空白）' });
      if (r.subjects === 0) warnings.push({ row: idx, msg: line + '：单科数为 0，相关率无法计算（保留空白）' });
      BK.RATE_KEYS.forEach(rk => {
        const raw = r['_raw_' + rk];
        if (raw == null) return;
        if (r['_raw_' + rk + '_pctwarn']) {
          warnings.push({ row: idx, msg: line + '：' + rk + ' 原始值 ' + (raw * 100) + ' 疑似百分数未带 % 号，已按 ' + raw.toFixed(4) + '（÷100）处理' });
          return;
        }
        const denom = BK.DENOM[rk](r);
        const person = r[BK.PERSON_KEYS[rk]];
        if (denom && person != null) {
          const calc = person / denom;
          if (Math.abs(calc - raw) > 0.05) warnings.push({ row: idx, msg: line + '：' + rk + ' 原始 ' + (raw * 100).toFixed(1) + '% 与人数重算 ' + (calc * 100).toFixed(1) + '% 偏差较大，已采用重算值' });
        }
      });
      if (r.subject && r.month != null) {
        const kk = r.subject + '|' + r.month;
        if (seen.has(kk)) errors.push({ row: idx, msg: line + '：重复记录（' + r.subject + ' ' + r.month + ' 月）' });
        else seen.add(kk);
      }
    });
    return { errors, warnings };
  }

  // —— 评比相关 sheet 解析（Sheet3 全年汇总透视 / Sheet4 季度考试数据 / Sheet5 最佳科组评比汇总）——
  // 这些表是源文件中已计算好的派生/评比视图，工作台原样呈现即可（含评分排名）。
  const SCORE_SHEET_NAMES = ['全年汇总透视', '季度考试数据', '最佳科组评比汇总'];

  function isScoreHeader(row) {
    if (!row) return false;
    const cells = row.filter(c => c != null && String(c).trim() !== '');
    if (cells.length < 3) return false;
    const f = String(row[0] || '').trim();
    return ['科组', '月份', '季度', '序号'].indexOf(f) >= 0;
  }
  function isScoreTitle(row) {
    if (!row) return false;
    const cells = row.map(c => c != null ? String(c).trim() : '').filter(c => c !== '');
    if (!cells.length) return false;
    // 整行皆为数字（如预留的全 0 行）→ 视为数据，不是标题
    if (cells.every(c => /^[-\d.]+$/.test(c))) return false;
    if (cells.length === 1) {
      // 单个单元格：若是已知科组名（如 Q2 的「数学」空行），属数据行占位而非标题
      if (SUBJECTS.indexOf(cells[0]) >= 0) return false;
      return true;
    }
    if (cells.every(c => c === cells[0])) return true; // 合并单元格展开的整行标题
    const f = cells[0];
    if (/^[一二三四五六]、/.test(f)) return true;       // 一、按科组（全年）
    if (/权重/.test(f)) return true;                    // ▌Q1 （权重：...）
    if (/^[\s▌]*[Qq]\d/.test(f)) return true;           // Q1（源：...）
    return false;
  }
  // 从一张表的原始行（含空行）中抽取所有「表头 + 数据块」
  function extractScoreBlocks(rows) {
    const blocks = [];
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (!row || row.every(c => c == null || String(c).trim() === '')) { i++; continue; }
      if (isScoreHeader(row)) {
        const header = row.map(c => (c == null ? '' : String(c).trim()));
        let title = '';
        for (let t = i - 1; t >= 0; t--) {
          if (rows[t] && isScoreTitle(rows[t])) { const fc = rows[t].find(c => c != null && String(c).trim() !== ''); title = fc ? String(fc).trim() : ''; break; }
        }
        const dataRows = [];
        let j = i + 1;
        while (j < rows.length) {
          const dr = rows[j];
          if (!dr || dr.every(c => c == null || String(c).trim() === '')) break; // 空行结束本块
          if (isScoreHeader(dr)) break;  // 下一张表
          if (isScoreTitle(dr)) break;   // 下一个分区
          const nonEmpty = dr.filter(c => c != null && String(c).trim() !== '').length;
          if (nonEmpty <= 1) { j++; continue; } // 跳过仅首格标签（如「合计」占位）
          dataRows.push(dr.map(c => (c == null ? null : c)));
          j++;
        }
        blocks.push({ title: title || '', header, rows: dataRows });
        i = j;
      } else {
        i++;
      }
    }
    return blocks;
  }
  function parseScoreSheets(sheets) {
    const result = { pivot: null, exam: null, rating: null, consumed: [] };
    // 精确匹配优先，再按关键词/Sheet序号兜底
    const byName = n => sheets.find(s => s.name === n);
    const byInclude = keys => sheets.find(s => keys.some(k => String(s.name || '').includes(k)));
    const bySheetIndex = n => sheets.find(s => String(s.name || '').toLowerCase() === 'sheet' + n);
    const piv = byName('全年汇总透视') || byInclude(['汇总透视', '全年汇总']) || bySheetIndex(3);
    const exam = byName('季度考试数据') || byInclude(['考试数据', '季度考试']) || bySheetIndex(4);
    const rating = byName('最佳科组评比汇总') || byInclude(['最佳科组', '评比汇总', '科组评比', '评比排名', '排名']) || bySheetIndex(5);
    if (piv) { result.pivot = { name: piv.name, blocks: extractScoreBlocks(piv.rows) }; result.consumed.push(piv.name); }
    if (exam) { result.exam = { name: exam.name, blocks: extractScoreBlocks(exam.rows) }; result.consumed.push(exam.name); }
    if (rating) { result.rating = { name: rating.name, blocks: extractScoreBlocks(rating.rows) }; result.consumed.push(rating.name); }
    return result;
  }

  // —— 主入口（纯函数）——
  function parseMatrix(sheets) {
    const allRecs = [];
    const sheetReports = [];
    sheets.forEach(sh => {
      const rows = (sh.rows || []).filter(r => r && r.some(c => c != null && String(c).trim() !== ''));
      if (rows.length < 2) { sheetReports.push({ name: sh.name, status: 'empty' }); return; }
      let recs = null, layout = null;
      const longRes = detectLong(rows);
      if (longRes) { recs = parseLong(longRes); layout = 'long'; }
      else { const wideRes = detectWide(rows); if (wideRes) { recs = wideRes; layout = 'wide'; } }
      if (recs && recs.length) {
        recs.forEach(r => { r._sheet = sh.name; });
        allRecs.push(...recs);
        sheetReports.push({ name: sh.name, status: 'ok', count: recs.length, layout });
      } else {
        sheetReports.push({ name: sh.name, status: 'unrecognized' });
      }
    });
    allRecs.forEach(r => { if (r.year == null) r.year = 2026; });
    // 率字段：备份原始 + 处理裸百分数
    allRecs.forEach(r => {
      BK.RATE_KEYS.forEach(rk => {
        if (r[rk] != null && typeof r[rk] === 'number') {
          if (r[rk] > 1) { r['_raw_' + rk + '_pctwarn'] = true; r[rk] = r[rk] / 100; }
          r['_raw_' + rk] = r[rk];
        }
      });
    });
    allRecs.forEach(deriveRecord);
    const { errors, warnings } = validate(allRecs);
    sheetReports.filter(s => s.status !== 'ok').forEach(s => {
      warnings.push({ msg: '未识别/空 sheet：' + s.name + '（' + ({ empty: '空表', unrecognized: '未能识别为长表或宽表' }[s.status] || s.status) + '）' });
    });
    // 评比相关 sheet（汇总透视/季度考试/评比汇总）单独解析，抑制其原 unrecognized 警告
    const score = parseScoreSheets(sheets);
    const consumed = score.consumed || [];
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (consumed.some(n => warnings[i].msg.indexOf(n) >= 0)) warnings.splice(i, 1);
    }
    return {
      records: allRecs,
      errors, warnings,
      layout: (sheetReports.find(s => s.status === 'ok') || {}).layout || 'unknown',
      sheetReports,
      score,
    };
  }

  // —— 浏览器入口 ——
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
          const sheets = wb.SheetNames.map(name => {
            const ws = wb.Sheets[name];
            const aoaRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
            const aoa = expandMerges(aoaRaw, ws['!merges']);
            return { name, rows: aoa };
          });
          resolve(parseMatrix(sheets));
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  CA.BESTKEZU.parseMatrix = parseMatrix;
  CA.BESTKEZU.parseFile = parseFile;
  CA.BESTKEZU.parseScoreSheets = parseScoreSheets;
  CA.BESTKEZU.toNum = toNum;
  CA.BESTKEZU.matchField = matchField;
})(typeof window !== 'undefined' ? window : global);
