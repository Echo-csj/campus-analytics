/*
 * parser.js — xlsx 一键提取（依赖 vendor/xlsx.full.min.js 的全局 XLSX）
 * 周报：DOS周报·数据统计表（标签→值单列结构）
 * 科组/教师：首行表头 + 每行一个维度
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 科组/教师 周报默认表头 → 内部字段（模板中心已移除，内联默认映射供解析使用）
  const DIM_DEFAULT = {
    kezu: {
      dimensionHeader: '科组',
      map: {
        '科组': 'dimension', '单科数': 'subjects', '课时': 'hours',
        '结课单科': 'jkSubj', '退费单科': 'tfSubj', '停课单科': 'tkSubj',
        '续费单科': 'xfSubj', '推荐单科': 'tjSubj', '教师数': 'teacherCount',
        '离职人数': 'quitCount', '进步率': 'progressRate',
      },
    },
    kpi: {
      dimensionHeader: '教师',
      map: {
        '教师': 'dimension', '学科组': 'subjectGroup', '周课时': 'weekHours',
        '周课次': 'weekSessions', '周参考课次': 'weekRefSessions',
        '周饱和度': 'saturation', '周进步率': 'progressRate',
      },
    },
  };

  function getDimMapping(stream) {
    return DIM_DEFAULT[stream] || DIM_DEFAULT.kpi;
  }

  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    let s = String(v).replace(/[%%,，\s]/g, '').replace(/[¥￥]/g, '');
    if (s === '' || s === '#DIV/0!' || s === '#VALUE!' || s === '/') return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function sheetToMatrix(ws) {
    // raw:true 读取单元格原始值：百分比格式单元格的 underlying value 即为小数（0.7039），
    // 避免 formatted value "7039%" 被误判为 7039 再 ÷100 导致扩大 100 倍。
    const out = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    return out;
  }

  // 简易百分数格式化（与 app.js 的 pct 保持一致）
  function pct(v) {
    if (v == null) return '';
    const p = Math.round(v * 10000) / 100;
    let s = p.toFixed(2);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s + '%';
  }

  // 标签清洗：去空格、去常见后缀，用于兜底模糊匹配
  function normalizeLabel(s) {
    return String(s).trim().replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '').replace(/(数|量|个)$/g, '').toLowerCase();
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
          // 同时取「格式化文本」矩阵：用于识别「自定义百分比格式」单元格
          // （显示带 % 但底层值 ≤1，如单元格格式 0.00"%" + 填 0.78 → 显示 0.78% 但底层存 0.78），
          // 若不处理会被当成小数分数直接显示成 78%。普通百分比格式(0.00%)底层已是小数，不受影响。
          const fmtMatrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
          const values = {};
          let unmatched = [];
          let rows = [];   // 忠实保留原表每一行的「事项→值」，供对比中心按原表对齐
          let weekSeq = null, totalWeeks = null;
          matrix.forEach((row, i) => {
            const label = row[0];
            const val = row[1];
            if (label == null) return;
            const lab = String(label).trim();
            const rawStr = (val == null ? '' : String(val).trim());
            const fmtCell = (fmtMatrix[i] && fmtMatrix[i][1] != null) ? String(fmtMatrix[i][1]).trim() : '';
            const fmtHasPct = /[%％]/.test(fmtCell);
            // raw:true 下百分比格式单元格已返回小数；fmtHasPct 用于自定义%格式单元格
            const isPct = /[%％]/.test(rawStr);
            const num = toNum(val);
            // 规范字段映射：精确匹配 → 别名匹配 → 大小写不敏感 → 清洗后兜底匹配
            let f = CA.SCHEMA.weeklyLabelMap[lab];
            if (!f) f = CA.SCHEMA.weeklyLabelMapAliases[lab];
            if (!f) f = CA.SCHEMA.weeklyLabelMapCI[lab.toLowerCase()];
            if (!f) f = CA.SCHEMA.weeklyLabelMapCI[normalizeLabel(lab)] || CA.SCHEMA.weeklyLabelMapAliases[normalizeLabel(lab)];
            // 入库 values：比例类字段统一存为小数(0–1)
            let storeVal = (f && f.type === 'text') ? (val == null ? '' : String(val)) : num;
            if (f && f.type === 'ratio' && f.unit !== '比') {
              const fmtNum = fmtHasPct ? toNum(fmtCell) : null;
              if (fmtHasPct && fmtNum != null && typeof num === 'number') {
                // 有 % 单元格格式：区分标准百分比格式（raw 已是小数）与自定义百分比格式（raw=显示值）
                // 标准格式：raw=0.78 显示 78%；raw=1.4 显示 140% → fmtNum ≈ num*100
                // 自定义格式：raw=0.78 显示 0.78% → fmtNum ≈ num
                if (Math.abs(fmtNum - num * 100) < 1e-6) {
                  storeVal = num; // 标准百分比格式，保持 raw 小数
                } else {
                  storeVal = fmtNum / 100; // 自定义百分比格式，按显示值÷100
                }
              } else if (isPct) {
                // 文本带 % 号（无单元格格式）
                storeVal = toNum(fmtCell || rawStr) / 100;
              } else if (typeof storeVal === 'number' && storeVal > 1 && !f.canExceed100) {
                // 无 % 号的普通百分数字段，值>1 视为整数百分数（如 70 → 70%）
                // 完成率字段（canExceed100）可>100%，值>1 视为完成倍数（如 1.4 → 140%），不÷100
                storeVal = storeVal / 100;
              }
            }
            // rows：供对比中心按原表对齐显示用。比率字段统一做标准化显示，避免 7039% 这类异常。
            let cellNum = num, cellText = rawStr, cellIsPct = isPct;
            if (f && f.type === 'ratio' && f.unit !== '比') {
              cellIsPct = true;
              cellNum = (storeVal != null) ? storeVal * 100 : null;
              cellText = (storeVal != null) ? pct(storeVal) : rawStr;
            }
            rows.push({ label: lab, raw: rawStr, num: cellNum, isPct: cellIsPct, text: cellText });
            if (f) {
              values[f.key] = storeVal;
              if (f.key === 'weekSeq') weekSeq = storeVal;
              if (f.key === 'totalWeeksOfMonth') totalWeeks = storeVal;
            } else {
              unmatched.push(lab);
            }
          });
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
          const fmtMatrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
          const mapping = getDimMapping(stream);
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
                const fmtStr = (fmtMatrix[i] && fmtMatrix[i][ci] != null) ? String(fmtMatrix[i][ci]).trim() : '';
                const rawHasPct = /[%％]/.test(rawStr);
                const fmtHasPct = /[%％]/.test(fmtStr);
                let v = (raw == null ? null : (typeof raw === 'number' ? raw : (key === 'subjectGroup' ? String(raw) : toNum(raw))));
                const fdef = fieldDef(key);
                // 比例类字段：带 % 单元格格式时区分标准/自定义百分比；
                // 否则带「%」号或普通百分数字段>1 时按百分数归一为小数；
                // 完成率字段（canExceed100）可>100%，值>1 视为完成倍数，不÷100；「比」类保持原值
                if (fdef && fdef.type === 'ratio' && fdef.unit !== '比') {
                  const fmtNum = fmtHasPct ? toNum(fmtStr) : null;
                  if (fmtHasPct && fmtNum != null && typeof v === 'number' && Math.abs(fmtNum - v * 100) >= 1e-6) {
                    v = fmtNum / 100; // 自定义百分比格式（raw=显示值），按显示值÷100
                  } else if (rawHasPct) {
                    v = toNum(fmtStr || rawStr) / 100;
                  } else if (typeof v === 'number' && v > 1 && !fdef.canExceed100) {
                    v = v / 100;
                  }
                  // 标准百分比格式：Math.abs(fmtNum - v*100) < 1e-6 时 raw 已是小数，保持 v 不变
                }
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
