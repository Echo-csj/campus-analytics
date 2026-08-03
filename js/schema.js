/*
 * schema.js — 数据模型与字段定义
 * 所有计算口径原样复用现有 Excel 模板（DOS周报·数据统计表 / PK-最佳科组 / ZD-级别评定 / TRM评比标准）。
 * 全局命名空间挂在 window.CA 上，纯静态无构建。
 */
(function (global) {
  'use strict';
  const CA = global.CA || (global.CA = {});

  // —— 周报（校区级，来自 DOS 周报·数据统计表）——
  // 该表为单列「标签→值」结构：A 列=标签，B 列=值。
  // label 为 Excel 中的精确中文标签；key 为内部字段名。
  const weeklyFields = [
    // meta
    { key: 'totalWeeksOfMonth', label: '当月周数', group: '基础信息', unit: '周', type: 'num' },
    { key: 'campus', label: '校区', group: '基础信息', unit: '', type: 'text' },
    { key: 'weekSeq', label: '第几周', group: '基础信息', unit: '周', type: 'num' },
    // 人力
    { key: 'teacherCount', label: '教师数', group: '人力', unit: '人', type: 'num' },
    { key: 'campusTotal', label: '校区总人数', group: '人力', unit: '人', type: 'num' },
    { key: 'partTimeRatioWeek', label: '兼职授课比（周）', group: '人力', unit: '率', type: 'ratio' },
    { key: 'partTimeRatioMonth', label: '兼职授课比（月）', group: '人力', unit: '率', type: 'ratio' },
    { key: 'coreTeacherCount', label: '骨干教师人数', group: '人力', unit: '人', type: 'num' },
    { key: 'coreTeacherRatio', label: '骨干教师占比', group: '人力', unit: '率', type: 'ratio' },
    { key: 'doubleThreeCount', label: '双三老师人数', group: '人力', unit: '人', type: 'num' },
    { key: 'doubleThreeRatio', label: '双三老师占比', group: '人力', unit: '率', type: 'ratio' },
    // 学员
    { key: 'v1Students', label: '1v1在读学员', group: '学员', unit: '人', type: 'num', aliases: ['1v1在读学员数', '1v1学员数', '1对1在读学员', '1对1在读学员数', '一对一在读学员', '一对一在读学员数'] },
    { key: 'v1Subjects', label: '1v1在读单科', group: '学员', unit: '科', type: 'num', aliases: ['1v1在读单科数', '1v1单科数', '1对1在读单科', '1对1在读单科数', '一对一在读单科', '一对一在读单科数'] },
    { key: 'subjectRatio', label: '单科比', group: '学员', unit: '比', type: 'ratio' },
    { key: 'v6Students', label: '1v6在读学员数', group: '学员', unit: '人', type: 'num', aliases: ['1v6在读学员', '1v6学员数', '1v6学员'] },
    { key: 'v6Subjects', label: '1v6在读学单科', group: '学员', unit: '科', type: 'num', aliases: ['1v6在读单科', '1v6单科数', '1v6单科'] },
    { key: 'v6SubjectRatio', label: '1v6单科比', group: '学员', unit: '比', type: 'ratio' },
    // 课时生产
    { key: 'v1WeekTarget', label: '1V1周目标课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v1WeekProduced', label: '1v1周生产课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v6WeekProduced', label: '1v6周生产课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v1WeekRate', label: '1V1周生产完成率', group: '课时生产', unit: '率', type: 'ratio' },
    { key: 'v1MonthTarget', label: '1V1月目标课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v1MonthProduced', label: '1v1月生产课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v6MonthProduced', label: '1v6月生产课时', group: '课时生产', unit: '课时', type: 'num' },
    { key: 'v1MonthRate', label: '1V1月生产完成率', group: '课时生产', unit: '率', type: 'ratio' },
    { key: 'schoolWeekAvg', label: '校周均课时', group: '课时生产', unit: '课时', type: 'num' },
    // 现金
    { key: 'v1WeekCash', label: '1v1周课时生产现金', group: '现金', unit: '元', type: 'num' },
    { key: 'v1MonthCash', label: '1v1月课时生产现金', group: '现金', unit: '元', type: 'num' },
    { key: 'v1WeekCashAvg', label: '1v1周课时生产现金均价', group: '现金', unit: '元', type: 'num' },
    { key: 'v1MonthCashAvg', label: '1v1月课时生产现金均价', group: '现金', unit: '元', type: 'num' },
    { key: 'v6WeekCash', label: '1v6周课时生产现金', group: '现金', unit: '元', type: 'num' },
    { key: 'v6MonthCash', label: '1v6月课时生产现金', group: '现金', unit: '元', type: 'num' },
    { key: 'weekCashTotal', label: '周课时生产总现金', group: '现金', unit: '元', type: 'num' },
    { key: 'v1WeekCashRatio', label: '1v1周课时生产金额占比', group: '现金', unit: '率', type: 'ratio' },
    { key: 'monthCashTotal', label: '月课时生产总现金', group: '现金', unit: '元', type: 'num' },
    { key: 'v1MonthCashRatio', label: '1v1月课时生产金额占比', group: '现金', unit: '率', type: 'ratio' },
    // 效能
    { key: 'weekEff', label: '周人均效能值', group: '效能', unit: '元', type: 'num' },
    { key: 'monthEff', label: '月人均效能值', group: '效能', unit: '元', type: 'num' },
    { key: 'v1WeekUnitAvg', label: '1v1周单位周平均', group: '效能', unit: '比', type: 'num' },
    { key: 'v1MonthUnitAvg', label: '1v1月单位周平均', group: '效能', unit: '比', type: 'num' },
    // 饱和度 / 协校
    { key: 'weekSaturation', label: '周饱和度', group: '饱和度协校', unit: '率', type: 'ratio' },
    { key: 'monthSaturation', label: '月饱和度', group: '饱和度协校', unit: '率', type: 'ratio' },
    { key: 'v1WeekXiexiao', label: '1V1周协校课时', group: '饱和度协校', unit: '课时', type: 'num' },
    { key: 'v1MonthXiexiao', label: '1V1月协校课时', group: '饱和度协校', unit: '课时', type: 'num' },
    { key: 'v1WeekXiexiaoRatio', label: '1V1协校占比（周）', group: '饱和度协校', unit: '率', type: 'ratio' },
    { key: 'v1MonthXiexiaoRatio', label: '1V1协校占比（月）', group: '饱和度协校', unit: '率', type: 'ratio' },
    // 续费
    { key: 'xfWeekNum', label: '1V1周续费人数', group: '续费', unit: '人', type: 'num' },
    { key: 'xfMonthNum', label: '1V1月续费人数', group: '续费', unit: '人', type: 'num' },
    { key: 'xfWeekNumRate', label: '1V1周续费人数率', group: '续费', unit: '率', type: 'ratio' },
    { key: 'xfMonthNumRate', label: '1V1月续费人数率', group: '续费', unit: '率', type: 'ratio' },
    { key: 'xfWeekSubj', label: '1V1周续费单科', group: '续费', unit: '科', type: 'num' },
    { key: 'xfMonthSubj', label: '1V1月续费单科', group: '续费', unit: '科', type: 'num' },
    { key: 'xfWeekSubjRate', label: '1V1周续费单科率', group: '续费', unit: '率', type: 'ratio' },
    { key: 'xfMonthSubjRate', label: '1V1月续费单科率', group: '续费', unit: '率', type: 'ratio' },
    // 推荐
    { key: 'tjWeekNum', label: '1V1周推荐人数', group: '推荐', unit: '人', type: 'num' },
    { key: 'tjMonthNum', label: '1V1月推荐人数', group: '推荐', unit: '人', type: 'num' },
    { key: 'tjWeekNumRate', label: '1V1周推荐人数率', group: '推荐', unit: '率', type: 'ratio' },
    { key: 'tjMonthNumRate', label: '1V1月推荐人数率', group: '推荐', unit: '率', type: 'ratio' },
    { key: 'tjWeekSubj', label: '1V1周推荐单科', group: '推荐', unit: '科', type: 'num' },
    { key: 'tjMonthSubj', label: '1V1月推荐单科', group: '推荐', unit: '科', type: 'num' },
    { key: 'tjWeekSubjRate', label: '1V1周推荐单科率', group: '推荐', unit: '率', type: 'ratio' },
    { key: 'tjMonthSubjRate', label: '1V1月推荐单科率', group: '推荐', unit: '率', type: 'ratio' },
    // 结课
    { key: 'jkWeekSubj', label: '1V1周结课单科', group: '结课', unit: '科', type: 'num' },
    { key: 'jkMonthSubj', label: '1V1月结课单科', group: '结课', unit: '科', type: 'num' },
    { key: 'jkWeekSubjRate', label: '1V1周结课单科率', group: '结课', unit: '率', type: 'ratio' },
    { key: 'jkMonthSubjRate', label: '1V1月结课单科率', group: '结课', unit: '率', type: 'ratio' },
    { key: 'jkWeekNum', label: '1V1周结课人数', group: '结课', unit: '人', type: 'num' },
    { key: 'jkMonthNum', label: '1V1月结课人数', group: '结课', unit: '人', type: 'num' },
    { key: 'jkWeekNumRate', label: '1V1周结课人数率', group: '结课', unit: '率', type: 'ratio' },
    { key: 'jkMonthNumRate', label: '1V1月结课人数率', group: '结课', unit: '率', type: 'ratio' },
    // 退费
    { key: 'tfWeekSubj', label: '1V1周退费单科', group: '退费', unit: '科', type: 'num' },
    { key: 'tfMonthSubj', label: '1V1月退费单科', group: '退费', unit: '科', type: 'num' },
    { key: 'tfWeekSubjRate', label: '1V1周退费单科率', group: '退费', unit: '率', type: 'ratio' },
    { key: 'tfMonthSubjRate', label: '1V1月退费单科率', group: '退费', unit: '率', type: 'ratio' },
    { key: 'tfWeekNum', label: '1V1周退费人数', group: '退费', unit: '人', type: 'num' },
    { key: 'tfMonthNum', label: '1V1月退费人数', group: '退费', unit: '人', type: 'num' },
    { key: 'tfWeekNumRate', label: '1V1周退费人数率', group: '退费', unit: '率', type: 'ratio' },
    { key: 'tfMonthNumRate', label: '1V1月退费人数率', group: '退费', unit: '率', type: 'ratio' },
    // 停课 / 请假 / 入职离职
    { key: 'tkNum', label: '1V1停课人数', group: '停课请假入职', unit: '人', type: 'num' },
    { key: 'tkNumRate', label: '1V1停课人数率', group: '停课请假入职', unit: '率', type: 'ratio' },
    { key: 'addClass', label: '1V1加课', group: '停课请假入职', unit: '次', type: 'num' },
    { key: 'leaveStudent', label: '1V1学员请假', group: '停课请假入职', unit: '次', type: 'num' },
    { key: 'leaveTeacher', label: '1V1老师请假', group: '停课请假入职', unit: '次', type: 'num' },
    { key: 'leaveRate', label: '1V1请假率', group: '停课请假入职', unit: '率', type: 'ratio' },
    { key: 'entryWeek', label: '周入职人数', group: '停课请假入职', unit: '人', type: 'num' },
    { key: 'entryMonth', label: '月入职人数', group: '停课请假入职', unit: '人', type: 'num' },
    { key: 'quitWeek', label: '周离职人数', group: '停课请假入职', unit: '人', type: 'num' },
    { key: 'quitMonth', label: '月离职人数', group: '停课请假入职', unit: '人', type: 'num' },
    { key: 'quitWeekRate', label: '周离职人数率', group: '停课请假入职', unit: '率', type: 'ratio' },
    { key: 'quitMonthRate', label: '月离职人数率', group: '停课请假入职', unit: '率', type: 'ratio' },
  ];

  // 五项满意度（从月度周报自动提取，校区级，取「月」口径率）
  const satisfactionItems = [
    { key: 'xfMonthSubjRate', name: '续费单科率', src: 'xfMonthSubjRate' },
    { key: 'jkMonthSubjRate', name: '结课单科率', src: 'jkMonthSubjRate' },
    { key: 'tfMonthSubjRate', name: '退费单科率', src: 'tfMonthSubjRate' },
    { key: 'tkNumRate', name: '停课人数率', src: 'tkNumRate' },
    { key: 'tjMonthSubjRate', name: '推荐单科率', src: 'tjMonthSubjRate' },
  ];

  // —— 最佳科组（来自科组周报，按用户周版台账）——
  // 维度：科组。周度提交 → 月度自动汇总。
  const kezuFields = [
    { key: 'subjects', label: '单科数', type: 'num', desc: '当周在读单科数（月度汇总=各周累加）' },
    { key: 'hours', label: '课时', type: 'num', desc: '当周生产课时（月度汇总=各周累加）' },
    { key: 'weekAvg', label: '周平均', type: 'calc', desc: '= 课时 / 单科数（周或月均可算）' },
    { key: 'jkSubj', label: '结课单科', type: 'num', desc: '当周结课单科（月累加）' },
    { key: 'tfSubj', label: '退费单科', type: 'num', desc: '当周退费单科（月累加）' },
    { key: 'tkSubj', label: '停课单科', type: 'num', desc: '当周停课单科（月累加）' },
    { key: 'xfSubj', label: '续费单科', type: 'num', desc: '当周续费单科（月累加）' },
    { key: 'tjSubj', label: '推荐单科', type: 'num', desc: '当周推荐单科（月累加）' },
    { key: 'teacherCount', label: '教师数', type: 'num', desc: '当周科组教师数（取月末周快照）' },
    { key: 'quitCount', label: '离职人数', type: 'num', desc: '当月离职人数（月度口径，月末周填写）' },
    { key: 'progressRate', label: '进步率', type: 'ratio', desc: '半年季度考进步率（半年度录入，月留空）' },
  ];

  // —— 教师 KPI（来自教师周报，按用户周版台账）——
  // 维度：教师。周度提交 → 月度 + 半年度自动汇总。
  const kpiFields = [
    { key: 'subjectGroup', label: '学科组', type: 'text', desc: '所属学科组（数学/英语/文综/理综…）' },
    { key: 'weekHours', label: '周课时', type: 'num', desc: '当周生产课时' },
    { key: 'weekSessions', label: '周课次', type: 'num', desc: '当周实际上课次数' },
    { key: 'weekRefSessions', label: '周参考课次', type: 'num', desc: '当周应上课次（用于算饱和度）' },
    { key: 'saturation', label: '周饱和度', type: 'ratio', desc: '= 周课次 / 周参考课次' },
    { key: 'progressRate', label: '周进步率', type: 'ratio', desc: '可选；半年度取季度考进步率' },
  ];

  // 分组顺序（用于周报展示）
  const weeklyGroups = ['基础信息', '人力', '学员', '课时生产', '现金', '效能', '饱和度协校',
    '续费', '推荐', '结课', '退费', '停课请假入职'];

  // 标签 → 字段 反查表（一键提取用）
  const weeklyLabelMap = {};
  weeklyFields.forEach(f => { weeklyLabelMap[f.label] = f; });

  // 大小写不敏感反查表（解决 1v1 / 1V1 等写法差异导致的解析丢失）
  const weeklyLabelMapCI = {};
  weeklyFields.forEach(f => { weeklyLabelMapCI[f.label.toLowerCase()] = f; });

  // 别名反查表：支持带“数/量/个”后缀、空格、1对1/一对一 等常见变体
  const weeklyLabelMapAliases = {};
  weeklyFields.forEach(f => {
    (f.aliases || []).forEach(a => { weeklyLabelMapAliases[a] = f; });
  });

  CA.SCHEMA = {
    weeklyFields, weeklyGroups, weeklyLabelMap, weeklyLabelMapCI, weeklyLabelMapAliases, satisfactionItems,
    kezuFields, kpiFields,
    streams: ['weekly', 'kezu', 'kpi'],
  };

})(window);
