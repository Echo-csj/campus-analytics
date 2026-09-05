/*
 * store.js — 本地存储（localStorage）+ 导入导出
 * 主键：stream + campus + year + month + week + dimension(科组/教师)
 * 数据完全存浏览器本地；可导出 data.json 备份 / 跨设备 / 历史补录。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});
  const KEY = 'ca_records_v1';

  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeAll(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
  }

  // 规范主键：(stream, campus, year, month, week, dimension)
  // campus 缺省按「泉山」，现有单校区历史数据零变化。
  function pk(r) {
    return [r.stream, r.campus || '泉山', r.year, r.month, r.week, r.dimension || '_'].join('|');
  }

  // upsert：同主键覆盖；写入前补全 campus 缺省，保证主键一致。
  function upsert(record) {
    record.campus = record.campus || '泉山';
    const arr = readAll();
    const key = pk(record);
    const idx = arr.findIndex(r => pk(r) === key);
    if (idx >= 0) arr[idx] = record; else arr.push(record);
    writeAll(arr);
    return record;
  }

  // 上传提交前预览：返回将覆盖 / 将新增的主键清单，供 UI 预警。
  function previewUpsert(records) {
    const arr = readAll();
    const overwrite = [], insert = [];
    (records || []).forEach(r => {
      const key = pk(r);
      if (arr.some(x => pk(x) === key)) overwrite.push(key); else insert.push(key);
    });
    return { overwrite, insert };
  }

  // 读取时套用修正规则（档A 数据修正中心）：非破坏性，规则在 ca_overrides_v1。
  // 无规则时 CA.applyOverrides 直接返回原数组，零开销。管理类功能请用 listRaw 取原始数据。
  function list(stream) {
    const raw = readAll().filter(r => !stream || r.stream === stream);
    return (typeof CA.applyOverrides === 'function') ? CA.applyOverrides(raw, stream) : raw;
  }
  // 原始记录读取（绕过修正规则），供回填 / 清理 / 修正中心 UI 等管理功能使用
  function listRaw(stream) {
    return readAll().filter(r => !stream || r.stream === stream);
  }
  function remove(stream, year, month, week, dimension, campus) {
    const arr = readAll();
    const key = [stream, campus || '泉山', year, month, week, dimension || '_'].join('|');
    writeAll(arr.filter(r => pk(r) !== key));
  }
  function clearAll() { writeAll([]); }

  function exportJSON() {
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: readAll() }, null, 2);
  }
  function importJSON(text) {
    const data = JSON.parse(text);
    const recs = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(recs)) throw new Error('格式不正确');
    let n = 0;
    recs.forEach(r => { upsert(r); n++; });
    return n;
  }

  CA.store = { readAll, upsert, previewUpsert, list, listRaw, remove, clearAll, exportJSON, importJSON };

})(window);
