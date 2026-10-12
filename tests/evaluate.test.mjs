import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReport, summarizeRun, summarizeQuality } from '../scripts/evaluate.mjs';
import { qualityReport } from '../lib/quality.mjs';

test('evaluation rejects empty samples rather than creating business examples', () => {
  assert.throws(() => makeReport({ drafts: [] }), /没有符合条件/);
});
test('evaluation separates machine checks from uncollected human evidence', () => {
  const state = { drafts: [{ id: 'draft_protocol', taskId: 'task_protocol', title: '协议验证', body: '软件回归输入', version: 1 }], tasks: [{ id: 'task_protocol', brief: '软件测试', sourceIds: [] }], sources: [], runs: [] };
  const report = makeReport(state);
  assert.equal(report.sampleCount, 1);
  assert.equal(report.human.status, 'not_collected');
  assert.deepEqual(report.human.ratings, []);
  assert.equal(report.drafts[0].run, null);
  assert.equal(report.drafts[0].automatic.readiness, 'unreviewed');
  assert.match(report.limitations.join(''), /不能计算准确率/);
});
test('failed request accounting preserves unknown usage', () => {
  const summary = summarizeRun({ id: 'run_protocol', createdAt: '2026-09-23T00:00:00Z', finishedAt: '2026-09-23T00:00:02Z', events: [{ kind: 'model', status: 'completed' }], usage: { inputTokens: 9, outputTokens: 3 }, usageUnknown: true, failedRequests: 1 });
  assert.equal(summary.durationMs, 2000); assert.equal(summary.requests, 2); assert.equal(summary.successfulRequests, 1); assert.equal(summary.usageUnknown, true); assert.equal(summary.failedRequests, 1);
});

test('evaluation applies issue decisions without rewriting original issue counts or human ratings', () => {
  const draft = { id: 'draft_decision', taskId: 'task_decision', title: '规则回归', body: '保证涨粉', pages: [], evidence: [], gaps: [], review: { verdict: '需要核对', issues: [], facts: [] } };
  const raw = qualityReport(draft, [], [], []);
  const decision = { id: 'decision_1', draftId: draft.id, issueKey: raw.issues.find(issue => issue.blocking).id, decision: 'dismissed', comment: '仅程序回归处理记录，不是真实内容效果。', createdAt: '2026-09-23T00:00:00Z' };
  const state = { drafts: [draft], tasks: [{ id: draft.taskId, sourceIds: [], brief: '规则回归' }], sources: [], runs: [], issueDecisions: [decision] };
  const report = makeReport(state);
  const automatic = report.drafts[0].automatic;
  assert.equal(automatic.blockingIssueCount, 0); assert.equal(automatic.totalBlockingIssueCount, 1); assert.equal(automatic.handledIssueCount, 1);
  assert.equal(automatic.issueCount, automatic.totalIssueCount - automatic.handledIssueCount);
  assert.equal(automatic.readiness, qualityReport(draft, [], [], [decision]).readiness);
  assert.equal(report.human.status, 'not_collected'); assert.deepEqual(report.human.ratings, []);
  assert.equal(summarizeQuality(draft, [], [], []).blockingIssueCount, 1);
});

test('execution summary counts observed attempts and does not include traces or input snapshots', () => {
  const run = { id: 'run_attempts', events: [{ kind: 'model', status: 'running' }, { kind: 'model', status: 'completed' }, { kind: 'model', status: 'running' }], failedRequests: 1, trace: [{ input: 'not for summary' }], contextSnapshot: { raw: 'not for summary' } };
  const result = summarizeRun(run); assert.equal(result.requests, 2); assert.equal(result.successfulRequests, 1);
  assert.equal('trace' in result, false); assert.equal('contextSnapshot' in result, false);
});
