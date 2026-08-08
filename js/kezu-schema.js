/*
 * kezu-schema.js — 最佳科组「月度数据」标准格式定义
 * 设计目标：结构清晰、字段规范、便于程序解析与展示。
 * 一条记录 = 某科组在某月的数据（科组 × 月 长表）。
 * 口径（2026-08-07 校定，与《泉山2026最佳科组_全年汇总》一致）：
 *   周平均 = 课时 ÷ 周数 ÷ 单科数
 *   结课率 = 结课 ÷ 单科数
 *   停课率 = 停课 ÷ (停课 + 单科数)
 *   退费率 = 退费 ÷ (退费 + 单科数)
 *   续费率 = 续费 ÷ 单科数
 *   离职率 = 离职 ÷ (教师数 + 离职)
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 科组固定枚举
  const SUBJECTS = ['数学', '英语', '文综', '理综'];

  // 标准字段定义
  // type: num 数值 | text 文本 | calc 派生
  // required: 上传必填；calc: 系统派生，不要求用户提供
  const FIELDS = [
    { key: 'year',     label: '年份',     type: 'num',  required: false, desc: '统计年份，缺省 2026', min: 2000, max: 2100 },
    { key: 'month',    label: '月份',     type: 'num',  required: true,  desc: '1–12 月', min: 1, max: 12 },
    { key: 'subject',  label: '科组',     type: 'text', required: true,  desc: '数学 / 英语 / 文综 / 理综', enum: SUBJECTS },
    { key: 'hours',    label: '课时',     type: 'num',  required: true,  desc: '当月生产课时', min: 0 },
    { key: 'subjects', label: '单科数',   type: 'num',  required: true,  desc: '当月开课单科(学科)数', min: 0 },
    { key: 'weeks',    label: '周数',     type: 'num',  required: true,  desc: '当月周数（人工月规则假设值）', min: 1 },
    { key: 'jieke',    label: '结课',     type: 'num',  required: false, desc: '结课人次', min: 0 },
    { key: 'tingke',   label: '停课',     type: 'num',  required: false, desc: '停课人次', min: 0 },
    { key: 'tuifei',   label: '退费',     type: 'num',  required: false, desc: '退费人次', min: 0 },
    { key: 'xufei',    label: '续费',     type: 'num',  required: false, desc: '续费人次', min: 0 },
    { key: 'teachers', label: '教师数',   type: 'num',  required: false, desc: '当月科组教师数', min: 0 },
    { key: 'quit',     label: '离职人数', type: 'num',  required: false, desc: '当月离职人数', min: 0 },
    // —— 派生字段（系统计算，统一口径）——
    { key: 'weekAvg',     label: '周平均', type: 'calc', desc: '= 课时 ÷ 周数 ÷ 单科数' },
    { key: 'jiekeRate',   label: '结课率', type: 'calc', desc: '= 结课 ÷ 单科数' },
    { key: 'tingkeRate',  label: '停课率', type: 'calc', desc: '= 停课 ÷ (停课 + 单科数)' },
    { key: 'tuifeiRate',  label: '退费率', type: 'calc', desc: '= 退费 ÷ (退费 + 单科数)' },
    { key: 'xufeiRate',   label: '续费率', type: 'calc', desc: '= 续费 ÷ 单科数' },
    { key: 'quitRate',    label: '离职率', type: 'calc', desc: '= 离职 ÷ (教师数 + 离职)' },
    { key: 'quarter',     label: '季度',   type: 'calc', desc: '= ⌊(月份-1)/3⌋+1（Q1–Q4）' },
  ];

  // 字段别名（上传时列标题 / 表头 模糊匹配用）
  const ALIASES = {
    month:    ['月份', '月', '期间', '统计月', '汇总月', '月份期间', '统计月份', '月报月份', 'month', 'mo', 'month_no'],
    subject:  ['科组', '学科', '科目', '组别', '学科组', '科类', '科组名称', '学科名称', 'group', 'subject', '科'],
    hours:    ['课时', '月课时', '总课时', '生产课时', '课时数', '月总课时', '课时量', 'hours', 'classhours'],
    subjects: ['单科数', '学科数', '单科', '学科', '开课单科', '开课学科数', 'subs', 'subjectcount'],
    weeks:    ['周数', '当月周数', '月周数', 'weeks', '周'],
    jieke:    ['结课', '结课人数', '结课单科', '结课人次', '月结课', 'jieke'],
    tingke:   ['停课', '停课人数', '停课单科', '停课人次', 'tingke'],
    tuifei:   ['退费', '退费人数', '退费单科', '退费人次', 'tuifei'],
    xufei:    ['续费', '续费人数', '续费单科', '续费人次', 'xufei'],
    teachers: ['教师数', '教师', '老师数', '教师人数', 'teachers', 'teachercount', '老师'],
    quit:     ['离职', '离职人数', '离职数', '月离职', 'quit', 'quitcount'],
    weekAvg:     ['周平均', '周均'],
    jiekeRate:   ['结课率'],
    tingkeRate:  ['停课率'],
    tuifeiRate:  ['退费率'],
    xufeiRate:   ['续费率'],
    quitRate:    ['离职率'],
  };

  // 率字段：若原始表提供，用于校验比对；口径以「人数 ÷ 分母」为准
  const RATE_KEYS = ['jiekeRate', 'tingkeRate', 'tuifeiRate', 'xufeiRate', 'quitRate'];
  const PERSON_KEYS = { jiekeRate: 'jieke', tingkeRate: 'tingke', tuifeiRate: 'tuifei', xufeiRate: 'xufei', quitRate: 'quit' };
  const DENOM = {
    jiekeRate:   r => r.subjects,
    tingkeRate:  r => (r.tingke || 0) + (r.subjects || 0),
    tuifeiRate:  r => (r.tuifei || 0) + (r.subjects || 0),
    xufeiRate:   r => r.subjects,
    quitRate:    r => (r.quit || 0) + (r.teachers || 0),
  };

  CA.BESTKEZU = CA.BESTKEZU || {};
  Object.assign(CA.BESTKEZU, { SUBJECTS, FIELDS, ALIASES, RATE_KEYS, PERSON_KEYS, DENOM });
})(typeof window !== 'undefined' ? window : global);
