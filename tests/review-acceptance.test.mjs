import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../lib/store.mjs';
import { createWorkflow } from '../lib/workflow.mjs';
import { createApp } from '../server.mjs';

// Cross-module protocol fixtures only: no user database, external provider or business outcome.
async function setup(t) {
  const store = createStore(':memory:');
  const source = store.addSource({ title: '隔离验收依据', text: '这份软件说明包含三项检查。', verificationStatus: 'verified' });
  let conflicting = false;
  const workflow = createWorkflow(store, async () => ({
    model: 'isolated-protocol-fixture', usage: { inputTokens: 1, outputTokens: 1 },
    output: [{ type: 'function_call', call_id: 'isolated_review', name: 'deliver_review', arguments: JSON.stringify({
      verdict: conflicting ? '有冲突' : '已识别事实匹配', issues: [], facts: [{
        claim: source.text, sourceRef: source.chunks[0].id, sourceQuote: source.text,
        status: conflicting ? 'conflicting' : 'supported', reason: '隔离协议验收，不是真实模型判断。',
      }],
    }) }],
  }));
  const app = createApp({ store, workflow, providerInfo: async () => ({ ready: false }), evaluationsDir: '/nonexistent-review-acceptance-reports' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const review = async (taskId, draftId) => {
    const result = await request(`/api/tasks/${taskId}/runs`, { action: 'review', draftId });
    assert.equal(result.status, 202, JSON.stringify(result.data));
    for (let i = 0; i < 200; i++) {
      const run = store.getRun(result.data.id);
      if (['completed', 'failed'].includes(run.status)) { assert.equal(run.status, 'completed', run.error); return; }
      await delay(5);
    }
    throw new Error('Isolated review did not terminate');
  };
  return { store, source, request, review, setConflicting: () => { conflicting = true; } };
}

test('HTTP journey keeps account, author collaboration and imported draft in one task; context edits expire acceptance', async t => {
  const { store, source, request, review } = await setup(t);
  const task = (await request('/api/tasks', { title: '隔离完整路径', brief: '核对软件说明', sourceIds: [source.id] })).data;
  const author = (await request('/api/collaborators', { name: '隔离测试角色' })).data;
  const collaboration = (await request('/api/collaborations', { taskId: task.id, collaboratorId: author.id })).data;
  const draft = (await request(`/api/tasks/${task.id}/drafts`, { title: '说明检查', body: source.text })).data;
  const account = (await request('/api/accounts', { name: '隔离规划档案', identity: 'planning' })).data;
  const linked = await request(`/api/tasks/${task.id}`, { accountId: account.id, brief: '检查当前版本的软件说明' });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.getCollaboration(collaboration.id).taskId, draft.taskId);
  await review(task.id, draft.id);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', comment: '隔离程序验收', expectedReviewRevision: store.getDraft(draft.id).reviewRevision })).status, 201);
  assert.equal((await request(`/api/tasks/${task.id}/messages`, { text: '说明已变更，请重新核验。' })).status, 201);
  const state = (await request('/api/state')).data;
  assert.equal(state.drafts.find(item => item.id === draft.id).reviewStale, true);
  assert.equal(state.quality[draft.id].readiness, 'stale');
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision: store.getDraft(draft.id).reviewRevision })).status, 409);
  assert.equal((await request(`/api/tasks/${task.id}`, { status: 'delivered' })).status, 400);
  await review(task.id, draft.id);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', comment: '重新确认当前上下文', expectedReviewRevision: store.getDraft(draft.id).reviewRevision })).status, 201);
  assert.equal((await request(`/api/tasks/${task.id}`, { status: 'delivered' })).status, 200);
  assert.equal(store.getState().feedback.length, 2);
});

test('HTTP re-review cannot leave accepted label or reuse old human issue decisions', async t => {
  const { store, source, request, review, setConflicting } = await setup(t);
  const task = (await request('/api/tasks', { brief: '隔离复审路径', sourceIds: [source.id] })).data;
  const draft = (await request(`/api/tasks/${task.id}/drafts`, { title: '说明检查', body: source.text })).data;
  await review(task.id, draft.id);
  const oldRevision = store.getDraft(draft.id).reviewRevision;
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision: oldRevision })).status, 201);
  setConflicting(); await review(task.id, draft.id);
  let quality = (await request(`/api/drafts/${draft.id}/quality`)).data;
  assert.equal(quality.readiness, 'blocked');
  assert.notEqual(store.getDraft(draft.id).status, 'accepted');
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision: oldRevision })).status, 409);
  const issue = quality.issues.find(item => item.blocking);
  assert.ok(issue);
  assert.equal((await request(`/api/drafts/${draft.id}/issues`, { issueKey: issue.id, decision: 'dismissed', comment: '仅用于验证旧决定不能覆盖下一轮审核', expectedReviewRevision: store.getDraft(draft.id).reviewRevision })).status, 201);
  await review(task.id, draft.id);
  quality = (await request(`/api/drafts/${draft.id}/quality`)).data;
  assert.equal(quality.readiness, 'blocked');
  assert.equal(quality.issues.find(item => item.id === issue.id).decision, null);
  assert.equal((await request(`/api/drafts/${draft.id}/feedback`, { decision: 'accepted', expectedReviewRevision: store.getDraft(draft.id).reviewRevision })).status, 400);
});
