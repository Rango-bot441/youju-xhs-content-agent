import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDraft, locateQuote, normalizeReview, qualityReport, compareDrafts, redactSensitive } from '../lib/quality.mjs';

// Isolated software boundary inputs. Never seeded into the user's business workspace.
const draft = (body, extra = {}) => ({ id: 'd1', title: '', body, cover: '', pages: [], evidence: [], gaps: [], ...extra });
test('否定承诺不会误报，肯定和转折后的承诺仍被阻断', () => {
  for (const body of ['我们不保证涨粉。', '不承诺必爆。', '不要写“保证涨粉”。', '我们无法保证有效。', '不能保证录取。', '不承诺包过。']) assert.equal(inspectDraft(draft(body)).length, 0, body);
  for (const body of ['保证涨粉。', '不但保证涨粉，还必爆。', '不保证赚钱，但保证涨粉。', '报名一定成功。', '保证录取。', '考试包过。']) assert.ok(inspectDraft(draft(body)).some(i => i.blocking), body);
});
test('原句定位允许空白差异，拒绝不存在的引句', () => {
  const d = draft('第一句。\n第二句。');
  assert.deepEqual(locateQuote(d, '第一句。 第二句。'), { field: 'body', start: 0, end: 9 });
  assert.equal(locateQuote(d, '不存在的句子'), null);
  assert.equal(locateQuote(draft('', { pages: [{ heading: '核对', text: '阅读来源。' }] }), '阅读来源。').field, 'pages.0.text');
});
test('未定位到原稿的模型意见不能成为硬阻断', () => {
  const review = normalizeReview({ verdict: '需修改', issues: [{ severity: 'high', quote: '稿件没有的原句', reason: '测试', suggestion: '核对' }] }, draft('本篇原文。'));
  assert.equal(review.issues[0].blocking, false);
  assert.equal(review.issues[0].locationVerified, false);
});
test('真实sourceRef不能掩盖伪造sourceQuote', () => {
  const sources = [{ id: 's', chunks: [{ id: 's:p1', text: '来源只说有内容SOP。' }] }];
  const d = draft('流程保证涨粉。');
  const review = normalizeReview({ verdict: '通过', issues: [], facts: [{ claim: d.body, sourceRef: 's:p1', sourceQuote: '来源保证涨粉。', status: 'supported', reason: '' }] }, d, sources);
  assert.equal(review.facts[0].status, 'unsupported');
  assert.ok(review.issues.some(i => i.category === 'fact' && i.blocking));
});
test('有原文支持的事实保留引用验证，但不制造准确率', () => {
  const d = draft('有内容SOP。', { evidence: [{ claim: '有内容SOP。', sourceRef: 's:p1' }] });
  const sources = [{ id: 's', chunks: [{ id: 's:p1', text: '来源：有内容SOP。' }] }];
  d.review = { verdict: '已核对', issues: [], facts: [{ claim: d.body, sourceRef: 's:p1', sourceQuote: '有内容SOP。', status: 'supported', reason: '' }] };
  const quality = qualityReport(d, sources);
  assert.equal(quality.readiness, 'ready');
  assert.equal(quality.facts[0].quoteVerified, true);
  assert.equal(Object.hasOwn(quality, 'accuracy'), false);
});
test('重复规范化不改变问题ID，虚构冲突摘录不得保留conflicting结论', () => {
  const d = draft('原稿事实。');
  const sources = [{ id: 's', chunks: [{ id: 's:p1', text: '只有这一段原文。' }] }];
  const review = normalizeReview({ verdict: '核对', issues: [{ severity: 'high', quote: '不存在的原句', reason: '程序回归' }], facts: [{ claim: d.body, sourceRef: 's:p1', sourceQuote: '伪造原文', status: 'conflicting', reason: '程序回归' }] }, d, sources);
  assert.equal(review.facts[0].status, 'unsupported');
  const normalizedAgain = normalizeReview(review, d, sources);
  assert.deepEqual(normalizedAgain.issues.map(i => i.id), review.issues.map(i => i.id));
  assert.deepEqual(normalizedAgain.facts, review.facts);
});
test('对自我说明与免责声明式内容不制造无依据事实审核阻断', () => {
  const d = draft('以上是同行可试用的核对框架，不代表该项目当年已按此流程执行；表单、审核口径和节奏待本人确认。');
  const result = normalizeReview({ verdict: '需确认', issues: [], facts: [{ claim: '以上是同行可试用的核对框架，不代表该项目当年已按此流程执行；表单、审核口径和节奏待本人确认。', sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '属于稿件边界说明，不是项目事实。' }] }, d, []);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].status, 'unsupported');
  assert.equal(result.issues.some(item => item.category === 'fact' && item.blocking), false);
});
test('文章范围说明保留在事实核查记录中但不误报为unsupported事实', () => {
  const body = '本文仅解释该页面注释，不解读2026年报名安排。';
  const result = normalizeReview({ verdict: '范围清楚', issues: [], facts: [{ claim: body, sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '文章范围说明不是政策事实。' }] }, draft(body), []);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].status, 'unsupported');
  assert.equal(result.issues.length, 0);
});
test('范围免责声明识别限于文首范围句，不跳过同句中真实业务结论', () => {
  const claim = '本文不讨论报名规则；报名一定成功。';
  const result = normalizeReview({ verdict: '需核对', issues: [], facts: [{ claim, sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '包含无来源结论。' }] }, draft(claim), []);
  assert.equal(result.issues.some(item => item.category === 'fact' && item.blocking), true);
  assert.equal(result.facts[0].status, 'unsupported');
});
test('历史自述中被扩大转述的业务事实仍需阻断，但纯建议不当成业务事实', () => {
  const sources = [{ id: 's', chunks: [{ id: 's:p1', text: '第三步沉淀选题库、素材库和转化话术SOP。' }] }];
  const d = draft('公开项目自述提到，稳定供给依赖持续复盘机制。');
  const review = normalizeReview({ verdict: '待确认', issues: [], facts: [{ claim: d.body, sourceRef: 's:p1', sourceQuote: '第三步沉淀选题库、素材库和转化话术SOP。', status: 'unsupported', reason: '来源没有提到持续复盘机制。' }] }, d, sources);
  assert.ok(review.issues.some(item => item.category === 'fact' && item.blocking));
  const advice = draft('建议为交稿内容设置复盘检查点。');
  const suggestion = normalizeReview({ verdict: '建议', issues: [], facts: [{ claim: advice.body, sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '这是可以验证的现时建议，不是历史业绩。' }] }, advice, []);
  assert.equal(suggestion.issues.some(item => item.category === 'fact' && item.blocking), false);
});
test('版本链不算重复，其他稿件重合可以检出', () => {
  const body = '这是一段用于比较程序行为的文字。内容应当由独立来源支持，并保留版本。';
  const d = draft(body, { id: 'd2', parentId: 'd1' });
  const peers = [draft(body), draft(body, { id: 'd3' })];
  const report = qualityReport(d, [], peers);
  assert.deepEqual(report.duplicates.map(x => x.draftId), ['d3']);
});
test('人工处理保留意见与理由，不覆盖原稿或自动形成真人评测', () => {
  const d = draft('保证涨粉。', { review: { verdict: '需改', issues: [] } });
  const report = qualityReport(d);
  const decision = { id: 'feedback1', draftId: d.id, issueKey: report.issues[0].id, decision: 'dismissed', comment: '边界程序检查', createdAt: '2026-09-23' };
  const updated = qualityReport(d, [], [], [decision]);
  assert.equal(updated.issues[0].decision.comment, decision.comment);
  assert.equal(d.body, '保证涨粉。');
  assert.notEqual(updated.readiness, 'ready');
});
test('版本差异能还原两边的内容', () => {
  const before = draft('第一句。\n旧内容。'), after = draft('第一句。\n新内容。', { id: 'd2' });
  const change = compareDrafts(before, after).fields.find(f => f.field === 'body');
  assert.equal(change.diff.filter(d => d.type !== 'add').map(d => d.text).join(''), before.body);
  assert.equal(change.diff.filter(d => d.type !== 'remove').map(d => d.text).join(''), after.body);
  assert.equal(compareDrafts(before, before).fields.every(f => !f.changed), true);
});
test('模型输入脱敏不修改原始资料', () => {
  const original = 'test@example.com 138-1234-5678 sk-abcdefgh123456 保留普通内容';
  const clean = redactSensitive(original);
  assert(!clean.includes('test@example.com')); assert(!clean.includes('138')); assert(!clean.includes('abcdefgh'));
  assert(clean.includes('保留普通内容')); assert(original.includes('test@example.com'));
});

test('凭据是不可人工豁免的硬阻断，标签同样受检', () => {
  for (const extra of [{ body: 'api_key=abcdefgh123456' }, { tags: ['sk-abcdefgh123456'] }]) {
    const d = draft('安全正文', { ...extra, review: { issues: [], facts: [] } });
    const initial = qualityReport(d);
    assert.equal(initial.exportSafety.hasCredentials, true);
    const safetyIssue = initial.issues.find(item => item.nonDismissible);
    assert.ok(safetyIssue?.blocking);
    assert.doesNotMatch(JSON.stringify(safetyIssue), /abcdefgh123456/);
    const decided = qualityReport(d, [], [], [{ draftId: d.id, issueKey: safetyIssue.id, decision: 'dismissed', comment: '程序隔离测试', createdAt: '2026-09-30' }]);
    assert.equal(decided.readiness, 'blocked');
  }
  const contact = qualityReport(draft('咨询 test@example.com 或 13812345678', { review: { issues: [], facts: [] } }));
  assert.equal(contact.exportSafety.hasCredentials, false);
  assert.equal(contact.exportSafety.hasContactDetails, true);
});

test('上下文过期有明确审核状态，旧轮次处理意见不解除新问题', () => {
  const d = draft('保证涨粉。', { review: { issues: [], facts: [] }, reviewRevision: 'current-review' });
  const before = qualityReport(d);
  const oldDecision = { draftId: d.id, issueKey: before.issues[0].id, reviewRevision: 'old-review', decision: 'dismissed' };
  assert.equal(qualityReport(d, [], [], [oldDecision]).readiness, 'blocked');
  const stale = qualityReport({ ...d, reviewStale: true, reviewStaleReason: '任务要求已更新' });
  assert.equal(stale.readiness, 'stale');
  assert.match(stale.checks.find(item => item.id === 'review').detail, /任务要求已更新/);
});

test('无引用事实也阻断，人工处理不把未支持事实变为绿灯', () => {
  const d = draft('课程已覆盖全国所有学校。');
  d.review = { verdict: '通过', issues: [], facts: [{ claim: d.body, sourceRef: '', sourceQuote: '', status: 'unsupported', reason: '没有证明材料。' }] };
  const report = qualityReport(d);
  assert.equal(report.readiness, 'blocked');
  const decisions = report.issues.map(i => ({ draftId: d.id, issueKey: i.id, decision: 'dismissed', comment: '隔离测试', createdAt: '2026-09-24' }));
  const handled = qualityReport(d, [], [], decisions);
  assert.equal(handled.readiness, 'needs_confirmation');
  assert.equal(handled.checks.find(c => c.id === 'facts').status, 'warn');
});

test('纯建议与范围说明不计为已核实事实，混合句不能整体豁免', () => {
  for (const claim of ['建议为交稿内容设置复盘检查点。', '本文仅解释该页面注释。']) {
    const d = draft(claim, { review: { verdict: '通过', issues: [], facts: [{ claim, status: 'unsupported' }] } });
    const report = qualityReport(d);
    assert.equal(report.checks.find(c => c.id === 'facts').status, 'warn');
    assert.equal(report.readiness, 'needs_confirmation');
  }
  for (const claim of ['本文不讨论报名规则，但是本区全年均可报名。', '建议为交稿内容设置检查点，项目业绩增加三倍。']) {
    const review = normalizeReview({ facts: [{ claim, status: 'unsupported' }] }, draft(claim));
    assert.ok(review.issues.some(i => i.category === 'fact' && i.blocking), claim);
  }
});

test('通用方法稿中的边界提醒不触发事实阻断，具体政策断言仍阻断', () => {
  const safe = '准备强基计划，可以先梳理孩子的年级、学科基础、兴趣方向和时间安排。具体报名条件与时间以当年度官方信息为准。';
  const safeReview = normalizeReview({ facts: [{ claim: safe, status: 'unsupported', reason: '通用准备建议与范围提醒，不是具体政策事实。' }] }, draft(safe));
  assert.equal(safeReview.issues.some(item => item.category === 'fact' && item.blocking), false);

  const unsafe = '2026年强基计划统一在3月报名，所有高校都按同一套校测规则执行。';
  const unsafeReview = normalizeReview({ facts: [{ claim: unsafe, status: 'unsupported', reason: '没有提供当年度官方依据。' }] }, draft(unsafe));
  assert.ok(unsafeReview.issues.some(item => item.category === 'fact' && item.blocking));
});

test('时效提醒只检查实际引用，不抹去历史资料的原文支持', () => {
  const d = draft('历史资料记载有内容SOP。', { review: { verdict: '核对', issues: [], facts: [{ claim: '历史资料记载有内容SOP。', sourceRef: 's:p1', sourceQuote: '有内容SOP。', status: 'supported' }] } });
  const sources = [{ id: 's', title: '历史资料', effectiveUntil: '2000-01-01', verificationStatus: 'needs_update', chunks: [{ id: 's:p1', text: '有内容SOP。' }] }, { id: 'unused', verificationStatus: 'unverified', chunks: [{ id: 'unused:p1', text: '未引用内容' }] }];
  const report = qualityReport(d, sources);
  assert.equal(report.facts[0].status, 'supported');
  assert.equal(report.readiness, 'needs_confirmation');
  assert.equal(report.sourceWarnings.length, 1);
  assert.equal(report.sourceWarnings[0].sourceId, 's');
  assert.match(report.checks.find(c => c.id === 'source_currency').detail, /历史材料/);
});

test('已标记演示的资料即使人工标为核验也不变成真实业务依据', () => {
  const d = draft('隔离测试原句。', { evidence: [{ claim: '隔离测试原句。', sourceRef: 's:p1' }], review: { issues: [], facts: [{ claim: '隔离测试原句。', sourceRef: 's:p1', sourceQuote: '隔离测试原句。', status: 'supported' }] } });
  for (const demo of [{ isDemo: true }, { title: '演示资料·历史存储兼容' }]) {
    const result = qualityReport(d, [{ id: 's', verificationStatus: 'verified', chunks: [{ id: 's:p1', text: '隔离测试原句。' }], ...demo }]);
    assert.equal(result.readiness, 'needs_confirmation');
    assert.match(result.sourceWarnings[0].reasons.join(''), /演示资料/);
  }
});
