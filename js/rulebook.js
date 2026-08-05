/*
 * rulebook.js — 计算口径（纯函数）
 * 原样复用：PK-最佳科组数据细则 / ZD-级别评定表 / TRM评比数据计算执行标准 / PK-同比环比。
 * 所有系数集中在本文件 CONFIG，便于按实际标准微调。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  const CONFIG = {
    // 教师级别（ZD-级别评定表）
    teacherLevel: {
      progressTiers: [[0.85, 20], [0.75, 15], [0.60, 10], [0, 0]], // ≥阈值→分值
      saturationTiers: [[0.75, 15], [0.675, 10], [0.60, 5], [0, 0]],
      cultureTotal: 30,        // 企业文化 5×6
      dailyTotal: 15,          // 日常优秀表现
      levels: [[90, 'A'], [75, 'B'], [60, 'C'], [0, 'D']],
    },
  };

  // —— 教师级别（ZD-级别评定表）——
  function progressLevelScore(rate) {
    for (const [th, s] of CONFIG.teacherLevel.progressTiers) if (rate >= th) return s;
    return 0;
  }
  function saturationLevelScore(rate) {
    for (const [th, s] of CONFIG.teacherLevel.saturationTiers) if (rate >= th) return s;
    return 0;
  }
  function teacherLevelTotal({ progressRate, profScore, saturation, culture = 30, daily = 15 }) {
    const s1 = progressLevelScore(progressRate);          // 进步率 20/15/10
    const s2 = profScore || 0;                            // 专业 20/15/10（用户或系统给）
    const s3 = saturationLevelScore(saturation);          // 饱和度 15/10/5
    const total = s1 + s2 + s3 + culture + daily;
    let level = 'D';
    for (const [th, lv] of CONFIG.teacherLevel.levels) if (total >= th) { level = lv; break; }
    return { total, level, parts: { progress: s1, prof: s2, saturation: s3, culture, daily } };
  }

  CA.rulebook = {
    CONFIG,
    progressLevelScore, saturationLevelScore, teacherLevelTotal,
  };

})(window);
