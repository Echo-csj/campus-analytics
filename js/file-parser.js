/*
 * file-parser.js — 通用文件上传解析引擎（CSV / TSV / Excel / JSON）
 * 暴露 window.CA.FileParser.parseFile(file)：返回 Promise<{tables, meta}>。
 * 设计目标：浏览器本地解析、闭环错误处理、便于上层 UI 做加载/错误/空/成功四态呈现。
 * 依赖：XLSX（vendor/xlsx.full.min.js，解析 Excel 时必需）。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  const ALLOWED = {
    csv:  { label: 'CSV / 分隔文本', kind: 'text' },
    tsv:  { label: 'TSV', kind: 'text' },
    txt:  { label: '分隔文本', kind: 'text' },
    xlsx: { label: 'Excel', kind: 'excel' },
    xls:  { label: 'Excel', kind: 'excel' },
    json: { label: 'JSON', kind: 'json' },
  };

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function readText(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function detectDelimiter(text) {
    const sample = text.slice(0, 6000);
    const cands = [',', '\t', ';', '|'];
    let best = ',', bestCount = -1;
    cands.forEach(function (d) {
      const count = sample.split(d).length;
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
  }

  function parseCSV(text) {
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let i = 0, inQ = false;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function aoaToTable(aoa) {
    const hIdx = aoa.findIndex(function (r) {
      return r && r.some(function (c) { return c != null && String(c).trim() !== ''; });
    });
    if (hIdx < 0) return { columns: [], rows: [] };
    const header = aoa[hIdx].map(function (h, i) {
      return (h == null || String(h).trim() === '') ? ('列' + (i + 1)) : String(h).trim();
    });
    const rows = [];
    for (let r = hIdx + 1; r < aoa.length; r++) {
      const ar = aoa[r];
      if (!ar || ar.every(function (c) { return c == null || String(c).trim() === ''; })) continue;
      const obj = {};
      header.forEach(function (h, i) { obj[h] = (ar[i] === undefined) ? null : ar[i]; });
      rows.push(obj);
    }
    return { columns: header, rows: rows };
  }

  function parseExcel(buf) {
    if (typeof XLSX === 'undefined') throw new Error('Excel 解析库未加载（请检查网络或 vendor/xlsx.full.min.js）。');
    const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: true });
    return wb.SheetNames.map(function (name) {
      const ws = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      const t = aoaToTable(aoa);
      return { name: name, columns: t.columns, rows: t.rows };
    });
  }

  function parseJSON(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('JSON 语法错误：' + (e.message || e)); }
    if (Array.isArray(data)) {
      if (data.length === 0) return { columns: [], rows: [] };
      const first = data[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        const cols = [];
        data.forEach(function (o) {
          if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
        });
        const rows = data.map(function (o) {
          const r = {};
          cols.forEach(function (c) { r[c] = (o && typeof o === 'object' && c in o) ? o[c] : null; });
          return r;
        });
        return { columns: cols, rows: rows };
      }
      if (Array.isArray(first)) {
        const h = first.map(function (_, i) { return '列' + (i + 1); });
        const rr = data.slice(1).map(function (ar) {
          const o = {}; h.forEach(function (c, i) { o[c] = (ar[i] === undefined) ? null : ar[i]; }); return o;
        });
        return { columns: h, rows: rr };
      }
      return { columns: ['值'], rows: data.map(function (v) { return { '值': v }; }) };
    }
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      const f0 = data[keys[0]];
      if (f0 && typeof f0 === 'object' && !Array.isArray(f0)) {
        const c2 = ['键'];
        keys.forEach(function (k) { Object.keys(data[k]).forEach(function (c) { if (c2.indexOf(c) < 0) c2.push(c); }); });
        const rr = keys.map(function (k) {
          const o = { '键': k }; c2.slice(1).forEach(function (c) { o[c] = data[k] ? data[k][c] : null; }); return o;
        });
        return { columns: c2, rows: rr };
      }
      return { columns: ['键', '值'], rows: keys.map(function (k) { return { '键': k, '值': data[k] }; }) };
    }
    throw new Error('无法识别的 JSON 结构：顶层需为对象或数组。');
  }

  function parseTextTables(text) {
    const aoa = parseCSV(text);
    const t = aoaToTable(aoa);
    return [{ name: '文本', columns: t.columns, rows: t.rows }];
  }

  // 主入口：Promise 化，所有校验/解析异常通过 reject 暴露给上层 UI
  function parseFile(file) {
    return new Promise(function (resolve, reject) {
      const ext = extOf(file.name);
      const info = ALLOWED[ext];
      if (!info) {
        return reject(new Error('不支持的文件格式 .' + (ext || '?') +
          '。仅支持：' + Object.keys(ALLOWED).map(function (k) { return '.' + k; }).join('、') + '。'));
      }
      if (file.size === 0) {
        return reject(new Error('文件大小为 0 字节，文件为空，无法解析。'));
      }
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      file.arrayBuffer().then(function (buf) {
        try {
          let tables;
          if (info.kind === 'excel') tables = parseExcel(buf);
          else if (info.kind === 'json') tables = [parseJSON(readText(buf))];
          else tables = parseTextTables(readText(buf));
          const rows = tables.reduce(function (s, t) { return s + t.rows.length; }, 0);
          const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
          resolve({ tables: tables, meta: { name: file.name, size: file.size, format: info.label, sheets: tables.length, rows: rows, ms: ms } });
        } catch (e) {
          reject(new Error((e && e.message) ? e.message : String(e)));
        }
      }).catch(function (e) {
        reject(new Error('文件读取失败：' + ((e && e.message) || e)));
      });
    });
  }

  CA.FileParser = {
    parseFile: parseFile,
    parseCSV: parseCSV,
    parseExcel: parseExcel,
    parseJSON: parseJSON,
    aoaToTable: aoaToTable,
    ALLOWED: ALLOWED,
    extOf: extOf,
  };
})(typeof window !== 'undefined' ? window : global);
