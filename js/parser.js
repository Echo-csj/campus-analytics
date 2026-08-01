/*
 * parser.js — xlsx 一键提取（依赖 vendor/xlsx.full.min.js 的全局 XLSX）
 * 周报：DOS周报·数据统计表（标签→值单列结构）
 * 科组/教师：首行表头 + 每行一个维度
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    let s = String(v).replace(/[%%,，\s]/g, '').replace(/[¥￥]/g, '');
    if (s === '' || s === '#DIV/0!' || s === '#VALUE!' || s === '/') return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function sheetToMatrix(ws) {
    const out = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    return out;
  }

  // —— 周报解析 ——
  function parseWeekly(file, ctx) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          let ws = wb.Sheets['数据统计表'] || wb.Sheets[wb.SheetNames[0]];
          const matrix = sheetToMatrix(ws);
          const values = {};
          let unmatched = [];
          let rows = [];   // 忠实保留原表每一行的「事项→值」，供对比中心按原表对齐
          let weekSeq = null, totalWeeks = null;
          for (const row of matrix) {
            const label = row[0];
            const val = row[1];
            if (label == null) continue;
            const lab = String(label).trim();
            const rawStr = (val == null ? '' : String(val).trim());
            const isPct = /[%％]/.test(rawStr);
            const num = toNum(val);
            // 对比图表统一用「百分数」坐标：带%号时 num 已是百分数(0.97/98)；
            // 不带%号的小数(0.8823)实为小数，×100 得百分数(88.23)，与带%号口径对齐。
            let cellNum = num;
            if (f && f.type === 'ratio' && f.unit !== '比' && !isPct && typeof num === 'number') cellNum = num * 100;
            rows.push({ label: lab, raw: rawStr, num: cellNum, isPct: isPct, text: rawStr });
            // 规范字段映射：精确匹配优先，否则大小写不敏感匹配
            let f = CA.SCHEMA.weeklyLabelMap[lab];
            if (!f) f = CA.SCHEMA.weeklyLabelMapCI[lab.toLowerCase()];
            if (f) {
              let n = (f.type === 'text') ? (val == null ? '' : String(val)) : num;
              // 比例类字段统一存为小数(0–1)：
              //  · 原表带「%」号 → 必为百分数，直接 ÷100（98%→0.98，0.97%→0.0097）
              //  · 无「%」号但 >1 → 兼容老数据按百分数处理 ÷100
              //  · 无「%」号且 ≤1 → 视为已为小数/分数（如 7月周报的 0.8823；单科比经 unit 排除）
              if (f.type === 'ratio' && f.unit !== '比' && (isPct || (typeof n === 'number' && n > 1))) n = n / 100;
              values[f.key] = n;
              if (f.key === 'weekSeq') weekSeq = n;
              if (f.key === 'totalWeeksOfMonth') totalWeeks = n;
            } else {
              unmatched.push(lab);
            }
          }
          const isMonthEnd = (weekSeq != null && totalWeeks != null) ? (weekSeq === totalWeeks) : false;
          resolve({ values, unmatched, rows, detected: { weekSeq, totalWeeks, isMonthEnd } });
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // —— 科组 / 教师 通用解析 ——
  function parseDimension(file, stream, ctx) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const matrix = sheetToMatrix(ws);
          const mapping = CA.templates.getMapping(stream);
          // 找到表头行（含 dimensionHeader）
          let headerIdx = -1;
          for (let i = 0; i < Math.min(matrix.length, 10); i++) {
            const row = matrix[i] || [];
            if (row.some(c => c != null && String(c).trim() === mapping.dimensionHeader)) { headerIdx = i; break; }
          }
          if (headerIdx < 0) throw new Error('未找到表头（应包含「' + mapping.dimensionHeader + '」列）');
          const headers = (matrix[headerIdx] || []).map(c => c == null ? '' : String(c).trim());
          const map = mapping.map;
          const rows = [];
          let unmatchedCols = [];
          for (let i = headerIdx + 1; i < matrix.length; i++) {
            const row = matrix[i] || [];
            if (!row.some(c => c != null && String(c).trim() !== '')) continue;
            const dim = row[headers.indexOf(mapping.dimensionHeader)];
            if (dim == null || String(dim).trim() === '') continue;
            const vals = {};
            const fieldDef = (k) => CA.SCHEMA.kezuFields.find(f => f.key === k) || CA.SCHEMA.kpiFields.find(f => f.key === k);
            headers.forEach((h, ci) => {
              const key = map[h];
              if (key) {
                if (key === 'dimension') return;
                const raw = row[ci];
                const rawStr = (raw == null ? '' : String(raw).trim());
                const rawHasPct = /[%％]/.test(rawStr);
                let v = (raw == null ? null : (typeof raw === 'number' ? raw : (key === 'subjectGroup' ? String(raw) : toNum(raw))));
                const fdef = fieldDef(key);
                // 比例类字段：带「%」号或 >1 时按百分数归一为小数（98%→0.98，0.97%→0.0097）；「比」类保持原值
                if (fdef && fdef.type === 'ratio' && fdef.unit !== '比' && (rawHasPct || (typeof v === 'number' && v > 1))) v = v / 100;
                vals[key] = v;
              } else if (h) {
                if (!unmatchedCols.includes(h)) unmatchedCols.push(h);
              }
            });
            rows.push({ dimension: String(dim).trim(), values: vals });
          }
          resolve({ rows, unmatchedCols, headers });
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  CA.parser = { parseWeekly, parseDimension, toNum };

})(window);
