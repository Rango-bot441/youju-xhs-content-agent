import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chunkText } from './sources.mjs';
import { qualityReport } from './quality.mjs';
import { redactSensitive } from './quality.mjs';
import { validateLeadAnalysis, validateLeadHumanReview } from './lead-classifier.mjs';

const PROFILE_FIELDS = ['name', 'audience', 'positioning', 'tone', 'productFacts', 'restrictions'];
const EMPTY_PROFILE = Object.fromEntries(PROFILE_FIELDS.map(key => [key, '']));
const NOW = () => new Date().toISOString();
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,120}$/;
const TASK_STATUSES = ['ready', 'needs_input', 'in_progress', 'needs_review', 'changes_requested', 'accepted', 'delivered', 'archived'];
const SOURCE_CATEGORIES = ['reference', 'product', 'experience', 'method', 'policy'];
const SOURCE_TYPES = ['policy', 'school', 'competition', 'parent_question', 'product_fact', 'other'];
const SOURCE_LEVELS = ['official', 'organization', 'first_hand', 'platform', 'other'];
const SOURCE_VERIFICATIONS = ['unverified', 'verified', 'needs_update'];
const LEAD_CHANNELS = ['comment', 'direct_message', 'group', 'manual'];
const LEAD_REVIEW_STATUSES = ['pending_review', 'follow_up', 'ready_handoff', 'handed_off', 'excluded'];
const EDITABLE_FIELDS = ['title', 'body', 'cover', 'pages', 'tags'];
const COLLABORATOR_TYPES = ['freelancer', 'vendor', 'internal', 'creator'];
const COLLABORATOR_STATUSES = ['active', 'paused', 'archived'];
const COLLABORATION_STATUSES = ['invited', 'in_progress', 'submitted', 'changes_requested', 'accepted', 'cancelled'];
const CAMPAIGN_STATUSES = ['planned', 'running', 'paused', 'completed', 'cancelled'];
const EXPERIMENT_STATUSES = ['planned', 'running', 'completed', 'cancelled'];
const TRAFFIC_TYPES = ['organic', 'paid', 'seed', 'enterprise'];

function makeId(prefix, supplied) {
  if (supplied === undefined || supplied === null) return `${prefix}_${randomUUID()}`;
  if (typeof supplied !== 'string' || !ID_PATTERN.test(supplied)) throw new Error('记录 ID 不合法。');
  return supplied;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
}
function date(value) {
  if (value === undefined || value === null) return NOW();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('日期格式不合法。');
  return new Date(value).toISOString();
}
function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}日期格式不合法。`);
  return new Date(value).toISOString().slice(0, 10);
}
function publicationDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}日期格式不合法。`);
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error(`${label}日期不存在。`);
  if (day > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })) throw new Error(`${label}不能晚于今天。`);
  return value.length === 10 ? day : new Date(value).toISOString();
}
function businessDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`${label}必须是有效日期。`);
  return value;
}
function summarizeStoredRun(run) {
  const { contextSnapshot, trace, result, ...summary } = run;
  return { ...summary, hasContextSnapshot: Boolean(contextSnapshot), traceCount: Array.isArray(trace) ? trace.length : 0, hasResult: result !== undefined };
}
function string(value, label, max = 30_000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正确或长度超限。`);
  return value;
}
function noImmutablePatch(patch, keys) {
  if (keys.some(key => Object.hasOwn(patch, key))) throw new Error('不能覆盖记录身份或已有版本；修改内容请创建新版本。');
}
function knownFields(patch, fields, label) {
  if (Object.keys(patch).some(key => !fields.includes(key))) throw new Error(`${label}包含不允许修改的字段。`);
}
function bool(value, label) { if (typeof value !== 'boolean') throw new Error(`${label}必须为布尔值。`); return value; }
function lockedFields(value = []) {
  if (!Array.isArray(value) || value.some(field => !EDITABLE_FIELDS.includes(field))) throw new Error('锁定字段不合法。');
  return [...new Set(value)];
}
function readDefaults(kind, item) {
  if (kind === 'source') return { category: 'reference', note: '', archived: false, region: '', grade: '', sourceType: 'other', sourceLevel: 'other', publishedAt: '', effectiveUntil: '', verificationStatus: 'unverified', reviewContextVersion: 0, ...item };
  if (kind === 'account') return { ...EMPTY_PROFILE, matrixRole: '', owner: '', identity: 'planning', archived: false, reviewContextVersion: 0, ...item };
  if (kind === 'task') return { accountId: null, owner: '', status: 'ready', assignment: null, messages: [], publication: null, publicationHistory: [], preflight: null, preflightHistory: [], reviewContextVersion: 0, ...item };
  if (kind === 'draft') return { origin: 'ai', author: '', changeNote: '', editingSeconds: null, lockedFields: [], evidenceNeedsReview: false, reviewContextHash: null, reviewRevision: null, variantStatus: '', variantIndex: null, variantAngle: '', variantAudience: '', variantGoal: '', selectedAt: '', ...item };
  if (kind === 'run') return { promptVersion: '', toolVersion: '', contextSnapshot: null, trace: [], failedRequests: 0, usageUnknown: false, scope: null, lockedFields: [], ...item };
  if (kind === 'lead') return { taskId: null, channel: 'comment', rawText: '', isDemo: false, analysis: null, reviewStatus: 'pending_review', manualNote: '', model: '', modelUsage: null, modelUsageUnknown: false, classifiedAt: null, humanReview: {}, confirmedFields: null, confirmedAt: null, history: [], ...item };
  if (kind === 'collaborator') return { type: 'creator', role: '', status: 'active', note: '', tags: [], ...item };
  if (kind === 'collaboration') return { taskId: null, collaboratorId: null, role: '', status: 'invited', dueDate: '', batch: '', deliverables: [], review: null, submittedAt: '', reviewedAt: '', reworkReason: '', history: [], ...item };
  if (kind === 'campaign') return { platform: '', trafficType: 'paid', objective: '', audience: '', attributionWindow: '', status: 'planned', budget: null, startDate: '', endDate: '', taskIds: [], notes: '', history: [], ...item };
  if (kind === 'experiment') return { campaignId: null, hypothesis: '', primaryMetric: '', metricDefinition: '', observationStart: '', observationEnd: '', status: 'planned', variants: [], conclusion: '', history: [], ...item };
  return item;
}

export function createStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS entity_kind ON entities(kind);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));`);
  const select = db.prepare('SELECT data FROM entities WHERE id = ? AND kind = ?');
  const selectAll = db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC');
  const selectRunSummaries = db.prepare("SELECT json_remove(data, '$.contextSnapshot', '$.trace', '$.result') AS data, CASE WHEN json_type(data, '$.contextSnapshot') IS NOT NULL AND json_type(data, '$.contextSnapshot') != 'null' THEN 1 ELSE 0 END AS hasContextSnapshot, COALESCE(json_array_length(data, '$.trace'), 0) AS traceCount, CASE WHEN json_type(data, '$.result') IS NULL THEN 0 ELSE 1 END AS hasResult FROM entities WHERE kind = 'run' ORDER BY rowid DESC");
  const insert = db.prepare('INSERT INTO entities(id, kind, data) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE entities SET data = ? WHERE id = ? AND kind = ?');
  let revision = 0;
  const externalVersion = db.prepare('PRAGMA data_version');
  const get = (kind, id) => { const row = select.get(id, kind); return row ? readDefaults(kind, JSON.parse(row.data)) : null; };
  const list = kind => selectAll.all(kind).map(row => readDefaults(kind, JSON.parse(row.data)));
  const required = (kind, id) => { const item = typeof id === 'string' ? get(kind, id) : null; if (!item) throw new Error('引用的记录不存在。'); return item; };
  const add = (kind, item) => {
    try { insert.run(item.id, kind, JSON.stringify(item)); revision++; }
    catch (error) { if (/UNIQUE|PRIMARY KEY/.test(error.message)) throw new Error('记录 ID 已存在，不能覆盖已有内容。'); throw error; }
    return get(kind, item.id);
  };
  const save = (kind, item) => { update.run(JSON.stringify(item), item.id, kind); revision++; return get(kind, item.id); };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  // Bind approval to content-bearing context, never to volatile UI/task status or timestamps.
  const contextHash = task => {
    const account = task.accountId ? required('account', task.accountId) : api.getProfile();
    const accountFields = Object.fromEntries([...PROFILE_FIELDS, 'matrixRole', 'identity', 'archived', 'reviewContextVersion'].map(key => [key, account[key] ?? null]));
    if (!task.accountId) accountFields.reviewContextVersion = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='profile_review_version'").get()?.value || '0');
    const sources = task.sourceIds.map(id => required('source', id)).sort((a, b) => a.id.localeCompare(b.id)).map(({ createdAt, ...source }) => source);
    return createHash('sha256').update(JSON.stringify(stable({ version: task.reviewContextVersion ?? 0, brief: task.brief, owner: task.owner, assignment: task.assignment, accountId: task.accountId, account: accountFields, sources, messages: task.messages.filter(message => message.role === 'user').map(({ text }) => text), plan: task.plan }))).digest('hex');
  };
  const reviewState = (draft, contextHashes = new Map()) => {
    if (!draft) return null;
    if (draft.review && draft.reviewContextHash && !contextHashes.has(draft.taskId)) contextHashes.set(draft.taskId, contextHash(required('task', draft.taskId)));
    const reviewStale = Boolean(draft.review && (!draft.reviewContextHash || draft.reviewContextHash !== contextHashes.get(draft.taskId)));
    return { ...draft, reviewStale, reviewStaleReason: !reviewStale ? '' : draft.reviewContextHash ? '任务要求、资料或账号信息已变化，请重新审核。' : '历史审核未绑定业务资料版本，请重新审核。', evidenceNeedsReview: draft.evidenceNeedsReview || reviewStale, status: reviewStale && draft.status === 'accepted' ? 'draft' : draft.status };
  };
  const taskState = task => {
    if (!task || !['accepted', 'delivered'].includes(task.status)) return task;
    const drafts = list('draft').filter(draft => draft.taskId === task.id);
    const contextHashes = new Map();
    const latest = drafts.filter(draft => !drafts.some(next => next.parentId === draft.id)).map(draft => reviewState(draft, contextHashes));
    return latest.some(draft => draft.reviewStale) || (task.status === 'accepted' && !latest.some(draft => draft.status === 'accepted')) || (task.status === 'delivered' && latest.some(draft => draft.status !== 'accepted')) ? { ...task, status: 'needs_review' } : task;
  };
  const validSourceIds = value => {
    if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string')) throw new Error('资料列表格式不正确。');
    const ids = [...new Set(value)];
    ids.forEach(id => required('source', id));
    return ids;
  };
  const validRef = (task, ref) => {
    if (typeof ref !== 'string' || !task.sourceIds.some(id => get('source', id)?.chunks.some(chunk => chunk.id === ref))) {
      throw new Error(`资料引用无效，必须引用当前任务的真实资料片段：${String(ref).slice(0, 180)}`);
    }
  };
  const validPlan = (task, plan) => {
    if (plan === null) return;
    object(plan, '选题方案');
    if (!Array.isArray(plan.topics) || !Array.isArray(plan.questions)) throw new Error('选题方案格式不正确。');
    const topicIds = new Set();
    for (const topic of plan.topics) {
      object(topic, '选题');
      if (typeof topic.id !== 'string' || !topic.id || topicIds.has(topic.id)) throw new Error('选题 ID 必须存在且不重复。');
      topicIds.add(topic.id);
      if (!Array.isArray(topic.sourceRefs)) throw new Error('选题资料引用格式不正确。');
      topic.sourceRefs.forEach(ref => validRef(task, ref));
    }
  };
  const validReview = (task, review) => {
    if (review === null) return;
    object(review, '审核');
    if (!Array.isArray(review.issues)) throw new Error('审核问题列表格式不正确。');
    for (const issue of review.issues) if (issue.sourceRef) validRef(task, issue.sourceRef);
    if (review.facts !== undefined) {
      if (!Array.isArray(review.facts)) throw new Error('事实核对列表格式不正确。');
      for (const fact of review.facts) if (fact.sourceRef) validRef(task, fact.sourceRef);
    }
  };
  const validAssignment = value => {
    if (value === null) return null;
    object(value, '任务单');
    const assignment = {};
    for (const field of ['audience', 'objective', 'angle']) assignment[field] = string(value[field] || '', '任务单', 6000);
    for (const field of ['facts', 'materials', 'deliverables', 'criteria', 'questions']) {
      if (!Array.isArray(value[field] || []) || (value[field] || []).length > 100) throw new Error('任务单列表格式不正确。');
      assignment[field] = (value[field] || []).map(item => string(item, '任务单条目', 6000));
    }
    return assignment;
  };
  const validPublication = (value, taskId) => {
    if (value === null) return null;
    object(value, '发布记录');
    knownFields(value, ['url', 'platform', 'note', 'publishedAt', 'observedAt', 'contentType', 'metricDefinition', 'trafficType', 'dataSource', 'metrics', 'draftId', 'version'], '发布记录');
    const result = {};
    for (const field of ['url', 'platform', 'note', 'publishedAt', 'observedAt', 'contentType', 'metricDefinition', 'trafficType', 'dataSource']) if (value[field] !== undefined) result[field] = string(value[field], '发布记录', 6000).trim();
    if (!result.url || !result.platform) throw new Error('发布记录必须填写实际内容链接与发布平台，空记录不代表已经发布。');
    if (result.trafficType !== undefined && !['organic', 'paid', 'seed', 'enterprise'].includes(result.trafficType)) throw new Error('流量来源不合法。');
    result.trafficType ||= 'organic';
    if (result.url) { let url; try { url = new URL(result.url); } catch { throw new Error('发布链接格式不正确。'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('发布链接必须为公开 HTTP(S) 链接。'); }
    const draft = required('draft', value.draftId);
    if (draft.taskId !== taskId) throw new Error('发布记录必须绑定当前任务的稿件版本。');
    if (value.version !== undefined && value.version !== draft.version) throw new Error('发布记录版本与所选稿件不一致。');
    result.draftId = draft.id; result.version = draft.version;
    result.publishedAt = publicationDate(value.publishedAt, '发布时间');
    result.observedAt = publicationDate(value.observedAt, '观察时间');
    if (result.publishedAt && result.observedAt && Date.parse(result.observedAt) < Date.parse(result.publishedAt)) throw new Error('观察时间不能早于发布时间。');
    if (value.metrics !== undefined) {
      object(value.metrics, '发布数据'); result.metrics = {};
      for (const [key, count] of Object.entries(value.metrics)) {
        if (!/^[A-Za-z\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,39}$/.test(key) || (count !== null && (typeof count !== 'number' || !Number.isFinite(count) || count < 0))) throw new Error('发布数据必须是非负实数；未知数据用 null 或不填写。');
        result.metrics[key] = count;
      }
      if (Object.values(result.metrics).some(count => count !== null) && !result.observedAt) throw new Error('填写发布数据时必须记录观察日期。');
    }
    return result;
  };
  const validPreflight = (value, taskId) => {
    if (value === null) return null;
    object(value, '发布前检查');
    knownFields(value, ['platform', 'checks', 'note', 'draftId', 'version'], '发布前检查');
    const draft = required('draft', value.draftId);
    if (draft.taskId !== taskId) throw new Error('发布前检查必须绑定当前任务的稿件版本。');
    if (value.version !== undefined && value.version !== draft.version) throw new Error('发布前检查版本与所选稿件不一致。');
    const platform = string(value.platform || '', '发布平台', 100).trim();
    if (!platform) throw new Error('请填写发布平台。');
    const names = ['title', 'cover', 'opening', 'search', 'comment', 'directMessage', 'persona', 'risk'];
    object(value.checks, '发布前检查项');
    if (Object.keys(value.checks).some(key => !names.includes(key))) throw new Error('发布前检查项不合法。');
    const checks = Object.fromEntries(names.map(name => [name, value.checks[name] === undefined ? false : bool(value.checks[name], '发布前检查项')]));
    return { draftId: draft.id, version: draft.version, platform, checks, note: string(value.note || '', '发布前备注', 6000), checkedAt: NOW() };
  };
  const validLead = lead => {
    object(lead, '线索');
    const text = redactSensitive(string(lead.rawText, '咨询原文', 6000)).trim();
    if (!text) throw new Error('咨询原文不能为空。');
    const taskId = lead.taskId || null;
    if (taskId !== null) required('task', taskId);
    const channel = lead.channel || 'comment';
    if (!LEAD_CHANNELS.includes(channel)) throw new Error('咨询来源不合法。');
    const isDemo = lead.isDemo === undefined ? false : bool(lead.isDemo, '演示标记');
    return { taskId, channel, rawText: text, isDemo };
  };
  const validMetrics = (value, label = '指标') => {
    if (value === undefined || value === null) return {};
    object(value, label);
    const metrics = {};
    for (const [key, count] of Object.entries(value)) {
      if (!/^[A-Za-z\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,39}$/.test(key) || (count !== null && (typeof count !== 'number' || !Number.isFinite(count) || count < 0))) throw new Error(`${label}必须是非负实数；未知数据用 null 或不填写。`);
      metrics[key] = count;
    }
    return metrics;
  };
  const validCollaborator = value => {
    object(value, '协作者');
    knownFields(value, ['name', 'type', 'role', 'status', 'note', 'tags'], '协作者');
    const name = string(value.name || '', '协作者名称', 300).trim();
    if (!name) throw new Error('请填写协作者名称。');
    const type = value.type || 'creator'; const status = value.status || 'active';
    if (!COLLABORATOR_TYPES.includes(type)) throw new Error('协作者类型不合法。');
    if (!COLLABORATOR_STATUSES.includes(status)) throw new Error('协作者状态不合法。');
    const tags = value.tags === undefined ? [] : value.tags;
    if (!Array.isArray(tags) || tags.length > 30 || tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new Error('协作者标签格式不正确。');
    return { name, type, role: string(value.role || '', '协作者角色', 6000).trim(), status, note: string(value.note || '', '协作者备注', 6000).trim(), tags: [...new Set(tags)] };
  };
  const validCollaboration = value => {
    object(value, '协作交付');
    knownFields(value, ['taskId', 'collaboratorId', 'role', 'status', 'dueDate', 'batch', 'deliverables', 'review', 'submittedAt', 'reviewedAt', 'reworkReason'], '协作交付');
    const taskId = value.taskId || null; const collaboratorId = value.collaboratorId || null;
    if (taskId) required('task', taskId); else throw new Error('协作交付必须绑定任务。');
    if (collaboratorId) required('collaborator', collaboratorId); else throw new Error('协作交付必须绑定协作者。');
    const status = value.status || 'invited'; if (!COLLABORATION_STATUSES.includes(status)) throw new Error('协作交付状态不合法。');
    const deliverables = value.deliverables === undefined ? [] : value.deliverables;
    if (!Array.isArray(deliverables) || deliverables.length > 50 || deliverables.some(item => typeof item !== 'string' || item.length > 6000)) throw new Error('协作交付物格式不正确。');
    const submittedAt = publicationDate(value.submittedAt, '交稿'); const reviewedAt = publicationDate(value.reviewedAt, '审核');
    const review = string(value.review || '', '协作审核说明', 6000).trim();
    const reworkReason = string(value.reworkReason || '', '返工原因', 6000).trim();
    if (['submitted', 'changes_requested', 'accepted'].includes(status) && !submittedAt) throw new Error('交稿或审核状态必须记录实际交稿日期。');
    if (['changes_requested', 'accepted'].includes(status) && (!reviewedAt || !review)) throw new Error('审核必须填写实际审核日期及说明。');
    if (reviewedAt && (!submittedAt || Date.parse(reviewedAt) < Date.parse(submittedAt))) throw new Error('审核日期不能早于交稿日期。');
    if (status === 'changes_requested' && !reworkReason) throw new Error('退回修改必须填写返工原因。');
    return { taskId, collaboratorId, role: string(value.role || '', '协作角色', 6000).trim(), status, dueDate: businessDate(value.dueDate, '交付截止'), batch: string(value.batch || '', '交付批次', 300).trim(), deliverables, review, submittedAt, reviewedAt, reworkReason };
  };
  const validCampaign = value => {
    object(value, '投放活动');
    knownFields(value, ['name', 'platform', 'trafficType', 'objective', 'audience', 'attributionWindow', 'status', 'budget', 'startDate', 'endDate', 'taskIds', 'notes'], '投放活动');
    const name = string(value.name || '', '活动名称', 300).trim(); if (!name) throw new Error('请填写活动名称。');
    const trafficType = value.trafficType || 'paid'; if (!TRAFFIC_TYPES.includes(trafficType)) throw new Error('流量来源不合法。');
    const status = value.status || 'planned'; if (!CAMPAIGN_STATUSES.includes(status)) throw new Error('活动状态不合法。');
    const taskIds = value.taskIds === undefined ? [] : value.taskIds; if (!Array.isArray(taskIds) || taskIds.length > 100 || taskIds.some(id => typeof id !== 'string')) throw new Error('活动任务列表格式不正确。'); taskIds.forEach(id => required('task', id));
    const budget = value.budget === null || value.budget === undefined || value.budget === '' ? null : value.budget; if (budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)) throw new Error('活动预算必须是非负数或留空。');
    const startDate = businessDate(value.startDate, '活动开始'); const endDate = businessDate(value.endDate, '活动结束'); if (startDate && endDate && endDate < startDate) throw new Error('活动结束日期不能早于开始日期。');
    return { name, platform: string(value.platform || '', '投放平台', 300).trim(), trafficType, objective: string(value.objective || '', '活动目标', 6000).trim(), audience: string(value.audience || '', '目标受众', 6000).trim(), attributionWindow: string(value.attributionWindow || '', '归因口径', 6000).trim(), status, budget, startDate, endDate, taskIds: [...new Set(taskIds)], notes: string(value.notes || '', '活动备注', 6000).trim() };
  };
  const validExperiment = (value, previous = null, refreshSnapshots = false) => {
    object(value, '投放实验');
    knownFields(value, ['campaignId', 'name', 'hypothesis', 'primaryMetric', 'metricDefinition', 'observationStart', 'observationEnd', 'status', 'variants', 'conclusion'], '投放实验');
    const campaignId = value.campaignId || null; if (campaignId) required('campaign', campaignId); else throw new Error('投放实验必须绑定活动。');
    const name = string(value.name || '', '实验名称', 300).trim(); if (!name) throw new Error('请填写实验名称。');
    const status = value.status || 'planned'; if (!EXPERIMENT_STATUSES.includes(status)) throw new Error('实验状态不合法。');
    const variants = value.variants === undefined ? [] : value.variants; if (!Array.isArray(variants) || variants.length < 1 || variants.length > 20) throw new Error('实验至少需要一个变体。');
    const ids = new Set();
    const observationStart = businessDate(value.observationStart, '观察开始'); const observationEnd = businessDate(value.observationEnd, '观察结束');
    if (observationStart && observationEnd && observationEnd < observationStart) throw new Error('观察结束不能早于开始。');
    const normalized = variants.map(variant => {
      object(variant, '实验变体'); knownFields(variant, ['id', 'name', 'taskId', 'draftId', 'metrics', 'observedAt', 'note'], '实验变体');
      const id = string(variant.id || '', '变体 ID', 120).trim(); if (!id || ids.has(id)) throw new Error('实验变体 ID 必须存在且不重复。'); ids.add(id);
      const draft = variant.draftId ? required('draft', variant.draftId) : null;
      const taskId = variant.taskId || draft?.taskId || null; const task = taskId ? required('task', taskId) : null;
      if (draft && draft.taskId !== taskId) throw new Error('实验稿件必须属于关联任务。');
      if (taskId && !required('campaign', campaignId).taskIds.includes(taskId)) throw new Error('实验任务必须属于投放活动。');
      const metrics = validMetrics(variant.metrics, '实验指标'); const observedAt = publicationDate(variant.observedAt, '实验观察');
      if (Object.values(metrics).some(metric => metric !== null) && !observedAt) throw new Error('实验数据必须记录观察日期。');
      if (observedAt && ((observationStart && observedAt.slice(0, 10) < observationStart) || (observationEnd && observedAt.slice(0, 10) > observationEnd))) throw new Error('实验数据观察日期必须处于观察窗口内。');
      const previousVariant = previous?.variants.find(item => item.id === id && item.taskId === taskId && item.draftId === (draft?.id || null));
      if (refreshSnapshots && task?.publication && draft && task.publication.draftId !== draft.id) throw new Error('当前发布记录属于另一稿件版本，不能更新到此实验变体；请核对版本绑定。');
      const publicationSnapshot = previousVariant && !refreshSnapshots ? previousVariant.publicationSnapshot : task?.publication && (!draft || task.publication.draftId === draft.id) ? task.publication : null;
      if (refreshSnapshots && previousVariant?.publicationSnapshot && !publicationSnapshot) throw new Error('当前没有可用发布记录，不能清空历史快照。');
      if (refreshSnapshots && previousVariant?.publicationSnapshot && ['url', 'platform', 'trafficType', 'dataSource', 'metricDefinition', 'publishedAt'].some(key => (previousVariant.publicationSnapshot[key] || '') !== (publicationSnapshot[key] || ''))) throw new Error('新旧发布数据口径不一致，请建立独立实验，不覆盖历史快照。');
      if (publicationSnapshot && (!publicationSnapshot.observedAt || (observationStart && publicationSnapshot.observedAt.slice(0, 10) < observationStart) || (observationEnd && publicationSnapshot.observedAt.slice(0, 10) > observationEnd))) throw new Error('关联发布快照的观察日期必须处于观察窗口内；请调整窗口或选择正确稿件，不能隐式替换历史快照。');
      return { id, name: string(variant.name || '', '变体名称', 300).trim(), taskId, draftId: draft?.id || null, metrics, observedAt, note: string(variant.note || '', '变体备注', 6000).trim(), publicationSnapshot };
    });
    const result = { campaignId, name, hypothesis: string(value.hypothesis || '', '实验假设', 6000).trim(), primaryMetric: string(value.primaryMetric || '', '主指标', 300).trim(), metricDefinition: string(value.metricDefinition || '', '指标口径', 6000).trim(), observationStart, observationEnd, status, variants: normalized, conclusion: string(value.conclusion || '', '人工实验结论', 6000).trim() };
    if (status === 'completed' && (!result.hypothesis || !result.primaryMetric || !result.metricDefinition || !observationStart || !observationEnd || !result.conclusion)) throw new Error('完成实验需填写假设、主指标、指标口径、观察窗口和人工结论。');
    return result;
  };
  const assertLatest = draft => { if (list('draft').some(item => item.parentId === draft.id)) throw new Error('请使用最新稿件版本。'); };
  const assertReviewRevision = (draft, request) => {
    if (Object.hasOwn(request, 'expectedReviewRevision') && (!draft.reviewRevision || request.expectedReviewRevision !== draft.reviewRevision)) {
      const error = new Error('审核版本已变化，请刷新并重新核对当前审核意见。'); error.status = 409; throw error;
    }
  };
  const draftDecisions = draft => list('issueDecision').filter(item => item.draftId === draft.id && item.reviewRevision === draft.reviewRevision);
  const reportFor = draft => qualityReport(reviewState(draft), required('task', draft.taskId).sourceIds.map(id => required('source', id)), list('draft').filter(item => item.taskId !== draft.taskId || item.topicId !== draft.topicId), draftDecisions(draft));
  const assertAcceptable = draft => {
    assertLatest(draft);
    if (reviewState(draft).reviewStale) throw new Error('审核已过期，请按最新任务资料重新审核后采纳。');
    if (!draft.review || draft.evidenceNeedsReview) throw new Error('稿件尚未完成当前版本审核，不能采纳。');
    const report = reportFor(draft);
    if (report.exportSafety?.hasCredentials) throw new Error('稿件含有凭据或密钥，必须移除并重新审核，不能人工绕过。');
    if (['unreviewed', 'blocked'].includes(report.readiness)) throw new Error('稿件存在未处理的阻断问题，请先审核、修改或逐条处理问题。');
  };
  const operationValidators = { collaborator: validCollaborator, collaboration: validCollaboration, campaign: validCampaign, experiment: validExperiment };
  const editableOperation = item => {
    const { id, createdAt, updatedAt, history, ...value } = item;
    if (value.variants) value.variants = value.variants.map(({ publicationSnapshot, ...variant }) => variant);
    return value;
  };
  const addOperation = (kind, value) => {
    const item = operationValidators[kind](value); const createdAt = NOW();
    return add(kind, { ...item, id: makeId(kind), createdAt, updatedAt: createdAt, history: [] });
  };
  const updateOperation = (kind, id, patch) => {
    object(patch, '业务记录修改');
    noImmutablePatch(patch, ['id', 'createdAt', 'updatedAt', 'history']);
    const current = required(kind, id);
    if (kind === 'collaboration' && ((patch.taskId && patch.taskId !== current.taskId) || (patch.collaboratorId && patch.collaboratorId !== current.collaboratorId))) throw new Error('协作任务与协作者不可更换，请新建交付记录。');
    let validatedPatch = patch; let refreshSnapshots = false;
    if (kind === 'experiment' && Object.hasOwn(patch, 'refreshPublicationSnapshots')) {
      refreshSnapshots = bool(patch.refreshPublicationSnapshots, '更新发布快照');
      const { refreshPublicationSnapshots, ...rest } = patch; validatedPatch = rest;
    }
    const value = operationValidators[kind]({ ...editableOperation(current), ...validatedPatch }, kind === 'experiment' ? current : undefined, refreshSnapshots);
    if (kind === 'campaign' && list('experiment').some(experiment => experiment.campaignId === id && experiment.variants.some(variant => variant.taskId && !value.taskIds.includes(variant.taskId)))) throw new Error('任务已被该活动的实验引用，不能从活动中移除。');
    if (isDeepStrictEqual(value, { ...editableOperation(current), ...(current.variants ? { variants: current.variants } : {}) })) return current;
    const updatedAt = NOW();
    const { history = [], ...snapshot } = current;
    return save(kind, { ...value, id, createdAt: current.createdAt, updatedAt, history: [...history, { ...snapshot, replacedAt: updatedAt }] });
  };

  const api = {
    listCollaborators: () => list('collaborator'),
    getCollaborator: id => get('collaborator', id),
    addCollaborator: value => addOperation('collaborator', value),
    updateCollaborator: (id, patch) => updateOperation('collaborator', id, patch),
    listCollaborations: () => list('collaboration'),
    getCollaboration: id => get('collaboration', id),
    addCollaboration: value => addOperation('collaboration', value),
    updateCollaboration: (id, patch) => updateOperation('collaboration', id, patch),
    listCampaigns: () => list('campaign'),
    getCampaign: id => get('campaign', id),
    addCampaign: value => addOperation('campaign', value),
    updateCampaign: (id, patch) => updateOperation('campaign', id, patch),
    listExperiments: () => list('experiment'),
    getExperiment: id => get('experiment', id),
    addExperiment: value => addOperation('experiment', value),
    updateExperiment: (id, patch) => updateOperation('experiment', id, patch),
    collaborationMetrics() {
      const records = list('collaboration');
      const reviewed = records.map(item => {
        const chain = [...item.history, item];
        const reviews = chain.filter((entry, index) => ['accepted', 'changes_requested'].includes(entry.status) && (index === 0 || chain[index - 1].status !== entry.status));
        // A same-round edit corrects the effective date; resubmission after a
        // rework starts a new round and must not replace the first-round date.
        let submitted = null; let sawRework = false;
        for (let index = 0; index < chain.length; index++) {
          const entry = chain[index];
          if (sawRework && entry.status === 'submitted' && chain[index - 1]?.status !== 'submitted') break;
          if (entry.submittedAt) submitted = { ...entry, dueDate: submitted?.dueDate ?? entry.dueDate };
          if (entry.status === 'changes_requested') sawRework = true;
        }
        return { item, reviews, submitted };
      });
      const audited = reviewed.filter(row => row.reviews.length);
      const firstPassCount = audited.filter(row => row.reviews[0].status === 'accepted').length;
      const reworkedCount = audited.filter(row => row.reviews.some(entry => entry.status === 'changes_requested')).length;
      const dueSamples = reviewed.filter(row => row.submitted?.dueDate && row.submitted.submittedAt);
      const onTimeCount = dueSamples.filter(row => row.submitted.submittedAt.slice(0, 10) <= row.submitted.dueDate).length;
      const cycles = reviewed.filter(row => row.item.status === 'accepted' && row.submitted && row.item.reviewedAt).map(row => (Date.parse(row.item.reviewedAt) - Date.parse(row.submitted.submittedAt)) / 86400000).filter(days => days >= 0);
      return { total: records.length, reviewedCount: audited.length, firstPassCount, firstPassRate: audited.length ? firstPassCount / audited.length : null, reworkedCount, reworkRate: audited.length ? reworkedCount / audited.length : null, onTimeCount, onTimeSampleCount: dueSamples.length, onTimeRate: dueSamples.length ? onTimeCount / dueSamples.length : null, acceptedCycleSampleCount: cycles.length, averageAcceptedCycleDays: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null, definition: '一次通过/返工按每份交付首次及后续审核状态统计；准时按首次交稿与当时截止日期；审核周期为首次交稿到当前验收日期。均为人工记录，无样本返回 null。' };
    },
    validatePublications(rows) {
      if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('导入记录必须为 1–1000 行。');
      const seen = new Set();
      return rows.map(row => {
        object(row, '导入行'); knownFields(row, ['taskId', 'publication'], '导入行');
        const task = required('task', row.taskId);
        if (seen.has(task.id)) throw new Error('同一批次不能重复导入同一任务。'); seen.add(task.id);
        if (!row.publication) throw new Error('导入行必须提供发布记录。');
        const publication = validPublication(row.publication, task.id);
        if (task.publication) {
          const previous = task.publication;
          if (['url', 'draftId', 'platform', 'trafficType'].some(key => (previous[key] || (key === 'trafficType' ? 'organic' : '')) !== publication[key]) || (previous.dataSource && previous.dataSource !== publication.dataSource)) throw new Error('任务已有不同发布身份或数据来源，导入不能覆盖。');
          if (!publication.observedAt || !previous.observedAt || Date.parse(publication.observedAt) <= Date.parse(previous.observedAt)) throw new Error('不能覆盖已有观察快照，只接受严格较晚的观察日期。');
        }
        return { taskId: task.id, publication };
      });
    },
    importPublications(rows) {
      if (Array.isArray(rows) && rows.length === 0) return [];
      const previousRevision = revision;
      db.exec('BEGIN IMMEDIATE');
      try {
        const normalized = api.validatePublications(rows);
        const results = normalized.map(row => api.updateTask(row.taskId, { publication: row.publication }));
        db.exec('COMMIT'); return results;
      } catch (error) { db.exec('ROLLBACK'); revision = previousRevision; throw error; }
    },
    getProfile() {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'profile'").get();
      return row ? { ...EMPTY_PROFILE, ...JSON.parse(row.value) } : { ...EMPTY_PROFILE };
    },
    saveProfile(profile) {
      object(profile, '账号档案');
      const saved = api.getProfile();
      const previous = structuredClone(saved);
      for (const key of PROFILE_FIELDS) if (Object.hasOwn(profile, key)) saved[key] = string(profile[key], '账号档案', 20_000).trim();
      if (!isDeepStrictEqual(saved, previous)) db.prepare("INSERT INTO settings(key,value) VALUES('profile_review_version','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
      db.prepare("INSERT INTO settings(key,value) VALUES('profile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(saved));
      revision++;
      return api.getProfile();
    },
    listAccounts: () => list('account'),
    getAccount: id => get('account', id),
    addAccount(account) {
      object(account, '账号');
      const createdAt = date(account.createdAt);
      const item = { id: makeId('account', account.id), ...EMPTY_PROFILE, matrixRole: '', owner: '', identity: 'planning', archived: false, createdAt, updatedAt: createdAt };
      for (const key of [...PROFILE_FIELDS, 'matrixRole', 'owner']) if (account[key] !== undefined) item[key] = string(account[key], '账号字段', 20_000).trim();
      if (!item.name) throw new Error('请填写账号名称。');
      if (account.identity !== undefined) item.identity = account.identity;
      if (!['real', 'planning'].includes(item.identity)) throw new Error('账号身份必须标记为真实或规划。');
      if (account.archived !== undefined) item.archived = bool(account.archived, '归档状态');
      return add('account', item);
    },
    updateAccount(id, patch) {
      object(patch, '账号修改'); knownFields(patch, [...PROFILE_FIELDS, 'matrixRole', 'owner', 'identity', 'archived'], '账号修改');
      const item = required('account', id);
      const previous = structuredClone(item);
      for (const key of [...PROFILE_FIELDS, 'matrixRole', 'owner']) if (patch[key] !== undefined) item[key] = string(patch[key], '账号字段', 20_000).trim();
      if (!item.name) throw new Error('请填写账号名称。');
      if (patch.identity !== undefined) { if (!['real', 'planning'].includes(patch.identity)) throw new Error('账号身份必须标记为真实或规划。'); item.identity = patch.identity; }
      if (patch.archived !== undefined) item.archived = bool(patch.archived, '归档状态');
      if (!isDeepStrictEqual(item, previous)) item.reviewContextVersion++;
      item.updatedAt = NOW(); return save('account', item);
    },
    listSources: () => list('source'),
    getSource: id => get('source', id),
    addSource(source) {
      object(source, '资料');
      const id = makeId('source', source.id);
      const text = string(source.text, '资料正文', 250_000).trim();
      if (!text) throw new Error('资料正文不能为空。');
      const category = source.category || 'reference';
      if (!SOURCE_CATEGORIES.includes(category)) throw new Error('资料分类不合法。');
      const sourceType = source.sourceType || 'other'; const sourceLevel = source.sourceLevel || 'other'; const verificationStatus = source.verificationStatus || 'unverified';
      if (!SOURCE_TYPES.includes(sourceType) || !SOURCE_LEVELS.includes(sourceLevel) || !SOURCE_VERIFICATIONS.includes(verificationStatus)) throw new Error('资料台账字段不合法。');
      const demoFlag = source.isDemo === undefined ? {} : { isDemo: bool(source.isDemo, '演示标记') };
      return add('source', { id, title: string(source.title || '未命名资料', '资料标题', 200), url: string(source.url || '', '资料链接', 4000), text, kind: string(source.kind || 'text', '资料类型', 30), chunks: chunkText(text, id), createdAt: date(source.createdAt), category, note: string(source.note || '', '资料说明', 6000), archived: source.archived === undefined ? false : bool(source.archived, '归档状态'), region: string(source.region || '', '适用地区', 160).trim(), grade: string(source.grade || '', '适用年级', 160).trim(), sourceType, sourceLevel, publishedAt: optionalDate(source.publishedAt, '发布时间'), effectiveUntil: optionalDate(source.effectiveUntil, '有效期'), verificationStatus, ...demoFlag });
    },
    updateSource(id, patch) {
      object(patch, '资料修改'); knownFields(patch, ['category', 'note', 'archived', 'region', 'grade', 'sourceType', 'sourceLevel', 'publishedAt', 'effectiveUntil', 'verificationStatus', 'isDemo'], '资料修改');
      const item = required('source', id);
      const previous = structuredClone(item);
      if (patch.category !== undefined) { if (!SOURCE_CATEGORIES.includes(patch.category)) throw new Error('资料分类不合法。'); item.category = patch.category; }
      if (patch.note !== undefined) item.note = string(patch.note, '资料说明', 6000);
      if (patch.archived !== undefined) item.archived = bool(patch.archived, '归档状态');
      if (patch.isDemo !== undefined) item.isDemo = bool(patch.isDemo, '演示标记');
      if (patch.region !== undefined) item.region = string(patch.region, '适用地区', 160).trim();
      if (patch.grade !== undefined) item.grade = string(patch.grade, '适用年级', 160).trim();
      if (patch.sourceType !== undefined) { if (!SOURCE_TYPES.includes(patch.sourceType)) throw new Error('资料类型不合法。'); item.sourceType = patch.sourceType; }
      if (patch.sourceLevel !== undefined) { if (!SOURCE_LEVELS.includes(patch.sourceLevel)) throw new Error('来源级别不合法。'); item.sourceLevel = patch.sourceLevel; }
      if (patch.publishedAt !== undefined) item.publishedAt = optionalDate(patch.publishedAt, '发布时间');
      if (patch.effectiveUntil !== undefined) item.effectiveUntil = optionalDate(patch.effectiveUntil, '有效期');
      if (patch.verificationStatus !== undefined) { if (!SOURCE_VERIFICATIONS.includes(patch.verificationStatus)) throw new Error('核验状态不合法。'); item.verificationStatus = patch.verificationStatus; }
      if (!isDeepStrictEqual(item, previous)) item.reviewContextVersion++;
      return save('source', item);
    },
    listLeads: () => list('lead'),
    getLead: id => get('lead', id),
    addLead(lead) {
      const validated = validLead(lead); const createdAt = date(lead.createdAt);
      return add('lead', { id: makeId('lead', lead.id), ...validated, analysis: null, reviewStatus: 'pending_review', manualNote: '', model: '', modelUsage: null, modelUsageUnknown: false, classifiedAt: null, humanReview: {}, confirmedFields: null, confirmedAt: null, history: [], createdAt, updatedAt: createdAt });
    },
    updateLead(id, patch) {
      object(patch, '线索修改'); knownFields(patch, ['taskId', 'reviewStatus', 'manualNote', 'humanReview'], '线索修改');
      const item = required('lead', id);
      const before = { taskId: item.taskId, reviewStatus: item.reviewStatus, manualNote: item.manualNote, humanReview: structuredClone(item.humanReview), confirmedFields: item.confirmedFields, confirmedAt: item.confirmedAt };
      if (patch.taskId !== undefined) { if (patch.taskId !== null) required('task', patch.taskId); item.taskId = patch.taskId; }
      if (patch.reviewStatus !== undefined) { if (!LEAD_REVIEW_STATUSES.includes(patch.reviewStatus)) throw new Error('线索状态不合法。'); item.reviewStatus = patch.reviewStatus; }
      if (patch.manualNote !== undefined) item.manualNote = redactSensitive(string(patch.manualNote, '人工备注', 6000)).trim();
      if (patch.humanReview !== undefined) {
        if (!Object.hasOwn(patch, 'manualNote') || !item.manualNote) throw new Error('修正线索字段时请填写本次人工备注。');
        item.humanReview = { ...item.humanReview, ...validateLeadHumanReview(patch.humanReview) };
      }
      const fieldsChanged = JSON.stringify(item.humanReview) !== JSON.stringify(before.humanReview) || item.taskId !== before.taskId;
      if (fieldsChanged && !patch.reviewStatus && ['ready_handoff', 'handed_off'].includes(item.reviewStatus)) item.reviewStatus = 'pending_review';
      if (['ready_handoff', 'handed_off'].includes(item.reviewStatus)) {
        if (!Object.hasOwn(patch, 'manualNote') || !item.manualNote) throw new Error('交接前必须填写本次人工确认备注。');
        if (item.reviewStatus === 'handed_off' && !['ready_handoff', 'handed_off'].includes(before.reviewStatus)) throw new Error('请先人工确认可交接，再标记已交接。');
        const fields = { ...(item.analysis || {}), ...item.humanReview };
        delete fields.reasoning;
        if (!Object.values(fields).some(value => typeof value === 'string' && value.trim() && value !== '待确认')) throw new Error('请先完成 AI 初判或填写人工修正字段，再确认交接。');
        if (item.reviewStatus === 'handed_off' && fieldsChanged) throw new Error('交接字段发生修改，请先重新确认可交接。');
        item.confirmedFields = fields; item.confirmedAt = NOW();
      } else { item.confirmedFields = null; item.confirmedAt = null; }
      const after = { taskId: item.taskId, reviewStatus: item.reviewStatus, manualNote: item.manualNote, humanReview: structuredClone(item.humanReview), confirmedFields: item.confirmedFields, confirmedAt: item.confirmedAt };
      item.history.push({ id: makeId('lead_event'), kind: 'human_review', at: NOW(), before, after });
      item.updatedAt = NOW(); return save('lead', item);
    },
    recordLeadAnalysis(id, result) {
      object(result, 'AI 分拣结果');
      const item = required('lead', id);
      const analysis = validateLeadAnalysis(result.analysis);
      const model = string(result.model || '', '模型名称', 300);
      const usage = result.usage ?? null;
      if (usage !== null && (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0)) throw new Error('模型用量格式不正确。');
      const before = { analysis: item.analysis, model: item.model, modelUsage: item.modelUsage, modelUsageUnknown: item.modelUsageUnknown, classifiedAt: item.classifiedAt, reviewStatus: item.reviewStatus, confirmedFields: item.confirmedFields, confirmedAt: item.confirmedAt };
      const after = { analysis, model, modelUsage: usage, modelUsageUnknown: result.usageUnknown === undefined ? usage === null : bool(result.usageUnknown, '模型用量状态'), classifiedAt: NOW(), reviewStatus: 'pending_review', confirmedFields: null, confirmedAt: null };
      Object.assign(item, after);
      item.history.push({ id: makeId('lead_event'), kind: 'ai_analysis', at: NOW(), before, after });
      item.updatedAt = NOW(); return save('lead', item);
    },
    listTasks: () => list('task').map(taskState),
    getTask: id => taskState(get('task', id)),
    getReviewContextHash: taskId => contextHash(required('task', taskId)),
    addTask(task) {
      object(task, '任务');
      const brief = string(task.brief, '任务要求', 20_000).trim();
      if (!brief) throw new Error('任务要求不能为空。');
      const createdAt = date(task.createdAt);
      const item = { id: makeId('task', task.id), title: string(task.title || brief.slice(0, 36), '任务标题', 200), brief, sourceIds: validSourceIds(task.sourceIds || []), createdAt, updatedAt: createdAt, plan: task.plan || null, accountId: task.accountId || null, owner: string(task.owner || '', '任务负责人', 300), status: 'ready', assignment: validAssignment(task.assignment || null), messages: [], publication: validPublication(task.publication || null), preflight: validPreflight(task.preflight || null) };
      if (item.accountId) { const account = required('account', item.accountId); if (account.archived) throw new Error('不能为归档账号创建任务。'); }
      validPlan(item, item.plan);
      return add('task', item);
    },
    updateTask(id, patch) {
      object(patch, '任务修改'); noImmutablePatch(patch, ['id', 'createdAt']);
      knownFields(patch, ['title', 'brief', 'owner', 'accountId', 'status', 'sourceIds', 'assignment', 'publication', 'preflight', 'plan', 'messages'], '任务修改');
      const current = required('task', id);
      const item = { ...current, ...patch, id, updatedAt: NOW() };
      item.brief = string(item.brief, '任务要求', 20_000).trim();
      item.title = string(item.title, '任务标题', 200);
      item.sourceIds = validSourceIds(item.sourceIds);
      if (!item.brief) throw new Error('任务要求不能为空。');
      const removed = current.sourceIds.filter(sourceId => !item.sourceIds.includes(sourceId));
      if (removed.length) throw new Error('任务只能增补资料，不能移除资料，否则历史引用会失效。请创建新任务。');
      if (item.accountId) required('account', item.accountId);
      if (item.accountId !== current.accountId && current.accountId && list('draft').some(draft => draft.taskId === id)) throw new Error('已有稿件的任务不能更换账号，请创建新任务。');
      item.owner = string(item.owner, '任务负责人', 300);
      if (!TASK_STATUSES.includes(item.status)) throw new Error('任务状态不合法。');
      item.assignment = validAssignment(item.assignment);
      // Legacy records remain readable; only explicit edits adopt the stricter version-bound contract.
      if (Object.hasOwn(patch, 'publication')) {
        item.publication = validPublication(patch.publication, id);
        if (current.publication && !isDeepStrictEqual(current.publication, item.publication)) item.publicationHistory = [...current.publicationHistory, { ...current.publication, replacedAt: item.updatedAt }];
      }
      if (Object.hasOwn(patch, 'preflight')) {
        item.preflight = validPreflight(patch.preflight, id);
        if (current.preflight && !isDeepStrictEqual(current.preflight, item.preflight)) item.preflightHistory = [...current.preflightHistory, { ...current.preflight, replacedAt: item.updatedAt }];
      }
      if (!Array.isArray(item.messages)) throw new Error('任务消息格式不正确。');
      if (['accepted', 'delivered'].includes(item.status) && Object.hasOwn(patch, 'status')) {
        const drafts = list('draft');
        const latest = drafts.filter(draft => draft.taskId === id && !drafts.some(next => next.parentId === draft.id));
        const accepted = latest.filter(draft => draft.status === 'accepted');
        if (!accepted.length) throw new Error('请先审核并采纳当前任务的稿件。');
        if (item.status === 'delivered' && latest.some(draft => draft.status !== 'accepted')) throw new Error('请先采纳当前任务所有最新稿件，再标记交付。');
        accepted.forEach(assertAcceptable);
        if (contextHash(current) !== contextHash(item)) throw new Error('业务上下文已变化，请保存后重新审核，不能同时采纳或交付。');
      }
      if (!Object.hasOwn(patch, 'status') && ['accepted', 'delivered'].includes(item.status) && contextHash(current) !== contextHash(item)) item.status = 'needs_review';
      if (contextHash(current) !== contextHash(item)) item.reviewContextVersion++;
      validPlan(item, item.plan);
      return save('task', item);
    },
    appendMessage(taskId, message) {
      object(message, '补充消息');
      const task = required('task', taskId);
      const role = message.role || 'user';
      if (!['user', 'assistant'].includes(role)) throw new Error('消息角色不合法。');
      const text = string(message.text, '补充消息', 20_000).trim();
      if (!text) throw new Error('补充消息不能为空。');
      const ids = message.sourceIds === undefined ? [] : validSourceIds(message.sourceIds);
      const item = { id: makeId('message'), role, text, createdAt: NOW() };
      return api.updateTask(taskId, { messages: [...task.messages, item], sourceIds: [...new Set([...task.sourceIds, ...ids])], status: role === 'user' ? 'ready' : task.status });
    },
    listRuns: () => list('run'),
    listRunSummaries: () => selectRunSummaries.all().map(row => ({ ...summarizeStoredRun(readDefaults('run', JSON.parse(row.data))), hasContextSnapshot: Boolean(row.hasContextSnapshot), traceCount: row.traceCount, hasResult: Boolean(row.hasResult) })),
    getRun: id => get('run', id),
    addRun(run) {
      object(run, '运行'); required('task', run.taskId);
      if (!['brief', 'plan', 'draft', 'variants', 'review', 'revise'].includes(run.action)) throw new Error('运行类型不合法。');
      if (!['queued', 'running', 'completed', 'failed'].includes(run.status || 'queued')) throw new Error('运行状态不合法。');
      return add('run', { id: makeId('run', run.id), taskId: run.taskId, action: run.action, topicId: run.topicId || '', draftId: run.draftId || '', variantCount: run.variantCount || 3, status: run.status || 'queued', instruction: string(run.instruction || '', '补充要求', 20_000), createdAt: date(run.createdAt), finishedAt: run.finishedAt ? date(run.finishedAt) : null, error: run.error || null, events: Array.isArray(run.events) ? run.events : [], usage: { inputTokens: 0, outputTokens: 0, ...run.usage }, model: run.model || '', promptVersion: run.promptVersion || '', toolVersion: run.toolVersion || '', contextSnapshot: run.contextSnapshot || null, trace: run.trace || [], failedRequests: run.failedRequests || 0, usageUnknown: Boolean(run.usageUnknown), scope: run.scope || null, lockedFields: lockedFields(run.lockedFields), retryOf: run.retryOf || null, previousTaskStatus: run.previousTaskStatus || null });
    },
    updateRun(id, patch) {
      object(patch, '运行修改'); noImmutablePatch(patch, ['id', 'taskId', 'action', 'createdAt']);
      const current = required('run', id);
      const item = { ...current, ...patch, usage: { ...current.usage, ...patch.usage }, id };
      if (!['queued', 'running', 'completed', 'failed'].includes(item.status)) throw new Error('运行状态不合法。');
      if (['completed', 'failed'].includes(current.status) && item.status !== current.status) throw new Error('已结束的运行不能重新启动，请创建新运行。');
      if (item.finishedAt) item.finishedAt = date(item.finishedAt);
      if (!Array.isArray(item.events)) throw new Error('运行事件格式不正确。');
      return save('run', item);
    },
    appendEvent(runId, event) {
      object(event, '运行事件');
      const run = required('run', runId);
      run.events.push({ ...event, at: date(event.at) });
      return save('run', run);
    },
    listDrafts: () => { const contextHashes = new Map(); return list('draft').map(draft => reviewState(draft, contextHashes)); },
    getDraft: id => reviewState(get('draft', id)),
    addDraft(draft) {
      object(draft, '草稿');
      const task = required('task', draft.taskId);
      const parent = draft.parentId ? required('draft', draft.parentId) : null;
      const topicId = draft.topicId || parent?.topicId || '';
      if (parent && (parent.taskId !== draft.taskId || parent.topicId !== topicId)) throw new Error('新版本必须与原稿属于同一个任务和选题。');
      const version = parent ? parent.version + 1 : 1;
      if (draft.version !== undefined && draft.version !== version) throw new Error('草稿版本号必须从 1 开始，并在原稿基础上递增。');
      if (parent && list('draft').some(item => item.parentId === parent.id)) throw new Error('该版本已有后续稿件，请基于最新版本继续修改。');
      if (!Array.isArray(draft.evidence || [])) throw new Error('草稿证据格式不正确。');
      (draft.evidence || []).forEach(evidence => validRef(task, evidence.sourceRef));
      validReview(task, draft.review || null);
      const origin = draft.origin || 'ai';
      if (!['ai', 'imported', 'manual'].includes(origin)) throw new Error('稿件来源类型不合法。');
      const editingSeconds = draft.editingSeconds ?? null;
      if (editingSeconds !== null && (!Number.isFinite(editingSeconds) || editingSeconds < 0 || editingSeconds > 604800)) throw new Error('编辑耗时必须是合理的非负秒数。');
      const variantStatus = draft.variantStatus || '';
      if (!['', 'candidate', 'selected', 'archived'].includes(variantStatus)) throw new Error('候选方案状态不合法。');
      const variantIndex = draft.variantIndex == null ? null : Number(draft.variantIndex);
      if (variantIndex !== null && (!Number.isInteger(variantIndex) || variantIndex < 1 || variantIndex > 5)) throw new Error('候选方案序号不合法。');
      const item = { id: makeId('draft', draft.id), taskId: task.id, topicId, title: string(draft.title || '', '草稿标题', 500), body: string(draft.body || '', '草稿正文'), cover: string(draft.cover || '', '封面文案', 3000), pages: draft.pages || [], tags: draft.tags || [], evidence: draft.evidence || [], gaps: draft.gaps || [], review: draft.review || null, version, parentId: parent?.id || null, createdAt: date(draft.createdAt), status: draft.status || 'draft', origin, author: string(draft.author || '', '作者', 300), changeNote: string(draft.changeNote || '', '修改说明', 6000), editingSeconds, lockedFields: lockedFields(draft.lockedFields), evidenceNeedsReview: Boolean(draft.evidenceNeedsReview), variantStatus, variantIndex, variantAngle: string(draft.variantAngle || '', '方案角度', 1200), variantAudience: string(draft.variantAudience || '', '方案受众', 800), variantGoal: string(draft.variantGoal || '', '方案目标', 800), selectedAt: draft.selectedAt ? date(draft.selectedAt) : '' };
      for (const key of ['pages', 'tags', 'gaps']) if (!Array.isArray(item[key])) throw new Error('草稿内容格式不正确。');
      if (item.pages.length > 30 || item.pages.some(page => !page || typeof page.heading !== 'string' || typeof page.text !== 'string' || page.heading.length > 500 || page.text.length > 10_000)) throw new Error('图文页格式不正确。');
      if (item.tags.length > 30 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new Error('标签格式不正确。');
      if (item.gaps.length > 100 || item.gaps.some(gap => typeof gap !== 'string' || gap.length > 6000)) throw new Error('素材缺口格式不正确。');
      item.reviewContextHash = item.review ? contextHash(task) : null;
      item.reviewRevision = item.review ? makeId('review') : null;
      return reviewState(add('draft', item));
    },
    addDraftVersion(id, patch) {
      object(patch, '人工修改'); knownFields(patch, [...EDITABLE_FIELDS, 'lockedFields', 'changeNote', 'editingSeconds'], '人工修改');
      const current = required('draft', id); assertLatest(current);
      const changeNote = string(patch.changeNote || '', '修改说明', 6000).trim();
      if (!changeNote) throw new Error('请填写修改说明，便于版本核对。');
      if (!EDITABLE_FIELDS.some(field => Object.hasOwn(patch, field)) && !Object.hasOwn(patch, 'lockedFields')) throw new Error('请至少修改一个稿件字段。');
      const next = { ...current, ...patch, parentId: current.id, version: current.version + 1, origin: 'manual', changeNote, review: null, status: 'draft', evidenceNeedsReview: true, editingSeconds: patch.editingSeconds ?? null };
      delete next.id; delete next.createdAt;
      const result = api.addDraft(next);
      api.updateTask(current.taskId, { status: 'needs_review' });
      return result;
    },
    updateDraft(id, patch) {
      object(patch, '草稿修改');
      if (Object.keys(patch).some(key => !['review', 'status', 'evidenceNeedsReview', 'reviewContextHash'].includes(key))) throw new Error('已保存的草稿内容不可覆盖；修改正文请创建新版本。');
      const current = required('draft', id);
      const item = { ...current, ...patch };
      validReview(required('task', item.taskId), item.review);
      if (Object.hasOwn(patch, 'review')) {
        item.reviewContextHash = item.review ? patch.reviewContextHash || contextHash(required('task', item.taskId)) : null;
        item.reviewRevision = item.review ? makeId('review') : null;
        item.status = 'draft';
      }
      if (patch.evidenceNeedsReview === true && item.status === 'accepted') item.status = 'draft';
      return reviewState(save('draft', item));
    },
    selectDraftVariant(id) {
      const selected = required('draft', id);
      if (!selected.variantStatus || !['candidate', 'selected'].includes(selected.variantStatus)) throw new Error('这份稿件不是可选择的候选方案。');
      if (selected.parentId || list('draft').some(item => item.parentId === selected.id)) throw new Error('已有后续版本，不能重新选择旧方案。');
      const siblings = list('draft').filter(item => item.taskId === selected.taskId && item.variantStatus && !item.parentId);
      siblings.forEach(item => { if (item.id !== selected.id && item.variantStatus !== 'archived') save('draft', { ...item, variantStatus: 'archived' }); });
      const updated = save('draft', { ...selected, variantStatus: 'selected', selectedAt: NOW(), review: null, evidenceNeedsReview: true, status: 'draft' });
      updateTask(selected.taskId, { status: 'needs_review' });
      return reviewState(updated);
    },
    listIssueDecisions: () => list('issueDecision'),
    getDraftIssueDecisions: id => draftDecisions(required('draft', id)),
    addIssueDecision(decision) {
      object(decision, '审核处理');
      const draft = required('draft', decision.draftId); assertLatest(draft);
      assertReviewRevision(draft, decision);
      if (!draft.review || draft.evidenceNeedsReview) throw new Error('稿件尚未完成当前审核，请等待复审完成后处理问题。');
      if (!['resolved', 'dismissed'].includes(decision.decision)) throw new Error('审核处理类型不合法。');
      const issueKey = string(decision.issueKey, '审核问题', 300);
      if (!reportFor(draft).issues.some(issue => issue.id === issueKey || issue.key === issueKey)) throw new Error('审核问题不存在，请刷新后选择真实问题。');
      const comment = string(decision.comment || '', '处理说明', 6000).trim();
      if (!comment) throw new Error('请填写处理说明，保留人工判断依据。');
      if (reviewState(draft).reviewStale) throw new Error('审核已过期，请重新审核后处理问题。');
      return add('issueDecision', { id: makeId('decision', decision.id), draftId: draft.id, reviewRevision: draft.reviewRevision, issueKey, decision: decision.decision, comment, createdAt: date(decision.createdAt) });
    },
    addFeedback(feedback) {
      object(feedback, '反馈'); const draft = required('draft', feedback.draftId); assertLatest(draft);
      assertReviewRevision(draft, feedback);
      if (!['accepted', 'needs_changes'].includes(feedback.decision)) throw new Error('反馈类型不合法。');
      if (feedback.decision === 'accepted') assertAcceptable(draft);
      const item = { id: makeId('feedback', feedback.id), draftId: feedback.draftId, reviewContextHash: draft.reviewContextHash, reviewRevision: draft.reviewRevision, decision: feedback.decision, comment: string(feedback.comment || '', '反馈说明', 10_000), createdAt: date(feedback.createdAt) };
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = add('feedback', item);
        api.updateDraft(draft.id, { status: feedback.decision === 'accepted' ? 'accepted' : 'needs_changes' });
        api.updateTask(draft.taskId, { status: feedback.decision === 'accepted' ? 'accepted' : 'changes_requested' });
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getRevision: () => `${revision}:${externalVersion.get().data_version}`,
    getState: ({ runSummaries = false } = {}) => ({ profile: api.getProfile(), accounts: api.listAccounts(), sources: api.listSources(), tasks: api.listTasks(), runs: runSummaries ? api.listRunSummaries() : api.listRuns(), drafts: api.listDrafts(), feedback: list('feedback'), issueDecisions: api.listIssueDecisions(), leads: api.listLeads(), collaborators: api.listCollaborators(), collaborations: api.listCollaborations(), campaigns: api.listCampaigns(), experiments: api.listExperiments(), collaborationMetrics: api.collaborationMetrics() }),
    close: () => db.close(),
  };

  for (const run of api.listRuns()) {
    if (run.status === 'queued' || run.status === 'running') {
      api.updateRun(run.id, { status: 'failed', finishedAt: NOW(), error: '本地服务已重启，此前未完成的运行已停止。请重新运行。' });
      api.appendEvent(run.id, { kind: 'error', title: '运行因服务重启中断', status: 'failed', detail: '已有资料与草稿仍保留。', durationMs: 0 });
      const task = api.getTask(run.taskId);
      if (task?.status === 'in_progress') {
        const status = run.resultDraftId && api.getDraft(run.resultDraftId) ? 'needs_review'
          : ['ready', 'needs_input', 'needs_review', 'changes_requested'].includes(run.previousTaskStatus) ? run.previousTaskStatus : 'ready';
        api.updateTask(task.id, { status });
      }
    }
  }
  return api;
}
