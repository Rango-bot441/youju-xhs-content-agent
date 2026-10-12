import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

// Isolated HTTP boundary fixtures. No production workspace or paid model calls.
async function setup(t, options = {}) {
  const store = createStore(':memory:');
  const calls = [];
  const workflow = options.workflow || { activeCount: 0, shutdown() {}, start(taskId, options) { calls.push({ taskId, options }); return store.addRun({ taskId, ...options }); }, cancel(id) { return store.updateRun(id, { status: 'failed', error: 'cancelled', finishedAt: new Date().toISOString() }); } };
  const app = createApp({ store, workflow, providerInfo: async () => ({ ready: false, model: '', source: 'isolated-test' }), providerCheck: options.providerCheck || (async () => ({ ready: false, message: 'No paid model in HTTP boundary tests' })), leadClassifier: options.leadClassifier, evaluationsDir: options.evaluationsDir || '/nonexistent-xhs-evaluations-directory' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); store.close(); });
  const request = async (path, body, headers = {}) => {
    const res = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, text };
  };
  return { store, app, request, origin, calls };
}
async function createTask(request, sourceIds = []) {
  return (await request('/api/tasks', { title: '资料功能交稿验收', brief: '检查资料引用说明稿件的事实与表达。', sourceIds })).data;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const boundaryLeadResult = () => ({ analysis: { region: '待确认', grade: '待确认', subject: '待确认', demand: '核对信息', intent: 'unclear', priority: 'low', missingFields: ['具体问题'], suggestedReply: '请说明需要核对的问题。', handoffSummary: '咨询细节待补', reasoning: '程序回归边界输入。' }, model: 'isolated-test-model', usage: { inputTokens: 1, outputTokens: 1 } });

test('health and state ETag are stable, empty evaluations are honest', async t => {
  const { request } = await setup(t);
  const health = await request('/api/health'); assert.equal(health.status, 200); assert.equal(health.data.app, 'xhs-content-agent'); assert.equal(health.data.pid, process.pid);
  const first = await request('/api/state'); assert.equal(first.status, 200); assert.deepEqual(first.data.accounts, []); assert.deepEqual(first.data.issueDecisions, []);
  assert.deepEqual(first.data.evaluations, []);
  assert.equal(first.data.capabilities.automaticPublishing, false);
  const cached = await request('/api/state', undefined, { 'If-None-Match': first.headers.get('etag') }); assert.equal(cached.status, 304); assert.equal(cached.text, '');
  await createTask(request);
  const changed = await request('/api/state', undefined, { 'If-None-Match': first.headers.get('etag') }); assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), first.headers.get('etag'));
  assert.deepEqual((await request('/api/evaluations')).data, { reports: [] });
});

test('business collaboration and campaign endpoints persist only validated records and expose state', async t => {
  const { request } = await setup(t);
  const initial = (await request('/api/state')).data;
  for (const key of ['collaborators', 'collaborations', 'campaigns', 'experiments']) assert.deepEqual(initial[key], []);
  assert.equal(initial.collaborationMetrics.firstPassRate, null);
  const task = await createTask(request);
  const creator = await request('/api/collaborators', { name: '隔离HTTP验收作者', type: 'vendor' });
  assert.equal(creator.status, 201);
  assert.equal((await request(`/api/collaborators/${creator.data.id}`, { status: 'paused' })).data.status, 'paused');
  assert.equal((await request('/api/collaborators')).data.length, 1);
  const delivery = await request('/api/collaborations', { taskId: task.id, collaboratorId: creator.data.id, batch: '隔离验证' });
  assert.equal(delivery.status, 201);
  assert.equal((await request(`/api/collaborations/${delivery.data.id}`, { status: 'accepted' })).status, 400);
  assert.equal((await request(`/api/collaborations/${delivery.data.id}`, { status: 'submitted', submittedAt: '2025-01-01' })).status, 200);
  const campaign = await request('/api/campaigns', { name: '隔离活动', taskIds: [task.id], audience: '程序测试', budget: 0 });
  assert.equal(campaign.status, 201); assert.equal(campaign.data.budget, 0);
  const experiment = await request('/api/experiments', { name: '隔离实验', campaignId: campaign.data.id, variants: [{ id: 'A', taskId: task.id }] });
  assert.equal(experiment.status, 201);
  assert.equal((await request(`/api/experiments/${experiment.data.id}`, { conclusion: '仅记录人工判断' })).status, 200);
  assert.equal((await request('/api/experiments/missing')).status, 400);
  const state = (await request('/api/state')).data;
  assert.equal(state.collaborations.length, 1); assert.equal(state.experiments.length, 1); assert.equal(state.experiments[0].history.length, 1);
});

test('state returns run summaries without private-size snapshots or traces', async t => {
  const { request, store } = await setup(t);
  const task = await createTask(request);
  const run = store.addRun({ taskId: task.id, action: 'review', status: 'completed', contextSnapshot: { systemPrompt: 'x'.repeat(10000) }, trace: [{ kind: 'tool', output: 'y'.repeat(10000) }] });
  const state = (await request('/api/state')).data;
  const summary = state.runs.find(item => item.id === run.id);
  assert.equal('contextSnapshot' in summary, false);
  assert.equal('trace' in summary, false);
  assert.equal(summary.hasContextSnapshot, true);
  assert.equal(summary.traceCount, 1);
  assert.ok(state.quality);
});

test('region education task brief carries structured context into the persistent task record', async t => {
  const { request } = await setup(t);
  const account = await request('/api/accounts', { name: '海淀家长升学信息号', identity: 'planning' });
  const created = await request('/api/tasks', {
    title: '海淀小升初材料说明', accountId: account.data.id, sourceIds: [],
    brief: '地区：北京海淀\n年级：小升初\n学科/主题：入学政策\n内容形式：小红书图文\n家长问题：入学材料有哪些？\n目标：解释官方通知中的材料要求\n内容要求：不推测个案结论。',
  });
  assert.equal(created.status, 201);
  assert.match(created.data.brief, /地区：北京海淀/);
  assert.match(created.data.brief, /家长问题：入学材料有哪些？/);
  assert.equal(created.data.accountId, account.data.id);
});

test('completed run evaluation stores only verified execution metadata and leaves human review empty', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'xhs-evaluation-'));
  const { request, store } = await setup(t, { evaluationsDir: temp });
  const task = await createTask(request);
  const run = store.addRun({ taskId: task.id, action: 'review', status: 'completed', model: 'test-model', finishedAt: new Date().toISOString(), usage: { inputTokens: 24, outputTokens: 7 }, events: [{ kind: 'model', status: 'completed' }], trace: [] });
  const result = await request('/api/evaluations', { runId: run.id });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.kind, 'run-audit'); assert.equal(result.data.run.inputTokens, 24); assert.equal(result.data.run.requests, 1); assert.equal(result.data.human.status, 'not_collected');
  assert.equal((await stat(join(temp, result.data.filename))).mode & 0o777, 0o600);
  assert.equal((await request('/api/evaluations', { runId: 'run_missing' })).status, 400);
  t.after(async () => rm(temp, { recursive: true, force: true }));
});

test('default evaluation listing includes completed runs without creating stored reports', async t => {
  const { request, store } = await setup(t);
  const task = await createTask(request);
  const run = store.addRun({ taskId: task.id, action: 'review', status: 'completed', finishedAt: new Date().toISOString(), events: [] });
  const result = await request('/api/evaluations');
  assert.equal(result.status, 200);
  assert.equal(result.data.reports[0].kind, 'run-audit');
  assert.equal(result.data.reports[0].run.runId, run.id);
  const state = await request('/api/state');
  assert.deepEqual(state.data.evaluations, []);
  assert.equal((await readdir('/nonexistent-xhs-evaluations-directory').catch(error => error.code)), 'ENOENT');
});

test('account edits and source classification preserve source text', async t => {
  const { request } = await setup(t);
  const account = await request('/api/accounts', { name: '资料说明账号', identity: 'planning', matrixRole: '经验分享', owner: '回归测试' }); assert.equal(account.status, 201); assert.equal(account.data.matrixRole, '经验分享');
  const updated = await request(`/api/accounts/${account.data.id}`, { audience: '资料工作台使用者', matrixRole: '问题解答' }); assert.equal(updated.data.audience, '资料工作台使用者'); assert.equal(updated.data.matrixRole, '问题解答');
  assert.equal((await request(`/api/accounts/${account.data.id}`, { id: 'other' })).status, 400);
  const source = await request('/api/sources', { title: '引用功能', text: '工作台会保存资料原文与引用。', category: 'product', note: '仅程序边界测试资料' }); assert.equal(source.status, 201);
  const classified = await request(`/api/sources/${source.data.id}`, { category: 'reference', archived: true }); assert.equal(classified.data.category, 'reference');
  assert.equal((await request(`/api/sources/${source.data.id}`, { text: '覆盖正文' })).status, 400);
  assert.equal((await request(`/api/sources/${source.data.id}`)).data.text, '工作台会保存资料原文与引用。');
});

test('regional source ledger persists verification fields without rewriting source text', async t => {
  const { request } = await setup(t);
  const source = await request('/api/sources', { title: '海淀资料', text: '此处是用于边界测试的公开资料正文。', region: '北京海淀', grade: '小升初', sourceType: 'policy', sourceLevel: 'official', publishedAt: '2026-09-01', effectiveUntil: '2027-01-01', verificationStatus: 'verified', isDemo: true });
  assert.equal(source.status, 201); assert.equal(source.data.region, '北京海淀'); assert.equal(source.data.sourceType, 'policy'); assert.equal(source.data.verificationStatus, 'verified');
  assert.equal(source.data.isDemo, true);
  const updated = await request(`/api/sources/${source.data.id}`, { region: '北京海淀', grade: '初一', sourceType: 'school', sourceLevel: 'organization', publishedAt: '', effectiveUntil: '', verificationStatus: 'needs_update', category: 'reference', note: '需要回看原文' });
  assert.equal(updated.status, 200); assert.equal(updated.data.grade, '初一'); assert.equal(updated.data.effectiveUntil, ''); assert.equal(updated.data.text, '此处是用于边界测试的公开资料正文。');
  assert.equal((await request(`/api/sources/${source.data.id}`, { verificationStatus: 'fake' })).status, 400);
});

test('publication preflight is a saved human checklist and keeps platform boundary explicit', async t => {
  const { request } = await setup(t);
  const task = await createTask(request);
  const draft = await request(`/api/tasks/${task.id}/drafts`, { title: '发布前检查稿', body: '只用于测试人工发布检查。' });
  const result = await request(`/api/tasks/${task.id}`, { preflight: { draftId: draft.data.id, platform: '小红书', checks: { title: true, cover: true, opening: false, search: true, comment: false, directMessage: true, persona: true, risk: false }, note: '前两行与风险项仍需人工确认。' } });
  assert.equal(result.status, 200); assert.equal(result.data.preflight.platform, '小红书'); assert.equal(result.data.preflight.checks.opening, false); assert.match(result.data.preflight.note, /风险项/);
  assert.equal((await request(`/api/tasks/${task.id}`, { preflight: { draftId: draft.data.id, platform: '小绿书', checks: { invalid: true } } })).status, 400);
});

test('publication records preserve traffic source and business metrics without inventing values', async t => {
  const { request } = await setup(t);
  const task = await createTask(request);
  const draft = await request(`/api/tasks/${task.id}/drafts`, { title: '投放口径稿', body: '只用于测试点击、转化和消耗口径。' });
  const result = await request(`/api/tasks/${task.id}`, { publication: { draftId: draft.data.id, platform: '小红书', trafficType: 'paid', url: 'https://example.com/note/1', observedAt: '2026-09-20', metrics: { impressions: 1000, clicks: 80, conversions: 4, spend: 200, revenue: null } } });
  assert.equal(result.status, 200); assert.equal(result.data.publication.trafficType, 'paid'); assert.equal(result.data.publication.metrics.clicks, 80); assert.equal(result.data.publication.metrics.revenue, null);
  assert.equal((await request(`/api/tasks/${task.id}`, { publication: { draftId: draft.data.id, trafficType: 'unknown', platform: '小红书', url: 'https://example.com/note/1' } })).status, 400);
});

test('lead triage stores a redacted consultation and requires human handoff status', async t => {
  let received = null;
  const { request } = await setup(t, { leadClassifier: async ({ rawText, channel, task }) => { received = { rawText, channel, task }; return { analysis: { region: '北京海淀', grade: '五年级', subject: '小升初', demand: '想核对材料', intent: 'policy', priority: 'medium', missingFields: ['具体材料类型'], suggestedReply: '可以先看官方通知中的材料要求。请问孩子目前几年级？', handoffSummary: '北京海淀五年级家长咨询小升初材料，需补充具体问题。', reasoning: '文本明确地区、年级与材料咨询，但细节不足。' }, model: 'isolated-test-model', usage: { inputTokens: 12, outputTokens: 8 }, usageUnknown: false }; } });
  const task = await createTask(request);
  const created = await request('/api/leads', { taskId: task.id, channel: 'comment', rawText: '北京海淀五年级，手机号13812345678，想问小升初材料。' });
  assert.equal(created.status, 201); assert.doesNotMatch(created.data.rawText, /13812345678/); assert.equal(created.data.reviewStatus, 'pending_review');
  const triaged = await request(`/api/leads/${created.data.id}/classify`, {});
  assert.equal(triaged.status, 200); assert.equal(triaged.data.analysis.region, '北京海淀'); assert.equal(triaged.data.analysis.priority, 'medium'); assert.equal(triaged.data.modelUsage.outputTokens, 8); assert.doesNotMatch(received.rawText, /13812345678/);
  const ready = await request(`/api/leads/${created.data.id}`, { reviewStatus: 'ready_handoff', manualNote: '人工确认地区和年级；仍需销售补问材料类型。' });
  assert.equal(ready.status, 200); assert.equal(ready.data.reviewStatus, 'ready_handoff');
  const csv = await request('/api/leads/export.csv'); assert.equal(csv.status, 200); assert.match(csv.text, /北京海淀/); assert.match(csv.text, /待销售确认/); assert.doesNotMatch(csv.text, /13812345678/);
});

test('existing draft can be submitted without sources then clarified without losing draft', async t => {
  const { request } = await setup(t);
  const task = await createTask(request);
  const draft = await request(`/api/tasks/${task.id}/drafts`, { title: '如何核对资料', body: '打开引用，可以查看原文。', author: '开发回归输入' });
  assert.equal(draft.status, 201); assert.equal(draft.data.origin, 'imported'); assert.equal(draft.data.review, null); assert.deepEqual(draft.data.evidence, []);
  const state1 = (await request('/api/state')).data; assert.equal(state1.tasks[0].status, 'needs_input');
  const source = (await request('/api/sources', { title: '资料功能说明', text: '引用片段可定位资料原文。' })).data;
  const message = await request(`/api/tasks/${task.id}/messages`, { text: '补充功能说明，请据此审查。', sourceIds: [source.id], role: 'assistant' });
  assert.equal(message.status, 201); assert.equal(message.data.messages[0].role, 'user'); assert.equal(message.data.status, 'ready');
  assert.deepEqual(message.data.sourceIds, [source.id]);
  assert.equal((await request(`/api/tasks/${task.id}`, { sourceIds: [] })).status, 400);
  assert.equal((await request('/api/state')).data.drafts.length, 1);
});

test('manual editing creates immutable version and only same lineage can compare', async t => {
  const { request, store } = await setup(t);
  const task = await createTask(request);
  const first = (await request(`/api/tasks/${task.id}/drafts`, { title: '如何核对资料', body: '打开资料查看原文。' })).data;
  assert.equal((await request(`/api/drafts/${first.id}/versions`, { body: '修改', changeNote: '' })).status, 400);
  const edited = await request(`/api/drafts/${first.id}/versions`, { body: '打开引用，逐句查看对应原文。', changeNote: '明确核对步骤', editingSeconds: 8, lockedFields: ['title'] });
  assert.equal(edited.status, 201); assert.equal(edited.data.version, 2); assert.equal(edited.data.origin, 'manual'); assert.equal(edited.data.evidenceNeedsReview, true);
  assert.equal(store.getDraft(first.id).body, '打开资料查看原文。');
  const diff = await request(`/api/drafts/${edited.data.id}/compare?base=${first.id}`); assert.equal(diff.status, 200); assert.equal(diff.data.fields.find(f => f.field === 'body').changed, true); assert.equal(diff.data.fields.find(f => f.field === 'title').changed, false);
  const unrelated = (await request(`/api/tasks/${task.id}/drafts`, { title: '不同稿件', body: '不能跨稿件混用版本。' })).data;
  assert.equal((await request(`/api/drafts/${edited.data.id}/compare?base=${unrelated.id}`)).status, 400);
  assert.equal((await request(`/api/drafts/${first.id}/versions`, { body: '旧版本修改', changeNote: '不能改旧版' })).status, 400);
});

test('quality and logged issue decisions gate acceptance without hiding review issues', async t => {
  const { request, store } = await setup(t);
  const source = (await request('/api/sources', { text: '来源引用能帮助人工核对内容。' })).data;
  const task = await createTask(request, [source.id]);
  const draft = (await request(`/api/tasks/${task.id}/drafts`, { title: '核对资料', body: '来源引用能帮助人工核对内容。' })).data;
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted' })).status, 409);
  store.updateDraft(draft.id, { review: { verdict: '需核对', issues: [{ severity: 'high', category: 'fact', field: 'body', quote: '来源引用能帮助人工核对内容。', reason: '人工确认功能说明', sourceRef: source.chunks[0].id, suggestion: '核对原文' }], facts: [] } });
  const quality = (await request(`/api/drafts/${draft.id}/quality`)).data;
  const expectedReviewRevision = store.getDraft(draft.id).reviewRevision;
  assert.equal(quality.readiness, 'blocked');
  assert.equal((await request(`/api/drafts/${draft.id}/issues`, { issueKey: 'invented', decision: 'resolved', comment: '假的问题', expectedReviewRevision })).status, 400);
  const decision = await request(`/api/drafts/${draft.id}/issues`, { issueKey: quality.issues[0].id, decision: 'dismissed', comment: '人工确认原文与稿件一致，记录本次判断。', expectedReviewRevision }); assert.equal(decision.status, 201);
  const accepted = await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', comment: '人工复核后采纳，非模型准确率证明。', expectedReviewRevision }); assert.equal(accepted.status, 201);
  assert.equal(store.getTask(task.id).status, 'accepted'); assert.equal(store.getDraft(draft.id).review.issues.length, 1);
  assert.equal((await request(`/api/tasks/${task.id}`, { status: 'delivered' })).status, 200);
});

test('human decision endpoints reject missing or late review revisions and in-flight reviews', async t => {
  const { request, store } = await setup(t);
  const source = store.addSource({ title: '隔离复核资料', text: '阅读实际来源。' });
  const task = store.addTask({ brief: '隔离迟到请求复核', sourceIds: [source.id] });
  const review = { verdict: '请核对', issues: [{ category: 'fact', field: 'body', severity: 'high', quote: '业务断言。', reason: '需核对', suggestion: '补充来源' }], facts: [] };
  const draft = store.addDraft({ taskId: task.id, title: '隔离稿件', body: '业务断言。', review });
  const issueKey = (await request(`/api/drafts/${draft.id}/quality`)).data.issues[0].id;
  const decision = { issueKey, decision: 'dismissed', comment: '隔离人审边界' };
  assert.equal((await request(`/api/drafts/${draft.id}/issues`, decision)).status, 409);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted' })).status, 409);
  store.updateDraft(draft.id, { review });
  const currentRevision = store.getDraft(draft.id).reviewRevision;
  assert.notEqual(currentRevision, draft.reviewRevision);
  for (const endpoint of ['issues', 'feedback']) {
    const result = await request(`/api/drafts/${draft.id}/${endpoint}`, { ...(endpoint === 'issues' ? decision : { decision: 'accepted' }), expectedReviewRevision: draft.reviewRevision });
    assert.equal(result.status, 409); assert.match(result.data.error, /审核|刷新/);
  }
  assert.equal(store.listIssueDecisions().length, 0);
  store.updateDraft(draft.id, { evidenceNeedsReview: true });
  assert.equal((await request(`/api/drafts/${draft.id}/issues`, { ...decision, expectedReviewRevision: currentRevision })).status, 409);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision: currentRevision })).status, 409);
  store.updateDraft(draft.id, { review, evidenceNeedsReview: false });
  const expectedReviewRevision = store.getDraft(draft.id).reviewRevision;
  assert.equal((await request(`/api/drafts/${draft.id}/issues`, { ...decision, expectedReviewRevision })).status, 201);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision })).status, 201);
  store.appendMessage(task.id, { text: '业务要求已更正。' });
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision })).status, 409);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'needs_changes', comment: '要求改稿不需要审核令牌' })).status, 201);
});

test('default export is content only and explicit evidence export includes only cited chunks', async t => {
  const { request, store } = await setup(t);
  const source = store.addSource({ title: '分段资料', text: `${'引用帮助核对原文。'.repeat(100)}\n\n未引用段落不应出现在导出证据包中。` });
  const other = store.addSource({ title: '未引用资料', text: '其他资料不能混入交付物。' });
  const task = store.addTask({ brief: '整理引用功能说明', sourceIds: [source.id, other.id] });
  const draft = store.addDraft({ taskId: task.id, title: '引用功能', body: '引用帮助核对原文。', pages: [{ heading: '检查步骤', text: '打开资料原文。' }], evidence: [{ claim: '引用帮助核对原文。', sourceRef: source.chunks[0].id }], gaps: ['仅内部边界说明'] });
  const json = await request(`/api/drafts/${draft.id}/export?format=json`);
  assert.equal(json.status, 200); assert.deepEqual(Object.keys(json.data).sort(), ['body', 'cover', 'pages', 'tags', 'title']); assert.equal(json.text.includes('仅内部边界说明'), false);
  const evidence = await request(`/api/drafts/${draft.id}/export?format=json&includeEvidence=1`);
  assert.equal(evidence.data.sources.length, 1); assert.equal(evidence.data.sources[0].chunks.length, 1); assert.equal(evidence.data.sources[0].chunks[0].id, source.chunks[0].id);
  assert.equal(evidence.text.includes('未引用资料'), false);
  const md = await request(`/api/drafts/${draft.id}/export?format=md`); assert.equal(md.status, 200); assert.equal(md.text.includes('仅内部边界说明'), false); assert.equal(md.text.includes(source.id), false);
});

test('task assignment export preserves deliverable fields without all source data', async t => {
  const { request } = await setup(t); const task = await createTask(request);
  const assignment = { audience: '工作台使用者', objective: '核对引用', angle: '操作说明', facts: ['支持原文定位'], materials: ['功能说明'], deliverables: ['一篇说明稿'], criteria: ['不编造功能'], questions: [] };
  assert.equal((await request(`/api/tasks/${task.id}`, { assignment, owner: '开发验收' })).status, 200);
  const result = await request(`/api/tasks/${task.id}/export?format=json`); assert.equal(result.status, 200); assert.deepEqual(result.data.assignment, assignment); assert.equal('sources' in result.data, false);
});

test('all draft export formats and filenames redact contacts, including evidence metadata', async t => {
  const { request, store } = await setup(t);
  const source = store.addSource({ title: '资料 test@example.com', text: '联系 13812345678', url: 'https://example.com/?contact=test@example.com' });
  const task = store.addTask({ brief: '隔离导出检查', sourceIds: [source.id] });
  const draft = store.addDraft({ taskId: task.id, title: '联系 test@example.com', body: '电话 13812345678', tags: ['test@example.com'], evidence: [{ claim: '联系 test@example.com', sourceRef: source.chunks[0].id }], gaps: ['联系 test@example.com'] });
  for (const format of ['json', 'md']) for (const includeEvidence of [0, 1]) {
    const result = await request(`/api/drafts/${draft.id}/export?format=${format}&includeEvidence=${includeEvidence}`);
    assert.equal(result.status, 200);
    assert.doesNotMatch(result.text, /test@example\.com|13812345678/);
    assert.doesNotMatch(decodeURIComponent(result.headers.get('content-disposition')), /test@example\.com/);
  }
  assert.equal(store.getDraft(draft.id).body, '电话 13812345678');
});

test('credentials block every draft format and evidence package without echoing the secret', async t => {
  const { request, store } = await setup(t);
  const source = store.addSource({ title: '隔离来源', text: 'api_key=abcdefgh123456' });
  const task = store.addTask({ brief: '隔离安全检查', sourceIds: [source.id] });
  const draft = store.addDraft({ taskId: task.id, title: '安全检查', body: 'Bearer abcdefgh123456' });
  for (const format of ['json', 'md']) {
    const blocked = await request(`/api/drafts/${draft.id}/export?format=${format}`);
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /凭据/); assert.doesNotMatch(blocked.text, /abcdefgh123456/);
  }
  const clean = store.addDraft({ taskId: task.id, title: '安全标题', body: '安全内容', evidence: [{ claim: '引用原文', sourceRef: source.chunks[0].id }] });
  assert.equal((await request(`/api/drafts/${clean.id}/export?format=json`)).status, 200);
  for (const format of ['json', 'md']) assert.equal((await request(`/api/drafts/${clean.id}/export?format=${format}&includeEvidence=1`)).status, 409);
});

test('lead handoff export carries task brief fields but never invents a parent lead', async t => {
  const { request, store } = await setup(t);
  const account = store.addAccount({ name: '海淀家长升学信息号', identity: 'planning' });
  const task = store.addTask({ title: '海淀小升初入学信息', brief: '地区：北京海淀\n年级：小升初\n学科/主题：入学政策\n内容形式：小红书图文\n家长问题：入学材料有哪些？', sourceIds: [], accountId: account.id });
  store.addDraft({ taskId: task.id, title: '官方入学通知怎么看', body: '只引用已导入的原文。' });
  const result = await request(`/api/tasks/${task.id}/lead-handoff.csv`);
  assert.equal(result.status, 200);
  assert.match(result.text, /"地区","年级","学科\/主题","家长原始问题"/);
  assert.match(result.text, /北京海淀/);
  assert.match(result.text, /小升初/);
  assert.match(result.text, /入学材料有哪些？/);
  assert.match(result.text, /需求判断待真实咨询后填写/);
  assert.match(result.text, /完成稿件质检与人工核验/);
  const latest = store.listDrafts().find(draft => draft.taskId === task.id);
  store.updateDraft(latest.id, { review: { verdict: '待补材料', issues: [], facts: [] } });
  const withPolicy = await request(`/api/tasks/${task.id}/lead-handoff.csv`);
  assert.match(withPolicy.text, /补齐素材缺口并确认稿件可交付/);
  assert.match(result.text, /待真实咨询后填写/);
  assert.match(result.text, /不包含虚构家长线索/);
  assert.doesNotMatch(result.text, /张三|138\d{8}/);
  assert.match(decodeURIComponent(result.headers.get('content-disposition')), /线索交接模板/);
  assert.match(result.headers.get('content-type'), /text\/csv/);
});

test('failed run retry keeps lineage and avoids regenerating an existing result draft', async t => {
  const { request, store, calls } = await setup(t); const task = await createTask(request);
  const failed = store.addRun({ taskId: task.id, action: 'revise', status: 'failed', instruction: '只改标题', scope: { field: 'title' }, lockedFields: ['body'] });
  const retry = await request(`/api/runs/${failed.id}/retry`, {}); assert.equal(retry.status, 202); assert.equal(calls[0].options.scope.field, 'title'); assert.equal(calls[0].options.retryOf, failed.id); assert.equal(store.getRun(failed.id).status, 'failed');
  const draft = store.addDraft({ taskId: task.id, title: '资料引用', body: '保留已生成稿件。' });
  const interrupted = store.addRun({ taskId: task.id, action: 'draft', status: 'failed' }); store.updateRun(interrupted.id, { resultDraftId: draft.id });
  assert.equal((await request(`/api/runs/${interrupted.id}/retry`, {})).status, 202); assert.equal(calls.at(-1).options.action, 'review'); assert.equal(calls.at(-1).options.draftId, draft.id);
  assert.equal((await request(`/api/runs/${retry.data.id}/retry`, {})).status, 400);
});

test('cross-site requests and non-JSON writes are rejected before mutation', async t => {
  const { request, origin, store } = await setup(t);
  const denied = await request('/api/tasks', { brief: '不能写入', sourceIds: [] }, { Origin: 'https://untrusted.example' }); assert.equal(denied.status, 403);
  const form = await fetch(`${origin}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(form.status, 415);
  assert.equal((await request('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(store.listTasks().length, 0);
});

test('automatic evaluation API saves actual selected drafts, preserves human boundary and never calls model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-evaluation-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { request, store, calls } = await setup(t, { evaluationsDir: directory });
  assert.equal((await request('/api/evaluations', {})).status, 400);
  assert.deepEqual(await readdir(directory), []);
  const task = await createTask(request);
  const draft = (await request(`/api/tasks/${task.id}/drafts`, { title: '资料引用说明', body: '可以打开引用核对原文。' })).data;
  assert.equal((await request('/api/evaluations', { draftId: draft.id })).status, 400);
  store.updateDraft(draft.id, { review: { verdict: '已审核', issues: [], facts: [] } });
  const before = JSON.stringify(store.getState());
  const created = await request('/api/evaluations', { taskId: task.id, draftId: draft.id });
  assert.equal(created.status, 201); assert.equal(created.data.sampleCount, 1); assert.equal(created.data.drafts[0].draftId, draft.id);
  assert.equal(created.data.kind, 'saved-draft-audit'); assert.equal(created.data.human.status, 'not_collected'); assert.deepEqual(created.data.human.ratings, []);
  const target = join(directory, created.data.filename);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).id, created.data.id);
  assert.equal((await request('/api/evaluations')).data.reports[0].id, created.data.id);
  const second = await request('/api/evaluations', { draftId: draft.id });
  assert.equal(second.status, 201); assert.notEqual(second.data.id, created.data.id); assert.equal((await readdir(directory)).length, 2);
  assert.equal((await request('/api/evaluations', { baseline: true })).status, 400);
  assert.equal((await request('/api/evaluations', { taskId: '../unsafe' })).status, 400);
  assert.equal((await request('/api/evaluations', { draftId: 'draft_missing' })).status, 400);
  assert.equal(JSON.stringify(store.getState()), before); assert.deepEqual(calls, []);
});

test('classification blocks provider checks and content starts/retries and appears in health', async t => {
  const started = deferred(), finish = deferred();
  const { request, store } = await setup(t, { leadClassifier: async () => { started.resolve(); await finish.promise; return boundaryLeadResult(); } });
  t.after(() => finish.resolve());
  const task = await createTask(request);
  const failed = store.addRun({ taskId: task.id, action: 'plan', status: 'failed' });
  const lead = (await request('/api/leads', { rawText: '咨询细节待补', channel: 'manual', isDemo: true })).data;
  const running = request(`/api/leads/${lead.id}/classify`, {}); await started.promise;
  const health = (await request('/api/health')).data; assert.equal(health.activeRuns, 1); assert.equal(health.kind, 'lead_classification'); assert.equal(health.status, 'running');
  const state = (await request('/api/state')).data; assert.equal(state.activity.busy, true);
  for (const path of ['/api/provider/check', `/api/tasks/${task.id}/runs`, `/api/runs/${failed.id}/retry`, `/api/leads/${lead.id}/classify`]) assert.equal((await request(path, { action: 'plan' })).status, 409);
  finish.resolve(); assert.equal((await running).status, 200); assert.equal((await request('/api/health')).data.activeRuns, 0);
});

test('provider checks and content runs prevent all other model entry points', async t => {
  const started = deferred(), finish = deferred();
  const { request, store, app } = await setup(t, { providerCheck: async () => { started.resolve(); await finish.promise; return { ready: true, message: 'isolated check' }; }, leadClassifier: async () => boundaryLeadResult() });
  t.after(() => finish.resolve());
  const task = await createTask(request); const lead = store.addLead({ rawText: '程序边界输入', isDemo: true });
  const running = request('/api/provider/check', {}); await started.promise;
  assert.equal((await request('/api/health')).data.kind, 'provider_check');
  assert.equal((await request(`/api/leads/${lead.id}/classify`, {})).status, 409);
  assert.equal((await request(`/api/tasks/${task.id}/runs`, { action: 'plan' })).status, 409);
  finish.resolve(); assert.equal((await running).status, 200);
  app.workflow.activeCount = 1;
  for (const path of ['/api/provider/check', `/api/leads/${lead.id}/classify`, `/api/tasks/${task.id}/runs`]) assert.equal((await request(path, { action: 'plan' })).status, 409);
  assert.equal((await request('/api/health')).data.kind, 'content_run'); app.workflow.activeCount = 0;
});

test('service shutdown drains an in-flight classification before closing storage', async t => {
  const started = deferred(), finish = deferred();
  const { request, store, app } = await setup(t, { leadClassifier: async () => { started.resolve(); await finish.promise; return boundaryLeadResult(); } });
  const lead = store.addLead({ rawText: '程序边界输入', isDemo: true });
  const running = request(`/api/leads/${lead.id}/classify`, {}); await started.promise;
  let closed = false; const closing = app.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  finish.resolve(); assert.equal((await running).status, 200); await closing;
  assert.equal(store.getLead(lead.id).model, 'isolated-test-model');
});

test('failed classification releases shared busy lock and ordinary POST cannot forge AI analysis', async t => {
  const { request, store } = await setup(t, { leadClassifier: async () => { throw new Error('isolated boundary failure'); } });
  const lead = store.addLead({ rawText: '程序边界输入', isDemo: true });
  assert.equal((await request(`/api/leads/${lead.id}/classify`, {})).status, 400);
  assert.equal((await request('/api/health')).data.activeRuns, 0);
  for (const payload of [{ analysis: boundaryLeadResult().analysis }, { model: 'forged' }, { classifiedAt: new Date().toISOString() }, { history: [] }, { confirmedFields: { region: 'forged' } }]) assert.equal((await request(`/api/leads/${lead.id}`, payload)).status, 400);
  assert.equal(store.getLead(lead.id).analysis, null);
});

test('handoff exports only current human-confirmed fields and requires recorded notes', async t => {
  const { request, store } = await setup(t, { leadClassifier: async () => boundaryLeadResult() });
  const lead = store.addLead({ rawText: '程序边界输入', isDemo: true });
  await request(`/api/leads/${lead.id}/classify`, {});
  assert.equal((await request(`/api/leads/${lead.id}`, { reviewStatus: 'ready_handoff' })).status, 400);
  assert.equal((await request(`/api/leads/${lead.id}`, { reviewStatus: 'handed_off', manualNote: '跳过确认' })).status, 400);
  const ready = await request(`/api/leads/${lead.id}`, { reviewStatus: 'ready_handoff', humanReview: { region: '人工确认地区', demand: '=1+1' }, manualNote: '已核对原文，明确人工修正。' });
  assert.equal(ready.status, 200); assert.equal(ready.data.analysis.region, '待确认'); assert.equal(ready.data.confirmedFields.region, '人工确认地区');
  const csv = await request('/api/leads/export.csv'); assert.match(csv.text, /人工确认地区/); assert.match(csv.text, /'=1\+1/); assert.match(csv.text, /虚构演示/);
  await request(`/api/leads/${lead.id}`, { humanReview: { region: '更正地区' }, manualNote: '修改后应重新确认。' });
  assert.doesNotMatch((await request('/api/leads/export.csv')).text, new RegExp(lead.id));
  assert.equal(store.getLead(lead.id).history.length, 3);
});

test('state reuses cached summaries until a store revision changes', async t => {
  const { request, store } = await setup(t);
  let snapshots = 0; const original = store.getState;
  store.getState = options => { snapshots++; return original(options); };
  const first = await request('/api/state'); await request('/api/state');
  const notModified = await request('/api/state', undefined, { 'If-None-Match': first.headers.get('etag') });
  assert.equal(notModified.status, 304); assert.equal(snapshots, 1);
  await createTask(request); await request('/api/state'); assert.equal(snapshots, 2);
  store.saveProfile({ name: '修改档案使缓存失效' }); await request('/api/state'); assert.equal(snapshots, 3);
});

test('state refreshes expired-source warnings at Shanghai midnight without a database change', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T15:59:00Z') });
  const { request, store } = await setup(t);
  const source = store.addSource({ text: '工作台保留资料原文。', verificationStatus: 'verified', effectiveUntil: '2026-09-24' });
  const task = store.addTask({ brief: '检查资料时效', sourceIds: [source.id] });
  const draft = store.addDraft({ taskId: task.id, title: '资料功能', body: '工作台保留资料原文。', evidence: [{ claim: '工作台保留资料原文', sourceRef: source.chunks[0].id }], review: { verdict: '已审核', issues: [], facts: [] } });
  const first = await request('/api/state');
  assert.equal(first.data.quality[draft.id].checks.find(check => check.id === 'source_currency').status, 'pass');
  t.mock.timers.setTime(new Date('2026-09-24T16:01:00Z').valueOf());
  const expired = await request('/api/state', undefined, { 'If-None-Match': first.headers.get('etag') });
  assert.equal(expired.status, 200);
  const currency = expired.data.quality[draft.id].checks.find(check => check.id === 'source_currency');
  assert.equal(currency.status, 'warn'); assert.match(currency.detail, /超过台账有效期/);
});
