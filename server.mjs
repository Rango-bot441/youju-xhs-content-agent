import { createServer } from 'node:http';
import { readFile, stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { importSource } from './lib/sources.mjs';
import { getProviderInfo, checkProvider } from './lib/provider.mjs';
import { createWorkflow, buildExport } from './lib/workflow.mjs';
import { qualityReport, compareDrafts, redactSensitive, QUALITY_VERSION } from './lib/quality.mjs';
import { makeReport, summarizeRun } from './scripts/evaluate.mjs';
import { classifyLead as classifyLeadWithModel } from './lib/lead-classifier.mjs';
import { createPublicationImportHandler } from './lib/publication-import-api.mjs';
import { sanitizeExport, safeExportFileName } from './public/export-safety.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CAPABILITIES = { accounts: true, assignments: true, sourceCategories: true, sourceLedger: true, messages: true, importedDrafts: true, manualVersions: true, scopedRevision: true, issueDecisions: true, comparison: true, evidenceExport: true, leads: true, leadAiTriage: true, automaticPublishing: false, realtimePlatformData: false, evaluations: true };
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function send(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > 1_000_000) throw new Error('内容超过 1MB，请拆分资料。'); parts.push(part); }
  try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new Error('请求内容必须是 JSON 对象。'); }
}
const exists = (value, label) => { if (!value) throw new Error(`${label}不存在。`); return value; };
function requireCurrentReview(draft, data) {
  if (!draft.review || draft.evidenceNeedsReview || draft.reviewStale || !draft.reviewRevision || data.expectedReviewRevision !== draft.reviewRevision) {
    const error = new Error('当前审核尚未完成、已过期或已更新。请刷新并查看最新审核，再提交人工判断。');
    error.status = 409;
    throw error;
  }
}
function sameLineage(store, first, second) {
  if (first.taskId !== second.taskId) return false;
  const ancestors = draft => { const ids = new Set(); let current = draft; while (current) { if (ids.has(current.id)) break; ids.add(current.id); current = current.parentId ? store.getDraft(current.parentId) : null; } return ids; };
  return ancestors(first).has(second.id) || ancestors(second).has(first.id);
}
function exportDraftObject(draft, sources, includeEvidence) {
  const content = pick(draft, ['title', 'body', 'cover', 'pages', 'tags']);
  if (!includeEvidence) return sanitizeExport(content);
  const refs = new Set([...(draft.evidence || []).map(e => e.sourceRef), ...(draft.review?.issues || []).map(i => i.sourceRef), ...(draft.review?.facts || []).map(f => f.sourceRef)].filter(Boolean));
  const cited = sources.map(source => ({ id: source.id, title: source.title, url: source.url, category: source.category, chunks: source.chunks.filter(chunk => refs.has(chunk.id)).map(chunk => ({ id: chunk.id, text: chunk.text })) })).filter(source => source.chunks.length);
  return sanitizeExport({ ...content, id: draft.id, version: draft.version, origin: draft.origin, status: draft.status, createdAt: draft.createdAt, reviewStale: Boolean(draft.reviewStale), evidence: draft.evidence, gaps: draft.gaps, review: draft.review, sources: cited });
}
function download(res, title, suffix, extension, content) {
  const name = `${safeExportFileName(title)}${suffix}.${extension}`;
  content = sanitizeExport(content);
  const contentType = extension === 'json' ? 'application/json; charset=utf-8' : extension === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8';
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
  res.end(extension === 'json' ? JSON.stringify(content, null, 2) : content);
}
const csvCell = value => { const text = String(value ?? ''); return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; };
function executionReportRun(run) {
  return { ...summarizeRun(run), taskId: run.taskId, startedAt: run.createdAt, finishedAt: run.finishedAt, events: (run.events || []).map(event => ({ ...event, detail: String(event.detail || '').slice(0, 1800) })), error: run.error || null };
}

export function createApp(options = {}) {
const root = options.root || ROOT;
const store = options.store || createStore(options.dbPath || process.env.XHS_DB_PATH || join(root, '.local', 'workspace.sqlite'));
const publicationImport = createPublicationImportHandler(store);
const workflow = options.workflow || createWorkflow(store);
const providerInfo = options.providerInfo || getProviderInfo;
const providerCheck = options.providerCheck || checkProvider;
const leadClassifier = options.leadClassifier || classifyLeadWithModel;
let modelOperation = null;
let shuttingDown = false;
let stateCache = null;
const activity = () => ({ busy: Boolean(modelOperation || workflow.activeCount), kind: modelOperation?.kind || (workflow.activeCount ? 'content_run' : null), activeRuns: Number(workflow.activeCount || 0) + Number(Boolean(modelOperation)), shuttingDown });
const assertModelIdle = () => {
  if (shuttingDown) { const error = new Error('服务正在等待当前任务完成后关闭，暂不接受新的模型请求。'); error.status = 503; throw error; }
  if (activity().busy) { const error = new Error('已有模型任务进行中，请等待当前内容任务、连接检查或线索分拣完成。'); error.status = 409; throw error; }
};
const withModelOperation = async (kind, action) => {
  assertModelIdle();
  const operation = { kind, promise: null }; modelOperation = operation;
  operation.promise = Promise.resolve().then(action);
  try { return await operation.promise; } finally { if (modelOperation === operation) modelOperation = null; }
};
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const port = server.address()?.port;
    const requestHost = req.headers.host || '';
    const origin = options.publicOrigin || process.env.PUBLIC_ORIGIN || `${req.socket.encrypted ? 'https' : 'http'}://${requestHost}`;
    const configuredHosts = (options.allowedHosts || process.env.ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const allowedHosts = new Set(configuredHosts.length ? configuredHosts : [`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(requestHost.toLowerCase())) return send(res, { error: configuredHosts.length ? '访问域名不在允许列表中。' : '仅接受本机访问。' }, 403);
    if (req.headers.origin && req.headers.origin !== origin) return send(res, { error: '拒绝跨站请求。' }, 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, { error: '拒绝跨站请求。' }, 403);
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return send(res, { error: '写操作需要 JSON 请求。' }, 415);
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/publications/import/template.csv') return download(res, '发布数据导入模板', '', 'csv', publicationImport.template());
    if (req.method === 'POST' && path === '/api/publications/import/preview') return send(res, publicationImport.preview((await body(req)).csv));
    if (req.method === 'POST' && path === '/api/publications/import/commit') return send(res, publicationImport.commit(await body(req)), 201);
    const operationRoute = path.match(/^\/api\/(collaborators|collaborations|campaigns|experiments)(?:\/([^/]+))?$/);
    if (operationRoute) {
      const [collection, entity] = { collaborators: ['Collaborators', 'Collaborator'], collaborations: ['Collaborations', 'Collaboration'], campaigns: ['Campaigns', 'Campaign'], experiments: ['Experiments', 'Experiment'] }[operationRoute[1]];
      const id = operationRoute[2];
      if (req.method === 'GET') return send(res, id ? exists(store[`get${entity}`](id), '业务记录') : store[`list${collection}`]());
      if (req.method === 'POST') return send(res, id ? store[`update${entity}`](id, await body(req)) : store[`add${entity}`](await body(req)), id ? 200 : 201);
    }
    if (req.method === 'GET' && path === '/api/health') { const current = activity(); return send(res, { ok: true, app: 'xhs-content-agent', version: '0.2.0', status: shuttingDown ? 'stopping' : current.busy ? 'running' : 'ready', ...current, pid: process.pid }); }
    if (req.method === 'GET' && path === '/api/state') {
      const revision = store.getRevision?.();
      const provider = await providerInfo();
      const currentActivity = activity();
      const currentDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      const cacheKey = revision === undefined ? null : JSON.stringify([revision, provider, currentActivity, currentDay]);
      if (cacheKey && stateCache?.key === cacheKey) {
        res.setHeader('ETag', stateCache.etag);
        if (req.headers['if-none-match']?.split(/\s*,\s*/).includes(stateCache.etag)) { res.writeHead(304, { 'Cache-Control': 'no-cache' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(stateCache.encoded);
      }
      const stored = store.getState({ runSummaries: true });
      const taskMap = new Map(stored.tasks.map(task => [task.id, task]));
      const sourceMap = new Map(stored.sources.map(source => [source.id, source]));
      const draftMap = new Map(stored.drafts.map(draft => [draft.id, draft]));
      const rootId = draft => { const seen = new Set(); while (draft.parentId && draftMap.has(draft.parentId) && !seen.has(draft.id)) { seen.add(draft.id); draft = draftMap.get(draft.parentId); } return draft.id; };
      const families = new Map(stored.drafts.map(draft => [draft.id, rootId(draft)]));
      const quality = Object.fromEntries(stored.drafts.filter(draft => draft.review).map(draft => {
        const task = taskMap.get(draft.taskId);
        const sources = (task?.sourceIds || []).map(id => sourceMap.get(id)).filter(Boolean);
        const peers = stored.drafts.filter(item => families.get(item.id) !== families.get(draft.id));
        const decisions = stored.issueDecisions.filter(item => item.draftId === draft.id && item.reviewRevision === draft.reviewRevision);
        return [draft.id, qualityReport(draft, sources, peers, decisions)];
      }));
      const state = { ...stored, quality, evaluations: [], provider, activity: currentActivity, capabilities: CAPABILITIES };
      const encoded = JSON.stringify(state); const etag = `"${createHash('sha256').update(encoded).digest('hex')}"`;
      if (cacheKey) stateCache = { key: cacheKey, encoded, etag };
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match']?.split(/\s*,\s*/).includes(etag)) { res.writeHead(304, { 'Cache-Control': 'no-cache' }); return res.end(); }
      return send(res, state);
    }
    if (req.method === 'GET' && path === '/api/evaluations') {
      const directory = options.evaluationsDir || join(root, '.local', 'evaluations');
      let names;
      try { names = (await readdir(directory)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(name)).sort().reverse().slice(0, 50); }
      catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
      const reports = []; const errors = [];
      for (const name of names) {
        try { const target = join(directory, name); const info = await stat(target); if (!info.isFile() || info.size > 5_000_000) throw new Error('报告文件过大或不是普通文件'); const report = JSON.parse(await readFile(target, 'utf8')); if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('报告格式不正确'); reports.push({ ...report, filename: name }); }
        catch { errors.push({ filename: name, error: '该评测报告无法读取或格式无效。' }); }
      }
      {
        const activeStore = store;
        reports.unshift(...activeStore.listRunSummaries().filter(run => run.action && ['completed', 'failed'].includes(run.status) && !reports.some(report => report.kind === 'run-audit' && report.run?.runId === run.id)).slice(0, 20).map(run => ({
          id: `run_audit_${run.id}`, createdAt: run.finishedAt || run.createdAt, title: '真实运行执行轨迹', kind: 'run-audit', sampleCount: 1,
          run: executionReportRun(run),
          human: { status: 'not_collected', ratings: [] }, limitations: ['执行轨迹不是生成质量准确率或业务提效证明。', '失败请求可能计费；实际消耗请以服务账单为准。'] })),
        );
      }
      return send(res, { reports, ...(errors.length ? { errors } : {}) });
    }
    if (req.method === 'POST' && path === '/api/evaluations') {
      const data = await body(req);
      if (Object.keys(data).some(key => !['taskId', 'draftId', 'runId'].includes(key))) throw new Error('自动核查仅接受任务、稿件或运行 ID，不支持通过此接口调用模型。');
      for (const key of ['taskId', 'draftId']) if (Object.hasOwn(data, key) && (typeof data[key] !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(data[key]))) throw new Error('任务或稿件 ID 格式不正确。');
      if (Object.hasOwn(data, 'runId') && (typeof data.runId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(data.runId))) throw new Error('运行 ID 格式不正确。');
      if (data.runId) {
        const run = exists(store.getRun(data.runId), '运行记录');
        if (!['completed', 'failed'].includes(run.status)) throw new Error('该运行尚未结束，暂不生成评测记录。');
        const report = { id: `evaluation_${randomUUID()}`, createdAt: new Date().toISOString(), title: '真实运行记录核查', kind: 'run-audit', sampleCount: 1,
          qualityVersion: QUALITY_VERSION, promptVersion: run.promptVersion || '旧版未记录', toolVersion: run.toolVersion || '旧版未记录',
          run: executionReportRun(run),
          human: { status: 'not_collected', ratings: [], note: '该记录仅包含系统执行日志；没有真人盲评、正确答案或人工耗时。' },
          limitations: ['模型调用数不等于账单金额。失败请求可能计费；usageUnknown 时实际消耗不可知。', '这份报告是执行轨迹，不是生成质量准确率，也不证明业务提效。'] };
        const directory = options.evaluationsDir || join(root, '.local', 'evaluations'); await mkdir(directory, { recursive: true });
        const filename = `${report.createdAt.replace(/[:.]/g, '-')}-${report.id}.json`;
        await writeFile(join(directory, filename), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
        return send(res, { ...report, filename }, 201);
      }
      const selectedDrafts = store.listDrafts().filter(draft => (!data.taskId || draft.taskId === data.taskId) && (!data.draftId || draft.id === data.draftId));
      if (!selectedDrafts.length) throw new Error('没有符合条件的真实保存稿件，评测未运行。');
      if (selectedDrafts.some(draft => !draft.review)) throw new Error('所选稿件尚未完成审核；请先运行独立质检。');
      const report = makeReport(store.getState(), data);
      const directory = options.evaluationsDir || join(root, '.local', 'evaluations');
      await mkdir(directory, { recursive: true });
      const filename = `${report.createdAt.replace(/[:.]/g, '-')}-${report.id}.json`;
      await writeFile(join(directory, filename), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
      return send(res, { ...report, filename }, 201);
    }
    if (req.method === 'POST' && path === '/api/profile') return send(res, store.saveProfile(await body(req)));
    if (req.method === 'POST' && path === '/api/accounts') return send(res, store.addAccount(await body(req)), 201);
    if (req.method === 'POST' && path === '/api/sources') {
      const data = await body(req);
      const source = await importSource({ title: data.title, text: data.text, url: data.url, kind: data.kind });
      return send(res, store.addSource({ ...source, ...pick(data, ['category', 'note', 'region', 'grade', 'sourceType', 'sourceLevel', 'publishedAt', 'effectiveUntil', 'verificationStatus', 'isDemo']) }), 201);
    }
    if (req.method === 'POST' && path === '/api/tasks') {
      const data = await body(req);
      return send(res, store.addTask(pick(data, ['title', 'brief', 'sourceIds', 'accountId', 'owner'])), 201);
    }
    if (req.method === 'POST' && path === '/api/provider/check') {
      return send(res, await withModelOperation('provider_check', () => providerCheck()));
    }
    if (req.method === 'POST' && path === '/api/leads') return send(res, store.addLead(pick(await body(req), ['taskId', 'channel', 'rawText', 'isDemo'])), 201);
    let match;
    if (req.method === 'POST' && (match = path.match(/^\/api\/accounts\/([^/]+)$/))) return send(res, store.updateAccount(match[1], await body(req)));
    if (req.method === 'GET' && (match = path.match(/^\/api\/sources\/([^/]+)$/))) return send(res, exists(store.getSource(match[1]), '资料'));
    if (req.method === 'POST' && (match = path.match(/^\/api\/sources\/([^/]+)$/))) return send(res, store.updateSource(match[1], await body(req)));
    if (req.method === 'POST' && (match = path.match(/^\/api\/leads\/([^/]+)$/))) return send(res, store.updateLead(match[1], await body(req)));
    if (req.method === 'POST' && (match = path.match(/^\/api\/leads\/([^/]+)\/classify$/))) {
      const lead = exists(store.getLead(match[1]), '线索');
      return send(res, await withModelOperation('lead_classification', async () => {
        const task = lead.taskId ? store.getTask(lead.taskId) : null;
        const result = await leadClassifier({ rawText: lead.rawText, channel: lead.channel, task });
        return store.recordLeadAnalysis(lead.id, result);
      }));
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/tasks\/([^/]+)$/))) {
      const data = await body(req); const allowed = ['title', 'brief', 'owner', 'accountId', 'status', 'sourceIds', 'assignment', 'publication', 'preflight'];
      if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('任务修改包含不允许修改的字段。');
      return send(res, store.updateTask(match[1], data));
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/tasks\/([^/]+)\/messages$/))) {
      const data = await body(req);
      return send(res, store.appendMessage(match[1], { role: 'user', text: data.text, sourceIds: data.sourceIds }), 201);
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/tasks\/([^/]+)\/drafts$/))) {
      const data = await body(req); const task = exists(store.getTask(match[1]), '任务');
      if (typeof data.title !== 'string' || !data.title.trim() || typeof data.body !== 'string' || !data.body.trim()) throw new Error('现成稿件需要标题和正文。');
      const draft = store.addDraft({ ...pick(data, ['title', 'body', 'cover', 'pages', 'tags', 'author', 'changeNote']), taskId: task.id, origin: 'imported', evidence: [], review: null });
      store.updateTask(task.id, { status: task.sourceIds.length ? 'needs_review' : 'needs_input' });
      return send(res, draft, 201);
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/drafts\/([^/]+)\/versions$/))) return send(res, store.addDraftVersion(match[1], await body(req)), 201);
    if (req.method === 'POST' && (match = path.match(/^\/api\/drafts\/([^/]+)\/select$/))) return send(res, store.selectDraftVariant(match[1]));
    if (req.method === 'GET' && (match = path.match(/^\/api\/drafts\/([^/]+)\/compare$/))) {
      const draft = exists(store.getDraft(match[1]), '稿件'); const base = exists(store.getDraft(url.searchParams.get('base') || draft.parentId || ''), '对比版本');
      if (!sameLineage(store, base, draft)) throw new Error('只能比较同一稿件版本链。');
      return send(res, compareDrafts(base, draft));
    }
    if (req.method === 'GET' && (match = path.match(/^\/api\/drafts\/([^/]+)\/quality$/))) {
      const draft = exists(store.getDraft(match[1]), '稿件'); const task = exists(store.getTask(draft.taskId), '任务');
      const peers = store.listDrafts().filter(item => item.id !== draft.id && !sameLineage(store, item, draft));
      return send(res, qualityReport(draft, task.sourceIds.map(id => store.getSource(id)), peers, store.getDraftIssueDecisions(draft.id)));
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/drafts\/([^/]+)\/issues$/))) {
      const data = await body(req); const draft = exists(store.getDraft(match[1]), '草稿');
      requireCurrentReview(draft, data);
      return send(res, store.addIssueDecision({ ...pick(data, ['issueKey', 'decision', 'comment', 'expectedReviewRevision']), draftId: draft.id }), 201);
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/tasks\/([^/]+)\/runs$/))) {
      const data = await body(req); assertModelIdle();
      return send(res, workflow.start(match[1], data), 202);
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/runs\/([^/]+)\/cancel$/))) return send(res, workflow.cancel(match[1]));
    if (req.method === 'POST' && (match = path.match(/^\/api\/runs\/([^/]+)\/retry$/))) {
      assertModelIdle();
      const old = exists(store.getRun(match[1]), '运行记录');
      if (old.status !== 'failed') throw new Error('仅允许重试失败或已取消的运行。');
      const run = workflow.retry ? workflow.retry(old.id) : workflow.start(old.taskId, old.resultDraftId ? { action: 'review', draftId: old.resultDraftId, instruction: old.instruction || '', retryOf: old.id } : { action: old.action, instruction: old.instruction || '', topicId: old.topicId, draftId: old.draftId, scope: old.scope, lockedFields: old.lockedFields, retryOf: old.id });
      return send(res, run, 202);
    }
    if (req.method === 'POST' && (match = path.match(/^\/api\/drafts\/([^/]+)\/feedback$/))) {
      const data = await body(req); const draft = exists(store.getDraft(match[1]), '草稿');
      if (data.decision === 'accepted') requireCurrentReview(draft, data);
      const feedback = store.addFeedback({ draftId: draft.id, decision: data.decision, comment: data.comment || '', ...pick(data, ['expectedReviewRevision']) });
      return send(res, feedback, 201);
    }
    if (req.method === 'GET' && (match = path.match(/^\/api\/drafts\/([^/]+)\/export$/))) {
      const draft = exists(store.getDraft(match[1]), '草稿');
      const task = store.getTask(draft.taskId);
      const sources = task.sourceIds.map(id => store.getSource(id));
      const json = url.searchParams.get('format') === 'json';
      const includeEvidence = url.searchParams.get('includeEvidence') === '1';
      const safeContent = exportDraftObject(draft, sources, includeEvidence);
      return download(res, safeContent.title, `-v${draft.version}`, json ? 'json' : 'md', json ? safeContent : buildExport(safeContent, safeContent.sources || [], { includeEvidence }));
    }
    if (req.method === 'GET' && (match = path.match(/^\/api\/tasks\/([^/]+)\/export$/))) {
      const task = exists(store.getTask(match[1]), '任务');
      if (!task.assignment) throw new Error('该任务尚未生成任务单。');
      const json = url.searchParams.get('format') === 'json';
      const assignment = task.assignment;
      const lines = [`# ${task.title}`, '', `负责人：${task.owner || '待分配'}`, '', `受众：${assignment.audience}`, '', `目标：${assignment.objective}`, '', `角度：${assignment.angle}`];
      for (const [key, label] of [['facts', '可用事实'], ['materials', '素材需求'], ['deliverables', '交付物'], ['criteria', '验收标准'], ['questions', '待补充信息']]) lines.push('', `## ${label}`, ...assignment[key].map(value => `- ${value}`));
      return download(res, task.title, '-任务单', json ? 'json' : 'md', json ? { title: task.title, owner: task.owner, assignment } : lines.join('\n'));
    }
    if (req.method === 'GET' && (match = path.match(/^\/api\/tasks\/([^/]+)\/lead-handoff\.csv$/))) {
      const task = exists(store.getTask(match[1]), '任务');
      const allDrafts = store.listDrafts();
      const latestDraft = allDrafts.filter(draft => draft.taskId === task.id && !allDrafts.some(next => next.parentId === draft.id)).sort((a, b) => b.version - a.version)[0];
      const account = task.accountId ? store.getAccount(task.accountId) : null;
      const field = label => task.brief.match(new RegExp(`^${label}[：:]\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
      const taskInfo = { region: field('地区'), grade: field('年级'), subject: field('学科/主题'), parentQuestion: field('家长问题') };
      const nextStep = latestDraft?.review ? '人工核验引用原文、补齐素材缺口并确认稿件可交付；真实咨询后核对家长需求再转销售' : '完成稿件质检与人工核验；真实咨询后核对家长年级、学科和具体问题再转销售';
      const cells = [
        ['地区', '年级', '学科/主题', '家长原始问题', '需求判断', '内容/来源', '交接状态', '下一步', '备注'],
        [taskInfo.region, taskInfo.grade, taskInfo.subject, taskInfo.parentQuestion, '', `${task.title}${latestDraft ? `；${latestDraft.title}（v${latestDraft.version}）` : ''}`, '待真实咨询后填写', nextStep, '不包含虚构家长线索；任务信息来自需求 brief，个人信息与需求判断待真实咨询后填写'],
      ];
      const csv = cells.map(row => row.map(csvCell).join(',')).join('\r\n');
      return download(res, account?.name || task.title, '-线索交接模板', 'csv', `\uFEFF${csv}\r\n`);
    }
    if (req.method === 'GET' && path === '/api/leads/export.csv') {
      const leads = store.listLeads().filter(lead => ['ready_handoff', 'handed_off'].includes(lead.reviewStatus) && lead.confirmedFields && lead.confirmedAt && lead.manualNote?.trim());
      const cells = [['线索ID', '来源', '地区', '年级', '学科', '需求类型', '需求摘要', '初判优先级', '待补信息', '销售交接摘要', '人工备注', '交接状态', '是否演示', '创建时间']];
      for (const lead of leads) {
        const analysis = lead.confirmedFields;
        cells.push([lead.id, lead.channel, analysis.region || '待人工确认', analysis.grade || '待人工确认', analysis.subject || '待人工确认', analysis.intent || '待人工确认', analysis.demand || '待人工确认', analysis.priority || '待人工确认', (analysis.missingFields || []).join('；'), analysis.handoffSummary || '待人工确认', lead.manualNote || '', lead.reviewStatus === 'handed_off' ? '已交接' : '待销售确认', lead.isDemo ? '虚构演示' : '真实输入', lead.createdAt]);
      }
      const csv = cells.map(row => row.map(csvCell).join(',')).join('\r\n');
      return download(res, '线索分拣', '-销售交接', 'csv', `\uFEFF${csv}\r\n`);
    }
    if (path.startsWith('/api/')) return send(res, { error: '接口不存在。' }, 404);
    if (req.method !== 'GET') return send(res, { error: '方法不支持。' }, 405);
    const target = resolve(root, 'public', path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`);
    if (!target.startsWith(join(root, 'public') + '/')) return send(res, { error: '路径无效。' }, 403);
    try { if (!(await stat(target)).isFile()) throw new Error(); const data = await readFile(target); res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); return res.end(data); }
    catch { return send(res, { error: '页面不存在。' }, 404); }
  } catch (error) { if (!res.headersSent) send(res, { error: redactSensitive(error.message).slice(0, 1800) }, error.status || 400); else res.end(); }
});
return { server, store, workflow, close: async () => {
  shuttingDown = true;
  const stopped = new Promise(resolveClose => server.close(resolveClose)); server.closeIdleConnections?.();
  // Drain every model operation before closing its storage; the service manager also checks activeRuns.
  if (modelOperation?.promise) await modelOperation.promise.catch(() => {});
  while (workflow.activeCount) await new Promise(resolveWait => setTimeout(resolveWait, 25));
  workflow.shutdown();
  await stopped;
  if (!options.store) store.close();
} };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  app.server.listen(port, host, () => console.log(`小红书内容工作台已启动：http://${host}:${port}`));
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : error.message); process.exitCode = 1; });
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
