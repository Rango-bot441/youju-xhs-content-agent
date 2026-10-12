import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskOperation, submitRevision, submitExistingDraft } from '../public/task-actions.js';

test('revision target and constraints cannot move to another task across awaits', async () => {
  const ui = { taskId: 'A', draftId: 'draft-A', reviewRevision:'review-A', scope: { field: 'body', text: '原句' }, lockedFields: ['title'] };
  const operation = captureTaskOperation(ui);
  const calls = [];
  await submitRevision(async (path, payload) => {
    calls.push({ path, payload });
    ui.taskId = 'B'; ui.draftId = 'draft-B'; ui.reviewRevision='review-B'; ui.scope.field = 'cover'; ui.lockedFields.push('body');
  }, operation, '只改正文');
  assert.equal(calls[0].path, '/api/drafts/draft-A/feedback');
  assert.equal(calls[1].path, '/api/tasks/A/runs');
  assert.equal(calls[1].payload.draftId, 'draft-A');
  assert.deepEqual(calls[1].payload.scope, { field: 'body', text: '原句' });
  assert.deepEqual(calls[1].payload.lockedFields, ['title']);
  assert.equal(operation.reviewRevision, 'review-A');
});

test('task-local delivery does not create or edit a task', async () => {
  const calls = [];
  const result = await submitExistingDraft(async (path, payload) => { calls.push({ path, payload }); return { id: 'new-draft' }; }, { taskId: 'A', draft: { title: '交稿', body: '正文' } });
  assert.deepEqual(calls.map(call => call.path), ['/api/tasks/A/drafts']);
  assert.equal(result.taskId, 'A');
});

test('inbox delivery creates one independent task and then its draft', async () => {
  const calls = [];
  await submitExistingDraft(async path => { calls.push(path); return { id: calls.length === 1 ? 'new-task' : 'new-draft' }; }, { newTask: { title: '独立任务' }, draft: { title: '稿件' } });
  assert.deepEqual(calls, ['/api/tasks', '/api/tasks/new-task/drafts']);
});
