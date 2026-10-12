import { createHash } from 'node:crypto';

export const PUBLICATION_IMPORT_COLUMNS = Object.freeze([
  ['taskId', '任务ID'], ['draftId', '稿件ID'], ['version', '稿件版本'], ['platform', '平台'],
  ['url', '内容链接'], ['trafficType', '流量类型'], ['publishedAt', '发布日期'], ['observedAt', '观察日期'],
  ['dataSource', '数据来源'], ['metricDefinition', '指标口径'], ['contentType', '内容类型'],
  ['impressions', '曝光'], ['clicks', '点击'], ['likes', '点赞'], ['saves', '收藏'], ['comments', '评论'],
  ['shares', '分享'], ['follows', '新增关注'], ['inquiries', '咨询'], ['qualifiedLeads', '有效咨询'],
  ['conversions', '转化'], ['spend', '花费'], ['revenue', '归因收入'], ['note', '备注'],
]);
const aliases = new Map(PUBLICATION_IMPORT_COLUMNS.flatMap(([key, label]) => [[key, key], [label, key]]));
const required = ['taskId', 'draftId', 'platform', 'url', 'trafficType', 'observedAt', 'dataSource', 'metricDefinition'];
const metricNames = ['impressions', 'clicks', 'likes', 'saves', 'comments', 'shares', 'follows', 'inquiries', 'qualifiedLeads', 'conversions', 'spend', 'revenue'];
const trafficTypes = new Map([['organic', 'organic'], ['paid', 'paid'], ['seed', 'seed'], ['enterprise', 'enterprise'], ['自然流量', 'organic'], ['效果投放', 'paid'], ['素人种草', 'seed'], ['企业账号投放', 'enterprise']]);

// Header-only template deliberately contains no fabricated business observations.
export function publicationImportTemplate({ language = 'zh' } = {}) {
  return '\uFEFF' + PUBLICATION_IMPORT_COLUMNS.map(pair => pair[language === 'en' ? 0 : 1]).join(',') + '\r\n';
}

export function parsePublicationCsv(input) {
  if (typeof input !== 'string' || input.length > 2_000_000) throw new Error('CSV 必须是文本，且不超过 2 MB 字符。');
  const text = input.replace(/^\uFEFF/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  const endCell = () => { row.push(cell); cell = ''; closed = false; };
  const endRow = () => { endCell(); if (row.some(value => value.trim() !== '')) rows.push(row); row = []; if (rows.length > 501) throw new Error('每次最多导入 500 条发布记录。'); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === ',') endCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === '"' || closed) throw new Error('CSV 引号格式错误：引号必须包裹整个字段，闭合后只能接逗号或换行。');
    else cell += ch;
  }
  if (quoted) throw new Error('CSV 存在未闭合的双引号。');
  if (cell || row.length || closed) endRow();
  if (!rows.length) throw new Error('CSV 为空，请使用模板填写实际数据。');
  return rows;
}

const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function publicationImportFingerprint(taskId, publication) {
  const normalized = {};
  for (const [key] of PUBLICATION_IMPORT_COLUMNS) {
    if (key === 'taskId') continue;
    const value = metricNames.includes(key) ? publication.metrics?.[key] : publication[key];
    if (value !== undefined && value !== null && value !== '') normalized[key] = value;
  }
  // Version is resolved from draftId by the store, not a distinct observation.
  delete normalized.version;
  return createHash('sha256').update(JSON.stringify(stable({ taskId, publication: normalized }))).digest('hex');
}
const identity = (taskId, publication) => JSON.stringify([taskId, publication.draftId, publication.url, publication.trafficType, publication.observedAt, publication.dataSource]);

/** Pure preview. No persistence or task/draft authorization: caller must validate linkage.
 * existingRows accepts [{taskId, publication}] or store task objects [{id, publication}].
 * Only rows with status=ready may be committed; ok=false means reject the entire batch.
 * Re-preview against current saved rows at commit time to prevent stale overwrite.
 */
export function previewPublicationImport(csv, { existingRows = [] } = {}) {
  const result = { ok: false, valid: false, rows: [], errors: [], warnings: [], summary: { total: 0, ready: 0, duplicate: 0, invalid: 0 } };
  const globalError = message => result.errors.push({ row: null, message });
  let parsed;
  try { parsed = parsePublicationCsv(csv); } catch (error) { globalError(error.message); return result; }
  const headers = parsed[0].map(value => aliases.get(value.trim()));
  parsed[0].forEach((name, index) => { if (!headers[index]) globalError(`未知列：${name || '空列名'}。`); });
  if (new Set(headers).size !== headers.length) globalError('列名重复（中文名和英文名指向同一字段也算重复）。');
  required.forEach(key => { if (!headers.includes(key)) globalError(`缺少必填列：${PUBLICATION_IMPORT_COLUMNS.find(pair => pair[0] === key)[1]}。`); });
  if (result.errors.length) return result;
  const seen = new Map();
  for (const record of existingRows) {
    if (!record.publication) continue;
    const taskId = record.taskId || record.id;
    seen.set(identity(taskId, record.publication), { fingerprint: publicationImportFingerprint(taskId, record.publication), rowNumber: null });
  }
  const readyTasks = new Set();
  parsed.slice(1).forEach((cells, index) => {
    const rowNumber = index + 2;
    const row = { rowNumber, taskId: '', publication: {}, fingerprint: null, status: 'invalid', errors: [], warnings: [] };
    result.rows.push(row);
    if (cells.length !== headers.length) { row.errors.push(`列数不匹配：应为 ${headers.length} 列，实际 ${cells.length} 列。`); return; }
    const values = Object.fromEntries(headers.map((key, i) => [key, cells[i].trim()]));
    required.forEach(key => { if (!values[key]) row.errors.push(`${PUBLICATION_IMPORT_COLUMNS.find(pair => pair[0] === key)[1]}不能为空。`); });
    row.taskId = values.taskId;
    const publication = { metrics: {} };
    row.publication = publication;
    for (const [key, value] of Object.entries(values)) {
      if (key === 'taskId') continue;
      if (value.length > 6000) { row.errors.push(`${key} 超过 6000 字符。`); continue; }
      if (metricNames.includes(key) || key === 'version') {
        if (!value) { if (key !== 'version') publication.metrics[key] = null; continue; }
        const number = Number(value);
        if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(number) || number < 0 || (key === 'version' && (!Number.isSafeInteger(number) || number < 1))) row.errors.push(`${key} 必须为非负十进制数；版本必须为正整数。`);
        else if (key === 'version') publication.version = number;
        else publication.metrics[key] = number;
      } else publication[key] = value;
    }
    publication.trafficType = trafficTypes.get(values.trafficType) || values.trafficType;
    if (!trafficTypes.has(values.trafficType)) row.errors.push('流量类型只能为 organic / paid / seed / enterprise 或模板对应中文。');
    for (const key of ['publishedAt', 'observedAt']) if (publication[key] && !dateValid(publication[key])) row.errors.push(`${key} 必须是有效的 YYYY-MM-DD 日期。`);
    if (dateValid(publication.publishedAt || '') && dateValid(publication.observedAt || '') && publication.observedAt < publication.publishedAt) row.errors.push('观察日期不能早于发布日期。');
    try { const url = new URL(publication.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { row.errors.push('内容链接必须为无用户名密码的 HTTP(S) 链接。'); }
    if (!publication.publishedAt) row.warnings.push('未填写发布日期，无法确认一致观察窗口，不计算跨内容汇总指标。');
    if (row.errors.length) return;
    row.fingerprint = publicationImportFingerprint(row.taskId, publication);
    const key = identity(row.taskId, publication); const previous = seen.get(key);
    if (previous?.fingerprint === row.fingerprint) { row.status = 'duplicate'; row.warnings.push(previous.rowNumber ? `与第 ${previous.rowNumber} 条记录重复，提交时跳过。` : '与已保存记录相同，提交时跳过。'); }
    else if (previous) row.errors.push('同一内容、观察日期和来源存在不同数据；请核对后单独修改，不自动覆盖。');
    else if (readyTasks.has(row.taskId)) row.errors.push('每批每个任务只能有一条新观察记录，请分批导入以保留清晰的观察历史。');
    else { row.status = 'ready'; readyTasks.add(row.taskId); seen.set(key, { fingerprint: row.fingerprint, rowNumber }); }
  });
  result.summary.total = result.rows.length;
  for (const row of result.rows) result.summary[row.status]++;
  for (const row of result.rows) {
    result.errors.push(...row.errors.map(message => ({ row: row.rowNumber, message })));
    result.warnings.push(...row.warnings.map(message => ({ row: row.rowNumber, message })));
  }
  if (!result.rows.length) globalError('模板尚无数据行，请填写真实发布记录。');
  result.ok = result.errors.length === 0 && result.summary.invalid === 0;
  result.valid = result.ok;
  if (result.summary.duplicate) result.warnings.push({ row: null, message: `${result.summary.duplicate} 条重复记录将跳过，不累计重复指标。` });
  return result;
}
