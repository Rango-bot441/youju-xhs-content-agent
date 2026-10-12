import { createHash } from 'node:crypto';
import { redactSensitive, inspectExportSafety } from '../public/export-safety.js';
export { redactSensitive } from '../public/export-safety.js';

export const QUALITY_VERSION = 'content-quality-2.4';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 14);
const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fields = draft => [
  { field: 'title', text: draft.title || '' }, { field: 'body', text: draft.body || '' }, { field: 'cover', text: draft.cover || '' },
  ...(draft.pages || []).flatMap((page, index) => [{ field: `pages.${index}.heading`, text: page.heading || '' }, { field: `pages.${index}.text`, text: page.text || '' }]),
  ...(draft.tags || []).map((text, index) => ({ field: `tags.${index}`, text: String(text) })),
];
const issueId = issue => `issue_${hash([issue.category || 'expression', issue.field || '', issue.quote || '', issue.sourceRef || ''].join('|'))}`;
function issue(value) { return { id: issueId(value), category: 'expression', field: '', sourceRef: '', blocking: false, locationVerified: false, ...value }; }

export function locateQuote(draft, quote, preferredField = '') {
  if (!tidy(quote)) return null;
  const candidates = fields(draft).sort((a, b) => Number(b.field === preferredField) - Number(a.field === preferredField));
  for (const { field, text } of candidates) {
    const index = text.indexOf(quote);
    if (index >= 0) return { field, start: index, end: index + quote.length };
    // Whitespace-only differences are allowed; preserve offsets into the original text.
    const offsets = []; let compact = '';
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { compact += text[i]; offsets.push(i); }
    const needle = String(quote).replace(/\s/g, '');
    const normalizedIndex = compact.indexOf(needle);
    if (needle && normalizedIndex >= 0) return { field, start: offsets[normalizedIndex], end: offsets[normalizedIndex + needle.length - 1] + 1 };
  }
  return null;
}

function isNegated(text, index) {
  const preceding = text.slice(Math.max(0, index - 24), index).split(/[。！？；;\n]/).at(-1);
  return /(?:不|未|没|无法|不能|不会|不应|不可|切勿|拒绝|避免|禁止|警惕|不承诺|不要(?:写|说|宣称)?)[“"「『]?\s*$/.test(preceding)
    || /(?:不要|禁止|避免|不能|不应).{0,8}(?:写|用|说|承诺|宣称).{0,3}$/.test(preceding);
}

export function inspectDraft(draft) {
  const issues = [];
  for (const { field, text } of fields(draft)) {
    const promises = /(?:保证|必然|一定|百分百|100[%％]).{0,10}?(?:涨粉|爆款|有效|赚钱|提升|转化|成功|录取|入学|通过|上岸)|必火|必爆|包录取|包过/g;
    for (const match of text.matchAll(promises)) {
      if (isNegated(text, match.index)) continue;
      issues.push(issue({ category: 'expression', field, severity: 'high', quote: match[0], reason: '出现确定性的效果承诺，需要可核验依据并人工判断适用性。', suggestion: '删除必然效果承诺，改为已证实事实或可检验目标。', blocking: true, locationVerified: true, location: { field, start: match.index, end: match.index + match[0].length } }));
    }
    const safety = inspectExportSafety(text);
    if (safety.hasCredentials) issues.push(issue({ category: 'material', field, severity: 'high', quote: '检测到疑似访问凭据', reason: '凭据不得出现在交付物中，此问题不能通过人工忽略解除。', suggestion: '编辑新版本移除凭据，然后重新审核。', blocking: true, nonDismissible: true }));
    if (safety.hasContactDetails) issues.push(issue({ category: 'material', field, severity: 'medium', quote: '检测到联系方式', reason: '文案、证据包、图文及文件名导出时会默认隐藏邮箱与手机，原始稿件不修改。', suggestion: '检查脱敏后的交付版本是否仍然通顺。', blocking: false }));
  }
  if (inspectExportSafety(draft).hasCredentials && !issues.some(item => item.nonDismissible)) issues.push(issue({ category: 'material', severity: 'high', quote: '附加内容中检测到疑似访问凭据', reason: '稿件附加内容存在疑似凭据，不能采纳或对外交付。', suggestion: '移除凭据后重新审核。', blocking: true, nonDismissible: true }));
  if ((draft.gaps || []).length) issues.push(issue({ category: 'material', severity: 'medium', quote: '素材缺口', reason: draft.gaps.join('；'), suggestion: '补充实际需要的材料，或移除依赖缺失材料的内容；建议框架可保留明确的适用边界。', blocking: false }));
  return [...new Map(issues.map(item => [item.id, item])).values()];
}

export function normalizeReview(review, draft, sources = []) {
  const refs = new Map(sources.flatMap(source => (source.chunks || []).map(chunk => [chunk.id, { ...chunk, source }])));
  const result = { ...review, verdict: String(review?.verdict || '待人工确认'), issues: [], facts: [], qualityVersion: QUALITY_VERSION };
  for (const original of review?.issues || []) {
    if (original.category === 'fact' && isNonFactualStatement(original.quote)) continue;
    const location = locateQuote(draft, original.quote, original.field);
    const category = ['fact', 'fit', 'expression', 'material'].includes(original.category) ? original.category : 'expression';
    const sourceRef = refs.has(original.sourceRef) ? original.sourceRef : '';
    // A model-invented quotation must never create a hard publication block.
    const severity = original.severity === 'high' && !location ? 'medium' : ['high', 'medium', 'low'].includes(original.severity) ? original.severity : 'medium';
    const locationNote = '（未定位到原稿原句，须先人工核对该意见。）';
    const reason = String(original.reason || '');
    const normalized = issue({ ...original, category, sourceRef, field: location?.field || original.field || '', severity, location, locationVerified: Boolean(location), blocking: Boolean(location && severity === 'high'), reason: reason + (!location && original.quote !== '素材缺口' && !reason.includes(locationNote) ? locationNote : '') });
    normalized.id = issueId(normalized);
    result.issues.push(normalized);
  }
  for (const original of review?.facts || []) {
    const source = refs.get(original.sourceRef);
    const claim = String(original.claim || '').trim();
    if (!claim) continue;
    const sourceQuote = String(original.sourceQuote || '').trim();
    const quoteVerified = Boolean(source && sourceQuote && tidy(source.text).includes(tidy(sourceQuote)));
    const location = locateQuote(draft, claim);
    if (!location) continue;
    let status = ['supported', 'unsupported', 'conflicting'].includes(original.status) ? original.status : 'unsupported';
    if (['supported', 'conflicting'].includes(status) && !quoteVerified || !location) status = 'unsupported';
    const fact = { ...original, claim, sourceRef: source ? original.sourceRef : '', sourceQuote, status, quoteVerified, location, claimLocated: Boolean(location), reason: String(original.reason || '') + (['supported', 'conflicting'].includes(original.status) && !quoteVerified ? ' 引用原句未在指定资料中找到，系统未接受该来源判断。' : '') };
    result.facts.push(fact);
    if (isNonFactualStatement(claim) || isGeneralAdviceOrBoundary(claim)) continue;
    if (status === 'conflicting' || status === 'unsupported') {
      result.issues.push(issue({ category: 'fact', field: location?.field || '', severity: location ? 'high' : 'medium', quote: claim, sourceRef: fact.sourceRef, reason: fact.reason || '现有资料不能支持这条事实表达。', suggestion: '补充能直接支持该事实的材料，或删除/缩小这一事实表述。', blocking: Boolean(location), locationVerified: Boolean(location), location }));
    }
  }
  for (const ruleIssue of inspectDraft(draft)) result.issues.push(ruleIssue);
  result.issues = [...new Map(result.issues.map(item => [item.id, item])).values()];
  if (result.issues.some(item => item.blocking)) result.verdict = '存在需修改问题';
  return result;
}

export function isNonFactualStatement(claim) {
  const text = tidy(claim);
  if (!text || text.length > 260) return false;
  // Exempt only a whole scope/advice statement. A leading disclaimer must not
  // hide a factual assertion later in the same model-returned claim.
  const clauses = text.split(/[，,；;。！？!?]|(?:但是|但|然而|因此|所以)/).map(tidy).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause =>
    /^(?:(?:本文|本篇|以上内容|这篇内容)\s*)?(?:不讨论|不解读|不涉及|不回答|不提供|不据此|仅讨论|仅解释|只讨论|只解释|不构成|不代表)/.test(clause)
    || /^(?:建议|可以尝试|可考虑)(?:为|将|先|再|把|补充|核对|检查|设置|保留|记录|整理|向|与|在)/.test(clause)
    || /^以上是.{0,30}(?:可试用|建议|待验证).{0,30}(?:框架|建议|方法)$/.test(clause)
    || /^.{1,45}待(?:本人|人工|进一步|资料)?(?:确认|核实|补充)$/.test(clause));
}

function isGeneralAdviceOrBoundary(claim) {
  const text = tidy(claim);
  if (!text || text.length > 320) return false;
  if (/准备[^。！？!?]{0,80}(?:可以|建议|先|再|梳理|整理|明确|检查)/.test(text) && /以当年度官方信息为准/.test(text)) return true;
  const clauses = text.split(/[，,；;。！？!?]|(?:但是|但|然而|因此|所以)/).map(tidy).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause =>
    /^(?:建议|可以尝试|可考虑)(?:为|将|先|再|把|补充|核对|检查|设置|保留|记录|整理|向|与|在)/.test(clause)
    || /^(?:具体|相关|最终|当前)?(?:报名条件|报名时间|录取规则|政策要求|适用范围|官方信息|招生简章).{0,20}(?:以|请以).{0,20}(?:为准|核对|确认)$/.test(clause)
    || /^(?:(?:本文|本篇|以上内容|这篇内容)\s*)?(?:不讨论|不解读|不涉及|不回答|不提供|不据此|仅讨论|仅解释|只讨论|只解释|不构成|不代表)/.test(clause)
  );
}

function grams(text) {
  const value = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const result = new Set();
  for (let i = 0; i < value.length - 2; i++) result.add(value.slice(i, i + 3));
  return result;
}
function similarity(a, b) {
  if (a.size < 10 || b.size < 10) return 0;
  let intersection = 0;
  for (const part of a) if (b.has(part)) intersection++;
  return 2 * intersection / (a.size + b.size);
}

export function qualityReport(draft, sources = [], peers = [], decisions = []) {
  const review = draft.review ? normalizeReview(draft.review, draft, sources) : null;
  const exportSafety = inspectExportSafety(draft);
  const issues = review?.issues || inspectDraft(draft);
  const draftDecisions = decisions.filter(value => value.draftId === draft.id && (!draft.reviewRevision || value.reviewRevision === draft.reviewRevision));
  const dedupedDecisions = new Map();
  for (const decision of draftDecisions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) dedupedDecisions.set(decision.issueKey, decision);
  const resolvedIssues = issues.map(item => ({ ...item, decision: dedupedDecisions.get(item.id) || null }));
  const openBlocking = resolvedIssues.filter(item => item.blocking && (item.nonDismissible || !item.decision));
  const openWarnings = resolvedIssues.filter(item => item.severity !== 'low' && !item.decision);
  const refs = new Set(sources.flatMap(source => (source.chunks || []).map(chunk => chunk.id)));
  const evidence = draft.evidence || [];
  const missingRefs = evidence.filter(item => !refs.has(item.sourceRef));
  const bodyGrams = grams(`${draft.title}\n${draft.body}`);
  const lineage = new Set([draft.id]);
  let parentId = draft.parentId;
  while (parentId && !lineage.has(parentId)) { lineage.add(parentId); parentId = peers.find(peer => peer.id === parentId)?.parentId; }
  const sameFamily = peer => {
    if (lineage.has(peer.id)) return true;
    let candidate = peer; const seen = new Set();
    while (candidate?.parentId && !seen.has(candidate.id)) { seen.add(candidate.id); if (lineage.has(candidate.parentId)) return true; candidate = peers.find(item => item.id === candidate.parentId); }
    return false;
  };
  const duplicates = peers.filter(peer => peer.id !== draft.id && !sameFamily(peer)).map(peer => ({ draftId: peer.id, title: peer.title, accountId: peer.accountId || null, similarity: Math.round(similarity(bodyGrams, grams(`${peer.title}\n${peer.body}`)) * 100), excerpt: (peer.body || '').slice(0, 120) })).filter(item => item.similarity >= 55).sort((a, b) => b.similarity - a.similarity).slice(0, 8);
  const factIssues = resolvedIssues.filter(item => item.category === 'fact' && !item.decision);
  const checkedFacts = (review?.facts || []).filter(fact => !isNonFactualStatement(fact.claim));
  const supportedFacts = checkedFacts.filter(fact => fact.status === 'supported' && fact.quoteVerified);
  const uncertainFacts = checkedFacts.length - supportedFacts.length;
  const usedRefs = new Set([...evidence.map(item => item.sourceRef), ...(review?.facts || []).map(item => item.sourceRef)].filter(Boolean));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const sourceWarnings = sources.filter(source => (source.chunks || []).some(chunk => usedRefs.has(chunk.id))).flatMap(source => {
    const reasons = [];
    if (source.effectiveUntil && source.effectiveUntil.slice(0, 10) < today) reasons.push('已超过台账有效期');
    if (source.verificationStatus === 'needs_update') reasons.push('已标记待更新');
    else if (source.verificationStatus === 'unverified') reasons.push('尚未人工核验');
    if (source.archived) reasons.push('已归档');
    if (source.isDemo === true || /演示资料|虚构练习|虚构演示/.test(`${source.title || ''} ${source.note || ''}`)) reasons.push('演示资料，不作为真实业务事实或对外发布依据');
    return reasons.length ? [{ sourceId: source.id, title: source.title || source.id, reasons }] : [];
  });
  const checks = [
    { id: 'review', label: '审核状态', status: draft.reviewStale ? 'fail' : review ? 'pass' : 'warn', detail: draft.reviewStale ? `原审核已过期：${draft.reviewStaleReason || '任务、账号或资料发生变化'}。重新审核后才能采纳或交付。` : review ? '已完成模型审核，仍由人工决定交付。' : '尚未完成审核；人工修改后的新版本需要重新核对。' },
    { id: 'export_safety', label: '交付安全', status: exportSafety.hasCredentials ? 'fail' : exportSafety.hasContactDetails ? 'warn' : 'pass', detail: '疑似访问凭据硬拦截；邮箱与手机在所有导出格式和文件名中默认隐藏，源稿不修改。此规则检查不等于完整隐私审计。' },
    { id: 'references', label: '来源引用', status: missingRefs.length ? 'fail' : evidence.length ? 'pass' : 'warn', detail: missingRefs.length ? `${missingRefs.length} 条引用无法定位。` : evidence.length ? `${evidence.length} 条引用存在；是否支持事实另行核查。` : '尚未绑定逐条依据。外部交稿可先审查再补充。' },
    { id: 'facts', label: '已识别事实支持核对', status: factIssues.length ? 'fail' : supportedFacts.length && !uncertainFacts ? 'pass' : 'warn', detail: checkedFacts.length ? `核对已识别的 ${checkedFacts.length} 条事实，其中 ${supportedFacts.length} 条有可定位的支持摘录、${uncertainFacts} 条仍缺支持或存在冲突。模型可能漏识别，不能据此认定全文已核验；人工处理意见不改变来源支持结论。` : '尚无已识别的外部事实支持结果；不是全文无事实风险。范围说明与建议不计为已核实事实。' },
    { id: 'source_currency', label: '来源时效与核验', status: sourceWarnings.length || !usedRefs.size ? 'warn' : 'pass', detail: sourceWarnings.length ? sourceWarnings.map(item => `${item.title}：${item.reasons.join('、')}`).join('；') + '。历史材料可用于历史说明，不能自动套用为当前规则。' : usedRefs.size ? '引用资料未发现台账时效警告；仍需核对正文适用地区、时间与人群。' : '尚无可核对时效的引用。' },
    { id: 'promises', label: '效果承诺', status: resolvedIssues.some(i => i.category === 'expression' && i.blocking && !i.decision) ? 'fail' : 'pass', detail: '程序检查确定性承诺及常见否定表达；不是平台合规认证。' },
    { id: 'materials', label: '素材完整性', status: (draft.gaps || []).length ? 'warn' : 'pass', detail: (draft.gaps || []).length ? `${draft.gaps.length} 项素材边界需确认。` : '未标记资料缺口，不代表已经覆盖所有业务要求。' },
    { id: 'duplicates', label: '内容重合', status: duplicates.length ? 'warn' : 'pass', detail: duplicates.length ? `与 ${duplicates.length} 篇其他稿件存在较多字面重合。` : '当前库中未检出明显字面重合；不是全网查重。' },
  ];
  return { qualityVersion: QUALITY_VERSION, checks, exportSafety, issues: resolvedIssues, facts: review?.facts || [], sourceWarnings, duplicates, readiness: exportSafety.hasCredentials ? 'blocked' : draft.reviewStale ? 'stale' : !review ? 'unreviewed' : openBlocking.length || missingRefs.length ? 'blocked' : openWarnings.length || duplicates.length || !supportedFacts.length || uncertainFacts || sourceWarnings.length ? 'needs_confirmation' : 'ready', limitations: ['资料自述与独立事实核验不同。', '审核为模型判断与程序规则的组合，人工处理记录不代表模型意见一定正确。', '内容重合采用本地文字片段比较，不评价抄袭或平台推荐表现。'] };
}

function textDiff(before, after) {
  if (before === after) return [{ type: 'same', text: before }];
  // Bounded LCS: a sentence/token diff for Chinese and Latin text, without quadratic blow-up.
  const split = value => value.match(/[^\n。！？.!?]+[。！？.!?]?|\n/g) || [];
  const a = split(before), b = split(after);
  if (a.length * b.length > 160_000) return [{ type: 'remove', text: before }, { type: 'add', text: after }];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const diff = []; let i = 0, j = 0;
  const add = (type, text) => { if (diff.at(-1)?.type === type) diff.at(-1).text += text; else diff.push({ type, text }); };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add('same', a[i++]); j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] > dp[i + 1][j])) add('add', b[j++]);
    else add('remove', a[i++]);
  }
  return diff;
}

export function compareDrafts(base, draft) {
  const values = value => ({ title: value.title || '', body: value.body || '', cover: value.cover || '', pages: (value.pages || []).map((page, i) => `${i + 1}. ${page.heading}\n${page.text}`).join('\n\n'), tags: (value.tags || []).join(' ') });
  const a = values(base), b = values(draft);
  return { baseId: base.id, draftId: draft.id, fields: Object.keys(a).map(field => ({ field, before: a[field], after: b[field], changed: a[field] !== b[field], diff: textDiff(a[field], b[field]) })) };
}
