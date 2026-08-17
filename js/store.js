/*
 * store.js — 本地存储（localStorage）+ 导入导出
 * 主键：stream + year + month + week + dimension(科组/教师)
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

  function pk(r) {
    return [r.stream, r.year, r.month, r.week, r.dimension || '_'].join('|');
  }

  // upsert：同主键覆盖
  function upsert(record) {
    const arr = readAll();
    const key = pk(record);
    const idx = arr.findIndex(r => pk(r) === key);
    if (idx >= 0) arr[idx] = record; else arr.push(record);
    writeAll(arr);
    return record;
  }

  function list(stream) {
    return readAll().filter(r => !stream || r.stream === stream);
  }
  function remove(stream, year, month, week, dimension) {
    const arr = readAll();
    const key = [stream, year, month, week, dimension || '_'].join('|');
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

  CA.store = { readAll, upsert, list, remove, clearAll, exportJSON, importJSON };

})(window);
