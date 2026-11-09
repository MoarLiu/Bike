export const BIKE_TEMPLATE_VERSION = '2.0.0';
export const BIKE_TEMPLATES = Object.freeze({
  summarize_outline: { title: '子树总结', instruction: '总结提供的大纲，保留关键判断、待办和备注。缺少依据的内容标为待确认。' },
  outline_to_prd: { title: 'PRD', instruction: '整理为 PRD，包含背景、目标、范围、用户场景、功能、非目标、风险和验收标准。缺少依据的结论、负责人和日期标为待确认。' },
  outline_to_tasks: { title: '任务计划', instruction: '按依赖顺序拆成可执行任务，每项附验收标准。没有依据的负责人和日期标为待确认。' },
  review_outline_structure: { title: '结构审查', instruction: '审查层级、重复项、缺失前提、不可执行任务和风险遗漏，给出建议并说明依据。' },
  outline_to_meeting: { title: '会议纪要', instruction: '整理为会议纪要，包含讨论主题、已明确的决定、行动项和待确认问题。未明确的决定、负责人和日期必须标为待确认。' },
});
