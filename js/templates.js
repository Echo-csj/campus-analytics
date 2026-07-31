/*
 * templates.js — 科组 / 教师 周报表头映射 + 模板中心覆盖
 * 科组周报、教师周报为「用户另做的按周独立台账」：每行一个维度（科组 / 教师），首行为表头。
 * 默认映射基于现有月报结构反推；用户可在模板中心上传自己的表头覆盖。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // 科组周报默认表头 → 内部字段
  const kezuDefault = {
    dimensionHeader: '科组',
    map: {
      '科组': 'dimension',
      '单科数': 'subjects',
      '课时': 'hours',
      '结课单科': 'jkSubj',
      '退费单科': 'tfSubj',
      '停课单科': 'tkSubj',
      '续费单科': 'xfSubj',
      '推荐单科': 'tjSubj',
      '教师数': 'teacherCount',
      '离职人数': 'quitCount',
      '进步率': 'progressRate',
    },
  };

  // 教师周报默认表头 → 内部字段
  const kpiDefault = {
    dimensionHeader: '教师',
    map: {
      '教师': 'dimension',
      '学科组': 'subjectGroup',
      '周课时': 'weekHours',
      '周课次': 'weekSessions',
      '周参考课次': 'weekRefSessions',
      '周饱和度': 'saturation',
      '周进步率': 'progressRate',
    },
  };

  // 起步模板列（供 Python 生成空 xlsx 样板；也用于浏览器提示应有列）
  const starterColumns = {
    kezu: ['科组', '单科数', '课时', '结课单科', '退费单科', '停课单科', '续费单科', '推荐单科', '教师数', '离职人数', '进步率'],
    kpi: ['教师', '学科组', '周课时', '周课次', '周参考课次', '周饱和度', '周进步率'],
  };

  // 当前生效映射（默认 + 用户覆盖）；覆盖存 localStorage
  function loadOverride(stream) {
    try { return JSON.parse(localStorage.getItem('ca_template_' + stream) || 'null'); }
    catch (e) { return null; }
  }
  function saveOverride(stream, map) {
    localStorage.setItem('ca_template_' + stream, JSON.stringify(map));
  }
  function getMapping(stream) {
    const ov = loadOverride(stream);
    if (ov && ov.map) return ov;
    return stream === 'kezu' ? kezuDefault : kpiDefault;
  }

  CA.templates = {
    kezuDefault, kpiDefault, starterColumns,
    loadOverride, saveOverride, getMapping,
  };

})(window);
