// 数据修正中心（档A）自测：加载 overrides.js + store.js，验证修正规则的套用与不破坏性。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.argv[2] || '.';
const storeSrc = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');
const ovSrc = fs.readFileSync(path.join(ROOT, 'js/overrides.js'), 'utf8');

// —— 浏览器环境垫片 ——
function makeLS() {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => m,
  };
}
const sandbox = {
  console,
  JSON,
  Math,
  Date,
  isFinite,
  Number,
  parseInt,
  parseFloat,
  localStorage: makeLS(),
  window: null,
};
sandbox.window = sandbox; // window === global
vm.createContext(sandbox);
vm.runInContext(ovSrc, sandbox);
vm.runInContext(storeSrc, sandbox);

const CA = sandbox.CA;
const OV = CA.overrides;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 原始周报：8 月第 5 周（误标，实为月末周），同组模板当月周数=4
const rawWeekly = [{
  stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_',
  values: { v1Students: 30, v1MonthProduced: 120, weekSeq: 4, totalWeeksOfMonth: 4 },
  rows: null,
}];
sandbox.localStorage.setItem('ca_records_v1', JSON.stringify(rawWeekly));
sandbox.localStorage.setItem('ca_overrides_v1', '[]');

console.log('【T1】无规则时零开销');
let out = CA.store.list('weekly');
check('返回原数组且 week 仍为 5', out.length === 1 && out[0].week === 5);
check('rawRecords 返回原始 week=5', OV.rawRecords('weekly')[0].week === 5);

console.log('【T2】周次重映射 5 → 4');
OV.add({ type: 'weekRemap', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', to: 4, note: 'test' });
out = CA.store.list('weekly');
check('读取时 week 变为 4', out.length === 1 && out[0].week === 4);
check('原始数据未被改动（仍为 5）', OV.rawRecords('weekly')[0].week === 5);
check('_remappedFrom 标记来源', out[0]._remappedFrom === 5);

console.log('【T3】忽略记录');
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
OV.add({ type: 'ignore', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_' });
out = CA.store.list('weekly');
check('读取时不返回被忽略记录', out.length === 0);
check('原始数据仍存在', OV.rawRecords('weekly').length === 1);

console.log('【T4】字段值修正');
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
OV.add({ type: 'fieldOverride', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', field: 'v1Students', value: '99', asNumber: true });
out = CA.store.list('weekly');
check('字段值被覆盖为数字 99', out[0].values.v1Students === 99);
check('原始值未被改动', OV.rawRecords('weekly')[0].values.v1Students === 30);

console.log('【T5】字段值修正（按文本）');
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
OV.add({ type: 'fieldOverride', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', field: 'note', value: '缺测', asNumber: false });
out = CA.store.list('weekly');
check('文本值原样保存', out[0].values.note === '缺测');

console.log('【T6】有效主键去重（remap 碰撞优先）');
// 同时存在 week4(legit) 与 week5(stray)；remap 5→4 后保留 remap 来的（override 优先）
sandbox.localStorage.setItem('ca_records_v1', JSON.stringify([
  { stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 4, dimension: '_', values: { v1Students: 10, weekSeq: 4, totalWeeksOfMonth: 4 }, rows: null },
  { stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', values: { v1Students: 30, weekSeq: 4, totalWeeksOfMonth: 4 }, rows: null },
]));
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
OV.add({ type: 'weekRemap', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', to: 4 });
out = CA.store.list('weekly');
check('去重后仅 1 条（week=4）', out.length === 1 && out[0].week === 4);
check('保留被 remap 来的记录（v1Students=30）', out[0].values.v1Students === 30);

console.log('【T7】对账容差');
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
check('默认容差 0.01', OV.tolerance('linkage') === 0.01);
OV.add({ type: 'tolerance', scope: 'linkage', value: 0.05 });
check('自定义容差生效 0.05', OV.tolerance('linkage') === 0.05);

console.log('【T8】规则去重（同身份同类型替换）');
sandbox.localStorage.setItem('ca_overrides_v1', '[]');
OV.add({ type: 'weekRemap', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', to: 4 });
OV.add({ type: 'weekRemap', stream: 'weekly', campus: '泉山', year: 2026, month: 8, week: 5, dimension: '_', to: 3 });
check('同身份 remap 仅保留 1 条且 to=3', OV.all().length === 1 && OV.all()[0].to === 3);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
