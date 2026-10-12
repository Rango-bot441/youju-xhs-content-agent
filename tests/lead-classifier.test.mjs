import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLead, validateLeadAnalysis, validateLeadHumanReview } from '../lib/lead-classifier.mjs';

const analysis = () => ({ region: '待确认', grade: '待确认', subject: '待确认', demand: '核对信息', intent: 'unclear', priority: 'low', missingFields: ['咨询细节'], suggestedReply: '请具体说明问题。', handoffSummary: '信息待补充', reasoning: '仅程序回归输入。' });
test('human correction validates only explicit editable fields and redacts sensitive values', () => {
  const result = validateLeadHumanReview({ region: '已核对地区', demand: '电话13812345678', missingFields: ['年级'] });
  assert.equal(result.region, '已核对地区'); assert.doesNotMatch(result.demand, /13812345678/); assert.equal('grade' in result, false);
  assert.throws(() => validateLeadHumanReview({ model: 'forged' }), /不允许/);
  assert.throws(() => validateLeadHumanReview({ intent: 'invented' }), /允许范围/);
  assert.throws(() => validateLeadHumanReview({ missingFields: 'not-array' }), /格式/);
  assert.doesNotMatch(validateLeadAnalysis({ ...analysis(), suggestedReply: '请联系13812345678' }).suggestedReply, /13812345678/);
});
test('classification forwards cancellation and redacts actual model inputs using an isolated function', async () => {
  let received;
  const controller = new AbortController();
  const result = await classifyLead({ rawText: '回归输入：13812345678', task: { brief: '联系13812345678' }, signal: controller.signal }, async options => {
    received = options;
    return { output: [{ type: 'function_call', name: 'deliver_lead_triage', arguments: JSON.stringify(analysis()) }], model: 'test-model', usage: { inputTokens: 2, outputTokens: 3 } };
  });
  assert.equal(received.signal, controller.signal); assert.doesNotMatch(received.input, /13812345678/); assert.equal(result.analysis.intent, 'unclear');
  assert.match(received.instructions, /不默认咨询者是家长/);
  assert.match(received.instructions, /学习或决策阶段/);
  assert.match(received.instructions, /不强迫追问/);
  controller.abort(new Error('cancelled'));
  await assert.rejects(classifyLead({ rawText: '回归输入', signal: controller.signal }, async () => { throw new Error('must not call'); }), /cancelled/);
});
