/*
 * overrides.js — 数据修正中心（档A：引导式修正规则 + 自动诊断）
 * ---------------------------------------------------------------
 * 设计原则（非破坏性）：
 *   - 修正以「规则」形式持久化于 localStorage 键 ca_overrides_v1，不改动原始上传数据。
 *   - 规则在【读取 / 聚合时】即插即用套用（CA.applyOverrides），只修正"算出来的结果"。
 *   - 无规则时 CA.applyOverrides 直接返回原数组，零开销。
 * 支持 4 类规则：
 *   weekRemap     周次重映射：把某条记录的 week 改写到正确周次（修复"月末周误存为第5周"类问题）
 *   ignore        忽略记录：在读取时丢弃该条记录（不删原始数据）
 *   fieldOverride 字段值修正：覆盖某条记录的某个数值 / 文本字段
 *   tolerance     对账容差：调整"数据关联对账"的数值容差（比例 TOL）
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});
  const KEY = 'ca_overrides_v1';
  const REC_KEY = 'ca_records_v1';

  function readOverrides() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeOverrides(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) {}
  }
  // 读取【原始】记录（绕过修正规则），供修正中心 UI 与清理 / 回填等管理功能使用
  function readRaw(stream) {
    let all = [];
    try { all = JSON.parse(localStorage.getItem(REC_KEY) || '[]'); } catch (e) { all = []; }
    return stream ? all.filter(r => r.stream === stream) : all;
  }

  // 规则匹配身份键（与 store.pk 对齐：stream|campus|year|month|week|dimension）
  function idKey(r) {
    return [r.stream, r.campus || '泉山', r.year, r.month, r.week, r.dimension || '_'].join('|');
  }

  function weekRemapFor(rec, rules) {
    const k = idKey(rec);
    const m = rules.find(x => x.type === 'weekRemap' && idKey(x) === k);
    return m ? m.to : null;
  }
  function isIgnored(rec, rules) {
    const k = idKey(rec);
    return rules.some(x => x.type === 'ignore' && idKey(x) === k);
  }
  function fieldOverridesFor(rec, rules) {
    const k = idKey(rec);
    return rules.filter(x => x.type === 'fieldOverride' && idKey(x) === k);
  }

  // 对账容差（数值比例 TOL），默认 0.01
  function tolerance(scope) {
    const all = readOverrides();
    const m = all.find(x => x.type === 'tolerance' && (!x.scope || x.scope === scope || x.scope === 'all'));
    if (m && typeof m.value === 'number' && isFinite(m.value)) return m.value;
    return 0.01;
  }

  // 纯函数：在读取时套用修正规则（非破坏性：不改原始数据，只修正算出来的结果）
  function applyOverrides(records, stream) {
    const rules = readOverrides();
    if (!rules.length) return records; // 零开销
    const rel = stream ? rules.filter(r => !r.stream || r.stream === stream) : rules;
    if (!rel.length) return records;

    const out = [];
    const seen = {}; // 有效主键 -> out 下标
    records.forEach(r => {
      let eff = r;
      // 1) 周次重映射
      const toWk = weekRemapFor(r, rel);
      if (toWk != null && toWk !== r.week) {
        eff = JSON.parse(JSON.stringify(r));
        eff.week = toWk;
        eff._remappedFrom = r.week;
      }
      // 2) 忽略
      if (isIgnored(eff, rel)) return;
      // 3) 字段值修正
      const fos = fieldOverridesFor(eff, rel);
      if (fos.length) {
        eff = (eff === r) ? JSON.parse(JSON.stringify(r)) : eff;
        fos.forEach(f => {
          if (!eff.values) eff.values = {};
          let val = f.value;
          if (f.asNumber !== false && val !== '' && val != null) {
            const n = Number(val);
            if (isFinite(n)) val = n;
          }
          eff.values[f.field] = val;
        });
      }
      // 4) 有效主键去重（remap 后可能与既有记录碰撞；被修正的记录优先覆盖原值）
      const ek = idKey(eff);
      if (seen[ek] != null) {
        if (eff._remappedFrom != null || fos.length) out[seen[ek]] = eff;
        return;
      }
      seen[ek] = out.length;
      out.push(eff);
    });
    return out;
  }

  // —— 规则管理 ——
  let _seq = (function () { return readOverrides().reduce((m, x) => Math.max(m, (x && x.id) || 0), 0); })();
  function genId() { return ++_seq; }

  // 新增 / 更新规则（同身份 + 同类型自动去重替换，避免重复规则）
  function add(rule) {
    const all = readOverrides();
    const r = Object.assign({ id: genId(), createdAt: Date.now() }, rule);
    const idx = all.findIndex(x => {
      if (x.type !== r.type) return false;
      if (x.type === 'tolerance') return (x.scope || 'all') === (r.scope || 'all');
      return idKey(x) === idKey(r) && (r.type !== 'fieldOverride' || x.field === r.field);
    });
    if (idx >= 0) all[idx] = r; else all.push(r);
    writeOverrides(all);
    return r;
  }
  function remove(id) {
    writeOverrides(readOverrides().filter(r => r.id !== id));
  }
  function all() { return readOverrides(); }
  function save(arr) { writeOverrides(arr || []); }
  function rawRecords(stream) { return readRaw(stream); }

  CA.overrides = {
    rawRecords, applyOverrides,
    weekRemapFor, isIgnored, fieldOverridesFor, tolerance,
    add, remove, all, save, KEY,
  };
  CA.applyOverrides = applyOverrides; // 便捷别名（store.js 在 list 时调用）

})(window);
