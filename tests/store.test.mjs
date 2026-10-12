import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { qualityReport } from '../lib/quality.mjs';

// Program boundary fixtures describe this application's behavior, not invented business records.
function setup(t, filename = ':memory:') {
  const store = createStore(filename);
  t.after(() => store.close());
  return store;
}
function sourceTask(store) {
  const source = store.addSource({ title: '资料引用功能说明', text: '导入资料后，系统会保留来源与原文。草稿引用采用来源 ID 加片段编号，便于人工定位核对。' });
  const task = store.addTask({ brief: '说明资料引用功能', sourceIds: [source.id] });
  return { source, task };
}
function draftInput(task, source) {
  return { taskId: task.id, topicId: 'reference_workflow', title: '如何核对资料引用', body: '打开草稿对应的来源片段，逐项核对原文。', evidence: [{ claim: '草稿引用可定位原文', sourceRef: source.chunks[0].id }] };
}

test('review is bound to effective context; corrections and first account assignment require a new review', t => {
  const store = setup(t); const { task, source } = sourceTask(store);
  const draft = store.addDraft({ ...draftInput(task, source), review: { verdict: '人工核对', issues: [], facts: [] } });
  store.addFeedback({ draftId: draft.id, decision: 'accepted' });
  assert.equal(store.getDraft(draft.id).reviewStale, false);
  store.updateTask(task.id, { title: '只改管理标题' });
  assert.equal(store.getDraft(draft.id).reviewStale, false);
  store.appendMessage(task.id, { text: '产品已下架，不能再写成在售。' });
  assert.equal(store.getDraft(draft.id).reviewStale, true);
  assert.notEqual(store.getDraft(draft.id).status, 'accepted');
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted' }), /过期/);
  assert.throws(() => store.updateTask(task.id, { status: 'delivered' }), /过期/);
  const account = store.addAccount({ name: '隔离账号' });
  store.updateTask(task.id, { accountId: account.id });
  store.updateDraft(draft.id, { review: { verdict: '重新核对', issues: [], facts: [] }, evidenceNeedsReview: false });
  assert.equal(store.getDraft(draft.id).reviewStale, false);
  assert.notEqual(store.getDraft(draft.id).status, 'accepted');
  store.addFeedback({ draftId: draft.id, decision: 'accepted' });
  store.updateAccount(account.id, { productFacts: '产品现已下架' });
  assert.equal(store.getDraft(draft.id).reviewStale, true);
  assert.equal(store.getTask(task.id).status, 'needs_review');
  assert.equal(store.getState().feedback.filter(row => row.decision === 'accepted').length, 2);
});

test('source metadata and global profile changes invalidate reviews without changing the saved draft', t => {
  const store = setup(t); const { task, source } = sourceTask(store);
  const draft = store.addDraft({ ...draftInput(task, source), review: { issues: [] } });
  store.updateSource(source.id, { note: '适用范围已缩小' });
  assert.equal(store.getDraft(draft.id).reviewStale, true);
  store.updateDraft(draft.id, { review: { issues: [] } });
  store.saveProfile({ tone: '避免夸大' });
  assert.equal(store.getDraft(draft.id).reviewStale, true);
  assert.equal(store.getDraft(draft.id).body, draft.body);
});

test('undoing a material context change does not silently restore approval and old decisions cannot approve a new review', t => {
  const store = setup(t); const { task, source } = sourceTask(store);
  const issue = { id: 'test_issue', severity: 'high', category: 'fact', field: 'body', quote: '打开草稿对应的来源片段', reason: '测试引用核对', sourceRef: source.chunks[0].id, locationVerified: true, blocking: true };
  const draft = store.addDraft({ ...draftInput(task, source), review: { issues: [issue] } });
  const issueKey = qualityReport(draft, [source]).issues.find(item => item.blocking).id;
  store.addIssueDecision({ draftId: draft.id, issueKey, decision: 'dismissed', comment: '首轮已人工核对' });
  store.addFeedback({ draftId: draft.id, decision: 'accepted' });
  store.updateTask(task.id, { brief: '业务要求变更' });
  store.updateTask(task.id, { brief: task.brief });
  assert.equal(store.getDraft(draft.id).reviewStale, true);
  store.updateDraft(draft.id, { review: { issues: [issue] } });
  assert.equal(store.getDraftIssueDecisions(draft.id).length, 0);
  assert.equal(store.listIssueDecisions().length, 1);
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted' }), /阻断问题/);
});

test('late human review requests cannot attach old decisions or acceptance to a new review revision', t => {
  const store = setup(t); const { task, source } = sourceTask(store);
  const review = { issues: [{ severity: 'high', category: 'fact', field: 'body', quote: '打开草稿对应的来源片段', reason: '核对原文', locationVerified: true, blocking: true }] };
  const draft = store.addDraft({ ...draftInput(task, source), review });
  const issueKey = qualityReport(draft, [source]).issues.find(item => item.blocking).id;
  store.updateDraft(draft.id, { review });
  assert.throws(() => store.addIssueDecision({ draftId: draft.id, issueKey, expectedReviewRevision: draft.reviewRevision, decision: 'dismissed', comment: '来自旧页面' }), /审核版本已变化/);
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted', expectedReviewRevision: draft.reviewRevision }), /审核版本已变化/);
  const current = store.getDraft(draft.id);
  store.updateDraft(draft.id, { evidenceNeedsReview: true });
  assert.throws(() => store.addIssueDecision({ draftId: draft.id, issueKey, expectedReviewRevision: current.reviewRevision, decision: 'dismissed', comment: '运行期间的人审' }), /尚未完成/);
  assert.equal(store.listIssueDecisions().length, 0);
});

test('experiment rename retains its original observation snapshot and validates explicit refresh', t => {
  const store = setup(t); const { task, source } = sourceTask(store); const draft = store.addDraft(draftInput(task, source));
  const publication = { platform: 'isolated', url: 'https://example.com/isolated', draftId: draft.id, observedAt: '2025-01-03', metrics: { clicks: 2 } };
  store.updateTask(task.id, { publication });
  const campaign = store.addCampaign({ name: '隔离活动', taskIds: [task.id] });
  const experiment = store.addExperiment({ name: '隔离实验', campaignId: campaign.id, observationStart: '2025-01-01', observationEnd: '2025-01-07', variants: [{ id: 'A', taskId: task.id, draftId: draft.id }] });
  store.updateTask(task.id, { publication: { ...publication, observedAt: '2025-02-01', metrics: { clicks: 9 } } });
  const renamed = store.updateExperiment(experiment.id, { name: '仅更名' });
  assert.deepEqual(renamed.variants[0].publicationSnapshot, experiment.variants[0].publicationSnapshot);
  assert.throws(() => store.updateExperiment(experiment.id, { refreshPublicationSnapshots: true }), /窗口/);
  assert.throws(() => store.updateExperiment(experiment.id, { observationStart: '2025-01-04' }), /窗口/);
  const refreshed = store.updateExperiment(experiment.id, { observationEnd: '2025-02-02', refreshPublicationSnapshots: true });
  assert.equal(refreshed.variants[0].publicationSnapshot.observedAt, '2025-02-01');
  assert.equal(refreshed.history.at(-1).variants[0].publicationSnapshot.observedAt, '2025-01-03');
  const next = store.addDraftVersion(draft.id, { body: '隔离新稿', changeNote: '测试版本边界' });
  store.updateTask(task.id, { publication: { ...publication, draftId: next.id, observedAt: '2025-02-01' } });
  assert.throws(() => store.updateExperiment(experiment.id, { refreshPublicationSnapshots: true }), /稿件版本/);
});

test('same-round submission date correction affects metrics without replacing first submission by rework', t => {
  const store = setup(t); const { task } = sourceTask(store);
  const creator = store.addCollaborator({ name: '隔离作者' });
  const item = store.addCollaboration({ taskId: task.id, collaboratorId: creator.id, dueDate: '2025-01-03', status: 'submitted', submittedAt: '2025-01-04' });
  store.updateCollaboration(item.id, { submittedAt: '2025-01-02' });
  assert.equal(store.collaborationMetrics().onTimeRate, 1);
  store.updateCollaboration(item.id, { status: 'changes_requested', reviewedAt: '2025-01-03', review: '补资料', reworkReason: '缺资料' });
  store.updateCollaboration(item.id, { status: 'submitted', submittedAt: '2025-01-05', reviewedAt: '', review: '' });
  store.updateCollaboration(item.id, { status: 'accepted', reviewedAt: '2025-01-06', review: '核对完成' });
  assert.equal(store.collaborationMetrics().onTimeRate, 1);
  assert.equal(store.collaborationMetrics().averageAcceptedCycleDays, 4);
  assert.equal(store.collaborationMetrics().firstPassRate, 0);
});

test('new store is empty and profile has no fabricated business information', t => {
  const store = setup(t);
  assert.deepEqual(Object.values(store.getProfile()), ['', '', '', '', '', '']);
  const state = store.getState();
  for (const key of ['sources', 'tasks', 'runs', 'drafts', 'feedback', 'leads']) assert.deepEqual(state[key], []);
  assert.equal('provider' in state, false);
});

test('collaboration review history computes observed rates without invented samples', t => {
  const store = setup(t); const { task } = sourceTask(store);
  assert.equal(store.collaborationMetrics().firstPassRate, null);
  const creator = store.addCollaborator({ name: '隔离程序验收作者', type: 'freelancer' });
  const delivery = store.addCollaboration({ taskId: task.id, collaboratorId: creator.id, batch: '程序边界测试', dueDate: '2025-01-03' });
  assert.throws(() => store.updateCollaboration(delivery.id, { status: 'accepted' }), /交稿日期/);
  store.updateCollaboration(delivery.id, { status: 'submitted', submittedAt: '2025-01-02' });
  assert.throws(() => store.updateCollaboration(delivery.id, { status: 'changes_requested', reviewedAt: '2025-01-03', review: '修改说明' }), /返工原因/);
  store.updateCollaboration(delivery.id, { status: 'changes_requested', reviewedAt: '2025-01-03', review: '修改说明', reworkReason: '缺少资料引用' });
  store.updateCollaboration(delivery.id, { status: 'submitted', submittedAt: '2025-01-04', reviewedAt: '', review: '' });
  const accepted = store.updateCollaboration(delivery.id, { status: 'accepted', reviewedAt: '2025-01-05', review: '核对完成' });
  assert.equal(accepted.history.length, 4);
  const metrics = store.collaborationMetrics();
  assert.equal(metrics.reviewedCount, 1); assert.equal(metrics.firstPassRate, 0); assert.equal(metrics.reworkRate, 1);
  assert.equal(metrics.onTimeRate, 1); assert.equal(metrics.averageAcceptedCycleDays, 3);
  assert.throws(() => store.updateCollaboration(delivery.id, { history: [] }), /不能覆盖/);
  const different = store.addTask({ brief: '另一隔离测试任务' });
  assert.throws(() => store.updateCollaboration(delivery.id, { taskId: different.id }), /不可更换/);
});

test('campaign experiments validate linkage, metric dates and manual conclusion boundaries', t => {
  const store = setup(t); const { task, source } = sourceTask(store); const draft = store.addDraft(draftInput(task, source));
  const campaign = store.addCampaign({ name: '隔离实验计划', taskIds: [task.id], audience: '程序验收', attributionWindow: '人工记录，7日观察' });
  assert.equal(campaign.budget, null);
  assert.throws(() => store.updateCampaign(campaign.id, { budget: -1 }), /预算/);
  assert.throws(() => store.updateCampaign(campaign.id, { startDate: '2025-02-30' }), /有效日期/);
  assert.throws(() => store.updateCampaign(campaign.id, { startDate: '2025-02-01', endDate: '2025-01-01' }), /早于/);
  const experiment = store.addExperiment({ campaignId: campaign.id, name: '指标边界验收', observationStart: '2025-01-01', observationEnd: '2025-01-07', variants: [{ id: 'A', taskId: task.id, draftId: draft.id }] });
  assert.equal(experiment.variants[0].publicationSnapshot, null);
  assert.throws(() => store.updateCampaign(campaign.id, { taskIds: [] }), /实验引用/);
  assert.throws(() => store.updateExperiment(experiment.id, { variants: [{ id: 'A', metrics: { clicks: 0 } }] }), /观察日期/);
  assert.throws(() => store.updateExperiment(experiment.id, { variants: [{ id: 'A', metrics: { clicks: 0 }, observedAt: '2025-02-01' }] }), /窗口/);
  assert.throws(() => store.updateExperiment(experiment.id, { variants: [{ id: 'A' }, { id: 'A' }] }), /不重复/);
  const another = store.addTask({ brief: '不同任务' });
  assert.throws(() => store.updateExperiment(experiment.id, { variants: [{ id: 'A', taskId: another.id, draftId: draft.id }] }), /属于关联任务/);
  assert.throws(() => store.updateExperiment(experiment.id, { status: 'completed' }), /人工结论/);
  const completed = store.updateExperiment(experiment.id, { status: 'completed', hypothesis: '程序边界说明', primaryMetric: 'CTR', metricDefinition: '点击 / 曝光，样本未收集', conclusion: '暂无有效样本，不能判断效果。' });
  assert.equal(completed.history.length, 1); assert.equal('significance' in completed, false);
  assert.throws(() => store.updateExperiment(experiment.id, { significance: true }), /不允许/);
});

test('publication batch validates before atomic commit and forbids existing record overwrite', t => {
  const store = setup(t); const { task, source } = sourceTask(store); const draft = store.addDraft(draftInput(task, source));
  const second = store.addTask({ brief: '第二个隔离任务' });
  const publication = { platform: 'manual-test', url: 'https://example.com/boundary', draftId: draft.id, observedAt: '2025-01-01', metrics: { clicks: 0 }, dataSource: 'CSV isolated test' };
  const rows = [{ taskId: task.id, publication }];
  const revision = store.getRevision();
  assert.equal(store.validatePublications(rows)[0].publication.dataSource, 'CSV isolated test');
  assert.equal(store.getRevision(), revision); assert.equal(store.getTask(task.id).publication, null);
  assert.throws(() => store.importPublications([...rows, { taskId: second.id, publication }]), /当前任务/);
  assert.equal(store.getTask(task.id).publication, null); assert.equal(store.getRevision(), revision);
  assert.throws(() => store.importPublications([...rows, ...rows]), /重复/);
  store.importPublications(rows); assert.equal(store.getTask(task.id).publication.metrics.clicks, 0);
  assert.throws(() => store.importPublications(rows), /不能覆盖/);
  assert.deepEqual(store.importPublications([]), []);
});

test('leads preserve redacted input and only accept validated AI output or explicit human states', t => {
  const store = setup(t);
  const lead = store.addLead({ channel: 'comment', rawText: '孩子五年级，电话 13812345678，想问入学政策。' });
  assert.doesNotMatch(lead.rawText, /13812345678/);
  assert.throws(() => store.updateLead(lead.id, { reviewStatus: 'invented' }), /状态不合法/);
  const analysis = { region: '待确认', grade: '五年级', subject: '入学政策', demand: '想了解政策', intent: 'policy', priority: 'low', missingFields: ['所在地区'], suggestedReply: '可以先确认所在地区，再查阅对应官方通知。', handoffSummary: '五年级家长咨询入学政策，地区待补。', reasoning: '原话只明确年级和政策咨询。' };
  store.recordLeadAnalysis(lead.id, { analysis, model: 'test-model', usage: { inputTokens: 1, outputTokens: 2 }, usageUnknown: false });
  const updated = store.updateLead(lead.id, { reviewStatus: 'follow_up' });
  assert.equal(updated.analysis.grade, '五年级'); assert.equal(updated.reviewStatus, 'follow_up');
  assert.throws(() => store.updateLead(lead.id, { rawText: '不可覆盖原话' }), /不允许修改/);
});

test('SQLite persists profiles, source chunks, versions and feedback across reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xhs-store-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'state.sqlite');
  let store = createStore(dbPath);
  store.saveProfile({ name: '本地验收档案', audience: '使用资料引用功能的用户' });
  const { source, task } = sourceTask(store);
  const first = store.addDraft(draftInput(task, source));
  const second = store.addDraft({ ...draftInput(task, source), body: '逐项核对原文，并确认来源日期。', parentId: first.id });
  const feedback = store.addFeedback({ draftId: second.id, decision: 'needs_changes', comment: '补充来源日期核对步骤。' });
  store.close();
  store = createStore(dbPath);
  assert.equal(store.getProfile().name, '本地验收档案');
  assert.deepEqual(store.getSource(source.id), source);
  assert.equal(store.getDraft(first.id).body, first.body);
  assert.equal(store.getDraft(second.id).version, 2);
  assert.equal(store.getDraft(second.id).parentId, first.id);
  assert.deepEqual(store.getState().feedback, [feedback]);
  store.close();
});

test('IDs cannot overwrite existing sources and chunks cannot be supplied by callers', t => {
  const store = setup(t);
  const source = store.addSource({ id: 'source_reference', text: '引用需要真实存在于资料正文中。', chunks: [{ id: 'fabricated', text: '不可接受' }] });
  assert.equal(source.chunks[0].id, 'source_reference:p1');
  assert.throws(() => store.addSource({ id: source.id, text: '不能覆盖原始资料。' }), /已存在/);
  assert.throws(() => store.addSource({ id: '../outside', text: '不合法 ID' }), /ID 不合法/);
  assert.equal(store.getSource(source.id).text, '引用需要真实存在于资料正文中。');
});

test('task sources must exist and source lists are deduplicated', t => {
  const store = setup(t);
  const source = store.addSource({ text: '资料导入支持纯文本。' });
  assert.throws(() => store.addTask({ brief: '检查引用', sourceIds: ['source_missing'] }), /不存在/);
  const task = store.addTask({ brief: '检查引用', sourceIds: [source.id, source.id] });
  assert.deepEqual(task.sourceIds, [source.id]);
  assert.throws(() => store.updateTask(task.id, { id: 'task_other' }), /不能覆盖/);
});

test('source demo flags are explicit and missing legacy flags remain absent', t => {
  const store = setup(t);
  const legacy = store.addSource({ title: '虚构演示资料', text: '仅用于程序字段边界验证。' });
  assert.equal(Object.hasOwn(legacy, 'isDemo'), false);
  assert.equal(Object.hasOwn(store.updateSource(legacy.id, { note: '保持旧资料属性' }), 'isDemo'), false);
  const explicit = store.addSource({ text: '显式演示标记的字段验证。', isDemo: true });
  assert.equal(store.getSource(explicit.id).isDemo, true);
  assert.equal(store.updateSource(explicit.id, { isDemo: false }).isDemo, false);
  assert.throws(() => store.addSource({ text: '非法标记', isDemo: 'false' }), /必须为布尔值/);
  assert.throws(() => store.updateSource(explicit.id, { isDemo: 0 }), /必须为布尔值/);
});

test('drafts and review citations must belong to the selected task sources', t => {
  const store = setup(t);
  const { source, task } = sourceTask(store);
  const unrelated = store.addSource({ text: '此资料没有选入当前任务。' });
  for (const sourceRef of ['source_missing:p1', `${source.id}:p999`, unrelated.chunks[0].id]) {
    assert.throws(() => store.addDraft({ ...draftInput(task, source), evidence: [{ claim: '检查引用', sourceRef }] }), /资料引用无效/);
  }
  const draft = store.addDraft(draftInput(task, source));
  assert.throws(() => store.updateDraft(draft.id, { review: { verdict: 'revise', issues: [{ sourceRef: unrelated.chunks[0].id }] } }), /资料引用无效/);
  const updated = store.updateDraft(draft.id, { review: { verdict: 'revise', issues: [{ reason: '句子太长', sourceRef: '' }] } });
  assert.equal(updated.review.issues[0].sourceRef, '');
});

test('draft contents are immutable and new versions preserve parent lineage', t => {
  const store = setup(t);
  const { source, task } = sourceTask(store);
  const first = store.addDraft(draftInput(task, source));
  assert.throws(() => store.updateDraft(first.id, { body: '尝试覆盖正文' }), /不可覆盖/);
  assert.throws(() => store.addDraft({ ...draftInput(task, source), version: 3 }), /版本号/);
  const next = store.addDraft({ ...draftInput(task, source), parentId: first.id });
  assert.equal(next.version, 2);
  assert.throws(() => store.addDraft({ ...draftInput(task, source), parentId: first.id }), /已有后续稿件/);
  assert.throws(() => store.addDraft({ ...draftInput(task, source), topicId: 'other', parentId: next.id }), /同一个任务和选题/);
  assert.throws(() => store.updateTask(task.id, { sourceIds: [] }), /历史引用会失效/);
});

test('feedback entries append without rewriting earlier feedback', t => {
  const store = setup(t);
  const { source, task } = sourceTask(store);
  const draft = store.addDraft(draftInput(task, source));
  const a = store.addFeedback({ draftId: draft.id, decision: 'needs_changes', comment: '补充核对步骤' });
  store.updateDraft(draft.id, { review: { verdict: '人工复核', issues: [], facts: [] } });
  const b = store.addFeedback({ draftId: draft.id, decision: 'accepted', comment: '人工核对后采纳' });
  assert.notEqual(a.id, b.id);
  assert.equal(store.getState().feedback.length, 2);
  assert.throws(() => store.addFeedback({ draftId: 'draft_missing', decision: 'accepted' }), /不存在/);
});

test('run fields and events persist and terminal state cannot restart', t => {
  const store = setup(t);
  const { task } = sourceTask(store);
  const run = store.addRun({ taskId: task.id, action: 'draft', topicId: 'reference_workflow', draftId: 'draft_reference', status: 'running', contextSnapshot: { prompt: 'stored privately' }, trace: [{ kind: 'tool' }] });
  store.appendEvent(run.id, { kind: 'tool', title: '读取资料', status: 'completed', detail: '已读取来源片段', durationMs: 4 });
  store.updateRun(run.id, { usage: { inputTokens: 15 } });
  store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
  const saved = store.getRun(run.id);
  assert.equal(saved.events.length, 1);
  assert.match(saved.events[0].at, /^\d{4}-/);
  assert.equal(saved.topicId, 'reference_workflow');
  assert.equal(saved.draftId, 'draft_reference');
  assert.deepEqual(saved.usage, { inputTokens: 15, outputTokens: 0 });
  const summary = store.listRunSummaries().find(item => item.id === run.id);
  assert.equal('contextSnapshot' in summary, false);
  assert.equal('trace' in summary, false);
  assert.equal(summary.hasContextSnapshot, true);
  assert.equal(summary.traceCount, 1);
  assert.throws(() => store.updateRun(run.id, { status: 'running' }), /不能重新启动/);
});

test('service restart marks unfinished runs failed while preserving artifacts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xhs-restart-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'state.sqlite');
  let store = createStore(dbPath);
  const { task, source } = sourceTask(store);
  store.updateTask(task.id, { status: 'in_progress' });
  const run = store.addRun({ taskId: task.id, action: 'plan', status: 'running', previousTaskStatus: 'needs_input' });
  store.close(); store = createStore(dbPath);
  assert.equal(store.getRun(run.id).status, 'failed');
  assert.match(store.getRun(run.id).error, /重启/);
  assert.equal(store.getRun(run.id).events.at(-1).status, 'failed');
  assert.equal(store.getTask(task.id).status, 'needs_input');
  assert.equal(store.getSource(source.id).text, source.text);
  store.close();
});

test('returned state is detached from storage', t => {
  const store = setup(t);
  const { source } = sourceTask(store);
  store.getSource(source.id).chunks[0].text = '尝试从返回对象修改存储';
  assert.equal(store.getSource(source.id).chunks[0].text, source.chunks[0].text);
});

test('legacy entities receive defaults on read without rewriting original JSON', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xhs-legacy-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  let store = createStore(path); const { source, task } = sourceTask(store); store.close();
  const db = new DatabaseSync(path);
  const rawTask = JSON.parse(db.prepare('SELECT data FROM entities WHERE id=?').get(task.id).data);
  for (const key of ['accountId', 'owner', 'status', 'assignment', 'messages', 'publication']) delete rawTask[key];
  const saved = JSON.stringify(rawTask); db.prepare('UPDATE entities SET data=? WHERE id=?').run(saved, task.id); db.close();
  store = createStore(path);
  assert.equal(store.getTask(task.id).accountId, null); assert.deepEqual(store.getTask(task.id).messages, []);
  assert.equal(store.getSource(source.id).category, 'reference'); store.close();
  const verify = new DatabaseSync(path, { readOnly: true });
  assert.equal(verify.prepare('SELECT data FROM entities WHERE id=?').get(task.id).data, saved); verify.close();
});

test('legacy accepted reviews are stale on read without rewriting draft or feedback history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xhs-legacy-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  let store = createStore(path); const { source, task } = sourceTask(store);
  const draft = store.addDraft({ ...draftInput(task, source), review: { issues: [] } });
  store.addFeedback({ draftId: draft.id, decision: 'accepted' }); store.close();
  const db = new DatabaseSync(path);
  const raw = JSON.parse(db.prepare('SELECT data FROM entities WHERE id=?').get(draft.id).data);
  delete raw.reviewContextHash; delete raw.reviewRevision;
  const saved = JSON.stringify(raw); db.prepare('UPDATE entities SET data=? WHERE id=?').run(saved, draft.id); db.close();
  store = createStore(path);
  assert.equal(store.getState().drafts[0].reviewStale, true);
  assert.equal(store.getState().tasks[0].status, 'needs_review');
  assert.equal(store.getState().feedback[0].decision, 'accepted');
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted' }), /过期/);
  store.close();
  const verify = new DatabaseSync(path, { readOnly: true });
  assert.equal(verify.prepare('SELECT data FROM entities WHERE id=?').get(draft.id).data, saved); verify.close();
});

test('accounts and source metadata are editable without mutating original source content', t => {
  const store = setup(t);
  assert.deepEqual(store.listAccounts(), []);
  const account = store.addAccount({ name: '资料工作台说明', identity: 'planning', owner: '本地测试' });
  assert.equal(account.identity, 'planning');
  assert.equal(store.updateAccount(account.id, { audience: '需要核对资料的使用者' }).audience, '需要核对资料的使用者');
  assert.throws(() => store.updateAccount(account.id, { secret: true }), /不允许/);
  const source = store.addSource({ text: '原始资料正文应保持不变。', category: 'method', note: '历史方法' });
  assert.equal(store.updateSource(source.id, { category: 'reference', archived: true }).text, source.text);
  assert.throws(() => store.updateSource(source.id, { text: '覆盖原文' }), /不允许/);
  assert.throws(() => store.updateSource(source.id, { category: 'unknown' }), /不合法/);
});

test('tasks can receive drafts before sources and collect clarification messages', t => {
  const store = setup(t);
  const account = store.addAccount({ name: '资料引用功能说明' });
  const task = store.addTask({ brief: '审核现成资料引用说明', accountId: account.id, sourceIds: [], owner: '测试作者' });
  const draft = store.addDraft({ taskId: task.id, title: '资料引用说明', body: '打开引用检查原文。', origin: 'imported' });
  assert.equal(draft.origin, 'imported'); assert.deepEqual(draft.evidence, []);
  const source = store.addSource({ text: '打开引用可以查看资料原文。' });
  const clarified = store.appendMessage(task.id, { text: '补充引用功能说明', sourceIds: [source.id] });
  assert.equal(clarified.status, 'ready'); assert.equal(clarified.messages[0].role, 'user');
  assert.deepEqual(clarified.sourceIds, [source.id]);
  assert.throws(() => store.updateTask(task.id, { sourceIds: [] }), /历史引用/);
  const other = store.addAccount({ name: '另一个账号' });
  assert.throws(() => store.updateTask(task.id, { accountId: other.id }), /不能更换账号/);
});

test('manual versions preserve history, invalidate stale review and require change notes', t => {
  const store = setup(t); const { source, task } = sourceTask(store);
  const first = store.addDraft({ ...draftInput(task, source), review: { verdict: '通过', issues: [] } });
  assert.throws(() => store.addDraftVersion(first.id, { body: '更新' }), /修改说明/);
  const second = store.addDraftVersion(first.id, { body: '逐句检查引用原文。', changeNote: '简化句子', lockedFields: ['title'], editingSeconds: 12 });
  assert.equal(second.version, 2); assert.equal(second.origin, 'manual'); assert.equal(second.review, null);
  assert.equal(second.evidenceNeedsReview, true); assert.deepEqual(second.evidence, first.evidence);
  assert.equal(second.editingSeconds, 12); assert.equal(store.getDraft(first.id).body, first.body);
  assert.throws(() => store.addDraftVersion(first.id, { body: '重写', changeNote: '旧版本' }), /最新/);
  assert.throws(() => store.addFeedback({ draftId: second.id, decision: 'accepted' }), /尚未完成/);
});

test('acceptance requires reviewed current draft and logged handling of blocking issues', t => {
  const store = setup(t); const { source, task } = sourceTask(store);
  const draft = store.addDraft(draftInput(task, source));
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted' }), /尚未完成/);
  assert.throws(() => store.updateTask(task.id, { status: 'accepted' }), /先审核并采纳/);
  store.updateDraft(draft.id, { review: { verdict: '需核对', issues: [{ id: 'issue_reference', severity: 'high', category: 'fact', field: 'body', quote: '打开草稿对应的来源片段', reason: '需要人工核对交互说明', sourceRef: source.chunks[0].id, suggestion: '核对原文', locationVerified: true, blocking: true }] } });
  const report = qualityReport(store.getDraft(draft.id), [source], [], []);
  assert.throws(() => store.addFeedback({ draftId: draft.id, decision: 'accepted' }), /阻断问题/);
  assert.throws(() => store.addIssueDecision({ draftId: draft.id, issueKey: 'missing', decision: 'resolved', comment: '不存在的问题' }), /问题不存在/);
  const issue = report.issues.find(item => item.blocking);
  const decision = store.addIssueDecision({ draftId: draft.id, issueKey: issue.id, decision: 'dismissed', comment: '核对当前来源，原句有对应支持。' });
  assert.equal(decision.issueKey, issue.id);
  const accepted = store.addFeedback({ draftId: draft.id, decision: 'accepted', comment: '人工复核后采纳' });
  assert.equal(accepted.decision, 'accepted'); assert.equal(store.getTask(task.id).status, 'accepted');
  assert.equal(store.updateTask(task.id, { status: 'delivered' }).status, 'delivered');
  assert.equal(store.getDraft(draft.id).review.issues.length, 1);
});

test('publication records require valid links and nonnegative data', t => {
  const store = setup(t); const { task, source } = sourceTask(store);
  const draft = store.addDraft(draftInput(task, source));
  const base = { url: 'https://example.com/reference', platform: '边界测试', draftId: draft.id, observedAt: '2026-09-23' };
  assert.throws(() => store.updateTask(task.id, { publication: { ...base, metrics: { views: -1 } } }), /非负/);
  assert.throws(() => store.updateTask(task.id, { publication: { ...base, url: 'javascript:alert(1)' } }), /HTTP/);
  const updated = store.updateTask(task.id, { publication: { ...base, note: '仅程序边界测试，非业务结果', metrics: { views: 0, likes: null } } });
  assert.equal(updated.publication.metrics.views, 0);
  assert.equal(updated.publication.metrics.likes, null); assert.equal(updated.publication.version, 1); assert.equal('saves' in updated.publication.metrics, false);
  for (const publication of [{}, { platform: '边界测试' }, { ...base, observedAt: '2026-02-30' }, { ...base, observedAt: 'not a date' }, { ...base, observedAt: '2999-01-01' }, { ...base, publishedAt: '2026-09-23', observedAt: '2026-09-22' }, { ...base, observedAt: '', metrics: { views: 0 } }, { ...base, version: 999 }]) assert.throws(() => store.updateTask(task.id, { publication }));
  const { task: other } = sourceTask(store);
  assert.throws(() => store.updateTask(other.id, { publication: base }), /当前任务/);
  const second = store.addDraftVersion(draft.id, { body: '新版不自动成为已发布版本。', changeNote: '边界测试' });
  assert.equal(second.version, 2); assert.equal(store.getTask(task.id).publication.draftId, draft.id); assert.equal(store.getTask(task.id).publication.version, 1);
});

test('lead confirmation requires current human note, preserves AI and field history, and resets after reclassification', t => {
  const store = setup(t);
  const lead = store.addLead({ rawText: '咨询信息尚不完整。', channel: 'manual', isDemo: true });
  assert.throws(() => store.updateLead(lead.id, { reviewStatus: 'ready_handoff' }), /人工确认备注/);
  assert.throws(() => store.updateLead(lead.id, { reviewStatus: 'ready_handoff', manualNote: '空字段不能确认' }), /人工修正字段/);
  assert.throws(() => store.updateLead(lead.id, { analysis: {} }), /不允许修改/);
  assert.throws(() => store.updateLead(lead.id, { model: 'invented' }), /不允许修改/);
  assert.throws(() => store.updateLead(lead.id, { humanReview: { region: '已人工核对' } }), /本次人工备注/);
  const ready = store.updateLead(lead.id, { humanReview: { region: '已人工核对', demand: '需要核对材料' }, reviewStatus: 'ready_handoff', manualNote: '依据咨询原文人工确认，可交接补问。' });
  assert.equal(ready.analysis, null); assert.equal(ready.confirmedFields.region, '已人工核对'); assert.equal(ready.history.length, 1);
  assert.throws(() => store.updateLead(lead.id, { reviewStatus: 'handed_off' }), /本次人工确认/);
  const handed = store.updateLead(lead.id, { reviewStatus: 'handed_off', manualNote: '确认完成本次交接。' }); assert.equal(handed.history.length, 2);
  const amended = store.updateLead(lead.id, { humanReview: { demand: '补充新的咨询问题' }, manualNote: '新增问题，需要重新确认。' }); assert.equal(amended.reviewStatus, 'pending_review'); assert.equal(amended.confirmedFields, null);
  assert.equal(amended.history[0].after.humanReview.demand, '需要核对材料');
  assert.throws(() => store.updateLead(lead.id, { reviewStatus: 'handed_off', manualNote: '跳过确认' }), /先人工确认/);
  const analysis = { region: '待确认', grade: '待确认', subject: '待确认', demand: '需要核对材料', intent: 'unclear', priority: 'low', missingFields: ['地区'], suggestedReply: '请说明需要核对哪种材料。', handoffSummary: '待补充材料类型', reasoning: '仅有泛化咨询。' };
  store.recordLeadAnalysis(lead.id, { analysis, model: 'boundary-model', usageUnknown: true });
  const corrected = store.updateLead(lead.id, { humanReview: { region: '人工确认地区', demand: '人工确认材料问题' }, manualNote: '人工已核验相关字段。', reviewStatus: 'ready_handoff' });
  assert.equal(corrected.analysis.region, '待确认'); assert.equal(corrected.confirmedFields.region, '人工确认地区');
  const rerun = store.recordLeadAnalysis(lead.id, { analysis: { ...analysis, priority: 'medium' }, model: 'boundary-model', usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(rerun.reviewStatus, 'pending_review'); assert.equal(rerun.confirmedFields, null); assert.equal(rerun.humanReview.region, '人工确认地区');
  assert.equal(rerun.history.filter(item => item.kind === 'ai_analysis').length, 2); assert.equal(rerun.history.at(-1).before.analysis.priority, 'low');
});
