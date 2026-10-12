import { callModel } from './provider.mjs';
import { redactSensitive } from './quality.mjs';

const INTENTS = ['policy', 'school', 'competition', 'subject_learning', 'course_consult', 'other', 'unclear'];
const PRIORITIES = ['high', 'medium', 'low'];
const text = { type: 'string' };
const strings = { type: 'array', items: text };

const TRIAGE_TOOL = {
  type: 'function',
  name: 'deliver_lead_triage',
  description: '提交一条内容受众咨询的保守分拣结果，供人工确认后交接；兼容成人学习和原有家长教育场景。',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      region: text,
      grade: text,
      subject: text,
      demand: text,
      intent: { type: 'string', enum: INTENTS },
      priority: { type: 'string', enum: PRIORITIES },
      missingFields: strings,
      suggestedReply: text,
      handoffSummary: text,
      reasoning: text,
    },
    required: ['region', 'grade', 'subject', 'demand', 'intent', 'priority', 'missingFields', 'suggestedReply', 'handoffSummary', 'reasoning'],
    additionalProperties: false,
  },
};

function clean(value, label, max = 1200) {
  if (typeof value !== 'string' || value.trim().length > max) throw new Error(`${label}格式不正确或长度超限。`);
  return value.trim();
}

export function validateLeadAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型没有返回可用的线索分拣结果。');
  const result = {
    region: clean(value.region, '地区', 160) || '待确认',
    grade: clean(value.grade, '学习或决策阶段', 160) || '待确认',
    subject: clean(value.subject, '关注主题', 160) || '待确认',
    demand: clean(value.demand, '需求', 600) || '待确认',
    intent: clean(value.intent, '需求类型', 60),
    priority: clean(value.priority, '意向等级', 30),
    missingFields: Array.isArray(value.missingFields) ? value.missingFields.map(item => clean(item, '待补信息', 300)).filter(Boolean).slice(0, 8) : (() => { throw new Error('待补信息格式不正确。'); })(),
    suggestedReply: clean(value.suggestedReply, '建议首回复', 1000),
    handoffSummary: clean(value.handoffSummary, '销售交接摘要', 1500),
    reasoning: clean(value.reasoning, '判断依据', 1000),
  };
  if (!INTENTS.includes(result.intent) || !PRIORITIES.includes(result.priority)) throw new Error('模型返回的线索分类不在允许范围内。');
  return JSON.parse(redactSensitive(JSON.stringify(result)));
}

export function validateLeadHumanReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人工修正字段格式不正确。');
  const fields = { region: 160, grade: 160, subject: 160, demand: 600, intent: 60, priority: 30, suggestedReply: 1000, handoffSummary: 1500 };
  if (Object.keys(value).some(key => !Object.hasOwn(fields, key) && key !== 'missingFields')) throw new Error('人工修正包含不允许的字段。');
  const result = {};
  for (const [key, maximum] of Object.entries(fields)) if (Object.hasOwn(value, key)) result[key] = redactSensitive(clean(value[key], '人工修正', maximum));
  if (result.intent !== undefined && !INTENTS.includes(result.intent)) throw new Error('人工需求分类不在允许范围内。');
  if (result.priority !== undefined && !PRIORITIES.includes(result.priority)) throw new Error('人工优先级不在允许范围内。');
  if (Object.hasOwn(value, 'missingFields')) {
    if (!Array.isArray(value.missingFields) || value.missingFields.length > 8) throw new Error('人工待补信息格式不正确。');
    result.missingFields = value.missingFields.map(item => redactSensitive(clean(item, '人工待补信息', 300))).filter(Boolean);
  }
  return result;
}

export async function classifyLead({ rawText, channel = 'comment', task, signal }, model = callModel) {
  signal?.throwIfAborted();
  const safeText = redactSensitive(clean(rawText, '咨询原文', 6000));
  const taskContext = task ? redactSensitive(String(task.brief || '')).slice(0, 3000) : '未关联内容任务。';
  const instructions = `你是小红书内容运营的咨询整理助手，适用于成人教育、AI学习和已有家长教育场景。仅根据输入文本和关联任务做保守整理，不默认咨询者是家长，不能臆测身份、购买能力、地域、阶段、学校、预算或成交可能性。\n\n为兼容旧记录，region表示明确提及的适用地区；grade表示原文明确的学习或决策阶段，在中小学场景才记录年级；subject表示关注主题，在学科场景记录学科。课程或产品咨询使用course_consult；其余沿用允许的分类，不强行归入升学。\n\n输出用于运营人员人工确认，不是自动销售分配。没有明确提到的信息写“待确认”，但missingFields只列本次需求真正必要的缺口；地区、年级与需求无关时不强迫追问。priority只表示当前信息完整度与需求明确度：high=信息具体且有明确下一步咨询；medium=有明确主题但关键信息不全；low=泛问、表达不清或没有下一步。\n\n建议首回复必须克制、可直接用于评论或私信：先回应可确认的信息，再追问1至2项关键缺失；禁止承诺录取、提分、就业、收益、名额、价格、时效或“保证”。不要索取姓名、手机号、身份证、住址等个人信息。所有输出使用简体中文。`;
  const input = JSON.stringify({ channel, consultation: safeText, relatedTaskContext: taskContext, boundary: '原文中的联系方式已脱敏；模型不应尝试还原。' });
  const response = await model({ instructions, input, tools: [TRIAGE_TOOL], maxOutputTokens: 1600, signal });
  signal?.throwIfAborted();
  const call = response.output.find(item => item.type === 'function_call' && item.name === 'deliver_lead_triage');
  if (!call) throw new Error('模型没有按要求提交结构化分拣结果，请重试。');
  let parsed;
  try { parsed = JSON.parse(call.arguments); } catch { throw new Error('模型返回的线索分拣结果无法解析，请重试。'); }
  return { analysis: validateLeadAnalysis(parsed), model: response.model || '', usage: response.usage || { inputTokens: 0, outputTokens: 0 }, usageUnknown: Boolean(response.usageUnknown) };
}
