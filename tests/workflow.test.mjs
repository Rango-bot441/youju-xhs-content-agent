import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateDraft, validateReview, inspectDraft, buildExport, createWorkflow, validateAssignment, validateScope, applyRevision, PROMPT_VERSION, TOOL_VERSION } from '../lib/workflow.mjs';
import { createStore } from '../lib/store.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// 仅测试程序约束；这些短字符串不是业务演示材料或效果数据。
const allowed = new Set(['source_public:p1']);
const draft = { title: '内容与增长', body: '将工作方法整理成内容。', cover: '从方法到内容', pages: [{ heading: '选题', text: '从用户问题出发。' }, { heading: '核对', text: '检查事实与来源。' }], tags: ['内容运营'], evidence: [{ claim: '内容与增长', sourceRef: 'source_public:p1' }], gaps: [] };
test('草稿拒绝不存在的资料引用，不会把臆造引用存成证据', () => {
  assert.throws(() => validateDraft({ ...draft, evidence: [{ claim: '内容与增长', sourceRef: 'source_fake:p2' }] }, allowed), /不存在或未实际读取/);
});
test('草稿必须有证据和完整图文页', () => {
  assert.throws(() => validateDraft({ ...draft, evidence: [] }, allowed), /至少一条/);
  assert.throws(() => validateDraft({ ...draft, pages: [] }, allowed), /至少两页/);
  assert.equal(validateDraft(draft, allowed).title, draft.title);
});
test('资料不足的计划保留具体问题，不伪造选题', () => {
  assert.deepEqual(validatePlan({ summary: '缺少产品资料', topics: [], questions: ['需要产品的公开介绍。'] }, allowed).topics, []);
  assert.throws(() => validatePlan({ summary: '资料不足', topics: [], questions: [] }, allowed), /缺少什么/);
});
test('直接模式允许只给主题生成草稿并自动审核，事实证据仍保持为空', async () => {
  const store = createStore(':memory:');
  const task = store.addTask({ title: '强基准备', brief: '主题/选题：普通家庭强基计划要怎么准备\n目标人群/阶段：高中家长', sourceIds: [] });
  let calls = 0;
  const workflow = createWorkflow(store, async request => {
    calls++;
    const context = JSON.parse(request.input[0].content);
    if (context.stage === 'draft') return toolResponse('deliver_draft', { ...draft, title: '普通家庭如何准备强基计划', cover: '先做资料核验', pages: draft.pages, evidence: [], gaps: ['缺少可核验政策资料'] });
    return toolResponse('deliver_review', { verdict: '资料不足，待人工核验', issues: [{ severity: 'high', category: 'material', field: 'body', quote: draft.body, reason: '当前没有可核验资料。', sourceRef: '', suggestion: '补充官方资料后再发布。' }], facts: [] });
  });
  try {
    const run = await terminal(store, workflow.start(task.id, { action: 'draft' }).id);
    assert.equal(run.status, 'completed', run.error || '');
    assert.equal(calls, 2);
    assert.equal(store.listDrafts().length, 1);
    assert.deepEqual(store.listDrafts()[0].evidence, []);
    assert.ok(store.listDrafts()[0].review);
  } finally { store.close(); }
});
test('审核高风险不能被模型的通过标签掩盖', () => {
  const result = validateReview({ verdict: '通过', issues: [{ severity: 'high', quote: '必爆', reason: '没有依据', sourceRef: '', suggestion: '删除承诺' }] }, allowed);
  assert.equal(result.verdict, '需修改');
  assert.equal(inspectDraft({ ...draft, body: '保证涨粉，这条必爆。' }).length, 2);
});
test('导出保留出处、原文、版本和未审核边界', () => {
  const result = buildExport({ ...draft, id: 'd1', version: 2, status: 'draft', createdAt: '2026-09-23', review: null }, [{ id: 'source_public', title: '个人网站', url: 'https://rango-bot441.github.io/', chunks: [{ id: 'source_public:p1', text: '内容与增长' }] }], { includeEvidence: true });
  assert.match(result, /版本：2/); assert.match(result, /https:\/\/rango-bot441.github.io/); assert.match(result, /原文：内容与增长/); assert.match(result, /模型审核尚未完成/);
});

// 内存内的协议测试替身，绝不写入用户工作区或作为业务生成结果。
async function terminal(store, id) {
  for (let i = 0; i < 100; i++) {
    const run = store.getRun(id);
    if (['completed', 'failed'].includes(run.status)) return run;
    await delay(5);
  }
  throw new Error('协议测试未按期结束');
}
function setup(sourceText = '用于软件校验的输入，不是业务成效。') {
  const store = createStore(':memory:');
  const source = store.addSource({ title: '协议边界测试资料', text: sourceText });
  const task = store.addTask({ brief: '验证协议约束', sourceIds: [source.id] });
  return { store, source, task };
}
const toolResponse = (name, args) => ({ output: [{ type: 'function_call', call_id: 'test_call', name, arguments: JSON.stringify(args) }], model: 'protocol-test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
test('re-review immediately revokes current acceptance even when the provider fails', async () => {
  const { store, task, source } = setup();
  try {
    const saved = store.addDraft({ ...draft, taskId: task.id, body: '请阅读来源说明。', evidence: [{ claim: '软件校验', sourceRef: source.chunks[0].id }], review: { issues: [], facts: [] } });
    store.addFeedback({ draftId: saved.id, decision: 'accepted' });
    const workflow = createWorkflow(store, async () => { throw new Error('隔离测试连接失败'); });
    const run = workflow.start(task.id, { action: 'review', draftId: saved.id });
    assert.notEqual(store.getDraft(saved.id).status, 'accepted');
    assert.equal(store.getDraft(saved.id).evidenceNeedsReview, true);
    await terminal(store, run.id);
    assert.equal(store.getTask(task.id).status, 'needs_review');
    assert.equal(store.getState().feedback[0].decision, 'accepted');
    assert.throws(() => store.addFeedback({ draftId: saved.id, decision: 'accepted' }), /尚未完成/);
  } finally { store.close(); }
});

test('a review response cannot approve context changed during the provider call', async () => {
  const { store, task, source } = setup();
  try {
    const saved = store.addDraft({ taskId: task.id, body: '请阅读来源说明。', evidence: [{ claim: '软件校验', sourceRef: source.chunks[0].id }] });
    const workflow = createWorkflow(store, async () => {
      store.appendMessage(task.id, { text: '新的业务纠错：之前的范围已改变。' });
      return toolResponse('deliver_review', { verdict: '通过', issues: [], facts: [] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'review', draftId: saved.id }).id);
    assert.equal(run.status, 'failed'); assert.match(run.error, /业务上下文已变化/);
    assert.equal(store.getDraft(saved.id).review, null);
    assert.equal(store.getDraft(saved.id).evidenceNeedsReview, true);
    assert.match(store.getTask(task.id).messages.at(-1).text, /纠错/);
  } finally { store.close(); }
});

test('archiving a task during a successful provider response keeps it archived and rejects the result', async () => {
  const { store, task, source } = setup();
  try {
    const saved = store.addDraft({ taskId: task.id, body: '请阅读来源说明。', evidence: [{ claim: '软件校验', sourceRef: source.chunks[0].id }] });
    const workflow = createWorkflow(store, async () => {
      store.updateTask(task.id, { status: 'archived' });
      return toolResponse('deliver_review', { verdict: '通过', issues: [], facts: [] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'review', draftId: saved.id }).id);
    assert.equal(run.status, 'failed'); assert.match(run.error, /归档/);
    assert.equal(store.getTask(task.id).status, 'archived');
    assert.equal(store.getDraft(saved.id).review, null);
  } finally { store.close(); }
});
test('工作流阻止跳过来源读取，达到上限后保留失败记录', async () => {
  const { store, task } = setup('软件校验长资料。'.repeat(1000));
  try {
    let calls = 0;
    const workflow = createWorkflow(store, async () => { calls++; return toolResponse('deliver_plan', { summary: '不可跳过核对', topics: [], questions: ['缺资料'] }); });
    const run = await terminal(store, workflow.start(task.id, { action: 'plan' }).id);
    assert.equal(run.status, 'failed');
    assert.equal(calls, 7);
    assert.equal(store.getTask(task.id).plan, null);
    assert.ok(run.events.some(event => event.detail.includes('必须实际读取资料')));
    assert.equal(workflow.activeCount, 0);
  } finally { store.close(); }
});
test('审核服务失败时保留已生成草稿，明确标记尚未审核', async () => {
  const { store, source, task } = setup();
  const ref = source.chunks[0].id;
  const topic = { id: 'topic_1', sourceRefs: [ref] };
  store.updateTask(task.id, { plan: { topics: [topic], questions: [] } });
  let calls = 0;
  const workflow = createWorkflow(store, async () => {
    calls++;
    if (calls === 1) return toolResponse('search_sources', { query: '软件校验' });
    if (calls === 2) return toolResponse('read_source', { sourceId: source.id, chunkIds: [ref] });
    if (calls === 3) return toolResponse('deliver_draft', { ...draft, evidence: [{ claim: '协议边界测试', sourceRef: ref }] });
    throw new Error('审核阶段连接失败');
  });
  try {
    const run = await terminal(store, workflow.start(task.id, { action: 'draft', topicId: 'topic_1' }).id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /审核阶段连接失败/);
    assert.equal(store.listDrafts().length, 1);
    assert.equal(store.getDraft(run.resultDraftId).review, null);
    assert.throws(() => workflow.start(task.id, { action: 'plan' }), /已有稿件/);
  } finally { store.close(); }
});
test('取消会停止模型等待并释放运行锁，不伪造结果', async () => {
  const { store, task } = setup();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const workflow = createWorkflow(store, ({ signal }) => new Promise((_resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  try {
    const run = workflow.start(task.id, { action: 'plan' });
    await started;
    assert.throws(() => workflow.start(task.id, { action: 'plan' }), /已有任务运行/);
    workflow.cancel(run.id);
    const result = await terminal(store, run.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /用户取消/);
    assert.equal(workflow.activeCount, 0);
    assert.equal(store.getTask(task.id).plan, null);
  } finally { store.close(); }
});

test('默认交付导出不携带资料全文、审核或内部版本，证据版需显式选择', () => {
  const result = buildExport({ ...draft, version: 1, status: 'draft', createdAt: '2026-09-23' }, [{ id: 'source_public', title: '内部资料', chunks: [{ id: 'source_public:p1', text: '不应默认出现在交付稿里的内部原文。' }] }]);
  assert.match(result, /将工作方法整理成内容/);
  assert.doesNotMatch(result, /内部原文|版本：|## 事实与来源|## 审核记录/);
});

test('export helper blocks credentials in selected delivery fields but ignores unused source text', () => {
  const credentials = 'sk-isolated_protocol_fixture';
  assert.throws(() => buildExport({ ...draft, tags: [credentials] }), /凭据/);
  const source = { id: 'source_public', title: '测试来源', chunks: [{ id: 'source_public:p1', text: credentials }] };
  assert.doesNotThrow(() => buildExport(draft, [source]));
  assert.throws(() => buildExport(draft, [source], { includeEvidence: true }), /凭据/);
  assert.doesNotThrow(() => buildExport({ ...draft, evidence: [] }, [source], { includeEvidence: true }));
});

test('短资料已经直接提供原文时可一次交付，保留工具与可重放快照', async () => {
  const { store, source, task } = setup();
  store.updateSource(source.id, { region: '协议测试地区', grade: '测试年级', effectiveUntil: '2000-01-01', verificationStatus: 'needs_update' });
  let requests = 0;
  try {
    const workflow = createWorkflow(store, async request => {
      requests++;
      const context = JSON.parse(request.input[0].content);
      assert.equal(context.directMaterials[0].chunks[0].text, source.text);
      assert.equal(context.directMaterials[0].region, '协议测试地区');
      assert.equal(context.materials[0].effectiveUntil, '2000-01-01');
      assert.equal(context.materials[0].verificationStatus, 'needs_update');
      assert.match(context.currentDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(request.tools.some(tool => tool.name === 'read_source'));
      return toolResponse('deliver_plan', { summary: '隔离软件测试', topics: [{ id: 'ignored', title: '测试选题', audience: '测试受众', angle: '程序行为', goal: '验证流程', format: '文本', why: '协议回归', sourceRefs: [source.chunks[0].id], gaps: [] }], questions: [] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'plan' }).id);
    assert.equal(run.status, 'completed'); assert.equal(requests, 1);
    assert.equal(run.promptVersion, PROMPT_VERSION); assert.equal(run.toolVersion, TOOL_VERSION);
    assert.equal(run.contextSnapshot.sources[0].text, source.text);
    assert.equal(run.contextSnapshot.sources[0].sha256.length, 64);
    assert.ok(run.trace.some(item => item.kind === 'model_request'));
    assert.ok(run.trace.some(item => item.kind === 'delivery'));
    assert.ok(run.events.some(item => item.kind === 'context'));
  } finally { store.close(); }
});

test('长资料读取工具同样传递适用范围与时效，范围声明不能洗掉后续断言', async () => {
  const { store, source, task } = setup('协议测试长资料。'.repeat(1000));
  store.updateSource(source.id, { region: '协议测试地区', verificationStatus: 'needs_update', effectiveUntil: '2000-01-01' });
  let calls = 0;
  try {
    const workflow = createWorkflow(store, async request => {
      calls++;
      if (calls === 1) return toolResponse('read_source', { sourceId: source.id, chunkIds: [source.chunks[0].id] });
      const output = JSON.parse(request.input.find(item => item.type === 'function_call_output').output);
      assert.equal(output.region, '协议测试地区');
      assert.equal(output.verificationStatus, 'needs_update');
      assert.equal(output.effectiveUntil, '2000-01-01');
      return toolResponse('deliver_plan', { summary: '资料待更新', topics: [], questions: ['需要当前适用材料。'] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'plan' }).id);
    assert.equal(run.status, 'completed');
    assert.equal(calls, 2);
    const claim = '本文不解读报名规则；所有学校全年可报名。';
    const review = validateReview({ verdict: '核对', issues: [], facts: [{ claim, sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '后半句无来源。' }] }, new Set(), { ...draft, body: claim });
    assert.ok(review.issues.some(issue => issue.blocking));
  } finally { store.close(); }
});

test('任务单无需预造资料，缺口形成澄清消息，用户回答与所选账号进入后续上下文', async () => {
  const store = createStore(':memory:');
  try {
    const account = store.addAccount({ name: '软件测试规划账号', identity: 'planning', audience: '测试受众' });
    const task = store.addTask({ brief: '协议测试：任务资料待补', sourceIds: [], accountId: account.id });
    let calls = 0;
    const workflow = createWorkflow(store, async request => {
      calls++;
      const context = JSON.parse(request.input[0].content);
      assert.equal(context.account.id, account.id);
      assert.equal(context.account.identity, 'planning');
      assert.deepEqual(context.directMaterials, []);
      if (calls === 2) assert.ok(context.task.messages.some(message => message.role === 'user' && message.text === '交付一篇知识说明，不做效果承诺。'));
      return toolResponse('deliver_brief', { audience: '测试受众', objective: '用户希望说明具体知识并服务测试受众', angle: '', facts: [], materials: [], deliverables: ['一篇知识说明'], criteria: ['不做效果承诺'], questions: calls === 1 ? ['需要交付什么？'] : [] });
    });
    const first = await terminal(store, workflow.start(task.id, { action: 'brief' }).id);
    assert.equal(first.status, 'completed');
    assert.equal(store.getTask(task.id).status, 'needs_input');
    assert.equal(store.getTask(task.id).messages.at(-1).role, 'assistant');
    store.appendMessage(task.id, { role: 'user', text: '交付一篇知识说明，不做效果承诺。' });
    const next = await terminal(store, workflow.start(task.id, { action: 'brief' }).id);
    assert.equal(next.status, 'completed');
    assert.equal(store.getTask(task.id).status, 'ready');
    assert.deepEqual(store.getTask(task.id).assignment.questions, []);
    assert.match(store.getTask(task.id).assignment.objective, /服务测试受众/);
    assert.throws(() => validateAssignment({ audience: '', objective: '', angle: '', facts: [], materials: [], deliverables: [], criteria: [], questions: [] }), /必须提出/);
  } finally { store.close(); }
});

test('任务单拒绝错误片段ID，正确内部引用也必须改成协作者可读文字', () => {
  const assignment = { audience: '测试受众', objective: '说明测试业务方法', angle: '', facts: [], materials: [], deliverables: ['一篇知识说明'], criteria: ['事实需有资料支持'], questions: [] };
  assert.throws(() => validateAssignment({ ...assignment, facts: ['内容来自 source_abc-4bd:p1'] }, new Set(['source_abc-4bd1:p1'])), /不存在或未读取/);
  assert.throws(() => validateAssignment({ ...assignment, facts: ['内容来自 source_abc-4bd1:p1'] }, new Set(['source_abc-4bd1:p1'])), /内部片段ID/);
  assert.throws(() => validateAssignment({ ...assignment, materials: ['sourceQuote: 测试原文'] }), /sourceQuote/);
  assert.equal(validateAssignment({ ...assignment, facts: ['内容依据：软件测试资料中的方法说明。'] }).facts.length, 1);
});

test('外部导入稿可以直接审核，事实引用与问题原句可定位', async () => {
  const { store, source, task } = setup('测试产品包含三节课程。');
  try {
    const imported = store.addDraft({ taskId: task.id, origin: 'imported', title: '外部测试稿', body: '测试产品包含三节课程。', pages: [], evidence: [] });
    const workflow = createWorkflow(store, async request => {
      const context = JSON.parse(request.input[0].content);
      assert.equal(context.selectedTopic, null);
      assert.equal(context.draft.origin, 'imported');
      return toolResponse('deliver_review', { verdict: '已按来源核对', issues: [], facts: [{ claim: '测试产品包含三节课程。', sourceRef: source.chunks[0].id, sourceQuote: source.text, status: 'supported', reason: '原文对应' }] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'review', draftId: imported.id }).id);
    assert.equal(run.status, 'completed');
    const review = store.getDraft(imported.id).review;
    assert.equal(review.facts[0].status, 'supported');
    assert.equal(review.facts[0].quoteVerified, true);
    assert.equal(review.facts[0].claimLocated, true);
    assert.equal(store.getTask(task.id).plan, null);
    assert.equal(store.getTask(task.id).status, 'needs_review');
  } finally { store.close(); }
});

test('审核不能将编造出处或原稿中不存在的句子当作可靠依据', () => {
  const original = { ...draft, body: '测试产品包含三节课程。' };
  const sources = [{ chunks: [{ id: 'source_public:p1', text: '测试产品包含两节课程。' }] }];
  const review = validateReview({ verdict: '通过', issues: [{ severity: 'high', category: 'fact', field: 'body', quote: '根本不在稿件里的句子', reason: '协议测试', sourceRef: '', suggestion: '核对原文' }], facts: [{ claim: original.body, sourceRef: 'source_public:p1', sourceQuote: '伪造的来源摘录', status: 'supported', reason: '协议测试' }] }, allowed, original, sources);
  assert.equal(review.facts[0].status, 'unsupported');
  assert.equal(review.issues.find(issue => issue.quote === '根本不在稿件里的句子').blocking, false);
  assert.equal(review.issues.find(issue => issue.quote === original.body).blocking, true);
  assert.throws(() => validateReview({ verdict: '通过', issues: [], facts: [{ claim: original.body, sourceRef: '', sourceQuote: '', status: 'supported', reason: '没有证据' }] }, allowed), /必须提供引用/);
});

test('内容范围免责声明不要求伪造事实来源，也不被判成事实错误', () => {
  const original = { ...draft, body: '本文不据此回答2026年报名安排。' };
  const review = validateReview({ verdict: '说明范围', issues: [], facts: [{ claim: original.body, sourceRef: 'source_public:p1', sourceQuote: '这不是支持政策结论的原文', status: 'unsupported', reason: '这是作者说明本文范围，不是政策事实。' }] }, allowed, original, [{ chunks: [{ id: 'source_public:p1', text: '页面数据截止至2023年8月。' }] }]);
  assert.equal(review.facts[0].status, 'unsupported');
  assert.equal(review.facts[0].sourceRef, '');
  assert.equal(review.issues.some(issue => issue.quote === original.body), false);
});

test('选区改稿只替换唯一选区，其他字段和锁定内容由程序保留', () => {
  const original = { ...draft, body: '开头保留。需要修改。结尾保留。', lockedFields: ['title', 'cover'] };
  const proposed = { replacement: '新的表述$&', title: '不应覆盖', cover: '不应覆盖', pages: [{ heading: '不应覆盖', text: '不应覆盖' }], evidence: [], gaps: [] };
  const changed = applyRevision(original, proposed, { field: 'body', text: '需要修改。' }, ['title', 'cover'], allowed);
  assert.equal(changed.body, '开头保留。新的表述$&结尾保留。');
  for (const field of ['title', 'cover', 'pages', 'tags']) assert.deepEqual(changed[field], original[field]);
  assert.throws(() => validateScope({ field: 'title' }, original, ['title']), /冲突/);
  assert.throws(() => validateScope({ field: 'body', text: '保留。' }, original), /唯一存在/);
  assert.throws(() => validateScope({ field: 'body', text: '并不存在' }, original), /唯一存在/);
});

test('整稿改写也不能改锁定字段，分页选区仅改被选中的文本', () => {
  const changed = applyRevision(draft, { ...draft, title: '新标题', body: '新正文', tags: ['新标签'] }, null, ['title', 'tags'], allowed);
  assert.equal(changed.body, '新正文'); assert.equal(changed.title, draft.title); assert.deepEqual(changed.tags, draft.tags);
  const pages = applyRevision(draft, { replacement: '检查可核验依据。', evidence: [], gaps: [] }, { field: 'pages', text: '检查事实与来源。' }, [], allowed);
  assert.deepEqual(pages.pages[0], draft.pages[0]);
  assert.equal(pages.pages[1].text, '检查可核验依据。');
  assert.equal(pages.body, draft.body);
});

test('局部AI改稿生成新版本并审核，不覆盖外部原稿或无关字段', async () => {
  const { store, task } = setup();
  try {
    const imported = store.addDraft({ taskId: task.id, origin: 'imported', title: '保持标题', body: '开头保留。原文需改。结尾保留。', pages: [], tags: ['保留标签'], evidence: [], lockedFields: ['title'] });
    const workflow = createWorkflow(store, async request => {
      const context = JSON.parse(request.input[0].content);
      if (context.stage === 'revise') {
        assert.ok(request.tools.some(tool => tool.name === 'deliver_revision'));
        return toolResponse('deliver_revision', { replacement: '修改后的说明。', pages: [], evidence: [], gaps: [] });
      }
      return toolResponse('deliver_review', { verdict: '需人工确认表达', issues: [], facts: [] });
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'revise', draftId: imported.id, instruction: '只改选区', scope: { field: 'body', text: '原文需改。' } }).id);
    assert.equal(run.status, 'completed');
    const next = store.getDraft(run.resultDraftId);
    assert.equal(next.version, 2); assert.equal(next.parentId, imported.id);
    assert.equal(next.body, '开头保留。修改后的说明。结尾保留。');
    assert.equal(next.title, imported.title); assert.deepEqual(next.tags, imported.tags);
    assert.equal(store.getDraft(imported.id).body, imported.body);
    assert.deepEqual(next.lockedFields, ['title']);
    assert.ok(next.review);
  } finally { store.close(); }
});

test('无分页和引用的外部稿可整稿修改，但锁定正文逐字保持且仍须审核', async () => {
  const { store, task } = setup();
  try {
    const imported = store.addDraft({ taskId: task.id, origin: 'imported', title: '旧标题', body: '  必须保留首尾空格的测试正文。  ', pages: [], evidence: [], lockedFields: ['body'] });
    const workflow = createWorkflow(store, async request => JSON.parse(request.input[0].content).stage === 'revise'
      ? toolResponse('deliver_draft', { title: '新标题', body: '模型试图改掉锁定正文。', cover: '', pages: [], tags: [], evidence: [], gaps: [] })
      : toolResponse('deliver_review', { verdict: '待人工确认', issues: [], facts: [] }));
    const run = await terminal(store, workflow.start(task.id, { action: 'revise', draftId: imported.id, instruction: '调整标题，正文锁定' }).id);
    assert.equal(run.status, 'completed');
    const next = store.getDraft(run.resultDraftId);
    assert.equal(next.title, '新标题'); assert.equal(next.body, imported.body);
    assert.deepEqual(next.pages, []); assert.deepEqual(next.evidence, []); assert.ok(next.review);
  } finally { store.close(); }
});

test('输入、工具结果与快照脱敏，模型推理内容不进入trace', async () => {
  const { store, source, task } = setup('软件测试联系 test@example.test，电话13812345678；资料无真实业务含义。');
  try {
    const workflow = createWorkflow(store, async request => {
      assert.doesNotMatch(JSON.stringify(request.input), /test@example\.test|13812345678/);
      return { ...toolResponse('deliver_plan', { summary: '缺少业务素材', topics: [], questions: ['请补充产品说明。'] }), output: [{ type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: '不应保存的推理文本' }], encrypted_content: 'opaque' }, ...toolResponse('deliver_plan', { summary: '缺少业务素材', topics: [], questions: ['请补充产品说明。'] }).output] };
    });
    const run = await terminal(store, workflow.start(task.id, { action: 'plan' }).id);
    assert.equal(run.status, 'completed');
    assert.doesNotMatch(JSON.stringify(run.contextSnapshot), /test@example\.test|13812345678/);
    assert.doesNotMatch(JSON.stringify(run.trace), /test@example\.test|13812345678|不应保存的推理文本|opaque/);
    assert.match(store.getSource(source.id).text, /13812345678/);
  } finally { store.close(); }
});

test('失败请求保存已知用量及未知标记，重试保留原失败记录', async () => {
  const { store, task } = setup();
  try {
    let calls = 0;
    const workflow = createWorkflow(store, async () => {
      calls++;
      if (calls === 1) {
        const error = new Error('协议测试：输出截断');
        error.usage = { inputTokens: 12, outputTokens: 4 }; error.usageUnknown = false; error.requestId = 'failed_test';
        throw error;
      }
      return toolResponse('deliver_plan', { summary: '需要补充资料', topics: [], questions: ['补充明确产品事实。'] });
    });
    const failed = await terminal(store, workflow.start(task.id, { action: 'plan' }).id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.failedRequests, 1); assert.equal(failed.usageUnknown, false);
    assert.deepEqual(failed.usage, { inputTokens: 12, outputTokens: 4 });
    assert.equal(store.getTask(task.id).status, 'ready');
    const retried = await terminal(store, workflow.retry(failed.id).id);
    assert.equal(retried.status, 'completed'); assert.equal(retried.retryOf, failed.id);
    assert.equal(store.getRun(failed.id).status, 'failed');
    assert.ok(failed.trace.some(item => item.kind === 'model_error' && item.requestId === 'failed_test'));
  } finally { store.close(); }
});

test('已有结果稿的失败运行重试只做审核，避免重复生成版本', async () => {
  const { store, source, task } = setup();
  try {
    store.updateTask(task.id, { plan: { topics: [{ id: 'topic_1', sourceRefs: [source.chunks[0].id] }], questions: [] } });
    let failReview = true;
    const workflow = createWorkflow(store, async request => {
      const context = JSON.parse(request.input[0].content);
      if (context.stage === 'draft') return toolResponse('deliver_draft', { ...draft, evidence: [{ claim: '程序测试', sourceRef: source.chunks[0].id }] });
      if (failReview) { failReview = false; throw new Error('审核阶段测试断线'); }
      return toolResponse('deliver_review', { verdict: '待人工确认', issues: [], facts: [] });
    });
    const failed = await terminal(store, workflow.start(task.id, { action: 'draft', topicId: 'topic_1' }).id);
    assert.equal(failed.status, 'failed'); assert.ok(failed.resultDraftId); assert.equal(failed.usageUnknown, true);
    const retried = await terminal(store, workflow.retry(failed.id).id);
    assert.equal(retried.action, 'review'); assert.equal(retried.status, 'completed');
    assert.equal(store.listDrafts().length, 1); assert.ok(store.getDraft(failed.resultDraftId).review);
  } finally { store.close(); }
});
