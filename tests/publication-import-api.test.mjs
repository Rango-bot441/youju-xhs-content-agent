import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createPublicationImportHandler } from '../lib/publication-import-api.mjs';

// Only isolated in-memory validation fixtures; never examples of business results.
function setup(t) {
  const store = createStore(':memory:'); t.after(() => store.close());
  const task = store.addTask({ brief: '隔离程序验收', title: '隔离验收任务' });
  const draft = store.addDraft({ taskId: task.id, body: '验收用文本', origin: 'imported' });
  const header = 'taskId,draftId,platform,url,trafficType,observedAt,dataSource,metricDefinition,impressions,clicks,spend';
  const line = (overrides = {}) => {
    const value = { taskId: task.id, draftId: draft.id, platform: '小红书', url: 'https://example.com/test-only', trafficType: 'paid', observedAt: '2026-09-20', dataSource: '隔离验收文件', metricDefinition: '隔离计数口径', impressions: '10', clicks: '2', spend: '', ...overrides };
    return header.split(',').map(key => value[key]).join(',');
  };
  return { store, task, draft, handler: createPublicationImportHandler(store), csv: (overrides) => `${header}\n${line(overrides)}`, header, line };
}

test('publication import preview is read-only, commit preserves unknown and duplicate replay skips', t => {
  const { store, task, handler, csv } = setup(t);
  const source = csv(); const before = store.getRevision(); const preview = handler.preview(source);
  assert.equal(preview.valid, true, JSON.stringify(preview.errors));
  assert.equal(store.getRevision(), before); assert.equal(store.getTask(task.id).publication, null);
  assert.deepEqual(handler.commit({ csv: source, token: preview.token }), { imported: 1, skipped: 0 });
  assert.equal(store.getTask(task.id).publication.metrics.spend, null);
  const again = handler.preview(source); assert.equal(again.valid, true, JSON.stringify(again.errors));
  assert.deepEqual(handler.commit({ csv: source, token: again.token }), { imported: 0, skipped: 1 });
});

test('invalid cross-task drafts and one invalid row prevent all import writes', t => {
  const { store, task, handler, header, line } = setup(t);
  const second = store.addTask({ brief: '另一隔离任务' });
  const source = `${header}\n${line()}\n${line({ taskId: second.id })}`;
  const preview = handler.preview(source); assert.equal(preview.valid, false);
  assert.throws(() => handler.commit({ csv: source, token: preview.token }), /未通过/);
  assert.equal(store.getTask(task.id).publication, null); assert.equal(store.getTask(second.id).publication, null);
});

test('preview confirmation rejects changed workspace and changed CSV', t => {
  const { store, task, handler, csv } = setup(t);
  const source = csv(); const preview = handler.preview(source);
  assert.throws(() => handler.commit({ csv: csv({ clicks: '3' }), token: preview.token }), /重新预览/);
  store.updateTask(task.id, { title: '工作区已修改' });
  assert.throws(() => handler.commit({ csv: source, token: preview.token }), /重新预览/);
});

test('corrected current observation wins over erroneous history when deduplicating imports', t => {
  const { store, task, handler, csv } = setup(t);
  const original = csv(); handler.commit({ csv: original, token: handler.preview(original).token });
  const publication = store.getTask(task.id).publication;
  store.updateTask(task.id, { publication: { ...publication, metrics: { ...publication.metrics, clicks: 3 } } });
  assert.equal(handler.preview(csv({ clicks: '3' })).rows[0].status, 'duplicate');
  assert.equal(handler.preview(original).valid, false);
});

test('later observations preserve previous snapshots; older dates and different links cannot replace current data', t => {
  const { store, task, handler, csv } = setup(t);
  const first = csv(); handler.commit({ csv: first, token: handler.preview(first).token });
  const later = csv({ observedAt: '2026-09-21', clicks: '3' });
  assert.equal(handler.preview(later).valid, true);
  handler.commit({ csv: later, token: handler.preview(later).token });
  assert.equal(store.getTask(task.id).publicationHistory.length, 1);
  assert.equal(handler.preview(csv({ observedAt: '2026-09-19' })).valid, false);
  assert.equal(handler.preview(csv({ observedAt: '2026-09-22', url: 'https://example.com/other' })).valid, false);
});

test('HTTP template and preview/confirmation endpoints use real isolated store validation', async t => {
  const { store, csv } = setup(t);
  const app = createApp({ store, providerInfo: async () => ({ ready: false }), workflow: { activeCount: 0, shutdown() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, value) => fetch(`${origin}/api/publications/import/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const template = await fetch(`${origin}/api/publications/import/template.csv`);
  assert.equal(template.status, 200); assert.match(template.headers.get('content-type'), /csv/);
  const response = await post('preview', { csv: csv() }); assert.equal(response.status, 200);
  const preview = await response.json(); assert.equal(preview.valid, true, JSON.stringify(preview.errors));
  const commit = await post('commit', { csv: csv(), token: preview.token }); assert.equal(commit.status, 201);
  assert.equal((await commit.json()).imported, 1);
});
