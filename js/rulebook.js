/*
 * rulebook.js — 计算口径（纯函数）
 * 原样复用：PK-最佳科组数据细则 / ZD-级别评定表 / TRM评比数据计算执行标准 / PK-同比环比。
 * 所有系数集中在本文件 CONFIG，便于按实际标准微调。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  const CONFIG = {
    // TRM：生产周平均(30%) + 客户满意度(60%) + 离职率(10%)
    trm: {
      prodCoefficient: 0.85,   // 生产得分 = 三月生产周平均之和 × 系数，封顶 30（实测对齐样例）
      prodCap: 30,
      satTotal: 60,            // 客户满意度满分
      quitTotal: 10,           // 离职率满分
      // 满意度各子项满分分配（合计 60）
      satItems: {
        progressRate: 12,      // 进步率（标准75%）
        tjRate: 8,             // 推荐人数率（标准5%）
        xfRate: 10,            // 续费人数率（标准8%）
        tkRate: 10,            // 停课人数率（标准8%）
        jkRate: 8,             // 结课人数率（标准2.5%）
        tfCashRate: 7,         // 退费现金率（标准9%）
        tfNumRate: 5,          // 退费人数率（标准2%）
      },
    },
    // 教师级别（ZD-级别评定表）
    teacherLevel: {
      progressTiers: [[0.85, 20], [0.75, 15], [0.60, 10], [0, 0]], // ≥阈值→分值
      saturationTiers: [[0.75, 15], [0.675, 10], [0.60, 5], [0, 0]],
      cultureTotal: 30,        // 企业文化 5×6
      dailyTotal: 15,          // 日常优秀表现
      levels: [[90, 'A'], [75, 'B'], [60, 'C'], [0, 'D']],
    },
  };

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // 通用分段：tiers = [[上限阈值, 百分比], ...] 升序；value≤阈值取对应百分比（封顶100）
  function tierPct(value, tiers) {
    let pct = 0;
    for (const [upper, p] of tiers) { if (value <= upper) { pct = p; break; } }
    return pct;
  }

  // —— 最佳科组 ——
  // 周平均 = 课时 / 单科数
  function kezuWeekAvg(hours, subjects) {
    return subjects ? hours / subjects : 0;
  }

  // —— TRM 分段扣分（来自评比标准）——
  // 离职率分段：≤3%→100%, 3~4→80%, 4~5→60%, 5~6→30%, >6→0
  function quitRateScore(rate) {
    const pct = tierPct(rate * 100, [[3, 1], [4, 0.8], [5, 0.6], [6, 0.3], [Infinity, 0]]);
    return CONFIG.trm.quitTotal * pct;
  }
  // 推荐人数率：≥15→100%, 15>x≥12→80%, 12>x≥9→60%, 9>x≥5→30%, <5→0
  function tjRateScore(rate) {
    const pct = tierPct(rate * 100, [[15, 1], [12, 0.8], [9, 0.6], [5, 0.3], [Infinity, 0]]);
    return CONFIG.trm.satItems.tjRate * pct;
  }
  // 续费人数率：≥15→100%, 15>x≥13→80%, 13>x≥10→60%, 10>x≥8→30%, <8→0
  function xfRateScore(rate) {
    const pct = tierPct(rate * 100, [[15, 1], [13, 0.8], [10, 0.6], [8, 0.3], [Infinity, 0]]);
    return CONFIG.trm.satItems.xfRate * pct;
  }
  // 停课人数率：≤5→100%, 5>x≤6→80%, 6>x≤7→60%, 7>x≤8→30%, >8→0
  function tkRateScore(rate) {
    const pct = tierPct(rate * 100, [[5, 1], [6, 0.8], [7, 0.6], [8, 0.3], [Infinity, 0]]);
    return CONFIG.trm.satItems.tkRate * pct;
  }
  // 结课人数率：≤2.5→100%, 2.5>x≤3→80%, 3>x≤4→50%, 4>x≤5→20%, >5→0
  function jkRateScore(rate) {
    const pct = tierPct(rate * 100, [[2.5, 1], [3, 0.8], [4, 0.5], [5, 0.2], [Infinity, 0]]);
    return CONFIG.trm.satItems.jkRate * pct;
  }
  // 退费现金率：≤9→100%, 9>x≤10→80%, 10>x≤12→50%, 12>x≤15→20%, >15→0
  function tfCashRateScore(rate) {
    const pct = tierPct(rate * 100, [[9, 1], [10, 0.8], [12, 0.5], [15, 0.2], [Infinity, 0]]);
    return CONFIG.trm.satItems.tfCashRate * pct;
  }
  // 退费人数率：≤2→100%, 2>x≤3→80%, 3>x≤4→50%, 4>x≤5→20%, >5→0
  function tfNumRateScore(rate) {
    const pct = tierPct(rate * 100, [[2, 1], [3, 0.8], [4, 0.5], [5, 0.2], [Infinity, 0]]);
    return CONFIG.trm.satItems.tfNumRate * pct;
  }
  // 进步率：按比例（标准75%）→ 分值（封顶100%）
  function progressScore(rate) {
    const pct = clamp(rate / 0.75, 0, 1);
    return CONFIG.trm.satItems.progressRate * pct;
  }

  // TRM 总分：传入某学科组一季度三个月的生产周平均 + 月度均值指标
  function trmScore({ prodAvg3, quitRate, tjRate, xfRate, tkRate, jkRate, tfCashRate, tfNumRate, progressRate }) {
    const prod = Math.min((prodAvg3 || 0) * CONFIG.trm.prodCoefficient, CONFIG.trm.prodCap);
    const sat =
      progressScore(progressRate) +
      tjRateScore(tjRate) + xfRateScore(xfRate) + tkRateScore(tkRate) +
      jkRateScore(jkRate) + tfCashRateScore(tfCashRate) + tfNumRateScore(tfNumRate);
    const quit = quitRateScore(quitRate);
    return { total: +(prod + sat + quit).toFixed(2), prod: +prod.toFixed(2), sat: +sat.toFixed(2), quit: +quit.toFixed(2) };
  }

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
    CONFIG, clamp, tierPct,
    kezuWeekAvg,
    trmScore, quitRateScore, tjRateScore, xfRateScore, tkRateScore, jkRateScore, tfCashRateScore, tfNumRateScore, progressScore,
    progressLevelScore, saturationLevelScore, teacherLevelTotal,
  };

})(window);
