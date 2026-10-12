import { VISUAL_PAGE_WIDTH, VISUAL_PAGE_HEIGHT, visualAssets, visualSvg } from './visuals.js';
import { calculateBusinessMetrics, groupBusinessMetrics } from './business-metrics.js';
import { PRIMARY_NAV, SECONDARY_TOOLS, contentLabel, nextActionForTask, pageToPrimary, stageForTask, filterTasks, isCurrentReview, taskEvidenceLabel as evidenceLabel } from './ui-model.js';
import { captureTaskOperation, submitRevision, submitExistingDraft } from './task-actions.js';
import { inspectExportSafety, safeExportFileName } from './export-safety.js';
const savedUi = (() => { try { return JSON.parse(localStorage.getItem('xhs-workbench-ui') || '{}'); } catch { return {}; } })();
const ui = { state: null, page: savedUi.page || 'dashboard', taskId: savedUi.taskId || null, draftId: savedUi.draftId || null, tab: savedUi.tab || 'draft', busy: false, notice: null, connection: null, signature: '', etag: null, drawer: null, drawerReturn: null, drawerFocus: null, evaluations: [], inbox: savedUi.inbox ?? true, filter: 'all', includeDemo: false, assetFilter: 'all', search: '', showNewTask: false, quality: null, comparison: null, demoPrefill: null, leadDemo: false };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const number = value => Number(value || 0).toLocaleString('zh-CN');
const activeRuns = () => ui.state.runs.filter(run => ['queued', 'running'].includes(run.status));
const currentTask = () => ui.state.tasks.find(task => task.id === ui.taskId);
const currentDraft = () => ui.state.drafts.find(draft => draft.id === ui.draftId && draft.taskId === ui.taskId);
const disabled = () => ui.busy || activeRuns().length || ui.state.activity?.busy || !ui.state.provider?.ready ? 'disabled' : '';
const action = (name, label, data = '', kind = '') => `<button type="button" class="btn ${kind}" data-action="${name}" ${data}>${label}</button>`;
const empty = (title, text) => `<div class="empty"><span class="eyebrow">等待你的下一步</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const statusLabel = run => ({ queued: '准备执行', running: '执行中', completed: '已完成', failed: run.error?.includes('取消') ? '已取消' : '未完成' }[run.status] || run.status);
const stageLabel = value => ({ brief: '整理任务单', plan: '选题计划', draft: '生成草稿', review: '独立质检', revise: '反馈改稿' }[value] || value);
const taskStatusLabel = value => ({ ready:'待开始', needs_input:'待补充', in_progress:'处理中', needs_review:'待审阅', changes_requested:'待修改', accepted:'已采纳', delivered:'已交付', archived:'已归档' }[value] || '待开始');
const fieldLabel = value => ({ title:'标题', body:'正文', cover:'封面', pages:'图文页', tags:'标签' }[value] || String(value || '').replace(/^pages\.(\d+)\.(heading|text)$/, (_, i, part) => `第 ${Number(i)+1} 页${part==='heading'?'标题':'正文'}`));
const qualityLabel = value => ({ ready: '可进入人工终审', blocked: '需先解决阻断项', needs_confirmation: '待人工确认', unreviewed: '尚未审核', stale: '审核已过期，需重新检查' }[value] || value || '尚未核查');
const canAccept = (quality, draft) => Boolean(isCurrentReview(draft, quality) && quality && !['unreviewed', 'blocked', 'stale'].includes(quality.readiness));
const operationContext = () => captureTaskOperation({...ui,reviewRevision:currentDraft()?.reviewRevision});
const sameOperation = op => ui.taskId === op.taskId && ui.draftId === op.draftId;
const taskList = (filter = 'all', search = '', includeDemo = false) => filterTasks(ui.state.tasks, { filter, search, includeDemo, sources: ui.state.sources, drafts: ui.state.drafts, runs: ui.state.runs, quality: ui.state.quality });
const citation = (ref, text = '查看原文 ↗', quote = '') => `<button type="button" class="source-button" data-action="citation" data-ref="${esc(ref)}" data-quote="${esc(quote)}">${esc(text)}</button>`;
const knownMetric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const metricNumber = value => knownMetric(value) ? number(value) : '未记录';
const rate = (part, whole) => knownMetric(part) && knownMetric(whole) && Number(whole) > 0 ? `${((Number(part) / Number(whole)) * 100).toFixed(2)}%` : '—';
const leadStatusLabel = value => ({ pending_review: '待人工确认', follow_up: '待追问', ready_handoff: '待销售确认', handed_off: '已交接', excluded: '不进入交接' }[value] || value);
const leadPriorityLabel = value => ({ high: '优先跟进', medium: '信息待补', low: '低优先' }[value] || '待 AI 初判');
const sourceStatus = source => {
  if (source.verificationStatus === 'needs_update') return ['需更新', 'warn'];
  if (source.effectiveUntil && source.effectiveUntil < new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })) return ['已过有效期', 'bad'];
  if (source.verificationStatus === 'verified') return ['已核验', 'good'];
  return ['待核验', 'warn'];
};
const evaluationReports = () => ui.evaluations || [];
const fieldMemory = new Map();
function resetDraftState() { ui.qualityReport=null; ui.qualityDraftId=null; ui.comparison=null; ui.scope=null; ui.lockedFields=[]; ui.editing=false; ui.editorPageCount=null; ui.selection=null; ui.drawer=null; }
function selectTask(id) { if (ui.taskId!==id) resetDraftState(); ui.taskId=id; ui.draftId=ui.state.drafts.find(d=>d.taskId===id)?.id||null; ui.showNewTask=false; ui.demoPrefill=null; ui.inbox=false; ui.notice=null; }
function selectDraft(id) { if (ui.draftId!==id) resetDraftState(); ui.draftId=id; }
function lineage(draft) {
  if (!draft) return [];
  const candidates=ui.state.drafts.filter(d=>d.taskId===draft.taskId), byId=new Map(candidates.map(d=>[d.id,d]));
  const rootId=d=>{ const seen=new Set(); while(d.parentId&&byId.has(d.parentId)&&!seen.has(d.id)){seen.add(d.id);d=byId.get(d.parentId);}return d.id; };
  const root=rootId(draft); return candidates.filter(d=>rootId(d)===root).sort((a,b)=>a.version-b.version||String(a.createdAt).localeCompare(String(b.createdAt)));
}
function closeOverlay(kind) {
  preserveFields();const returnKey=ui.overlayReturnKey;ui[kind]=null;render();
  const target=new Map(keyedElements([...document.querySelectorAll('input,textarea,select,button,a,summary')])).get(returnKey);target?.focus({preventScroll:true});
}
function openOverlay(kind,value,button) {
  preserveFields();ui.overlayReturnKey=keyedElements([...document.querySelectorAll('input,textarea,select,button,a,summary')]).find(([,el])=>el===button)?.[0];ui[kind]=value;render();document.querySelector('[role="dialog"]')?.querySelector('input,button,textarea,select')?.focus({preventScroll:true});
}
function locateDraftText(field,start,end) {
  const el=[...document.querySelectorAll('[data-copy-field]')].find(node=>node.dataset.copyField===field);if(!el||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>el.textContent.length){ui.notice={error:true,text:'这条意见当前无法定位到对应原句，请对照稿件人工核查。'};render();return;}
  for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),range=document.createRange();let node,offset=0,started=false;while((node=walk.nextNode())){const limit=offset+node.textContent.length;if(!started&&start<=limit){range.setStart(node,start-offset);started=true;}if(end<=limit){range.setEnd(node,end-offset);break;}offset=limit;}
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('quote-focus');window.setTimeout(()=>el.classList.remove('quote-focus'),2500);
}

// Deterministic rendering is separate from model text generation.
const cleanFileName = value => safeExportFileName(value);

function downloadSvg(draft, asset, index, total) {
  const filePart = asset.kind === 'cover' ? `封面${asset.parts > 1 ? `-${asset.part}` : ''}` : `图文-${String(asset.sourcePage).padStart(2, '0')}${asset.parts > 1 ? `-${asset.part}` : ''}`;
  const blob = new Blob([visualSvg(draft, asset, index, total)], { type: 'image/svg+xml;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${cleanFileName(draft.title)}-${filePart}.svg`;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function downloadPng(draft, asset, index, total) {
  const svg = visualSvg(draft, asset, index, total);
  const image = new Image();
  const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片素材转换失败，请改用 SVG 下载。')); });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas'); canvas.width = VISUAL_PAGE_WIDTH; canvas.height = VISUAL_PAGE_HEIGHT;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('浏览器未能生成 PNG，请改用 SVG 下载。');
  const filePart = asset.kind === 'cover' ? `封面${asset.parts > 1 ? `-${asset.part}` : ''}` : `图文-${String(asset.sourcePage).padStart(2, '0')}${asset.parts > 1 ? `-${asset.part}` : ''}`;
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${cleanFileName(draft.title)}-${filePart}.png`;
  document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function downloadAllVisuals(draft) {
  const assets = visualAssets(draft);
  assets.forEach((asset, index) => downloadSvg(draft, asset, index, assets.length));
  ui.notice = { text: `已发起 ${assets.length} 张 SVG 图文素材下载；浏览器若询问，请允许多文件下载。` };
  render();
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务没有返回有效结果，请检查服务是否仍在运行。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function refresh(force = false) {
  const previous = ui.state;
  const headers = ui.etag && !force ? { 'If-None-Match': ui.etag } : {};
  const response = await fetch('/api/state', { headers });
  if (response.status === 304) {
    // 评测报告保存在文件系统，不参与工作区 revision；在评测页或强制刷新时仍需读一次，
    // 否则新生成的运行核查会一直等到下一次数据库变更才出现在导航和列表里。
    if (force || ui.page === 'evaluations') {
      try {
        const reports = (await request('/api/evaluations')).reports || [];
        const signature = JSON.stringify(reports.map(report => [report.filename, report.createdAt, report.id]));
        const previousSignature = JSON.stringify((ui.evaluations || []).map(report => [report.filename, report.createdAt, report.id]));
        ui.evaluations = reports;
        if (signature !== previousSignature) render();
      } catch { /* 保留已有评测记录，避免短暂读取失败清空界面 */ }
    }
    return false;
  }
  if (!response.ok) throw new Error(`读取工作区失败（${response.status}）`);
  ui.etag = response.headers.get('ETag') || ui.etag;
  const state = await response.json();
  ui.state = state;
  try { ui.evaluations = (await request('/api/evaluations')).reports || []; } catch { ui.evaluations = []; }
  if (!state.tasks.some(task => task.id === ui.taskId)) ui.taskId = state.tasks[0]?.id || null;
  const newest = state.drafts.find(draft => draft.taskId === ui.taskId);
  if (!currentDraft() || (previous && newest && !previous.drafts.some(draft => draft.id === newest.id))) {
    ui.draftId = newest?.id || null;
    resetDraftState();
  }
  const signature = JSON.stringify(state);
  if (force || signature !== ui.signature) { ui.signature = signature; render(); }
  return true;
}

function saveUi() {
  try { localStorage.setItem('xhs-workbench-ui', JSON.stringify({ page: ui.page, taskId: ui.taskId, draftId: ui.draftId, tab: ui.tab, inbox:ui.inbox })); } catch {}
}

function taskEvidenceLabel(task) { return evidenceLabel(task, ui.state.sources); }

function taskCard(task, compact = false) {
  const drafts = ui.state.drafts.filter(draft => draft.taskId === task.id);
  const latest = [...drafts].sort((a,b)=>String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.version-a.version)[0];
  const next = nextActionForTask(task, ui.state.drafts, ui.state.runs, ui.state.quality);
  const account = ui.state.accounts?.find(item => item.id === task.accountId);
  const label = taskEvidenceLabel(task);
  return `<button class="card task-card ${compact ? 'compact' : ''}" data-action="open-task" data-id="${esc(task.id)}"><div class="row between"><span class="stage-chip stage-${esc(next.stage)}">${esc(next.label)}</span><span class="muted">${date(task.updatedAt || task.createdAt)}</span></div><div class="row between task-card-title"><strong>${esc(task.title || task.brief?.slice(0, 70) || '未命名任务')}</strong>${label ? badge(label, label === '演示模式' ? 'warn' : 'subtle') : ''}</div><p class="muted">${esc(account?.name || '未分配账号')} · ${drafts.length} 个版本${latest ? ` · v${latest.version}` : ''}</p><span class="task-next">${esc(next.hint)} →</span></button>`;
}

function secondaryToolLinks(ids = []) {
  return SECONDARY_TOOLS.filter(tool => ids.includes(tool.id)).map(tool => action('nav', tool.label, `data-page="${esc(tool.id)}"`, 'small')).join('');
}

function dashboardPage() {
  const tasks = taskList();
  const publicPractice = ui.state.tasks.find(task => /^公开资料实践/.test(task.title || '') || taskEvidenceLabel(task) === '公开资料实践');
  const providerReady = Boolean(ui.state.provider?.ready);
  const pendingTasks = tasks.filter(task => stageForTask(task, ui.state.drafts, ui.state.runs, ui.state.quality) !== 'delivery');
  const recentTasks = pendingTasks.filter(task => task.id !== publicPractice?.id).slice(0, 3);
  const practice = publicPractice
    ? `<article class="quick-practice card"><div class="quick-practice-copy"><span class="eyebrow">公开练习任务 · 可直接查看</span><h2>${esc(publicPractice.title)}</h2><p class="muted">${publicPractice.sourceIds?.length || 0} 份公开资料 · 仅用于流程演示，不代表真实客户或业务效果。</p></div><div class="row">${action('open-task', '打开公开练习', `data-id="${esc(publicPractice.id)}"`, 'small')}</div></article>`
    : `<article class="quick-practice card"><div class="quick-practice-copy"><span class="eyebrow">公开练习任务</span><h2>暂无可直接体验的公开练习</h2><p class="muted">可先导入公开可核验资料；系统不会自动创建虚构任务或结果。</p></div><div class="row">${action('nav', '查看内容任务', 'data-page="tasks"', 'small')}</div></article>`;
  const modelState = ui.connection?.ready
    ? '<span class="model-state-pill is-ready" aria-label="模型连接成功">模型连接成功</span>'
    : providerReady
      ? '<span class="model-state-pill is-pending" aria-label="模型已配置，连接待检查">模型已配置，连接待检查</span>'
      : '<span class="model-state-pill is-missing" aria-label="模型未配置，AI暂不可用">模型未配置 · AI 暂不可用</span>';
  const steps = [['01', '任务要求', '确认目标与交付要求'], ['02', '资料与稿件', '选择依据并提交外稿'], ['03', 'AI 核验', '定位问题与来源'], ['04', '人工处理与导出', '决定修改、采纳或交付']];
  return `<section class="quick-start-hero"><div class="quick-start-heading"><div class="eyebrow">小红书内容审核工作台</div><div class="quick-start-title-row"><h1>开始审核一份外稿</h1>${modelState}</div><p class="muted">提交现成稿件，按任务要求、资料依据逐步核验，再由你决定修改与交付。</p><div class="quick-start-actions">${action('deliver-draft','开始审核一份外稿','','primary quick-start-cta')}</div>${!providerReady ? '<p class="model-unavailable-note">现在仍可保存任务、资料和稿件；配置模型后才能运行 AI，不会显示预设审核结果。</p>' : ''}</div></section>
    ${practice}
    <section class="dashboard-next card"><div class="workflow-card-heading"><span class="eyebrow">审核流程</span><h2>四步完成一份外稿审核</h2><p class="muted">每一步都有记录；是否通过和能否交付，最终由人工确认。</p></div><ol class="dashboard-flow">${steps.map(([number, title, hint]) => `<li><span class="workflow-number">${number}</span><strong>${title}</strong><small>${hint}</small></li>`).join('')}</ol></section>
    <section class="dashboard-list"><div class="section-header"><div><h2>其他待处理任务</h2><p class="muted">公开练习已单独置顶；此处最多显示 3 项，其余任务仍可在任务列表查看。</p></div>${action('nav','查看全部任务','data-page="tasks"','small')}</div>${recentTasks.length ? `<div class="stack">${recentTasks.map(task => taskCard(task)).join('')}</div>` : empty('当前没有其他待处理任务','开始审核外稿，或从全部任务中打开已有任务。')}</section>
    <details class="card dashboard-boundary"><summary>查看系统边界与高级能力</summary><div class="grid three-col"><div><strong>人工负责</strong><p class="muted">账号边界、事实核验、问题处理和是否交付。</p></div><div><strong>高级工具</strong><p class="muted">资料台账、版本对比、质量评测、运行日志和案例回放。</p></div><div><strong>不会自动做</strong><p class="muted">不自动发布、不抓取私信，也不把演示记录当成增长结果。</p></div></div></details></div>`;
}

function libraryPage() {
  const sources = ui.state.sources || [];
  const accounts = ui.state.accounts || [];
  return `<div class="page-heading"><div><div class="eyebrow">内容与账号</div><h1>内容与账号</h1><p class="muted">先确定账号边界，再让 AI 使用经过标记的资料。</p></div></div><div class="grid two-col library-choice"><button class="card choice-card" data-action="nav" data-page="profile"><span class="eyebrow">01 · 账号边界</span><h2>账号档案</h2><p>${accounts.length ? `${accounts.length} 个账号或规划档案` : '还没有账号档案'}</p><span class="task-next">查看或新建账号 →</span></button><button class="card choice-card" data-action="nav" data-page="sources"><span class="eyebrow">02 · 内容依据</span><h2>资料台账</h2><p>${sources.length ? `${sources.length} 份资料，${sources.filter(item => item.verificationStatus === 'verified').length} 份已核验` : '还没有资料'}</p><span class="task-next">查看来源与核验状态 →</span></button></div><section class="card library-boundary"><h2>为什么要先做这一步</h2><div class="grid three-col"><div><strong>账号</strong><p class="muted">决定能讲什么、不能承诺什么。</p></div><div><strong>资料</strong><p class="muted">决定哪些表达能回到原文。</p></div><div><strong>版本</strong><p class="muted">决定谁改了什么、为什么改。</p></div></div></section><section class="secondary-tools"><div><span class="eyebrow">更多工具</span><p class="muted">需要时再打开，不影响主流程。</p></div><div class="row wrap">${secondaryToolLinks(['assets', 'collaboration', 'leads', 'replay'])}</div></section>`;
}

function contentAssetsPage() {
  const reviewed = ui.state.drafts.filter(draft => isCurrentReview(draft, ui.state.quality?.[draft.id]) && !ui.state.drafts.some(child => child.parentId === draft.id)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const classify = draft => {
    const task = ui.state.tasks.find(item => item.id === draft.taskId);
    const label = taskEvidenceLabel(task || draft);
    if (label === '演示模式') return 'demo';
    if (label === '历史项目自述') return 'historical';
    const taskSources = (task?.sourceIds || []).map(id => ui.state.sources.find(source => source.id === id));
    return taskSources.length && taskSources.every(source => source?.verificationStatus === 'verified' && sourceStatus(source)[0] === '已核验') ? 'real' : 'unverified';
  };
  const counts = { unverified: reviewed.filter(draft => classify(draft) === 'unverified').length, all: reviewed.length, real: reviewed.filter(draft => classify(draft) === 'real').length, historical: reviewed.filter(draft => classify(draft) === 'historical').length, demo: reviewed.filter(draft => classify(draft) === 'demo').length };
  const drafts = reviewed.filter(draft => ui.assetFilter === 'all' || classify(draft) === ui.assetFilter);
  const filterLabels = [['all', '全部'], ['real', '已核验来源'], ['historical', '历史自述'], ['demo', '演示练习'], ['unverified', '来源待核验']];
  return `<div class="page-heading"><div><div class="eyebrow">通过当前检查的候选资产</div><h1>内容资产</h1><p class="muted">仅显示最新版本、审核未过期且无阻断问题的稿件；未经人工采纳仍不可直接交付。历史与失效审核可在原任务中查看。</p></div>${badge(`${drafts.length} / ${reviewed.length} 份`)}</div><div class="asset-filters" role="tablist" aria-label="内容资产来源筛选">${filterLabels.map(([id, label]) => `<button class="tab ${ui.assetFilter === id ? 'selected' : ''}" data-action="asset-filter" data-filter="${id}">${label} · ${counts[id]}</button>`).join('')}</div>${drafts.length ? `<div class="grid two-col asset-grid">${drafts.map(draft => { const task = ui.state.tasks.find(item => item.id === draft.taskId); const account = task?.accountId ? ui.state.accounts?.find(item => item.id === task.accountId) : null; const kind = classify(draft); const kindLabel = kind === 'demo' ? '演示练习' : kind === 'historical' ? '历史项目自述' : kind === 'real' ? '来源已核验' : '来源待核验'; const kindStyle = kind === 'demo' ? 'warn' : kind === 'real' ? 'good' : 'subtle'; return `<article class="card asset-card"><div class="row between"><span class="eyebrow">${draft.origin === 'manual' ? '人工版本' : '审核稿'}</span><span class="row">${badge(kindLabel, kindStyle)}${badge(draft.status === 'accepted' ? '已采纳' : '已审核', draft.status === 'accepted' ? 'good' : 'subtle')}</span></div><h2>${esc(draft.title)}</h2><p class="muted">${esc(account?.name || '未分配账号')} · v${draft.version} · ${date(draft.updatedAt || draft.createdAt)}</p><p>${esc(draft.body.slice(0, 180))}${draft.body.length > 180 ? '…' : ''}</p><div class="tags">${(draft.tags || []).slice(0, 6).map(tag => `<span>#${esc(tag.replace(/^#/, ''))}</span>`).join('')}</div><div class="row between"><span class="muted">${esc(task?.title || '来源任务')}</span>${action('open-task','打开任务',`data-id="${esc(draft.taskId)}" data-draft-id="${esc(draft.id)}"`,'small')}</div></article>`; }).join('')}</div>` : empty('没有匹配的内容资产', '先完成一次审核，或切换来源筛选查看历史与演示记录。')}</div>`;
}

const businessInput = (name, label, value = '', type = 'text', required = false) => `<label class="field">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value ?? '')}" ${required ? 'required' : ''} ${type === 'number' ? 'min="0" step="any"' : ''}></label>`;
const businessText = (name, label, value = '', required = false) => `<label class="field">${esc(label)}<textarea name="${esc(name)}" rows="2" ${required ? 'required' : ''}>${esc(value)}</textarea></label>`;
const businessSelect = (name, label, values, selected = '') => `<label class="field">${esc(label)}<select name="${esc(name)}">${values.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
const taskOptions = () => [['', '暂不关联'], ...ui.state.tasks.map(task => [task.id, task.title])];
const collaboratorStatuses = [['active','合作中'],['paused','暂停'],['archived','已归档']];
const deliveryStatuses = [['invited','待接单'],['in_progress','制作中'],['submitted','待审核'],['changes_requested','需返工'],['accepted','已验收'],['cancelled','已取消']];
const campaignStatuses = [['planned','计划中'],['running','执行中'],['paused','暂停'],['completed','已结束'],['cancelled','已取消']];
const experimentStatuses = [['planned','计划中'],['running','观察中'],['completed','已复盘'],['cancelled','已取消']];
const trafficOptions = [['organic','自然流量'],['paid','效果投放'],['seed','素人种草'],['enterprise','企业账号投放']];
const experimentMetricFields = [['impressions','曝光'],['clicks','点击'],['likes','点赞'],['saves','收藏'],['comments','评论'],['shares','分享'],['follows','新增关注'],['inquiries','咨询量'],['qualifiedLeads','有效咨询'],['conversions','转化'],['spend','花费（元）'],['revenue','收入（元）']];

function collaboratorForm(record = {}) {
  return `<form data-form="collaborator" data-record-id="${esc(record.id || '')}" class="stack"><div class="grid two-col">${businessInput('name','作者 / 合作方名称',record.name,'text',true)}${businessSelect('type','合作类型',[['freelancer','兼职作者'],['vendor','供应商'],['internal','内部同事'],['creator','创作者']],record.type || 'freelancer')}${businessInput('role','负责内容 / 专长',record.role)}${businessSelect('status','合作状态',collaboratorStatuses,record.status || 'active')}</div>${businessText('note','协作约定（勿填个人联系方式）',record.note)}<button class="btn small">${record.id ? '保存合作方' : '添加合作方'}</button></form>`;
}
function collaborationForm(record = {}) {
  return `<form data-form="collaboration" data-record-id="${esc(record.id || '')}" class="stack"><div class="grid two-col">${businessSelect('taskId','关联内容任务',[['','请选择内容任务'],...taskOptions().slice(1)],record.taskId)}${businessSelect('collaboratorId','合作方',[['','请选择'],...(ui.state.collaborators || []).map(item => [item.id,item.name])],record.collaboratorId)}${businessInput('role','本次负责环节',record.role)}${businessInput('batch','交付批次',record.batch)}${businessInput('dueDate','交付截止日期',record.dueDate,'date')}${businessSelect('status','交付状态',deliveryStatuses,record.status || 'invited')}${businessInput('submittedAt','实际提交日期',record.submittedAt?.slice(0,10),'date')}${businessInput('reviewedAt','本次审核日期',record.reviewedAt?.slice(0,10),'date')}</div>${businessText('deliverables','交付物清单（一行一项）',(record.deliverables || []).join('\n'))}${businessText('review','人工审核 / 验收意见',record.review)}${businessText('reworkReason','返工原因（需返工时必填）',record.reworkReason)}<p class="muted">待审核需填写实际提交日期；返工或验收需填写审核日期与意见。状态变更留痕，不自动通知外部作者。</p><button class="btn small">${record.id ? '保存交付与审核' : '创建协作单'}</button></form>`;
}
function collaborationPage() {
  const collaborators = ui.state.collaborators || [], records = ui.state.collaborations || [];
  return `<div class="page-heading"><div><div class="eyebrow">更多工具 · 内容供给与人工验收</div><h1>作者协作</h1><p class="muted">先登记真实合作方，再关联内容任务。用截止时间、交付清单和返工原因管理内容供给，不将 AI 审核等同于人工验收。</p></div></div><div class="grid two-col"><details class="card"><summary>＋ 添加合作方</summary>${collaboratorForm()}</details><details class="card"><summary>＋ 创建协作单</summary>${collaborationForm()}</details></div><section class="card"><h2>协作记录</h2><p class="muted">${records.length} 张协作单 · 未录入的历史合作不估填；返工与一次通过口径仅统计系统中的实际审核记录。</p>${records.length ? records.map(record => `<details class="business-record"><summary><span>${esc(ui.state.tasks.find(t => t.id === record.taskId)?.title || '内容任务')} · ${esc(collaborators.find(c => c.id === record.collaboratorId)?.name || '合作方')}</span>${badge(deliveryStatuses.find(([value]) => value === record.status)?.[1] || record.status)}<span class="muted">${esc(record.batch || '未分批次')} · 截止 ${esc(record.dueDate || '未定')}</span></summary>${collaborationForm(record)}<details><summary>状态留痕 · ${(record.history || []).length} 条</summary>${(record.history || []).map(event => `<p class="muted">${date(event.replacedAt || event.at || event.createdAt)} · ${esc(deliveryStatuses.find(([value])=>value===event.status)?.[1] || event.status || event.to || event.action || '记录更新')} ${esc(event.review || event.note || '')}</p>`).join('')}</details></details>`).join('') : empty('还没有协作单','添加合作方后，为已有内容任务约定交付与审核。')}</section><section class="card"><h2>合作方档案</h2>${collaborators.length ? collaborators.map(record => `<details class="business-record"><summary>${esc(record.name)} · ${esc(collaboratorStatuses.find(([value])=>value===record.status)?.[1] || record.status)}</summary>${collaboratorForm(record)}</details>`).join('') : '<p class="muted">没有记录。不会自动生成作者、供应商或历史成绩。</p>'}</section>`;
}
function campaignForm(record = {}) {
  return `<form data-form="campaign" data-record-id="${esc(record.id || '')}" class="stack"><div class="grid two-col">${businessInput('name','计划名称',record.name,'text',true)}${businessInput('platform','平台',record.platform || '小红书')}${businessSelect('trafficType','流量类型',trafficOptions,record.trafficType || 'paid')}${businessSelect('status','计划状态',campaignStatuses,record.status || 'planned')}${businessInput('budget','计划预算（元；未知留空）',record.budget,'number')}${businessInput('startDate','计划开始日期',record.startDate,'date')}${businessInput('endDate','计划结束日期',record.endDate,'date')}</div>${businessText('objective','业务目标',record.objective)}${businessText('audience','目标人群',record.audience)}${businessText('attributionWindow','归因窗口与规则',record.attributionWindow)}<fieldset><legend>关联内容任务</legend>${ui.state.tasks.map(task => `<label class="check-row"><input type="checkbox" name="taskIds" value="${esc(task.id)}" ${record.taskIds?.includes(task.id) ? 'checked' : ''}>${esc(task.title)}</label>`).join('')}</fieldset>${businessText('notes','备注与边界',record.notes)}<button class="btn small">${record.id ? '保存计划' : '创建计划'}</button></form>`;
}
function experimentForm(record = {}) {
  const variants = record.variants?.length ? record.variants : [{id:'A',name:'A'},{id:'B',name:'B'}];
  return `<form data-form="experiment" data-record-id="${esc(record.id || '')}" class="stack"><div class="grid two-col">${businessInput('name','实验名称',record.name,'text',true)}${businessSelect('campaignId','所属计划',[['','请选择'],...(ui.state.campaigns || []).map(c=>[c.id,c.name])],record.campaignId)}${businessInput('primaryMetric','主指标',record.primaryMetric)}${businessInput('observationStart','观察开始日期',record.observationStart,'date')}${businessInput('observationEnd','观察结束日期',record.observationEnd,'date')}</div>${businessText('hypothesis','待验证假设',record.hypothesis)}${businessText('metricDefinition','指标口径 / 对照条件 / 归因说明',record.metricDefinition)}${variants.map((variant,index) => `<fieldset class="variant-fields"><legend>素材变体 ${index+1}</legend><input name="variant-${index}-id" type="hidden" value="${esc(variant.id)}"><div class="grid two-col">${businessInput(`variant-${index}-name`,'变体名称',variant.name)}${businessSelect(`variant-${index}-taskId`,'关联任务',taskOptions(),variant.taskId)}${businessSelect(`variant-${index}-draftId`,'稿件版本',[['','暂不关联'],...ui.state.drafts.filter(d=>!variant.taskId || d.taskId===variant.taskId).map(d=>[d.id,`${d.title} · v${d.version}`])],variant.draftId)}</div>${businessText(`variant-${index}-note`,'变体说明 / 数据来源',variant.note)}<details data-detail-key="experiment-${esc(record.id || 'new')}-variant-${index}-metrics"><summary>录入观察数据（可稍后）</summary><div class="grid two-col">${businessInput(`variant-${index}-observedAt`,'数据观察日期',variant.observedAt?.slice(0,10),'date')}${experimentMetricFields.map(([key,label])=>businessInput(`variant-${index}-${key}`,label,variant.metrics?.[key],'number')).join('')}</div></details></fieldset>`).join('')}<details data-detail-key="experiment-${esc(record.id || 'new')}-conclusion"><summary>实验状态与人工复盘（可稍后）</summary><div class="stack">${businessSelect('status','实验状态',experimentStatuses,record.status || 'planned')}${businessText('conclusion','人工复盘结论与下一步',record.conclusion)}</div></details><div class="notice">指标为空代表未知，不是 0；两条内容对比不等于严格随机实验，系统不自动宣布赢家或显著性。完成实验前需补齐假设、指标口径、窗口及人工结论。</div><button class="btn small">${record.id ? '保存实验与观察记录' : '创建实验'}</button></form>`;
}
function campaignsPage() {
  const campaigns = ui.state.campaigns || [], experiments = ui.state.experiments || [];
  return `<div class="page-heading"><div><div class="eyebrow">更多工具 · 假设到复盘</div><h1>投放实验</h1><p class="muted">记录真实计划、素材对照与观察结果。不会创建广告、消费预算或接管平台投放。</p></div></div><div class="grid two-col"><details class="card"><summary>＋ 新建投放计划</summary>${campaignForm()}</details><details class="card"><summary>＋ 新建素材实验</summary>${experimentForm()}</details></div><section class="card"><h2>素材实验</h2>${experiments.length ? experiments.map(record => `<details class="business-record"><summary><span>${esc(record.name)}</span>${badge(experimentStatuses.find(([value])=>value===record.status)?.[1] || record.status)}<span class="muted">${esc(record.primaryMetric || '主指标待定')}</span></summary>${experimentForm(record)}</details>`).join('') : empty('还没有实验','先创建计划，再写下一个可验证的内容假设。没有真实数据时只保留计划，不生成结果。')}</section><section class="card"><h2>投放计划</h2>${campaigns.length ? campaigns.map(record => `<details class="business-record"><summary><span>${esc(record.name)}</span>${badge(campaignStatuses.find(([value])=>value===record.status)?.[1] || record.status)}<span class="muted">${esc(record.platform)} · ${record.taskIds?.length || 0} 个关联任务</span></summary>${campaignForm(record)}</details>`).join('') : '<p class="muted">暂无计划；预算、流量和转化均需来自实际业务。</p>'}</section>`;
}

function reviewPage() {
  const records = ui.state.tasks.filter(task => task.publication).length;
  return `<div class="page-heading"><div><div class="eyebrow">交付后的真实记录</div><h1>复盘</h1><p class="muted">只汇总人工录入的发布数据，并把内容问题沉淀为下一轮动作。</p></div></div><div class="grid two-col review-choice"><button class="card choice-card" data-action="nav" data-page="analytics"><span class="eyebrow">01 · 业务结果</span><h2>发布复盘</h2><p>${records ? `${records} 条已记录内容` : '还没有真实发布数据'}</p><span class="task-next">查看发布链接与人工指标 →</span></button><button class="card choice-card" data-action="nav" data-page="evaluations"><span class="eyebrow">02 · 系统证据</span><h2>发布前检查</h2><p>${evaluationReports().length} 条自动核查与运行记录</p><span class="task-next">查看质量边界与执行轨迹 →</span></button></div><section class="card review-boundary"><h2>复盘口径</h2><p class="muted">系统自动核查不等于真人评分，运行记录不等于业务提效；没有真实发布数据时保持空白。</p></section><section class="secondary-tools"><div><span class="eyebrow">更多工具</span><p class="muted">查看 AI 运行证据，或回到真实咨询记录。</p></div><div class="row wrap">${secondaryToolLinks(['campaigns', 'replay', 'leads'])}</div></section>`;
}

function enhancePublicationForm() {
  const form = document.querySelector('form[data-form="publication"]');
  if (!form || form.dataset.businessMetrics === 'true') return;
  const task = currentTask();
  const draft = currentDraft();
  const publication = task?.publication?.draftId === draft?.id ? task.publication : null;
  const metrics = publication?.metrics || {};
  const value = key => metrics[key] ?? '';
  const trafficType = publication?.trafficType || 'organic';
  const grid = form.querySelector('.grid.two-col');
  if (!grid) return;
  grid.insertAdjacentHTML('afterend', `<fieldset class="business-metrics"><legend>业务结果（有真实数据再填，空白不等于 0）</legend>${businessInput('dataSource','数据来源（后台报表名称 / 人工统计出处）',publication?.dataSource)}${businessText('metricDefinition','统计与归因口径（去重、转化定义、退款处理）',publication?.metricDefinition)}<div class="grid two-col"><label class="field">流量来源<select name="trafficType"><option value="organic" ${trafficType === 'organic' ? 'selected' : ''}>自然流量</option><option value="paid" ${trafficType === 'paid' ? 'selected' : ''}>效果投放</option><option value="seed" ${trafficType === 'seed' ? 'selected' : ''}>素人种草</option><option value="enterprise" ${trafficType === 'enterprise' ? 'selected' : ''}>企业账号投放</option></select></label><label class="field">点击<input name="clicks" type="number" min="0" value="${esc(value('clicks'))}"></label><label class="field">点赞<input name="likes" type="number" min="0" value="${esc(value('likes'))}"></label><label class="field">分享<input name="shares" type="number" min="0" value="${esc(value('shares'))}"></label><label class="field">新增关注<input name="follows" type="number" min="0" value="${esc(value('follows'))}"></label><label class="field">咨询量<input name="inquiries" type="number" min="0" value="${esc(value('inquiries'))}"></label><label class="field">转化量<input name="conversions" type="number" min="0" value="${esc(value('conversions'))}"></label><label class="field">投放消耗<input name="spend" type="number" min="0" step="0.01" value="${esc(value('spend'))}"></label><label class="field">归因收入<input name="revenue" type="number" min="0" step="0.01" value="${esc(value('revenue'))}"></label></div><p class="muted">只有分子、分母、来源、观察窗口与统计口径齐全，才计算 CTR、CVR、有效咨询成本与收入回报 ROAS；不冒充利润 ROI。</p></fieldset>`);
  form.dataset.businessMetrics = 'true';
}

function enhanceBusinessKpis() {
  if (ui.page !== 'analytics' || document.querySelector('[data-business-kpis]')) return;
  const anchor = document.querySelector('.analytics-metrics');
  if (!anchor) return;
  const records = ui.state.tasks.filter(task => task.publication);
  const metrics = calculateBusinessMetrics(records);
  const format = (value, type = '') => value == null ? '口径不足' : type === '%' ? `${(value * 100).toFixed(2)}%` : `${Number(value).toFixed(2)}${type}`;
  const card = document.createElement('section');
  card.className = 'card business-kpis';
  card.dataset.businessKpis = 'true';
  card.innerHTML = `<div class="row between"><div><h2>投放与转化口径</h2><p class="muted">只计算相同来源、流量类型、发布日期和观察日期的完整记录；收入回报不是利润 ROI。</p></div><span class="badge subtle">人工录入 / CSV</span></div><div class="grid four-col"><div class="metric"><span>CTR</span><strong>${format(metrics.ctr,'%')}</strong><small>点击 / 曝光</small></div><div class="metric"><span>CVR</span><strong>${format(metrics.cvr,'%')}</strong><small>转化 / 点击</small></div><div class="metric"><span>有效咨询成本 CPL</span><strong>${format(metrics.cpl,' 元')}</strong><small>消耗 / 有效咨询</small></div><div class="metric"><span>收入回报 ROAS</span><strong>${format(metrics.roas,' 倍')}</strong><small>收入 / 广告消耗；非利润 ROI</small></div></div>${metrics.reason ? `<p class="muted">${esc(metrics.reason)}</p>` : ''}`;
  anchor.after(card);
  const groups = groupBusinessMetrics(records);
  if (groups.length > 1) card.insertAdjacentHTML('beforeend', `<details class="metric-groups"><summary>按流量与观察口径分组查看 · ${groups.length} 组</summary><div class="table-scroll"><table><thead><tr><th>口径</th><th>条数</th><th>CTR</th><th>CVR</th><th>CPL</th><th>ROAS</th></tr></thead><tbody>${groups.map(group=>`<tr><td>${esc(group.platform || '平台未记录')} · ${esc(trafficOptions.find(([value])=>value===group.trafficType)?.[1] || '流量未记录')}<br>${esc(group.publishedAt || '发布日期缺失')} → ${esc(group.observedAt || '观察日期缺失')}<br>${esc(group.dataSource || '来源缺失')} · ${esc(group.metricDefinition || '统计口径缺失')}${group.reason ? `<p class="muted">${esc(group.reason)}</p>` : ''}</td><td>${group.recordCount}</td><td>${format(group.ctr,'%')}</td><td>${format(group.cvr,'%')}</td><td>${format(group.cpl,' 元')}</td><td>${format(group.roas,' 倍')}</td></tr>`).join('')}</tbody></table></div></details>`);
}

function enhanceImportPanel() {
  if (ui.page !== 'analytics') return;
  const panel = document.createElement('details'); panel.className = 'card csv-import-panel';
  panel.innerHTML = `<summary>从平台导出文件导入发布数据（CSV）</summary><form data-form="publication-csv" class="stack"><p class="muted">只导入已存在任务与稿件的发布数据。先预览，再确认入库；冲突会阻止导入，完全相同的记录跳过。文件须为 UTF-8 CSV。</p><a class="btn small" href="/api/publications/import/template.csv" download>下载空白字段模板</a><label class="field">读取 CSV 文件<input id="publication-csv-file" type="file" accept=".csv,text/csv"></label><label class="field">或粘贴 CSV<textarea name="csv" rows="6" placeholder="保留模板表头；未知指标留空，不填 0。">${esc(ui.csvText || '')}</textarea></label><details class="csv-id-reference" data-detail-key="csv-id-reference"><summary>查看任务与稿件 ID 对照</summary><p class="muted">选中 ID 文本即可复制。每条发布记录需关联同一任务下的稿件，不能把其他任务的稿件混入。</p>${ui.state.tasks.map(task=>`<div class="csv-id-item"><strong>${esc(task.title)}</strong><p>任务 ID：<code>${esc(task.id)}</code></p>${ui.state.drafts.filter(draft=>draft.taskId===task.id).map(draft=>`<p>${esc(draft.title)} · v${draft.version}<br>稿件 ID：<code>${esc(draft.id)}</code></p>`).join('') || '<p class="muted">暂无稿件，先保存一份稿件后再导入发布数据。</p>'}</div>`).join('') || '<p class="muted">请先创建内容任务。</p>'}</details>${action('csv-preview','校验并预览','','small')}${ui.csvPreview ? `<section class="csv-preview"><h3>${ui.csvPreview.valid ? '校验通过，请核对' : '仍有错误，尚未写入'}</h3>${(ui.csvPreview.errors || []).map(item=>`<p class="alert error">第 ${esc(item.row)} 行：${esc(item.message)}</p>`).join('')}${(ui.csvPreview.warnings || []).map(item=>`<p class="muted">${esc(typeof item === 'string' ? item : item.message)}</p>`).join('')}<div class="table-scroll"><table><thead><tr><th>行</th><th>关联任务</th><th>处理方式</th><th>观察日期</th><th>待导入内容与指标</th></tr></thead><tbody>${(ui.csvPreview.rows || []).map(item=>`<tr><td>${esc(item.rowNumber)}</td><td>${esc(ui.state.tasks.find(task=>task.id===item.taskId)?.title || item.taskId)}</td><td>${esc(({ready:'待导入',duplicate:'重复跳过',invalid:'需修正',error:'需修正'}[item.status] || '需修正'))}</td><td>${esc(item.publication?.observedAt)}</td><td><details><summary>核对链接、来源与指标</summary><p>发布链接：<span>${esc(item.publication?.url || '未记录')}</span></p><p>数据来源：${esc(item.publication?.dataSource || '未记录')}</p><p>统计口径：${esc(item.publication?.metricDefinition || '未记录')}</p><p>${experimentMetricFields.filter(([key])=>knownMetric(item.publication?.metrics?.[key])).map(([key,label])=>`${esc(label)}：${esc(item.publication.metrics[key])}`).join(' · ') || '本行未录入指标，保持未知。'}</p></details></td></tr>`).join('')}</tbody></table></div>${ui.csvPreview.valid ? action('csv-commit','确认导入已预览的数据','','small') : ''}</section>` : ''}</form>`;
  document.querySelector('.page > .footer-note')?.before(panel);
}

function enhanceCollaborationMetrics() {
  if (ui.page !== 'collaboration') return;
  const metrics = ui.state.collaborationMetrics || {};
  const format = value => value == null ? '无样本' : `${(Number(value)*100).toFixed(1)}%`;
  const panel = document.createElement('section'); panel.className = 'grid four-col collaboration-metrics';
  panel.innerHTML = `<div class="metric"><span>一次通过率</span><strong>${format(metrics.firstPassRate)}</strong><small>${metrics.firstPassCount || 0} / ${metrics.reviewedCount || 0} 张已审核协作单</small></div><div class="metric"><span>返工率</span><strong>${format(metrics.reworkRate)}</strong><small>${metrics.reworkedCount || 0} 张曾返工 / ${metrics.reviewedCount || 0} 张已审核</small></div><div class="metric"><span>准时交稿率</span><strong>${format(metrics.onTimeRate)}</strong><small>${metrics.onTimeCount || 0} / ${metrics.onTimeSampleCount || 0} 张有截止和交稿日期</small></div><div class="metric"><span>平均验收周期</span><strong>${metrics.averageAcceptedCycleDays == null ? '无样本' : Number(metrics.averageAcceptedCycleDays).toFixed(1)+' 天'}</strong><small>${metrics.acceptedCycleSampleCount || 0} 张含首次交稿与验收日期</small></div>`;
  document.querySelector('.page-heading')?.after(panel);
}

function tasksPage() { return inboxPage(); }

function viewScope() { return ui.modal ? JSON.stringify(['modal',ui.modal,ui.modalTaskId || '',ui.modalAccountId || '']) : JSON.stringify([ui.page,ui.page==='work'?[ui.showNewTask?'new':ui.inbox?'inbox':ui.taskId,ui.showNewTask||ui.inbox?'':ui.draftId,ui.showNewTask?'new':ui.tab]:null]); }
function controlIdentity(el) {
  if (!el) return null;
  const form=el.closest('[data-form]')?.dataset.form || '';
  const record=el.closest('[data-record-id]')?.dataset.recordId || '';
  const issue=el.closest('[data-issue-key]')?.dataset.issueKey || '';
  const attrs=[...el.attributes].filter(a=>a.name.startsWith('data-')&&a.name!=='data-field-state').map(a=>`${a.name}=${a.value}`).sort().join('|');
  return [form,record,issue,el.localName,el.id||'',el.name||'',el.type||'',attrs,['checkbox','radio'].includes(el.type)?el.value:''].join('::');
}
function controls(root=document) { return [...root.querySelectorAll('input,textarea,select')].filter(el=>!['file','password'].includes(el.type)&&!['task-select','draft-select','replay-draft-select','evaluation-draft'].includes(el.id)); }
function keyedElements(elements) { const seen=new Map();return elements.map(el=>{const base=controlIdentity(el);const n=seen.get(base)||0;seen.set(base,n+1);return [base+'::'+n,el];}); }
function detailElements() {const counts=new Map();return [...document.querySelectorAll('details')].map(el=>{const base=el.dataset.issueKey||el.dataset.detailKey||el.querySelector(':scope > summary')?.textContent?.trim()||'详情';const n=counts.get(base)||0;counts.set(base,n+1);return [base+'::'+n,el];});}
function forgetForm(type, recordId, targetScope = viewScope()) {
  const prefix = type+'::'+(recordId === undefined ? '' : recordId+'::');
  for (const [scope,record] of fieldMemory) {if(scope!==targetScope)continue;record.fields=record.fields.filter(field=>!field.key.startsWith(prefix));try{localStorage.setItem('xhs-fields:'+scope,JSON.stringify(record.fields));}catch{}}
  if(viewScope()!==targetScope)return;
  document.querySelectorAll(`[data-form="${type}"]`).forEach(form=>{if(recordId !== undefined && form.dataset.recordId !== recordId)return; form.reset();form.dataset.discardInputs='true';});
}
function preserveFields() {
  const scope=$('app')?.dataset.scope;if(!scope)return null;
  const fields=keyedElements(controls()).filter(([,el])=>!el.closest('[data-discard-inputs]')).map(([key,el])=>({key,value:el.value,checked:el.checked,selected:el.multiple?[...el.selectedOptions].map(o=>o.value):null}));
  const focused = document.activeElement;
  const focus=keyedElements([...document.querySelectorAll('input,textarea,select,button,a,summary')]).find(([,el])=>el===focused)?.[0];
  const record={fields,focus,start:focused?.selectionStart,end:focused?.selectionEnd,details:detailElements().map(([key,el])=>({key,open:el.open})),scroll:window.scrollY,drawerScroll:document.querySelector('.drawer')?.scrollTop||0};
  fieldMemory.set(scope,record);try{localStorage.setItem('xhs-fields:'+scope,JSON.stringify(fields));}catch{}return record;
}
function restoreFields() {
  const scope=viewScope();let saved=fieldMemory.get(scope);if(!saved){try{saved={fields:JSON.parse(localStorage.getItem('xhs-fields:'+scope)||'[]')};}catch{saved={fields:[]};}}
  const fields=new Map(keyedElements(controls()));for(const field of saved.fields){const el=fields.get(field.key);if(!el)continue;if(el.localName==='select'&&!el.multiple&&![...el.options].some(o=>o.value===field.value))continue;el.value=field.value;if(['checkbox','radio'].includes(el.type))el.checked=field.checked;if(el.multiple&&field.selected)for(const option of el.options)option.selected=field.selected.includes(option.value);}
  const details=new Map(detailElements());for(const detail of saved.details||[]){const el=details.get(detail.key);if(el)el.open=detail.open;}
  const focused=new Map(keyedElements([...document.querySelectorAll('input,textarea,select,button,a,summary')])).get(saved.focus);if(focused){focused.focus({preventScroll:true});try{if(typeof saved.start==='number')focused.setSelectionRange(saved.start,saved.end);}catch{}}
  if(saved.scroll!==undefined)window.scrollTo(0,saved.scroll);if(document.querySelector('.drawer'))document.querySelector('.drawer').scrollTop=saved.drawerScroll||0;
}

function render() {
  if (!ui.state) return;
  preserveFields();
  const { provider, tasks, sources } = ui.state;
  const leads = ui.state.leads || [];
  const published = tasks.filter(task => task.publication);
  const pendingLeads = leads.filter(lead => ['pending_review', 'follow_up', 'ready_handoff'].includes(lead.reviewStatus));
  const running = activeRuns().length;
  const pages = { dashboard: '工作台', work: '工作台', tasks: '内容任务', library: '内容与账号', review: '复盘', sources: '资料台账', assets: '内容资产', collaboration: '作者协作', campaigns: '投放实验', leads: '真实咨询', analytics: '发布复盘', replay: '过程与证据', profile: '账号档案', evaluations: '发布前检查' };
  saveUi();
  $('app').innerHTML = `<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#" data-action="nav" data-page="dashboard"><span class="brand-mark">据</span><span>有据<small>内容审核工作台</small></span></a>
      <div class="eyebrow">工作空间</div>
      <nav aria-label="主导航">${PRIMARY_NAV.map((item, index) => `<button class="nav-item ${pageToPrimary(ui.page) === item.id ? 'active' : ''}" data-action="nav" data-page="${item.id}"><span>${String(index + 1).padStart(2, '0')}</span>${item.label}</button>`).join('')}</nav>
      ${ui.page === 'work' && !ui.inbox ? `<div class="sidebar-context"><span class="eyebrow">当前任务</span><strong>${esc(currentTask()?.title || '未选择任务')}</strong><button class="text-button" data-action="nav" data-page="tasks">返回任务列表</button></div>` : ''}
      <div class="sidebar-bottom"><span class="muted">本机保存 · AI 运行时发送所选资料至模型服务</span></div>
    </aside>
    <main class="main" id="main"><header class="topbar"><span>${pages[ui.page]}</span><div class="row">${running ? badge('任务执行中', 'warn') : ''}${ui.page === 'work' && ui.inbox ? '' : badge(ui.connection?.ready ? '模型连接成功' : provider.ready ? '模型已配置' : '模型待配置', ui.connection?.ready ? 'good' : '')}<button class="btn small" data-action="check" ${ui.busy || activeRuns().length ? 'disabled' : ''}>${ui.busy ? '请稍候…' : '检查连接'}</button></div></header>
      <div class="page">${ui.notice ? `<div class="alert ${ui.notice.error ? 'error' : 'success'}" role="status"><span>${esc(ui.notice.text)}</span><button class="close" data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}
      ${ui.page === 'sources' ? sourcesPage() : ui.page === 'leads' ? leadsPage() : ui.page === 'profile' ? profilePage() : ui.page === 'assets' ? contentAssetsPage() : ui.page === 'collaboration' ? collaborationPage() : ui.page === 'campaigns' ? campaignsPage() : ui.page === 'analytics' ? analyticsPage() : ui.page === 'replay' ? caseReplayPage() : ui.page === 'evaluations' ? evaluationsPage() : ui.page === 'tasks' ? tasksPage() : ui.page === 'library' ? libraryPage() : ui.page === 'review' ? reviewPage() : ui.page === 'dashboard' || (ui.page === 'work' && ui.inbox) ? dashboardPage() : workPage()}
      <footer class="footer-note">${esc(provider.model || '尚未配置模型')} · 本机保存 · AI 运行会发送所选资料至已配置模型服务 · 事实需核验</footer></div>
    </main></div><div id="drawer-root"></div><div id="modal-root"></div>`;
  $('app').dataset.scope=viewScope();
  renderDrawer();
  renderModal();
  enhancePublicationForm();
  enhanceBusinessKpis();
  enhanceImportPanel();
  enhanceCollaborationMetrics();
  restoreFields();
  const dialog=document.querySelector('[role="dialog"]');if(dialog){document.querySelector('.shell').inert=true;if(!dialog.contains(document.activeElement))dialog.querySelector('input,button,textarea,select')?.focus({preventScroll:true});}
}

function sourcesPage() {
  const verified = ui.state.sources.filter(source => sourceStatus(source)[0] === '已核验').length;
  const needsUpdate = ui.state.sources.filter(source => sourceStatus(source)[0] !== '已核验').length;
  return `<div class="page-heading"><div><div class="eyebrow">资料台账 · 人工核验优先</div><h1>资料台账</h1><p class="muted">把内容依据按适用范围、时效、来源等级和使用边界标清；模型只能使用你选中的资料，不替代核验。</p></div>${badge(`${ui.state.sources.length} 份资料`)}</div>
    <div class="grid three-col source-ledger-metrics"><div class="metric"><span>已核验资料</span><strong>${verified}</strong><small>人工确认可作为当前依据</small></div><div class="metric"><span>待复核 / 更新</span><strong>${needsUpdate}</strong><small>含未核验或已过有效期资料</small></div><div class="metric"><span>已标注内容场景</span><strong>${new Set(ui.state.sources.map(source => source.category).filter(Boolean)).size}</strong><small>便于按任务复用资料</small></div></div>
    <div class="grid two-col"><section class="card"><h2>导入资料</h2><form data-form="source" class="stack">
      <label class="field">资料名称<input id="source-title" name="title" maxlength="200" placeholder="例如：课程公开介绍、项目复盘"></label>
      <label class="field">公开网页链接<input id="source-url" name="url" type="url" placeholder="https://…"></label>
      <p class="muted">需要登录或动态加载的页面，可复制有权使用的正文到下方。</p>
      <label class="field">或直接粘贴正文<textarea id="source-text" name="text" rows="9" placeholder="粘贴真实素材。填写正文后，将优先导入正文，链接作为出处保留。"></textarea></label>
      <label class="field">导入本地文件<input id="source-file" type="file" accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html"></label>
      <details class="source-ledger-form"><summary>补充资料适用范围与台账</summary><div class="grid two-col"><label class="field">适用范围（如地区 / 人群）<input name="region" maxlength="160" placeholder="例如：职场转型人群、某城市用户"></label><label class="field">适用阶段 / 场景<input name="grade" maxlength="160" placeholder="例如：入门期、决策前、发布后复盘"></label><label class="field">资料类型<select name="sourceType"><option value="policy">平台规则</option><option value="school">业务案例</option><option value="competition">竞品观察</option><option value="parent_question">用户问题</option><option value="product_fact">产品事实</option><option value="other" selected>其他</option></select></label><label class="field">来源级别<select name="sourceLevel"><option value="official">官方原文</option><option value="organization">机构公开信息</option><option value="first_hand">一手访谈 / 亲历</option><option value="platform">平台讨论</option><option value="other" selected>其他</option></select></label><label class="field">发布时间<input name="publishedAt" type="date"></label><label class="field">有效期至<input name="effectiveUntil" type="date"></label><label class="field">初始核验状态<select name="verificationStatus"><option value="unverified" selected>待人工核验</option><option value="verified">已人工核验</option><option value="needs_update">需更新</option></select></label><label class="field">资料备注<textarea name="note" rows="2" placeholder="例如：只适用于本次任务；原文未说明的部分不得推断"></textarea></label></div></details>
      <div class="row between"><span class="muted">支持 TXT、Markdown、HTML</span><button class="btn primary" type="submit" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '导入中…' : '保存真实资料'}</button></div>
    </form></section><div class="source-category-list">${ui.state.sources.length ? ui.state.sources.map(source => { const [status, kind] = sourceStatus(source); return `<article class="card source-ledger-card"><div class="row between"><div class="row">${badge(source.kind === 'url' ? '网页' : source.kind.toUpperCase())}${badge(status, kind)}</div><span class="muted">${date(source.createdAt)}</span></div><h3>${esc(source.title)}</h3><div class="source-scope">${source.region ? badge(source.region) : badge('适用范围待补', 'warn')}${source.grade ? badge(source.grade) : badge('适用阶段待补', 'warn')}<span>${({ policy:'政策', school:'学校', competition:'竞赛', parent_question:'家长问题', product_fact:'产品事实', other:'其他' }[source.sourceType] || '其他')}</span><span>${({ official:'官方原文', organization:'机构公开信息', first_hand:'一手资料', platform:'平台讨论', other:'其他' }[source.sourceLevel] || '其他')}</span></div><details><summary>编辑资料台账</summary><div class="grid two-col"><label class="field">资料分类<select data-source-category="${esc(source.id)}"><option value="reference" ${source.category==='reference'?'selected':''}>参考内容</option><option value="product" ${source.category==='product'?'selected':''}>产品事实</option><option value="experience" ${source.category==='experience'?'selected':''}>亲历素材</option><option value="method" ${source.category==='method'?'selected':''}>历史方法自述</option><option value="policy" ${source.category==='policy'?'selected':''}>平台规则资料</option></select></label><label class="field">适用范围<input data-source-region="${esc(source.id)}" value="${esc(source.region || '')}" maxlength="160"></label><label class="field">适用阶段 / 场景<input data-source-grade="${esc(source.id)}" value="${esc(source.grade || '')}" maxlength="160"></label><label class="field">资料类型<select data-source-type="${esc(source.id)}"><option value="policy" ${source.sourceType==='policy'?'selected':''}>政策</option><option value="school" ${source.sourceType==='school'?'selected':''}>学校</option><option value="competition" ${source.sourceType==='competition'?'selected':''}>竞赛</option><option value="parent_question" ${source.sourceType==='parent_question'?'selected':''}>家长问题</option><option value="product_fact" ${source.sourceType==='product_fact'?'selected':''}>产品事实</option><option value="other" ${source.sourceType==='other'?'selected':''}>其他</option></select></label><label class="field">来源级别<select data-source-level="${esc(source.id)}"><option value="official" ${source.sourceLevel==='official'?'selected':''}>官方原文</option><option value="organization" ${source.sourceLevel==='organization'?'selected':''}>机构公开信息</option><option value="first_hand" ${source.sourceLevel==='first_hand'?'selected':''}>一手访谈 / 亲历</option><option value="platform" ${source.sourceLevel==='platform'?'selected':''}>平台讨论</option><option value="other" ${source.sourceLevel==='other'?'selected':''}>其他</option></select></label><label class="field">发布时间<input data-source-published="${esc(source.id)}" type="date" value="${esc(source.publishedAt || '')}"></label><label class="field">有效期至<input data-source-effective="${esc(source.id)}" type="date" value="${esc(source.effectiveUntil || '')}"></label><label class="field">核验状态<select data-source-verification="${esc(source.id)}"><option value="unverified" ${source.verificationStatus==='unverified'?'selected':''}>待人工核验</option><option value="verified" ${source.verificationStatus==='verified'?'selected':''}>已人工核验</option><option value="needs_update" ${source.verificationStatus==='needs_update'?'selected':''}>需更新</option></select></label></div><label class="field">备注<textarea data-source-note="${esc(source.id)}" rows="2" placeholder="资料范围、来源限制">${esc(source.note || '')}</textarea></label></details><p class="muted">${source.publishedAt ? `发布 ${esc(source.publishedAt)} · ` : ''}${source.effectiveUntil ? `有效至 ${esc(source.effectiveUntil)} · ` : ''}${number(source.text.length)} 字符 · ${source.chunks.length} 个资料片段</p><p>${esc(source.text.slice(0, 130))}…</p>${action('source', '查看资料与片段 ↗', `data-id="${esc(source.id)}"`, 'small')}</article>`; }).join('') : empty('还没有资料', '先导入一份资料；适用范围、时效与核验状态会跟着资料一起保存。')}</div></div>`;
}

function profilePage() {
  const profile = ui.state.profile;
  const accounts = ui.state.accounts || [];
  const fields = [['name', '账号名称', '未正式开设也可留空'], ['audience', '目标受众', '想帮助谁解决什么问题'], ['positioning', '账号定位', '内容范围、专业角色与差异'], ['tone', '表达风格', '例如：直接、具体、少术语'], ['productFacts', '已确认的产品或业务事实', '只填写有依据的信息；具体证据另行导入资料库'], ['restrictions', '内容边界', '不能承诺的效果、不能出现的信息或不适合的表达']];
  return `<div class="page-heading"><div><div class="eyebrow">账号档案与内容边界</div><h1>账号管理</h1><p class="muted">只记录真实账号或明确标为规划中的账号，不生成虚构案例。</p></div>${action('new-account','＋ 新建账号','','primary')}</div><div class="grid two-col">${accounts.map(account=>`<article class="card account-card"><div class="row between"><h2>${esc(account.name)}</h2>${badge(account.identity==='real'?'真实账号':'规划中账号',account.identity==='real'?'good':'warn')}</div><div class="row">${action('edit-account','编辑档案',`data-id="${esc(account.id)}"`,'small')}</div><p class="muted">${esc(account.matrixRole || '矩阵角色待补')} · ${esc(account.audience || '尚未填写受众')}</p><p class="muted">${esc(account.positioning || '尚未填写定位')}</p><details><summary>档案详情</summary><p>${esc(account.tone || '')}</p><p>${esc(account.productFacts || '')}</p><p>${esc(account.restrictions || '')}</p></details></article>`).join('')}${accounts.length? '' : empty('没有账号档案','可先建一个规划中账号，不会将它表述成真实运营账号。')}</div><details class="card"><summary>兼容旧版个人档案</summary><form data-form="profile" class="stack"><div class="grid two-col">${fields.map(([key, label, placeholder]) => `<label class="field">${label}${key === 'name' ? `<input id="profile-${key}" name="${key}" value="${esc(profile[key])}" placeholder="${placeholder}">` : `<textarea id="profile-${key}" name="${key}" rows="${['productFacts', 'restrictions'].includes(key) ? 5 : 3}" placeholder="${placeholder}">${esc(profile[key])}</textarea>`}</label>`).join('')}</div><button class="btn primary">保存旧版档案</button></form></details>`;
}

function analyticsPage() {
  const records = ui.state.tasks.filter(task => task.publication).sort((a, b) => String(b.publication.observedAt || b.updatedAt).localeCompare(String(a.publication.observedAt || a.updatedAt)));
  const known = key => records.filter(task=>knownMetric(task.publication?.metrics?.[key]));
  const sum = key => known(key).length ? known(key).reduce((total, task) => total + Number(task.publication.metrics[key]), 0) : null;
  const impressions = sum('impressions'); const saves = sum('saves'); const comments = sum('comments'); const qualifiedLeads = sum('qualifiedLeads');
  const sameScope=records.length>0&&records.every(t=>t.publication.platform&&t.publication.observedAt)&&new Set(records.map(t=>`${t.publication.platform}|${t.publication.observedAt}`)).size===1;
  const aggregateRate=key=>sameScope&&known(key).length===records.length&&known('impressions').length===records.length?rate(sum(key),impressions):'逐条查看';
  return `<div class="page-heading"><div><div class="eyebrow">发布后人工数据 · 不接入平台实时数据</div><h1>发布复盘</h1><p class="muted">把已发布内容的效果与有效咨询放在同一张工作台。只汇总你主动录入的数据，不推断未记录的曝光或拉新结果。</p></div>${badge(`${records.length} 条已记录内容`, records.length ? 'good' : 'warn')}</div>
    <div class="grid four-col analytics-metrics"><div class="metric"><span>已记录内容</span><strong>${records.length}</strong><small>已填写发布后数据</small></div><div class="metric"><span>曝光</span><strong>${metricNumber(impressions)}</strong><small>${known('impressions').length}/${records.length} 条已记录，不补零</small></div><div class="metric"><span>收藏率</span><strong>${aggregateRate('saves')}</strong><small>${known('saves').length}/${records.length} 条有收藏数据</small></div><div class="metric"><span>有效咨询</span><strong>${metricNumber(qualifiedLeads)}</strong><small>不等于成交或真实拉新</small></div></div>
    ${records.length ? `<section class="card analytics-table-wrap"><div class="row between"><div><h2>内容表现明细</h2><p class="muted">可按任务回到稿件页，补充原始数据或复盘备注。</p></div><span class="muted">评论率 ${aggregateRate('comments')}</span></div><div class="analytics-table-scroll"><table class="analytics-table"><thead><tr><th>内容任务</th><th>平台 / 日期</th><th>曝光</th><th>收藏率</th><th>评论率</th><th>有效咨询</th><th>复盘备注</th></tr></thead><tbody>${records.map(task => { const publication = task.publication; const metrics = publication.metrics || {}; return `<tr><td><button class="text-button analytics-task-link" data-action="open-task" data-id="${esc(task.id)}">${esc(task.title)} ↗</button><small>${esc(publication.contentType || '内容类型未填')}</small></td><td>${esc(publication.platform || '未填写')}<small>${esc(publication.observedAt || '观察日期未填')}</small></td><td>${metricNumber(metrics.impressions)}</td><td>${rate(metrics.saves, metrics.impressions)}</td><td>${rate(metrics.comments, metrics.impressions)}</td><td>${metricNumber(metrics.qualifiedLeads)}</td><td class="analytics-note">${esc(publication.note || '尚未填写')}</td></tr>`; }).join('')}</tbody></table></div><p class="muted analytics-footnote">口径：收藏率 = 收藏 / 曝光；评论率 = 评论 / 曝光。缺失字段显示“未记录”，不当作 0；仅当平台、观察日期一致且分子分母完整时汇总比率。有效咨询由人工按业务标准录入，系统不抓取私信、不识别个人信息，也不会自动分配销售线索。</p></section>` : empty('还没有发布复盘数据', '在任一稿件页完成发布后，填写链接、曝光、收藏、评论和有效咨询；这里才会出现真实汇总。')}`;
}

function leadHumanFields(lead) {
  const fields={...(lead.analysis||{}),...(lead.humanReview||{})};
  return `<details class="lead-human-review"><summary>人工校正与交接记录</summary><p class="muted">可修正 AI 的字段。确认交接时将冻结本次字段与备注，后续修改需重新确认。</p><div class="grid two-col">${[['region','地区'],['grade','学习 / 决策阶段'],['subject','主题 / 学习需求'],['demand','需求'],['suggestedReply','建议回复'],['handoffSummary','交接摘要']].map(([key,label])=>`<label class="field">${label}<textarea data-lead-field="${key}" data-lead-owner="${lead.id}" rows="2">${esc(fields[key]||'')}</textarea></label>`).join('')}<label class="field">需求类型<select data-lead-field="intent" data-lead-owner="${lead.id}">${[['unclear','待确认'],['policy','政策咨询'],['school','学校选择'],['competition','竞赛活动'],['subject_learning','学科学习'],['course_consult','课程 / 产品咨询'],['other','其他']].map(([value,label])=>`<option value="${value}" ${fields.intent===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="field">跟进优先级<select data-lead-field="priority" data-lead-owner="${lead.id}">${[['medium','信息待补'],['high','优先跟进'],['low','低优先']].map(([value,label])=>`<option value="${value}" ${fields.priority===value?'selected':''}>${label}</option>`).join('')}</select></label></div><label class="field">待补信息（每行一项）<textarea data-lead-field="missingFields" data-lead-owner="${lead.id}" rows="2">${esc((fields.missingFields||[]).join('\n'))}</textarea></label>${action('lead-save','保存人工校正',`data-id="${lead.id}"`,'small')}${lead.confirmedAt?`<p class="muted">交接字段确认于 ${date(lead.confirmedAt)}；以保存时的字段快照交接。</p>`:''}${lead.history?.length?`<details><summary>历史留痕 · ${lead.history.length} 次</summary>${lead.history.map(item=>`<p class="muted">${date(item.at||item.createdAt)} · ${esc(leadStatusLabel(item.after?.reviewStatus||item.action||'已记录修改'))}${item.after?.manualNote?` · ${esc(item.after.manualNote)}`:''}</p>`).join('')}</details>`:''}</details>`;
}
function readLeadHumanFields(card) {
  const result={};for(const field of card.querySelectorAll('[data-lead-field]'))result[field.dataset.leadField]=field.dataset.leadField==='missingFields'?field.value.split('\n').map(v=>v.trim()).filter(Boolean):field.value.trim();return result;
}
function leadsPage() {
  const leads = [...(ui.state.leads || [])].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const counts = {
    pending: leads.filter(lead => lead.reviewStatus === 'pending_review').length,
    ready: leads.filter(lead => lead.reviewStatus === 'ready_handoff').length,
    handed: leads.filter(lead => lead.reviewStatus === 'handed_off').length,
  };
  const demoText = ui.leadDemo ? '【虚构演示咨询】孩子现在五年级，在北京海淀，最近在看小升初信息。想知道官方通知一般要先看哪些材料？如果需要进一步判断，我可以补充孩子目前的学校情况。' : '';
  const taskOptions = (ui.state.tasks || []).map(task => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('');
  return `<div class="page-heading"><div><div class="eyebrow">AI 初判 · 人工确认后再交接</div><h1>真实咨询</h1><p class="muted">粘贴一条评论或私信，模型仅整理适用范围、学习或决策阶段、关注主题和需求；不自动抓取平台私信、不直接分配销售，也不会替你判断成交。</p></div><div class="row"><a class="btn small" href="/api/leads/export.csv" download>导出销售交接 CSV ↗</a>${action('lead-demo', '填充教育场景演示', '', 'small')}</div></div>
    <div class="grid three-col lead-metrics"><div class="metric"><span>待人工确认</span><strong>${counts.pending}</strong><small>AI 初判不等于已验证需求</small></div><div class="metric"><span>待销售确认</span><strong>${counts.ready}</strong><small>人工确认字段后才进入队列</small></div><div class="metric"><span>已交接</span><strong>${counts.handed}</strong><small>仅记录状态，不代表成交</small></div></div>
    <div class="lead-workspace"><section class="card lead-input"><div class="row between"><div><h2>录入一条咨询</h2><p class="muted">请不要填姓名、手机号、住址等个人信息。系统会对常见联系方式脱敏后保存并发送给模型。</p></div>${ui.leadDemo ? badge('虚构演示', 'warn') : ''}</div><form data-form="lead" class="stack"><div class="grid two-col"><label class="field">来源<select name="channel"><option value="comment">评论区</option><option value="direct_message">私信</option><option value="group">群聊</option><option value="manual">人工录入</option></select></label><label class="field">关联内容任务（可选）<select name="taskId"><option value="">不关联任务</option>${taskOptions}</select></label></div><label class="field">咨询原话<textarea name="rawText" rows="8" required placeholder="粘贴有权处理且已脱敏的用户问题；不确定的信息不要补写。">${esc(demoText)}</textarea></label><label class="check-row"><input type="checkbox" name="isDemo" ${ui.leadDemo ? 'checked' : ''}> 这是虚构演示，不代表真实用户咨询</label><label class="check-row"><input type="checkbox" name="runTriage" ${ui.state.provider?.ready ? '' : 'disabled'}> 保存后调用当前模型进行初步分拣（会消耗模型额度）</label><div class="notice warning">模型输出必须人工复核。AI 初判不等于通用 CRM；涉及政策、资格和服务承诺，必须核对原文。</div><button class="btn primary" type="submit" ${ui.busy ? 'disabled' : ''}>保存咨询（按勾选项决定是否 AI 分拣）</button></form></section>
      <section class="card lead-flow"><span class="eyebrow">交接规则</span><div class="lead-flow-steps"><div><span>01</span><strong>原话入库</strong><small>联系方式脱敏</small></div><div><span>02</span><strong>AI 初判</strong><small>字段与追问建议</small></div><div><span>03</span><strong>人工确认</strong><small>修正误判与边界</small></div><div><span>04</span><strong>销售交接</strong><small>CSV / 状态留痕</small></div></div><p class="muted">系统不接入平台账号，不抓取评论或私信。线上真实使用时，运营人员只将有权限处理的咨询内容粘贴到这里。</p></section></div>
    <section class="lead-list"><div class="row between"><div><h2>分拣队列</h2><p class="muted">“优先跟进”仅表示模型看到的信息更完整或有明确下一步，不代表转化概率。</p></div>${badge(`${leads.length} 条本地记录`)}</div>${leads.length ? `<div class="stack">${leads.map(lead => { const analysis = lead.analysis; const task = lead.taskId ? ui.state.tasks.find(item => item.id === lead.taskId) : null; const priorityClass = analysis?.priority === 'high' ? 'good' : analysis?.priority === 'medium' ? 'warn' : ''; return `<article class="card lead-card" data-lead-id="${esc(lead.id)}"><div class="row between"><div class="row">${badge(leadStatusLabel(lead.reviewStatus), lead.reviewStatus === 'handed_off' ? 'good' : lead.reviewStatus === 'excluded' ? '' : 'warn')}${lead.isDemo ? badge('虚构演示', 'warn') : badge('人工录入 · 未独立核验')}${analysis ? badge(leadPriorityLabel(analysis.priority), priorityClass) : badge('待 AI 初判', 'warn')}</div><span class="muted">${date(lead.updatedAt || lead.createdAt)}</span></div><div class="lead-card-grid"><div><span class="eyebrow">咨询原话${lead.channel === 'direct_message' ? ' · 私信' : lead.channel === 'comment' ? ' · 评论区' : ''}</span><p class="body-copy">${esc(lead.rawText)}</p>${task ? `<p class="muted">关联任务：${esc(task.title)}</p>` : ''}</div>${analysis ? `<div class="lead-analysis"><div class="lead-fields">${[['地区', analysis.region], ['阶段', analysis.grade], ['主题', analysis.subject], ['需求', analysis.demand]].map(([label, value]) => `<span><b>${label}</b>${esc(value || '待确认')}</span>`).join('')}</div><p><b>需求类型：</b>${esc(({ policy:'政策咨询', school:'学校选择', competition:'竞赛活动', subject_learning:'学科学习', course_consult:'课程 / 产品咨询', other:'其他', unclear:'待确认' }[analysis.intent] || analysis.intent))}</p><p><b>建议首回复：</b>${esc(analysis.suggestedReply)}</p><p><b>待补信息：</b>${analysis.missingFields?.length ? esc(analysis.missingFields.join('；')) : '模型未列出缺口，仍需人工核对'}</p><details><summary>查看交接摘要与判断依据</summary><p><b>销售交接摘要：</b>${esc(analysis.handoffSummary)}</p><p class="muted">AI 判断依据：${esc(analysis.reasoning)}${lead.model ? ` · ${esc(lead.model)}` : ''}</p></details></div>` : `<div class="lead-analysis empty-inline"><h3>还没有 AI 初判</h3><p>保存后可单独运行分拣；不会把空白字段自动补成结论。</p></div>`}</div>${leadHumanFields(lead)}<div class="lead-actions"><label class="field">人工备注<textarea data-lead-note="${esc(lead.id)}" rows="2" placeholder="补充已核验信息、追问结果或不交接原因">${esc(lead.manualNote || '')}</textarea></label><div class="row">${!analysis ? action('lead-classify', '运行 AI 分拣', `data-id="${esc(lead.id)}"`, 'primary') : ''}${action('lead-status', '待追问', `data-id="${esc(lead.id)}" data-status="follow_up"`, 'small')}${action('lead-status', '确认可交接', `data-id="${esc(lead.id)}" data-status="ready_handoff"`, 'small')}${action('lead-status', '标记已交接', `data-id="${esc(lead.id)}" data-status="handed_off" ${lead.reviewStatus==='ready_handoff'?'':'disabled'}`, 'small')}${action('lead-status', '不进入交接', `data-id="${esc(lead.id)}" data-status="excluded"`, 'small')}</div></div></article>`; }).join('')}</div>` : empty('还没有线索记录', '可先填充一条虚构演示咨询，提交后亲自运行 AI 分拣；真实使用时再录入经授权处理的内容。')}</section>`;
}

function caseReplayPage() {
  const candidate = ui.state.drafts.find(d=>d.id===ui.replayDraftId) || currentDraft() || [...ui.state.drafts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!candidate) return `<div class="page-heading"><div><div class="eyebrow">真实运行记录 · 不编造完成案例</div><h1>AI案例回放</h1><p class="muted">这里会把当前工作区真实完成的“输入 - AI - 人工 - 核验 - 交付”串成一条可讲解的链路。</p></div></div>${empty('还没有可回放案例', '先建立一条内容任务并完成至少一版稿件；或使用演示模式亲自跑完流程。')}</div>`;
  const task = ui.state.tasks.find(item => item.id === candidate.taskId);
  const versions = lineage(candidate);
  const first = versions.find(item => !item.parentId) || candidate;
  const latest = versions.at(-1) || candidate;
  const ids=new Set(versions.map(d=>d.id));
  const runs = ui.state.runs.filter(run => run.taskId === candidate.taskId && (['brief','plan'].includes(run.action)||ids.has(run.draftId)||ids.has(run.resultDraftId))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const sources = (task?.sourceIds || []).map(id => ui.state.sources.find(source => source.id === id)).filter(Boolean);
  const decisionKeys = new Set((ui.state.issueDecisions || []).filter(item => item.draftId === latest.id).map(item => item.issueKey));
  const totalIssues = latest.review?.issues?.length || 0;
  const unresolvedIssues = latest.review?.issues?.filter(issue => !decisionKeys.has(issue.id)).length || 0;
  const manualVersions = versions.filter(item => item.origin === 'manual').length;
  return `<div class="page-heading"><div><div class="eyebrow">真实保存记录 · 面试讲解模式</div><h1>AI案例回放</h1><p class="muted">用一条实际任务说明模型做了什么、人工改了什么、哪些内容必须回到原文核验。它不是“AI 自动完成”的包装。</p></div><div class="row">${action('open-task', '回到当前任务', `data-id="${esc(candidate.taskId)}"`, 'primary')}${latest.review ? action('evaluate', '核查此案例最新版', `data-draft-id="${latest.id}"`, 'small') : ''}</div></div>
    <label class="field replay-select">选择回放稿件链<select id="replay-draft-select">${ui.state.drafts.filter(d=>!ui.state.drafts.some(child=>child.parentId===d.id)).map(d=>`<option value="${esc(d.id)}" ${lineage(d).some(v=>v.id===candidate.id)?'selected':''}>${esc(ui.state.tasks.find(t=>t.id===d.taskId)?.title||'任务')} · v${d.version} · ${esc(d.title)}</option>`).join('')}</select></label><div class="grid four-col replay-metrics"><div class="metric"><span>引用资料</span><strong>${sources.length}</strong><small>只使用选定的本地资料</small></div><div class="metric"><span>模型运行</span><strong>${runs.filter(run => run.status === 'completed').length}</strong><small>记录模型调用与执行轨迹</small></div><div class="metric"><span>人工版本</span><strong>${manualVersions}</strong><small>不覆盖 AI 初稿</small></div><div class="metric"><span>待处理意见</span><strong>${unresolvedIssues}</strong><small>共 ${totalIssues} 条审核意见</small></div></div>
    <section class="card replay-timeline"><div class="row between"><div><h2>从输入到交付</h2><p class="muted">每一步均来自当前工作区已保存记录。</p></div>${badge(latest.review ? '已进入核验环节' : '尚未完成核验', latest.review ? 'good' : 'warn')}</div><div class="replay-steps"><article><span>01</span><div><strong>原始业务输入</strong><p>${esc(task?.brief || '任务内容已不可用')}</p></div></article><article><span>02</span><div><strong>区域资料与范围</strong><p>${sources.length ? esc(sources.map(source => `${source.title}${source.verificationStatus === 'verified' ? '（已核验）' : '（待核验）'}`).join('；')) : '未关联资料，不能将稿件视为政策或学校事实。'}</p></div></article><article><span>03</span><div><strong>AI 生成动作</strong><p>${runs.length ? esc(runs.map(run => `${stageLabel(run.action)}：${statusLabel(run)}`).join('；')) : '未留下模型运行记录；可能是人工导入稿。'}</p></div></article><article><span>04</span><div><strong>${first.origin==='ai'?'AI 初稿':first.origin==='imported'?'导入的原稿':'人工原稿'}</strong><p><b>${esc(first.title)}</b><br>${esc(first.body.slice(0, 180))}${first.body.length > 180 ? '…' : ''}</p></div></article><article><span>05</span><div><strong>人工修改与版本留痕</strong><p>${manualVersions ? esc(versions.filter(item => item.origin === 'manual').map(item => `v${item.version}：${item.changeNote || '未填写说明'}`).join('；')) : '本案例尚未保存人工版本；面试演示时应亲自说明还会怎样人工改写。'}</p></div></article><article><span>06</span><div><strong>事实核验与交付</strong><p>${latest.review ? esc(`审核结论：${latest.review.verdict}。${totalIssues ? `共 ${totalIssues} 条意见，需逐条处理或记录人工判断。` : '未发现具体意见，仍需人工终审。'}`) : '尚未运行独立质检，不能作为可发布或可交接成果。'}</p></div></article></div></section>
    <div class="grid two-col"><section class="card"><h2>面试时你可以这样讲</h2><ol class="replay-script"><li><b>输入：</b>我先把地区、学段、家长问题和允许使用的资料锁进任务，避免模型从标题推断政策细节。</li><li><b>AI：</b>模型负责选题、初稿、图文分页和初步质检；每条事实必须回链到资料片段。</li><li><b>人工：</b>我会保留版本链，确认标题、表达、转化入口和不该承诺的边界。</li><li><b>业务：</b>发布后录入曝光、收藏、评论和有效咨询；真实咨询再进入线索分拣和销售交接。</li></ol></section><section class="card"><h2>模型做不到的部分</h2><ul><li>不能替代官方政策、学校与竞赛信息的人工核验。</li><li>不能自动读取小红书或小绿书私信，也不会绕过用户授权收集个人信息。</li><li>不能把“初步意向”说成成交概率，更不会自动承诺升学或学习结果。</li><li>不能把本作品的运行记录和你的历史获客成果混为一谈。</li></ul></section></div>`;
}

function evaluationsPage() {
  const mode=ui.evaluationFilter||'all';
  const reports = evaluationReports().filter(report=>mode==='all'||(mode==='runs'?report.kind==='run-audit':report.kind!=='run-audit'));
  return `<div class="page-heading"><div><div class="eyebrow">自动核查 ≠ 真人评分</div><h1>质量核查记录</h1><p class="muted">对已保存稿件运行规则与来源检查。不把单份样本称为准确率，也不推断真实业务提升。</p></div></div>
    <div class="card evaluation-controls"><label class="field">明确选择核查对象<select id="evaluation-draft"><option value="">请选择稿件版本</option>${ui.state.drafts.filter(d=>d.review).map(d=>`<option value="${esc(d.id)}" ${ui.evaluationDraftId===d.id?'selected':''}>${esc(ui.state.tasks.find(t=>t.id===d.taskId)?.title||'任务')} · v${d.version} · ${esc(d.title)}</option>`).join('')}</select></label>${action('evaluate','生成所选稿件核查',ui.busy?'disabled':'','primary')}<p class="muted">执行运行核查请在任务的执行记录中选择一条运行。这里不会改选其他稿件。</p><div class="tab-bar" aria-label="评测类型">${[['all','全部记录'],['drafts','稿件质量核查'],['runs','执行运行核查']].map(([value,label])=>`<button type="button" class="tab ${mode===value?'selected':''}" data-action="evaluation-filter" data-filter="${value}">${label}</button>`).join('')}</div></div>${reports.length ? `<div class="stack">${reports.map(report => `<article class="card evaluation-card"><div class="row between"><div><h2>${esc(report.title || '已保存稿件核查')}</h2><p class="muted">${date(report.createdAt)} · ${esc(({ 'run-audit':'执行运行核查','saved-draft-audit':'稿件质量核查','single-call-comparison':'工作流与单次调用对照' })[report.kind] || '自动核查')} · ${number(report.sampleCount)} 项</p></div>${badge(report.kind==='run-audit'?'执行记录':'仅自动检查')}</div>${report.run ? `<div class="run-audit"><div class="grid three-col">${[['状态',statusLabel(report.run)],['模型请求',report.run.requests],['输入 tokens',report.run.inputTokens],['输出 tokens',report.run.outputTokens],['失败请求',report.run.failedRequests],['耗时',report.run.durationMs==null?'未知':`${Math.round(report.run.durationMs/1000)} 秒`]].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${esc(value??'未知')}</strong></div>`).join('')}</div><p class="muted">${esc(report.run.model||'模型尚未响应')} · 用量未知：${report.run.usageUnknown?'是':'否'} · 失败请求可能产生费用。</p>${report.run.error?`<p class="alert error">${esc(report.run.error)}</p>`:''}${(report.run.events||[]).length?`<details><summary>执行过程 · ${(report.run.events||[]).length} 条</summary><div class="timeline">${report.run.events.map(e=>`<div class="event"><strong>${esc(e.title)}</strong><p>${esc(e.detail)}</p></div>`).join('')}</div></details>`:''}</div>`:''}${(report.drafts || []).map(item => `<section class="card"><div class="row between"><strong>${esc(item.title)} · v${number(item.version)}</strong>${badge(qualityLabel(item.automatic?.readiness), item.automatic?.readiness === 'ready' ? 'good' : 'warn')}</div><div class="grid three-col">${[['核查项', item.automatic?.checks?.length], ['待处理问题', item.automatic?.issueCount], ['可定位意见', item.automatic?.locatedIssueCount]].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${number(value)}</strong></div>`).join('')}</div></section>`).join('')}<p class="muted">人工评价：${esc(report.human?.status === 'not_collected' ? '未收集' : report.human?.status || '未记录')} · 不构成准确率</p>${(report.limitations || []).length ? `<details><summary>评测范围与限制</summary><ul>${report.limitations.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}</article>`).join('')}</div>` : empty('尚无核查报告', '报告基于真实保存的稿件生成；不会创建虚构样本或自动调用模型。')}</div>`;
}

function renderModal() {
  const root = $('modal-root'); if (!root) return;
  const shell = (title, content) => `<div class="drawer-backdrop" data-action="close-modal"></div><section class="drawer modal-drawer" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="row between"><h2 id="modal-title">${esc(title)}</h2>${action('close-modal','×','','close')}</div>${content}</section>`;
  if (ui.modal === 'account') {
    const account = ui.state.accounts.find(item => item.id === ui.modalAccountId) || {};
    root.innerHTML = shell(account.id ? '编辑账号档案' : '新建账号档案', `<form data-form="account" data-record-id="${esc(account.id || '')}" class="stack">${businessInput('name','账号名称',account.name,'text',true)}${businessSelect('identity','账号状态',[['planning','规划中'],['real','真实账号']],account.identity || 'planning')}${businessInput('matrixRole','矩阵角色',account.matrixRole)}${businessText('audience','目标受众',account.audience)}${businessText('positioning','账号定位',account.positioning)}${businessText('tone','表达风格',account.tone)}${businessText('productFacts','已确认业务事实',account.productFacts)}${businessText('restrictions','内容边界',account.restrictions)}<p class="muted">修改影响内容的账号信息后，相关稿件需要重新审核；不会改写原稿。</p><button class="btn primary">保存账号</button></form>`);
  } else if (ui.modal === 'task-edit') {
    const task = ui.state.tasks.find(item => item.id === ui.modalTaskId); if (!task) return;
    const accountLocked = task.accountId && ui.state.drafts.some(draft => draft.taskId === task.id);
    root.innerHTML = shell('编辑任务要求', `<form data-form="task-update" data-task-id="${esc(task.id)}" class="stack">${businessInput('title','任务标题',task.title,'text',true)}${businessText('brief','受众、目标与交付要求',task.brief)}${businessInput('owner','负责人',task.owner)}<label class="field">关联账号<select name="accountId" ${accountLocked?'disabled':''}><option value="">暂不分配账号</option>${ui.state.accounts.filter(a=>!a.archived || a.id===task.accountId).map(a=>`<option value="${esc(a.id)}" ${a.id===task.accountId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label>${accountLocked?`<input type="hidden" name="accountId" value="${esc(task.accountId)}"><p class="muted">已有稿件的账号不能更换；可编辑该账号档案。尚未分配账号的任务可以补关联。</p>`:''}<fieldset><legend>本次允许使用的资料</legend>${ui.state.sources.filter(source=>!source.archived || task.sourceIds.includes(source.id)).map(source=>`<label class="check-row"><input type="checkbox" name="sourceIds" value="${esc(source.id)}" ${task.sourceIds.includes(source.id)?'checked':''}>${esc(source.title)}</label>`).join('')}</fieldset><p class="notice">变更要求、资料或补关联账号会使旧审核过期；重新审核和人工采纳后才能交付。</p><button class="btn primary">保存任务要求</button></form>`);
  } else if (ui.modal === 'deliver') {
    const task = ui.state.tasks.find(item => item.id === ui.modalTaskId);
    root.innerHTML = shell(task ? '交稿到当前任务' : '提交现成稿件', `<p class="muted">${task ? '保存到「'+esc(task.title)+'」，沿用账号、资料和协作记录；不覆盖已有稿件。' : '在收件箱创建独立审核任务；不会覆盖已有任务。'}</p><form data-form="draft-import" data-task-id="${esc(task?.id || '')}" class="stack">${task ? '' : `${businessInput('taskTitle','任务标题','','text',true)}${businessText('taskBrief','交付要求','')}`}${businessInput('title','稿件标题','','text',true)}<label class="field">正文<textarea name="body" rows="10" required></textarea></label>${businessText('cover','封面文案','')}${businessInput('author','作者','')}${businessInput('changeNote','版本说明','')}${task ? '' : `<label class="field">关联账号<select name="accountId"><option value="">暂不分配</option>${ui.state.accounts.filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><fieldset><legend>相关资料</legend>${ui.state.sources.filter(source=>!source.archived).map(source=>`<label class="check-row"><input type="checkbox" name="sourceIds" value="${esc(source.id)}">${esc(source.title)}</label>`).join('') || '<p class="muted">暂未导入资料，先保存原稿。</p>'}</fieldset>`}<p class="muted">本次只保存稿件，不自动调用 AI。确认资料和模型配置后，可手动启动审核。</p><button class="btn primary" data-import-submit>保存稿件到${task ? '当前任务' : '新任务'}</button></form>`);
  } else root.innerHTML = '';
}

function inboxPage() {
  const tasks = taskList('all', '', ui.includeDemo);
  const visibleTasks = taskList(ui.filter, ui.search, ui.includeDemo);
  const filters = [['all','全部'],['input','待补充'],['review','待审核 / 修改'],['delivery','交付 / 复盘'],['in_progress','处理中'],['archived','已归档']];
  const versions = ui.state.drafts.filter(draft => tasks.some(task => task.id === draft.taskId));
  return `<div class="page-heading"><div><div class="eyebrow">任务收件箱 · ${tasks.length} 项</div><h1>内容任务</h1><p class="muted">与工作台使用相同的阶段口径；默认不混入演示任务。</p></div><div class="row">${action('new-task','＋ 新建任务单','','primary')}${action('deliver-draft','提交独立稿件','','small')}</div></div><div class="inbox-toolbar"><label class="search-field"><span aria-hidden="true">⌕</span><input id="task-search" type="search" aria-label="搜索内容任务" value="${esc(ui.search)}" placeholder="搜索任务标题、背景或受众问题"></label><label class="check-row"><input type="checkbox" id="include-demo" ${ui.includeDemo?'checked':''}>包含演示任务</label></div><div class="tab-bar" aria-label="按任务阶段筛选">${filters.map(([id,label])=>`<button class="tab ${ui.filter===id?'selected':''}" data-action="filter" data-filter="${id}">${label} · ${taskList(id,'',ui.includeDemo).length}</button>`).join('')}</div><p class="muted">${visibleTasks.length} 项匹配任务 · ${versions.length} 个保留版本</p>${visibleTasks.length ? `<div class="stack">${visibleTasks.map(task=>taskCard(task)).join('')}</div>` : empty('没有匹配任务', '清空搜索、切换阶段，或新建一个真实内容任务。')}<details class="card secondary-demo"><summary>需要先体验？使用已标明的虚构练习</summary><p class="muted">仅为熟悉流程，不是真实项目或业务效果。创建练习本身不调用模型。</p>${action('demo-fill','填充演示内容','','small')}</details>`;
}

// Keep task intake language aligned with a general Xiaohongshu content operation workflow.
function newTaskForm() {
  const demo = ui.demoPrefill || {};
  const value = key => esc(demo[key] || '');
  return `<details class="card" ${ui.showNewTask ? 'open' : ''}><summary>＋ 创建小红书内容任务</summary><form data-form="task" class="stack"><div class="grid two-col"><label class="field">业务背景 / 适用范围<input name="region" value="${value('region')}" placeholder="例如：成人教育、职场转型、某城市用户"></label><label class="field">目标人群 / 所处阶段<input name="grade" value="${value('grade')}" placeholder="例如：准备转行、首次购买、复购用户"></label><label class="field">主题 / 选题方向<input name="subject" value="${value('subject')}" placeholder="例如：矩阵协作、内容复盘、产品体验"></label><label class="field">内容形式<select name="platform"><option ${demo.platform === '小红书图文' ? 'selected' : ''}>小红书图文</option><option>小红书短视频脚本</option><option>两种版本</option></select></label></div><label class="field">目标受众正在问什么<textarea name="parentQuestion" rows="2" placeholder="写一个具体问题；不确定可留空">${value('parentQuestion')}</textarea></label><label class="field">本次内容目标<input name="objective" value="${value('objective')}" placeholder="例如：建立认知、提高收藏、承接咨询或验证选题"></label><label class="field">成功指标（可留空）<input name="successMetric" value="${value('successMetric')}" placeholder="例如：收藏率、有效咨询量、线索成本；没有数据不要估填"></label><label class="field">任务标题<input id="task-title" name="title" value="${value('title')}" maxlength="200" placeholder="留空时自动生成"></label><label class="field">补充要求<textarea id="task-brief" name="brief" rows="3" placeholder="例如：只根据已选资料；不把经验写成平台规则；输出标题、正文和分页">${value('brief')}</textarea></label><label class="field">关联账号<select name="accountId"><option value="">暂不分配账号</option>${(ui.state.accounts || []).filter(a => !a.archived).map(a => `<option value="${esc(a.id)}" ${a.id === demo.accountId ? 'selected' : ''}>${esc(a.name)}${a.identity === 'planning' ? ' · 规划中' : ''}</option>`).join('')}</select></label><label class="field">负责人<input name="owner" value="${value('owner')}" placeholder="可留空"></label><fieldset><legend>本次允许使用的资料</legend>${ui.state.sources.length ? ui.state.sources.map(source => `<label class="row source-choice"><input id="select-${source.id}" name="sourceIds" type="checkbox" value="${esc(source.id)}" ${source.id === demo.sourceId ? 'checked' : ''}><span><strong>${esc(source.title)}</strong>${source.text.length < 240 ? '<small> · 正文过短，可能仅有标题</small>' : ''}</span></label>`).join('') : `<p class="muted">尚无资料。先导入真实素材，避免无依据地生成内容。</p>`}</fieldset>${ui.demoPrefill ? '<div class="notice warning">当前为虚构练习：练习账号与资料已保存，任务仍待创建。结果不可当作真实项目、平台规则或业务效果发布。</div>' : ''}<div class="row between"><span class="muted">创建任务本身不调用模型；运行 AI 时会发送选定资料至已配置模型服务。</span><button class="btn primary" ${ui.busy ? 'disabled' : ''}>创建任务单</button></div></form></details>`;
}

function workPage() {
  const task = currentTask();
  const draft = currentDraft();
  const tasks = ui.state.tasks;
  const currentStage = task ? stageForTask(task, ui.state.drafts, ui.state.runs, ui.state.quality) : 'brief';
  const stageOrder = ['brief', 'materials', 'review', 'delivery'];
  const stageNames = { brief: '任务要求', materials: '资料与稿件', review: 'AI 核验', delivery: '人工处理与导出' };
  const visibleStage = currentStage === 'production' ? 'review' : currentStage;
  const stageIndex = stageOrder.indexOf(visibleStage);
  const next = task ? nextActionForTask(task, ui.state.drafts, ui.state.runs, ui.state.quality) : null;
  if (ui.inbox) return inboxPage();
  if (ui.showNewTask) return `<div class="page-heading compact-heading"><div><div class="eyebrow">独立创建 · 不修改已有任务</div><h1>新建内容任务</h1></div>${action('back-inbox','返回收件箱','','small')}</div>${newTaskForm()}`;
  return `<div class="page-heading compact-heading"><div><div class="eyebrow">${esc(taskStatusLabel(task?.status))} · ${esc(task?.owner || '未分配负责人')}</div><h1>${esc(task?.title || task?.brief?.slice(0, 55) || '内容工作台')}</h1><p class="muted">${task ? `${esc(task.accountId ? ui.state.accounts?.find(a => a.id === task.accountId)?.name || '账号已归档' : '未分配账号')} · ${task.sourceIds.length} 份资料 · ${ui.state.drafts.filter(d => d.taskId === task.id).length} 个稿件版本` : '从真实任务开始；不预置演示数据。'}</p></div><div class="row">${action('back-inbox','返回收件箱','', 'small')}${task ? action('edit-task','编辑任务要求','','small') + action('deliver-draft','＋ 交稿到此任务',`data-task-id="${esc(task.id)}"`,'small') : ''}</div></div>

    ${tasks.length ? `<div class="task-selector row between"><label class="field">当前任务<select id="task-select">${tasks.map(item => `<option value="${esc(item.id)}" ${item.id === ui.taskId ? 'selected' : ''}>${esc(item.title)}</option>`).join('')}</select></label><span class="muted">${date(task?.createdAt)}</span></div>` : ''}
    ${task ? `${ui.tab==='plan' ? `<section class="card task-brief"><details open><summary>任务要求与补充对话 <span class="muted">· ${task.sourceIds.length} 份资料</span></summary><p class="body-copy">${esc(task.brief)}</p>${(task.messages || []).map(message => `<p class="task-message"><strong>${message.role === 'user' ? '你' : '工作台'} · ${date(message.createdAt)}</strong><br>${esc(message.text)}</p>`).join('')}<form data-form="message" class="stack"><textarea id="task-message" name="text" rows="2" placeholder="补充要求、回答待确认问题或追加背景…"></textarea><fieldset><legend>追加资料（已关联资料保留）</legend>${ui.state.sources.filter(s=>!s.archived&&!task.sourceIds.includes(s.id)).map(source=>`<label class="row"><input type="checkbox" name="sourceIds" value="${esc(source.id)}">${esc(source.title)}</label>`).join('')||'<p class="muted">没有可追加资料，可先去区域资料页导入。</p>'}</fieldset><div class="row"><button class="btn" ${ui.busy ? 'disabled' : ''}>补充到任务</button>${action('brief','根据补充更新任务单',disabled(),'small')}</div></form></details></section>` : ''}
      <div class="progress workflow-progress"><div class="workflow-progress-copy"><span class="eyebrow">四步工作流</span><strong>${stageNames[visibleStage] || '任务要求'}</strong><span class="muted">下一步：${next?.label || '补充需求'}</span></div><div class="workflow-steps">${stageOrder.map((stage, index) => { const done = index < stageIndex || (stage === 'delivery' && visibleStage === 'delivery'); return `<div class="step ${done ? 'done' : ''} ${stage === visibleStage ? 'current' : ''}" title="${esc(stageNames[stage])}"><span>${done ? '✓' : String(index + 1).padStart(2, '0')}</span>${stageNames[stage]}</div>`; }).join('')}</div></div>
      ${!ui.state.provider?.ready ? '<div class="notice warning">模型尚未配置：可以整理资料、编辑任务和保存稿件；AI 生成、审稿与改稿暂不可用。配置模型后再启动，不会伪造审核结果。</div>' : ''}${runBanner(task)}
      <div class="tab-bar" role="tablist" aria-label="任务视图">${[['plan', '需求与资料'], ['draft', '稿件审核'], ['delivery', '交付复盘'], ['logs', '执行记录']].map(([id, label]) => `<button class="tab ${ui.tab === id ? 'selected' : ''}" role="tab" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${label}${id === 'logs' ? ` <small>${ui.state.runs.filter(r => r.taskId === task.id).length}</small>` : ''}</button>`).join('')}</div>
      ${ui.tab === 'plan' ? planPanel(task) : ui.tab === 'logs' ? logsPanel(task) : draftPanel(task, draft)}` : inboxPage()}`;
}

function assignmentView(assignment) {
  return `<div class="assignment"><strong>任务单 · 当前信息</strong>${[['受众', assignment.audience],['目标', assignment.objective],['表达角度', assignment.angle]].filter(([,v]) => v).map(([label,value]) => `<p><span>${label}：</span>${esc(value)}</p>`).join('')}${[['facts','已知事实'],['materials','可用材料'],['deliverables','交付清单'],['criteria','验收标准'],['questions','待补充问题']].filter(([key])=>assignment[key]?.length).map(([key,label])=>`<section><h4>${label}</h4><ul>${assignment[key].map(value=>`<li>${esc(typeof value==='string'?value:JSON.stringify(value))}</li>`).join('')}</ul></section>`).join('')}</div>`;
}

function runBanner(task) {
  const run = ui.state.runs.find(item => item.taskId === task.id);
  if (!run) return '';
  if (['queued', 'running'].includes(run.status)) return `<div class="alert progress-banner"><div><strong>${stageLabel(run.action)} · ${statusLabel(run)}</strong><p>${esc(run.events.at(-1)?.title || '等待开始')}</p><span class="muted">可以查看执行记录。内容完成后会自动出现。</span></div>${action('cancel', '停止本次运行', `data-id="${run.id}"`, 'small')}</div>`;
  if (run.status === 'failed') return `<div class="alert error"><div><strong>${stageLabel(run.action)} · ${statusLabel(run)}</strong><p>${esc(run.error)}</p>${run.resultDraftId ? '<p>已有草稿仍保留，审核尚未完成时请先重新质检。</p>' : ''}</div>${action('retry', '重试本次操作', `data-id="${run.id}" ${disabled()}`, 'small')}</div>`;
  return '';
}

function planPanel(task) {
  const brief=`<section class="card"><div class="row between"><h2>任务单</h2>${action('brief',task.assignment?'根据补充更新任务单':'整理任务单',disabled(),task.assignment?'small':'primary')}<a class="btn small" href="/api/tasks/${task.id}/export" download>导出任务单</a></div>${task.assignment?assignmentView(task.assignment):'<p class="muted">先整理受众、目标、材料、交付要求和待补信息；有现成稿件也可直接审稿。</p>'}</section>`;
  if (!task.plan) return `${brief}<section class="card">${empty('尚无选题计划', '如果需要从资料开始创作，可独立生成选题。已有稿件无需经过选题步骤。')}<div class="row">${action('plan', '生成选题计划', disabled()+(task.sourceIds.length?'':' disabled'), task.assignment?'primary':'small')}</div></section>`;
  return `${brief}<div class="row between panel-heading"><p>${esc(task.plan.summary)}</p>${ui.state.drafts.some(d => d.taskId === task.id) ? '<span class="muted">已有稿件；更换选题方向请新建任务。</span>' : action('plan', '重新规划', disabled(), 'small')}</div><div class="grid three-col">${task.plan.topics.map((topic, index) => `<article class="card topic-card"><div class="row between"><span class="eyebrow">选题 ${String(index + 1).padStart(2, '0')}</span>${badge(topic.format)}</div><h2>${esc(topic.title)}</h2><p class="muted">${esc(topic.audience)}</p><p>${esc(topic.angle)}</p><dl><dt>内容目标</dt><dd>${esc(topic.goal)}</dd><dt>为什么选它</dt><dd>${esc(topic.why)}</dd></dl><div class="row">${topic.sourceRefs.map((ref, n) => citation(ref, `依据 ${n + 1} ↗`)).join('')}</div>${topic.gaps.length ? `<details><summary>素材缺口 · ${topic.gaps.length}</summary><ul>${topic.gaps.map(gap => `<li>${esc(gap)}</li>`).join('')}</ul></details>` : ''}${action('draft', '用这个选题成稿 →', `data-topic="${topic.id}" ${disabled()}`, 'primary')}</article>`).join('')}</div>${task.plan.questions.length ? `<section class="card"><h3>需要你补充判断</h3><ul>${task.plan.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></section>` : ''}`;
}

function draftPanel(task, draft) {
  if (!draft) return `<section class="card">${empty(task.plan ? '选一个方向，开始成稿' : '先有依据，再开始写', task.plan ? '到选题计划中选择一篇，系统将生成正文、封面和图文页大纲，并单独质检。' : '等待选题生成，或在选题计划页开始任务。')}${action('tab', '查看选题计划 →', 'data-tab="plan"', 'primary')}</section>`;
  const delivery = ui.tab === 'delivery';
  const versions = ui.state.drafts.filter(item => item.taskId === task.id);
  const chain = lineage(draft);
  const editorPages=Array.from({length:Math.max(draft.pages.length||1,ui.editorPageCount||0)},(_,index)=>draft.pages[index]||{heading:'',text:''});
  const publication=task.publication?.draftId===draft.id?task.publication:null;
  const preflight=task.preflight?.draftId===draft.id?task.preflight:null;
  const otherPublication=task.publication&&!publication?task.publication:null;
  const nextExists = versions.some(item => item.parentId === draft.id);
  const feedback = ui.state.feedback.filter(item => item.draftId === draft.id);
  const decisions = (ui.state.issueDecisions || []).filter(item => item.draftId === draft.id && item.reviewRevision === draft.reviewRevision);
  const quality = ui.state.quality?.[draft.id] || (ui.qualityDraftId===draft.id ? ui.qualityReport : null);
  const reviewedFacts = quality?.facts || draft.review?.facts || [];
  const reviewIssues = quality?.issues || draft.review?.issues || [];
  const evidenceItems = [...(draft.evidence||[]),...reviewedFacts.filter(f=>f.sourceRef)].filter((item,index,list)=>item.sourceRef&&list.findIndex(other=>other.sourceRef===item.sourceRef&&other.claim===item.claim)===index);
  const exportSafety = inspectExportSafety(draft);
  const assets = exportSafety.blocked ? [] : visualAssets(draft);
  const unresolvedIssues = quality?.issues?.filter(item => !item.decision) || [];
  const nextActions = [];
  if (draft.reviewStale) nextActions.push(draft.reviewStaleReason || '要求或资料已变更，请重新审核');
  else if (!draft.review) nextActions.push('先运行独立质检');
  if (unresolvedIssues.some(item => item.blocking)) nextActions.push('先处理阻断问题');
  else if (unresolvedIssues.length) nextActions.push('人工确认待核对项');
  if (draft.gaps.length) nextActions.push(`补充或确认 ${draft.gaps.length} 项素材边界`);
  return `<div class="row between version-row"><div class="row"><label class="field">查看稿件<select id="draft-select">${versions.map(item => `<option value="${item.id}" ${item.id === draft.id ? 'selected' : ''}>v${item.version} · ${esc(item.title)}</option>`).join('')}</select></label>${badge(draft.reviewStale ? '审核已过期' : draft.status === 'accepted' ? '已采纳' : draft.status === 'needs_changes' ? '待修改' : '待人工审阅', draft.reviewStale ? 'warn' : draft.status === 'accepted' ? 'good' : '')}</div><div class="row">${delivery ? (exportSafety.blocked ? '<span class="badge bad">含敏感凭据，禁止导出</span>' : `<a class="btn primary" href="/api/drafts/${draft.id}/export?format=md" download>导出发布文案 ↗</a><a class="btn small" href="/api/drafts/${draft.id}/export?format=json&includeEvidence=1" download>证据包 ↗</a><a class="btn small" href="/api/tasks/${task.id}/lead-handoff.csv" download>销售交接 ↗</a>`) : `<button class="btn small" data-action="edit-draft" ${nextExists ? 'disabled' : ''}>人工编辑</button>`}</div></div>
    ${draft.reviewStale ? `<div class="notice warning"><strong>旧审核不能继续用于采纳或交付。</strong> ${esc(draft.reviewStaleReason || '要求、资料或账号已变更，请重新审核。')}</div>` : ''}
    ${delivery && !canAccept(quality,draft) ? '<div class="notice warning">此稿尚未通过当前检查。可查看内容与历史数据，不能据此认定可发布；请先回到“产出与审核”。</div>' : ''}
    ${exportSafety.blocked ? '<div class="notice warning">检测到疑似敏感凭据：已禁止文案和图片导出。请人工编辑新版本移除凭据，再重新审核；不能通过忽略意见解除限制。</div>' : ''}
    ${exportSafety.hasContactDetails ? '<p class="notice">导出中的联系方式默认隐藏；原稿保持不变。</p>' : ''}
    ${chain.length > 1 ? `<details class="version-compare card"><summary>比较版本差异</summary><label class="field">与版本比较<select id="compare-select">${chain.filter(v=>v.id!==draft.id).map(v=>`<option value="${v.id}">v${v.version} · ${esc(v.title)}</option>`).join('')}</select></label>${action('compare','查看差异','', 'small')}${ui.comparison ? `<div class="diff-fields">${ui.comparison.fields.map(field=>`<details><summary>${esc(fieldLabel(field.field))} ${field.changed ? '· 有修改' : '· 未变化'}</summary><pre>${(field.diff||[]).map(part=>`<span class="diff-${part.type}">${esc(part.text)}</span>`).join('')}</pre></details>`).join('')}</div>`:''}</details>` : ''}
    ${ui.editing ? `<form class="card edit-form" data-form="edit"><label class="field">标题<input name="title" value="${esc(draft.title)}"></label><label class="field">正文<textarea name="body" rows="14">${esc(draft.body)}</textarea></label><label class="field">封面<textarea name="cover" rows="2">${esc(draft.cover)}</textarea></label><label class="field">标签（用逗号分隔）<input name="tags" value="${esc(draft.tags.join('，'))}"></label><details><summary>编辑图文分页</summary>${editorPages.map((page,index)=>`<fieldset><legend>第 ${index+1} 页</legend><label class="field">页标题<input name="page-heading-${index}" value="${esc(page.heading)}"></label><label class="field">页正文<textarea name="page-text-${index}" rows="5">${esc(page.text)}</textarea></label></fieldset>`).join('')}${action('add-page','增加一页','','small')}<p class="muted">页标题与正文同时留空时，该页不会保存。</p></details><fieldset><legend>锁定字段：生成式改稿不得变更</legend>${['title','body','cover','pages'].map(field=>`<label><input type="checkbox" name="lockedFields" value="${field}" ${draft.lockedFields?.includes(field)?'checked':''}> ${fieldLabel(field)}</label>`).join(' ')}</fieldset><label class="field">版本说明<input name="changeNote" required placeholder="说明本次人工修改"></label><div class="row"><button class="btn primary" type="submit">保存为新版本</button>${action('cancel-edit','取消')}</div></form>`:''}
    ${!delivery ? `<div class="mobile-work-actions"><button type="button" class="btn small" data-action="jump-copy">查看正文</button><button type="button" class="btn small" data-action="jump-review">审稿与修改 ${reviewIssues.filter(i=>!i.decision).length}</button></div>` : ''}<div class="draft-layout ${delivery ? 'delivery-layout' : ''}"><div id="draft-copy" class="draft-main stack"><details class="card draft-text" ${delivery ? '' : 'open'}><summary>${delivery ? '查看待交付文案' : '稿件正文'}</summary><article><div class="row between"><span class="eyebrow">正文 · v${draft.version}</span><span class="muted">${date(draft.createdAt)}</span></div><h2 data-copy-field="title">${esc(draft.title)}</h2><p data-copy-field="body" class="body-copy selectable-copy" data-field="body">${esc(draft.body)}</p><div class="tags">${draft.tags.map(tag => `<span>${esc(tag.startsWith('#') ? tag : '#' + tag)}</span>`).join('')}</div></article></details>
      <details class="card copy-pages"><summary>封面与分页文案 · 可定位原句</summary><h3>封面</h3><p class="body-copy" data-copy-field="cover">${esc(draft.cover)}</p>${draft.pages.map((page,index)=>`<section><h3 data-copy-field="pages.${index}.heading">${esc(page.heading)}</h3><p class="body-copy" data-copy-field="pages.${index}.text">${esc(page.text)}</p></section>`).join('')}</details>${delivery ? `<details class="card visual-delivery"><summary>图文模板与发布前检查 · ${assets.length} 张素材</summary><div class="row between"><div><h3>图文素材交付</h3><p class="muted">将已生成的封面与分页文案排成固定尺寸 SVG 卡片。文字过长会拆页，下载后可交给设计继续制作，或直接作为轻量图文素材使用。</p></div><div class="row">${badge(`${assets.length} 张模板素材`, 'good')}${action('download-visuals', '下载整套 SVG', exportSafety.blocked ? 'disabled' : '', 'small')}</div></div><div class="visual-grid">${assets.map((asset, index) => `<article class="visual-card"><img loading="lazy" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(visualSvg(draft, asset, index, assets.length))}" alt="${esc((asset.kind === 'cover' ? '封面图文素材' : `图文素材第 ${asset.sourcePage} 页`)+(asset.parts>1?` · ${asset.part}/${asset.parts}`:''))}"><div class="visual-card-footer"><span>${asset.kind === 'cover' ? `封面${asset.parts > 1 ? `-${asset.part}` : ''}` : `第 ${asset.sourcePage} 页${asset.parts > 1 ? ` · ${asset.part}/${asset.parts}` : ''}`}</span><div class="row visual-downloads">${action('download-png', 'PNG', `data-asset-index="${index}"`, 'small')}${action('download-visual', 'SVG', `data-asset-index="${index}"`, 'small')}</div></div></article>`).join('')}</div><form data-form="preflight" class="platform-preflight"><div class="row between"><div><h4>发布前人工检查</h4><p class="muted">${preflight ? `最近保存：${date(preflight.checkedAt)}` : '本版尚未保存人工检查；旧版检查不会自动沿用。'}</p></div><label class="field compact-field">平台<select name="platform"><option value="小红书" ${preflight?.platform === '小红书' ? 'selected' : ''}>小红书</option><option value="小绿书" ${preflight?.platform === '小绿书' ? 'selected' : ''}>小绿书</option></select></label></div><div class="preflight-checks">${[['title','标题是受众正在问的具体问题'],['cover','封面一眼说清信息价值'],['opening','前两行能承接阅读'],['search','已补搜索关键词与标签'],['comment','已准备评论区引导'],['directMessage','已确认私信承接动作'],['persona','表达符合账号人设'],['risk','不含未核验事实或效果承诺']].map(([key,label]) => `<label><input type="checkbox" name="${key}" ${preflight?.checks?.[key] ? 'checked' : ''}>${label}</label>`).join('')}</div><label class="field">发布前备注<textarea name="note" rows="2" placeholder="例如：政策时间仍待官方原文复核，暂不发布">${esc(preflight?.note || '')}</textarea></label><button class="btn small" type="submit">保存发布前检查</button></form><p class="muted visual-boundary">PNG 与 SVG 均由模板渲染生成，不是 AI 图片生成；目前未接入实拍素材、品牌图库或自动制图。</p></details>` : ''}
      ${!delivery ? `<details class="card"><summary>事实与来源 · ${evidenceItems.length} 条引用</summary><p class="muted">点击引用可对照资料原文。来源存在不代表事实已独立核验。</p>${evidenceItems.map(item => `<div class="evidence-row"><p>${esc(item.claim)}</p>${citation(item.sourceRef,'查看对应依据 ↗',item.sourceQuote||'')}</div>`).join('') || '<p class="muted">本版尚无可定位来源。请补充资料并重新审核，当前不能证明稿件事实有据。</p>'}</details>` : ''}${delivery ? `<details class="card"><summary>发布后复盘 · 手动填写真实数据</summary><div class="row between"><div><h3>发布后复盘</h3><p class="muted">${publication ? `当前记录对应 v${draft.version}` : `此稿 v${draft.version} 暂无发布记录`}；未知数据留空，不当作 0。</p></div>${publication ? badge('当前版本已有记录', 'good') : badge('待发布后填写', 'warn')}</div>${otherPublication ? `<div class="notice warning">本任务的已有发布记录属于${otherPublication.version ? ` v${otherPublication.version}` : '其他版本'}，下方不会复制其链接与指标。${otherPublication.draftId ? action('open-draft','查看已发布版本',`data-id="${esc(otherPublication.draftId)}"`,'small') : '旧记录未绑定稿件，需人工核对。'}保存新记录将替换本任务原有发布记录。</div>` : ''}<form data-form="publication" class="stack"><div class="grid two-col"><label class="field">平台<input required name="platform" value="${esc(publication?.platform || '小红书')}" placeholder="小红书 / 小绿书"></label><label class="field">内容链接<input required name="url" type="url" value="${esc(publication?.url || '')}" placeholder="发布后粘贴公开链接"></label><label class="field">发布日期<input name="publishedAt" type="date" value="${esc(publication?.publishedAt || '')}"></label><label class="field">观察日期<input name="observedAt" type="date" value="${esc(publication?.observedAt || '')}"></label><label class="field">内容类型<input name="contentType" value="${esc(publication?.contentType || '图文')}" placeholder="图文 / 问答 / 清单"></label><label class="field">曝光<input name="impressions" type="number" min="0" value="${publication?.metrics?.impressions ?? ''}"></label><label class="field">收藏<input name="saves" type="number" min="0" value="${publication?.metrics?.saves ?? ''}"></label><label class="field">评论<input name="comments" type="number" min="0" value="${publication?.metrics?.comments ?? ''}"></label><label class="field">有效咨询<input name="qualifiedLeads" type="number" min="0" value="${publication?.metrics?.qualifiedLeads ?? ''}"></label></div><label class="field">复盘备注<textarea name="note" rows="2" placeholder="哪些受众问题出现了？下一条内容准备怎么调整？">${esc(publication?.note || '')}</textarea>${otherPublication ? '<label class="check-row"><input type="checkbox" name="confirmRebind" required> 我已核对，确认用本稿发布记录替换当前任务的原记录</label>' : ''}<button class="btn small" type="submit">保存发布数据</button></form></details>` : ''}</div>
    ${!delivery ? `<aside id="draft-review" class="aside-panel stack"><section class="card"><div class="row between"><h3>独立质检</h3>${action('review', draft.reviewStale ? '重新审核当前依据' : draft.review ? '重新质检' : '开始审核', disabled(), draft.reviewStale || !draft.review ? 'primary' : 'small')}${action('quality', '规则核查', '', 'small')}</div>${quality ? `<div class="quality-result"><strong>${esc(qualityLabel(quality.readiness))}</strong><p class="muted">${quality.readiness === 'ready' ? '可以进入人工终审；系统检查不是事实绝对正确或平台合规保证。' : '检查到待处理事项；请先阅读下面列出的下一步。'}</p>${nextActions.length ? `<ul class="quality-next-actions">${nextActions.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}<details class="quality-check-details"><summary>规则检查明细 · ${(quality.checks||[]).length} 项</summary>${(quality.checks||[]).map(check=>`<p>${badge(({pass:'通过',warn:'待确认',fail:'未通过'})[check.status] || check.status)} ${esc(check.label)} · ${esc(check.detail)}</p>`).join('')}</details></div>`:''}${draft.review ? `<p>${badge(reviewIssues.some(i => i.blocking && !decisions.some(d=>d.issueKey===i.id)) ? '存在未处理问题' : reviewIssues.length ? '存在待确认事项' : '未发现具体问题', reviewIssues.some(i => i.blocking && !decisions.some(d=>d.issueKey===i.id)) ? 'bad' : 'warn')}</p><details class="review-issue"><summary>查看模型审核结论</summary><p class="verdict-copy">${esc(draft.review.verdict)}</p></details>${reviewIssues.length ? reviewIssues.map(issue => { const decision=decisions.filter(d=>d.issueKey===issue.id).at(-1); return `<details class="review-issue issue-row" data-issue-key="${esc(issue.id)}" ${issue.blocking && !decision ? 'open' : ''}><summary>${badge(issue.blocking&&!decision?'需处理':decision?'已记录判断':issue.severity==='low'?'表达建议':'待核对',issue.blocking&&!decision?'bad':'warn')} ${esc(issue.quote.slice(0,65))}${issue.location?.field?` · ${esc(fieldLabel(issue.location.field))}`:''}</summary><p>${esc(issue.reason)}</p><p><strong>建议：</strong>${esc(issue.suggestion)}</p>${issue.locationVerified&&issue.location?.field?`<button class="source-button" data-action="locate-issue" data-field="${esc(issue.location.field)}" data-start="${issue.location.start}" data-end="${issue.location.end}">定位原句 ↗</button>`:''}${issue.sourceRef?citation(issue.sourceRef):''}${decision?`<p class="muted">${decision.decision==='resolved'?'标记已修改':'选择保留'} · ${esc(decision.comment)}</p>`:`<textarea rows="2" aria-label="审核意见处理说明" placeholder="说明修改了什么，或为什么保留"></textarea><div class="row">${action('issue-decision','已修改',`data-issue="${issue.id}" data-decision="resolved" ${ui.busy || draft.reviewStale || draft.evidenceNeedsReview || issue.nonDismissible ? 'disabled' : ''}`,'small')}${action('issue-decision','保留意见',`data-issue="${issue.id}" data-decision="dismissed" ${ui.busy || draft.reviewStale || draft.evidenceNeedsReview || issue.nonDismissible ? 'disabled' : ''}`,'small')}</div>`}</details>`}).join(''):'<p class="muted">本次未发现具体问题，仍需人工审阅。</p>'}<details><summary>已识别事实核查 · ${reviewedFacts.length} 条</summary><p class="muted">由模型识别需核验的事实，可能漏抽。未列出的句子不代表已核验；请人工检查全文。</p>${reviewedFacts.map(f=>`<div class="evidence-row"><p>${esc(f.claim)}</p>${badge(f.status==='supported'&&f.quoteVerified?'来源原文匹配':'待人工核对',f.status==='supported'&&f.quoteVerified?'good':'warn')}<p>${esc(f.reason)}</p>${f.sourceRef?citation(f.sourceRef,'查看原文 ↗',f.sourceQuote||''):''}</div>`).join('')||'<p class="muted">未识别出事实条目；这不代表全文事实正确。</p>'}</details>`:'<p class="muted">尚未完成模型质检。发布前请完成审核。</p>'}${action('evaluate','生成本稿核查记录',`data-draft-id="${draft.id}"`, 'small')}<p class="muted">自动核查≠真人评估；仅已审核稿件可采纳，未解决问题须逐项留痕。</p></section>
      <section class="card"><h3>你的判断，进入下一版</h3><form data-form="revise" class="stack"><label class="field">修改要求<textarea id="revision-${draft.id}" name="instruction" rows="4" placeholder="选择正文中的一段可指定局部修改，或留空选择后描述修改范围。" ${nextExists ? 'disabled' : ''}></textarea></label><div class="row"><label class="field">修改范围<select id="scope-field"><option value="">整稿</option><option value="title">标题</option><option value="body">正文</option><option value="cover">封面</option><option value="pages">图文页</option></select></label>${action('capture-selection','使用所选原文','', 'small')}${ui.scope?.text?`<p class="notice">仅修改${fieldLabel(ui.scope.field)}选区 ${ui.scope.text.length} 字 ${action('clear-scope','取消选区','','small')}</p>`:''}</div><fieldset><legend>锁定字段</legend>${['title','body','cover','pages'].map(field=>`<label><input type="checkbox" name="lockedFields" value="${field}" ${draft.lockedFields?.includes(field)?'checked':''}> ${fieldLabel(field)}</label>`).join(' ')}</fieldset><div class="row">${action('revise-submit','反馈并生成新版本 →',disabled() + (nextExists?' disabled':''),'small')}${action('accept','确认人工采纳',ui.busy || nextExists || !canAccept(quality,draft) ? 'disabled' : '', canAccept(quality,draft) ? 'primary' : 'small')}</div><p class="muted">${nextExists ? '此版本已有后续稿件，请切换到最新版本。' : !quality ? '先运行规则核查，确认没有阻断问题后再进入人工终审。' : quality.readiness === 'blocked' ? '请先处理所有阻断问题，再进入人工终审。' : quality.readiness === 'needs_confirmation' ? '仍有资料或审核事项待确认；采纳后不会自动发布。' : '系统核查不能替代人工核验；采纳只记录内部终审通过，不发布内容。'}</p></form></section>
      ${draft.gaps.length ? `<section class="card"><h3>发布前还需确认</h3><ul>${draft.gaps.map(gap => `<li>${esc(gap)}</li>`).join('')}</ul></section>` : ''}
      ${feedback.length ? `<details class="card"><summary>历史反馈记录 · ${feedback.length} 条</summary>${feedback.map(item => `<div class="feedback-item"><div class="row between">${badge(item.decision === 'accepted' ? '采纳' : '要求修改')}<span class="muted">${date(item.createdAt)}</span></div><p>${esc(item.comment || '未附加说明')}</p></div>`).join('')}</details>` : ''}</aside>` : ''}</div>`;
}

function logsPanel(task) {
  const runs = ui.state.runs.filter(run => run.taskId === task.id);
  if (!runs.length) return empty('还没有执行记录', '启动任务后，检索、阅读、生成和质检过程会保存在这里。');
  return `<div class="stack">${runs.map((run, index) => `<details class="card" ${index === 0 ? 'open' : ''}><summary><span class="row between"><span>${stageLabel(run.action)} · ${date(run.createdAt)}</span>${badge(statusLabel(run), run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn')}</span></summary><div class="row metrics"><div class="metric"><span>输入 tokens</span><strong>${number(run.usage.inputTokens)}</strong></div><div class="metric"><span>输出 tokens</span><strong>${number(run.usage.outputTokens)}</strong></div><div class="metric"><span>已用时</span><strong>${Math.max(0, Math.round((new Date(run.finishedAt || Date.now()) - new Date(run.createdAt)) / 1000))} 秒</strong></div></div><p class="muted">${esc(run.model || '尚未收到模型结果')} · 失败请求可能未返回 token 用量，记录不等于账单。${run.usageUnknown?'当前运行至少一次调用用量未知。':''}</p>${run.action!=='brief'&&['completed','failed'].includes(run.status)?action('run-evaluation','生成执行核查记录',`data-id="${esc(run.id)}"`,'small'):''}${run.instruction ? `<details><summary>本次补充要求</summary><p class="body-copy">${esc(run.instruction)}</p></details>` : ''}${run.error ? `<p class="alert error">${esc(run.error)}</p>` : ''}<div class="timeline">${run.events.map(event => `<div class="event ${event.status === 'failed' ? 'error' : ''}"><div class="row between"><strong>${esc(event.title)}</strong><span class="muted">${date(event.at)}${event.durationMs ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}</span></div><p class="body-copy muted">${esc(event.detail)}</p></div>`).join('')}</div></details>`).join('')}</div>`;
}

function renderDrawer() {
  const root = $('drawer-root');
  if (!root || !ui.drawer) return;
  const source = ui.state.sources.find(item => item.id === ui.drawer.sourceId || item.chunks.some(chunk => chunk.id === ui.drawer.ref));
  if (!source) return;
  const chunks = ui.drawer.ref ? source.chunks.filter(chunk => chunk.id === ui.drawer.ref) : source.chunks;
  const selectedRef = ui.drawer.ref;
  const sourceText=chunk=>{const quote=ui.drawer.quote||'',index=quote?chunk.text.indexOf(quote):-1;return index<0?esc(chunk.text):esc(chunk.text.slice(0,index))+`<mark>${esc(quote)}</mark>`+esc(chunk.text.slice(index+quote.length));};
  root.innerHTML = `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1"><div class="row between"><span class="eyebrow">来源原文</span><button class="close" data-action="close-drawer" aria-label="关闭原文">×</button></div><h2 id="drawer-title">${esc(source.title)}</h2>${source.url && /^https?:\/\//i.test(source.url) ? `<a class="source-button" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">打开原网页 ↗</a>` : ''}<p class="muted">导入于 ${date(source.createdAt)} · 网页自述未经独立核验</p>${chunks.map(chunk => `<section class="card ${chunk.id===selectedRef?'source-highlight':''}" id="${esc(chunk.id)}"><span class="muted source-id">${esc(chunk.id)}</span><p class="body-copy">${sourceText(chunk)}</p></section>`).join('')}${selectedRef? action('source-context','查看整份资料上下文',`data-id="${source.id}"`,'small'):''}</aside>`;
  if (selectedRef) document.getElementById(selectedRef)?.scrollIntoView({block:'center'});
}

async function mutate(fn, message) {
  if (ui.busy) return;
  ui.busy = true; ui.notice = null; render();
  try { await fn(); if (message) ui.notice = { text: message }; await refresh(true); }
  catch (error) { ui.notice = { error: true, text: error.message }; render(); }
  finally { ui.busy = false; render(); }
}

async function startRun(options, operation = operationContext()) {
  await request(`/api/tasks/${operation.taskId}/runs`, options);
  if (sameOperation(operation)) ui.tab = ['plan','brief'].includes(options.action) ? 'plan' : 'draft';
}

async function fillDemo() {
  const confirmed = window.confirm('将立即保存一套明确标注为虚构的练习账号与资料，并填好待创建任务的表单。任务需点击“创建任务单”才保存；后续模型运行会消耗额度。继续吗？');
  if (!confirmed) return;
  return mutate(async () => {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    const account = await request('/api/accounts', { name:`演示账号·家长信息号（虚构练习 ${stamp}）`, audience:'演示受众：关注孩子学习规划的家长，不代表真实用户', positioning:'演示定位：把复杂教育信息整理成家长容易理解的图文；仅用于流程体验', tone:'清楚、克制、少术语，不制造焦虑', productFacts:'无真实课程、学校或服务信息；本账号与资料均为虚构练习', restrictions:'不得把演示资料写成真实政策、学校安排或家长咨询；不得承诺升学结果', identity:'planning' });
    const source = await request('/api/sources', { title:`演示资料·虚构练习：家长如何整理教育信息（${stamp}）`, isDemo:true, category:'reference', note:'本资料完全为练习而写，不对应任何真实政策、学校、活动、时间或真实家长问题。禁止当作事实来源发布。', text:'【虚构演示资料，不是真实政策或学校通知】\n\n练习主题：家长收到一份较长的教育活动说明后，如何把信息整理清楚。\n\n虚构练习设定：假设说明包含活动对象、准备事项、办理步骤和咨询方式四类信息；没有真实机构、报名时间、学校名单、资格条件或联系方式。\n\n整理方法：先看信息来源；再分出适用对象、准备事项、下一步和核对入口；原文没写清的内容标为待确认，不根据经验补答案。\n\n边界：本资料只演示内容整理方法，不对应任何真实地区或机构，不可用于实际报名、升学判断或家长答疑。' });
    ui.page = 'work'; ui.inbox = false; ui.showNewTask = true;
    ui.demoPrefill = { region:'演示练习（非真实地区）', grade:'不针对真实年级', subject:'家长如何整理教育活动信息', platform:'小红书图文', parentQuestion:'收到一份较长的教育活动说明，怎样快速看懂重点？（虚构练习问题）', objective:'体验选题、图文生成、AI审核和反馈改稿流程', title:'演示任务·把长说明整理成家长看得懂的图文', brief:'明确标注为虚构演示；只使用所选演示资料中的通用整理方法；不得编造政策、学校、时间、资格、联系方式或真实用户线索；不得将结果直接对外发布。', accountId:account.id, sourceId:source.id };
    ui.notice = { text: '虚构练习账号与资料已保存，任务表单已填好。检查内容后点击“创建任务单”；后续逐步运行模型。' };
  });
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  const name = button.dataset.action;
  const operation = operationContext();
  if (name === 'csv-preview') return mutate(async () => { ui.csvText = document.querySelector('[name="csv"]').value; ui.csvPreview = await request('/api/publications/import/preview', {csv:ui.csvText}); }, 'CSV 预览完成；尚未写入发布记录。');
  if (name === 'csv-commit') {
    const csv = document.querySelector('[name="csv"]')?.value || '';
    if (!ui.csvPreview?.valid || csv !== ui.csvText) { ui.csvPreview = null; ui.notice={error:true,text:'CSV 已变更，请重新校验预览。'}; render(); return; }
    return mutate(async () => { const result = await request('/api/publications/import/commit',{csv,token:ui.csvPreview.token}); ui.csvPreview=null; ui.csvText=''; forgetForm('publication-csv'); ui.notice={text:`导入 ${result.imported} 条，跳过 ${result.skipped} 条相同记录。`}; });
  }
  if (name === 'reload') { location.reload(); return; }
  if (name === 'back-inbox') { ui.inbox=true;ui.page='tasks';render();return; }
  if (name === 'nav') { preserveFields();resetDraftState();ui.page = button.dataset.page; ui.inbox = ['work','tasks'].includes(ui.page); ui.notice = null; if (ui.page === 'tasks') { ui.filter = button.dataset.filter || 'all'; ui.search = ''; ui.includeDemo = false; } render(); return; }
  if (name === 'new-task') { preserveFields();resetDraftState();ui.page='work';ui.inbox=false;ui.showNewTask=true;ui.demoPrefill=null;render();document.querySelector('[data-form="task"] input')?.focus();return; }
  if (name === 'demo-fill') return fillDemo();
  if (name === 'lead-demo') { ui.page = 'leads'; ui.leadDemo = true; ui.notice = { text: '已填入虚构演示咨询。提交后才会保存；勾选 AI 分拣时会调用当前模型。' }; render(); return; }
  if (name === 'lead-classify') return mutate(() => request(`/api/leads/${button.dataset.id}/classify`, {}), 'AI 初步分拣已保存。请核对字段、建议回复和交接摘要后再决定是否交接。');
  if (name === 'lead-status' || name === 'lead-save') { const card=button.closest('.lead-card'),note=card.querySelector('[data-lead-note]')?.value.trim()||''; if((name==='lead-save'||['ready_handoff','handed_off'].includes(button.dataset.status))&&!note){ui.notice={error:true,text:'请填写本次人工核对或修正备注。'};render();return;} const patch={manualNote:note,humanReview:readLeadHumanFields(card)};if(name==='lead-status')patch.reviewStatus=button.dataset.status;return mutate(()=>request(`/api/leads/${button.dataset.id}`,patch),name==='lead-save'?'人工校正已保存；发生变更时需重新确认交接。':`线索已标记为“${leadStatusLabel(button.dataset.status)}”。`); }
  if (name === 'asset-filter') { ui.assetFilter = button.dataset.filter; render(); return; }
  if (name === 'filter') { ui.filter = button.dataset.filter; render(); return; }
  if (name === 'open-task') { preserveFields();selectTask(button.dataset.id);if(button.dataset.draftId)selectDraft(button.dataset.draftId);ui.page='work';ui.tab=stageForTask(currentTask(),ui.state.drafts,ui.state.runs,ui.state.quality)==='delivery'?'delivery':ui.draftId ? 'draft' : 'plan';render();return; }
  if (name === 'open-draft') {const draft=ui.state.drafts.find(d=>d.id===button.dataset.id);if(!draft)return;preserveFields();selectTask(draft.taskId);selectDraft(draft.id);ui.page='work';ui.tab='draft';render();return;}
  if (name === 'deliver-draft') { ui.modalTaskId=button.dataset.taskId || null;ui.modalAccountId=null;openOverlay('modal','deliver',button);return; }
  if (name === 'new-account' || name === 'edit-account') { ui.modalAccountId=name==='edit-account'?button.dataset.id:null;ui.modalTaskId=null;openOverlay('modal','account',button);return; }
  if (name === 'edit-task') {ui.modalTaskId=ui.taskId;ui.modalAccountId=null;openOverlay('modal','task-edit',button);return;}
  if (name === 'close-modal') { closeOverlay('modal');return; }
  if (name === 'compare') { const base=$('compare-select')?.value; if(!base)return; return mutate(async () => { const result=await request(`/api/drafts/${operation.draftId}/compare?base=${encodeURIComponent(base)}`);if(sameOperation(operation))ui.comparison=result; }); }
  if (name === 'quality') { const id=ui.draftId;return mutate(async()=>{const report=await request(`/api/drafts/${id}/quality`);if(ui.draftId===id){ui.qualityReport=report;ui.qualityDraftId=id;}},'本稿规则核查已完成。'); }
  if (name === 'clear-scope') {ui.scope=null;ui.selection=null;render();return;}
  if (name === 'capture-selection') { const selected=ui.selection;if(!selected||selected.draftId!==ui.draftId){ui.notice={error:true,text:'请先在稿件正文、标题或分页文案中选择一段原文。'};render();return;}ui.scope={field:selected.field.split('.')[0],text:selected.text};ui.notice={text:`已限制为${fieldLabel(selected.field)}中的 ${selected.text.length} 字。`};render();return; }
  if (name === 'revise-submit') { const form=button.closest('form');const text=form.querySelector('textarea[name="instruction"]')?.value.trim();if(!text){ui.notice={error:true,text:'请先写下具体修改要求。'};render();return;}const lockedFields=[...form.querySelectorAll('input[name="lockedFields"]:checked')].map(el=>el.value);const selectedField=form.querySelector('#scope-field')?.value;const scope=ui.scope?.text?ui.scope:selectedField?{field:selectedField}:null;const target=captureTaskOperation({...operation,scope,lockedFields});return mutate(async()=>{await submitRevision(request,target,text);if(sameOperation(target))ui.tab='draft';}); }
  if (name === 'locate-issue') {locateDraftText(button.dataset.field,Number(button.dataset.start),Number(button.dataset.end));return;}
  if (name === 'edit-draft') { if(ui.state.drafts.some(d=>d.parentId===ui.draftId))return;ui.editing=true;render();return; }
  if (name === 'add-page') {ui.editorPageCount=Math.max(currentDraft()?.pages.length||1,ui.editorPageCount||0)+1;render();return;}
  if (name === 'jump-review' || name === 'jump-copy') {const target=$(name==='jump-review'?'draft-review':'draft-copy');target?.scrollIntoView({behavior:'smooth',block:'start'});return;}
  if (name === 'cancel-edit') { ui.editing = false; render(); return; }
  if (name === 'edit-save') {button.closest('form')?.requestSubmit();return;}
  if (name === 'issue-decision') { const issue = (ui.state.quality?.[operation.draftId]?.issues || currentDraft()?.review?.issues || []).find(i=>i.id===button.dataset.issue); if (!issue || currentDraft()?.reviewStale || currentDraft()?.evidenceNeedsReview || issue.nonDismissible) return; const comment = button.closest('.issue-row')?.querySelector('textarea')?.value || ''; if (!comment.trim()) { ui.notice={error:true,text:'请填写处理说明，记录这条审核意见的判断依据。'}; render(); return; } return mutate(()=>request(`/api/drafts/${operation.draftId}/issues`,{issueKey:issue.id,decision:button.dataset.decision,comment,expectedReviewRevision:operation.reviewRevision}),'已记录问题处理决定。'); }
  if (name === 'evaluation-filter') {ui.evaluationFilter=button.dataset.filter;render();return;}
  if (name === 'evaluate') {const id=button.dataset.draftId||$('evaluation-draft')?.value;if(!id){ui.notice={error:true,text:'请明确选择一份已审核稿件；系统不会替换为其他稿件。'};render();return;}return mutate(async()=>{const draft=ui.state.drafts.find(d=>d.id===id);if(!draft?.review)throw new Error('所选稿件尚未完成审核。');await request('/api/evaluations',{draftId:id});ui.evaluations=(await request('/api/evaluations')).reports||[];ui.evaluationDraftId=id;ui.evaluationFilter='drafts';ui.page='evaluations';},'已生成所选稿件自动核查；不等同真人评价。');}
  if (name === 'run-evaluation') return mutate(async()=>{await request('/api/evaluations',{runId:button.dataset.id});ui.evaluations=(await request('/api/evaluations')).reports||[];resetDraftState();ui.evaluationFilter='runs';ui.page='evaluations';},'已保存执行记录核查；未把它算作质量评分。');
  if (name === 'export-evidence') { location.href=`/api/drafts/${ui.draftId}/export?format=json&includeEvidence=1`;return; }
  if (name === 'download-visuals') { const draft = currentDraft(); if (draft) downloadAllVisuals(draft); return; }
  if (name === 'download-visual') { const draft = currentDraft(); const asset = draft && visualAssets(draft)[Number(button.dataset.assetIndex)]; if (draft && asset) downloadSvg(draft, asset, Number(button.dataset.assetIndex), visualAssets(draft).length); return; }
  if (name === 'download-png') { const draft = currentDraft(); const asset = draft && visualAssets(draft)[Number(button.dataset.assetIndex)]; if (draft && asset) return mutate(() => downloadPng(draft, asset, Number(button.dataset.assetIndex), visualAssets(draft).length), 'PNG 图片已下载。'); }
  if (name === 'tab') { ui.tab = button.dataset.tab; render(); return; }
  if (name === 'dismiss') { ui.notice = null; render(); return; }
  if (name === 'source' || name === 'citation') {openOverlay('drawer',name==='source'?{sourceId:button.dataset.id}:{ref:button.dataset.ref,quote:button.dataset.quote||''},button);return;}
  if (name === 'source-context') {ui.drawer={sourceId:button.dataset.id};render();return;}
  if (name === 'close-drawer') {closeOverlay('drawer');return;}
  if (name === 'check') return mutate(async () => { ui.connection = await request('/api/provider/check', {}); if (!ui.connection.ready) throw new Error(ui.connection.message || ui.connection.error || '模型连接失败'); }, '真实模型连接成功。');
  if (name === 'cancel') return mutate(() => request(`/api/runs/${button.dataset.id}/cancel`, {}), '已发送停止请求，运行状态会随之更新。');
  if (name === 'brief') return mutate(() => startRun({action:'brief'}));
  if (name === 'plan') return mutate(() => startRun({ action: 'plan' }));
  if (name === 'draft') return mutate(() => startRun({ action: 'draft', topicId: button.dataset.topic }));
  if (name === 'review') return mutate(() => startRun({ action: 'review', draftId: operation.draftId }));
  if (name === 'retry') { const run = ui.state.runs.find(item => item.id === button.dataset.id); return mutate(() => request(`/api/runs/${run.id}/retry`, {})); }
  if (name === 'accept') { const comment = $(`revision-${ui.draftId}`)?.value || ''; return mutate(() => request(`/api/drafts/${operation.draftId}/feedback`, { decision: 'accepted', comment, expectedReviewRevision:operation.reviewRevision }), '已记录采纳决定，内容未发布。'); }
});

document.addEventListener('change', async event => {
  const field = event.target;
  if(field.id==='include-demo'){ui.includeDemo=field.checked;render();return;}
  if (field.id==='evaluation-draft') {ui.evaluationDraftId=field.value;return;}
  if (field.id==='replay-draft-select') {ui.replayDraftId=field.value;render();return;}
  if (field.id === 'task-search') { ui.search = field.value; render(); return; }
  if (field.matches('input[type="checkbox"],select')) preserveFields();
  if (field.id === 'task-select') {preserveFields();selectTask(field.value);ui.tab=stageForTask(currentTask(),ui.state.drafts,ui.state.runs,ui.state.quality)==='delivery'?'delivery':ui.draftId?'draft':'plan';render();return;}
  if (field.id === 'draft-select') {preserveFields();selectDraft(field.value);render();return;}
  if (field.matches('[data-source-category],[data-source-note],[data-source-region],[data-source-grade],[data-source-type],[data-source-level],[data-source-published],[data-source-effective],[data-source-verification]')) {
    const id = field.dataset.sourceCategory || field.dataset.sourceNote || field.dataset.sourceRegion || field.dataset.sourceGrade || field.dataset.sourceType || field.dataset.sourceLevel || field.dataset.sourcePublished || field.dataset.sourceEffective || field.dataset.sourceVerification;
    const card = field.closest('.card');
    const value = selector => card.querySelector(selector)?.value;
    mutate(() => request(`/api/sources/${id}`, { category: value('[data-source-category]'), note: value('[data-source-note]'), region: value('[data-source-region]'), grade: value('[data-source-grade]'), sourceType: value('[data-source-type]'), sourceLevel: value('[data-source-level]'), publishedAt: value('[data-source-published]'), effectiveUntil: value('[data-source-effective]'), verificationStatus: value('[data-source-verification]') }), '资料台账已保存。');
  }
  if(field.id==='scope-field') ui.scope=field.value?{field:field.value}:null;
  if (field.id === 'source-file' && field.files[0]) {
    const file = field.files[0], textField=$('source-text'), titleField=$('source-title');
    if (file.size > 850_000) { ui.notice = { error: true, text: '文件过大，请精简为 850 KB 以内的文本。' }; render(); return; }
    const text=await file.text();if(!textField?.isConnected || !titleField?.isConnected)return;
    textField.value=text;if(!titleField.value)titleField.value=file.name;
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'task-search') { ui.search = event.target.value; render(); const input = $('task-search'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
  preserveFields();
});
document.addEventListener('selectionchange',()=>{const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return;const range=selection.getRangeAt(0);const anchor=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;const field=anchor?.closest('[data-copy-field]');if(!field||!field.contains(range.endContainer))return;const text=selection.toString();if(text.trim())ui.selection={draftId:ui.draftId,field:field.dataset.copyField,text};});

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (ui.busy) return;
  const data = new FormData(form);
  const type = form.dataset.form;
  const operation = operationContext(), formScope = viewScope();
  if (['collaborator','collaboration','campaign','experiment'].includes(type)) return mutate(async () => {
    const payload = Object.fromEntries(data.entries());
    if (type === 'collaboration') payload.deliverables = String(data.get('deliverables') || '').split('\n').map(value => value.trim()).filter(Boolean);
    if (type === 'campaign') { payload.taskIds = data.getAll('taskIds'); payload.budget = data.get('budget') === '' ? null : Number(data.get('budget')); }
    if (type === 'experiment') {
      payload.variants = [...data.keys()].filter(key => /^variant-\d+-id$/.test(key)).map(key => {
        const prefix = key.slice(0,-2), metrics = {};
        for (const [metric] of experimentMetricFields) { const value = data.get(prefix + metric); metrics[metric] = value === '' ? null : Number(value); }
        return { id:data.get(key), name:data.get(prefix+'name'), taskId:data.get(prefix+'taskId') || null, draftId:data.get(prefix+'draftId') || null, observedAt:data.get(prefix+'observedAt') || '', note:data.get(prefix+'note') || '', metrics };
      });
      for (const key of Object.keys(payload)) if (key.startsWith('variant-')) delete payload[key];
    }
    const endpoint = {collaborator:'collaborators',collaboration:'collaborations',campaign:'campaigns',experiment:'experiments'}[type];
    await request(`/api/${endpoint}${form.dataset.recordId ? '/'+form.dataset.recordId : ''}`,payload);
    forgetForm(type,form.dataset.recordId || '',formScope);
  }, '业务记录已保存；未调用模型、未对外通知或执行投放。');
  if (type === 'profile') return mutate(() => request('/api/profile', Object.fromEntries(data.entries())), '账号档案已保存。');
  if (type === 'message') {const sourceIds=data.getAll('sourceIds');let text=String(data.get('text')||'').trim();if(!text&&!sourceIds.length){ui.notice={error:true,text:'请填写补充说明或勾选要追加的资料。'};render();return;}if(!text)text='追加资料：'+sourceIds.map(id=>ui.state.sources.find(s=>s.id===id)?.title||id).join('、');return mutate(async()=>{await request(`/api/tasks/${operation.taskId}/messages`,{text,sourceIds});forgetForm('message',undefined,formScope);},'补充已加入任务；可点击“根据补充更新任务单”继续。');}
  if (type === 'account') {const id=form.dataset.recordId;return mutate(async()=>{await request(`/api/accounts${id?'/'+id:''}`,Object.fromEntries(data.entries()));forgetForm('account',id || '',formScope);if(viewScope()===formScope){ui.modal=null;ui.page='profile';}},'账号档案已保存；受影响稿件需重新审核。');}
  if (type === 'draft-import') {const taskId=form.dataset.taskId || null;const payload={taskId,newTask:{title:data.get('taskTitle'),brief:data.get('taskBrief')||'现成稿件交付与审阅',sourceIds:data.getAll('sourceIds'),accountId:data.get('accountId')||undefined},draft:{title:data.get('title'),body:data.get('body'),cover:data.get('cover'),author:data.get('author')||'',changeNote:data.get('changeNote')||'用户提交现有稿件'}};return mutate(async()=>{const result=await submitExistingDraft(request,payload);forgetForm('draft-import',undefined,formScope);if(viewScope()===formScope){resetDraftState();ui.taskId=result.taskId;ui.draftId=result.draft.id;ui.page='work';ui.inbox=false;ui.tab='draft';ui.modal=null;}},'稿件已保存到指定任务，尚未调用 AI；确认资料后可开始审核。');}
  if (type === 'edit') {if(ui.state.drafts.some(d=>d.parentId===ui.draftId)){ui.notice={error:true,text:'此版本已有后续稿件，请编辑最新版本。'};render();return;}const payload={title:data.get('title'),body:data.get('body'),cover:data.get('cover'),changeNote:data.get('changeNote'),lockedFields:data.getAll('lockedFields'),tags:String(data.get('tags')||'').split(/[,，\n]/).map(v=>v.trim().replace(/^#/, '')).filter(Boolean)};payload.pages=[...data.keys()].filter(key=>key.startsWith('page-heading-')).map(key=>({heading:String(data.get(key)||''),text:String(data.get(key.replace('heading','text'))||'')})).filter(page=>page.heading.trim()||page.text.trim());return mutate(async()=>{const draft=await request(`/api/drafts/${operation.draftId}/versions`,payload);forgetForm('edit',undefined,formScope);if(sameOperation(operation))selectDraft(draft.id);},'已保存标题、正文、封面、分页与标签的新版本；请重新质检。');}
  if (type === 'task-update') {const id=form.dataset.taskId;return mutate(async()=>{await request(`/api/tasks/${id}`,{title:data.get('title'),brief:data.get('brief'),owner:data.get('owner'),accountId:data.get('accountId')||null,sourceIds:data.getAll('sourceIds')});forgetForm('task-update',undefined,formScope);if(viewScope()===formScope)ui.modal=null;},'任务要求已保存；变更后的稿件需重新审核。');}
  if (type === 'publication') return mutate(async()=>{const metrics={};for(const key of ['impressions','clicks','likes','saves','comments','shares','follows','inquiries','qualifiedLeads','conversions','spend','revenue']){const value=String(data.get(key)||'').trim();metrics[key]=value===''?null:Number(value);}await request(`/api/tasks/${operation.taskId}`,{publication:{draftId:operation.draftId,platform:String(data.get('platform')||'').trim(),url:String(data.get('url')||'').trim(),publishedAt:String(data.get('publishedAt')||'').trim(),observedAt:String(data.get('observedAt')||'').trim(),contentType:String(data.get('contentType')||'').trim(),trafficType:String(data.get('trafficType')||'organic'),dataSource:String(data.get('dataSource')||'').trim(),metricDefinition:String(data.get('metricDefinition')||'').trim(),note:String(data.get('note')||'').trim(),metrics}});},'发布记录已绑定当前稿件版本；空白指标按未知保存。');
  if (type === 'preflight') return mutate(() => request(`/api/tasks/${operation.taskId}`, { preflight: { draftId: operation.draftId, platform: data.get('platform'), checks: Object.fromEntries(['title','cover','opening','search','comment','directMessage','persona','risk'].map(key => [key, data.get(key) === 'on'])), note: String(data.get('note') || '') } }), '发布前检查已保存；未完成项仍需要人工补齐。');
  if (type === 'lead') {const classify=data.get('runTriage')==='on' && ui.state.provider?.ready;return mutate(async()=>{const lead=await request('/api/leads',{taskId:data.get('taskId')||null,channel:data.get('channel'),rawText:String(data.get('rawText')||''),isDemo:data.get('isDemo')==='on'});forgetForm('lead',undefined,formScope);if(viewScope()===formScope){ui.page='leads';ui.leadDemo=false;}if(classify)await request(`/api/leads/${lead.id}/classify`,{});},classify?'线索已保存并完成 AI 初判；仍需人工核对。':'线索已保存，尚未调用 AI 分拣。');}
  if (type === 'task') return mutate(async () => { const context=String(data.get('region')||'').trim(),audience=String(data.get('grade')||'').trim(),subject=String(data.get('subject')||'').trim(),platform=String(data.get('platform')||'小红书图文'),question=String(data.get('parentQuestion')||'').trim(),objective=String(data.get('objective')||'').trim(),successMetric=String(data.get('successMetric')||'').trim(),extra=String(data.get('brief')||'').trim(); const structured=[`业务背景/适用范围：${context||'待补充'}`,`目标人群/阶段：${audience||'待补充'}`,`主题/选题：${subject||'待补充'}`,`内容形式：${platform}`,`受众问题：${question||'待明确'}`,`内容目标：${objective||'待明确'}`,`成功指标：${successMetric||'待记录，不估填'}`,`内容要求：${extra||'仅依据已导入资料；缺少正文时先补充，不推测未被支持的事实。'}`].join('\n'); const title=String(data.get('title')||'').trim()||`${subject||'小红书'}内容任务`; const task=await request('/api/tasks',{title,brief:structured,sourceIds:data.getAll('sourceIds'),accountId:data.get('accountId')||undefined,owner:data.get('owner')||''}); forgetForm('task',undefined,formScope); if(viewScope()===formScope){resetDraftState(); ui.taskId=task.id; ui.draftId=null; ui.tab='plan'; ui.inbox=false; ui.showNewTask=false; ui.demoPrefill=null;} });
  if (type === 'source') {
    const payload = Object.fromEntries(data.entries());
    if (!String(payload.text || '').trim() && !String(payload.url || '').trim()) { ui.notice = { error: true, text: '请粘贴正文或填写公开网页链接。' }; render(); return; }
    if (!String(payload.text || '').trim()) delete payload.text;
    return mutate(async () => { await request('/api/sources', payload); forgetForm('source',undefined,formScope); }, '资料已导入，可以在新任务中选用。');
  }
  if (type === 'revise') {
    const instruction = String(data.get('instruction') || '').trim();
    if (!instruction) { ui.notice = { error: true, text: '先写下具体修改要求，再生成下一版。' }; render(); return; }
    const scope=data.get('scope') || form.querySelector('#scope-field')?.value;const target=captureTaskOperation({...operation,scope:ui.scope?.text?ui.scope:scope?{field:scope}:null,lockedFields:data.getAll('lockedFields')});
    return mutate(async () => { await submitRevision(request,target,instruction);if(sameOperation(target))ui.tab='draft'; });
  }
});
document.addEventListener('change', async event => {
  if (/^variant-\d+-taskId$/.test(event.target.name || '')) {
    const prefix = event.target.name.replace('taskId',''), taskId=event.target.value;
    const select=event.target.form.querySelector(`[name="${prefix}draftId"]`);
    select.innerHTML=`<option value="">暂不关联</option>${ui.state.drafts.filter(d=>d.taskId===taskId).map(d=>`<option value="${esc(d.id)}">${esc(d.title)} · v${d.version}</option>`).join('')}`;
  }
  if (event.target.id !== 'publication-csv-file') return;
  const file = event.target.files?.[0], textField=document.querySelector('[name="csv"]'); if (!file || !textField) return;
  if (file.size > 2 * 1024 * 1024) { ui.notice={error:true,text:'CSV 请控制在 2 MB 内，较大文件请分批导入。'}; render(); return; }
  const text = await file.text(); if(!textField.isConnected)return;ui.csvText=text; ui.csvPreview=null;
  textField.value=text;
  document.querySelector('.csv-preview')?.remove();
});
document.addEventListener('input', event => {
  if (event.target.name !== 'csv') return;
  ui.csvPreview=null;
  document.querySelector('.csv-preview')?.remove();
});
document.addEventListener('keydown', event => {
  if(event.key==='Escape'&&(ui.modal||ui.drawer)){event.preventDefault();closeOverlay(ui.modal?'modal':'drawer');return;}
  const dialog=document.querySelector('[role="dialog"]');
  if(event.key==='Tab'&&dialog){const items=[...dialog.querySelectorAll('button,a,input,textarea,select,summary,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);if(items.length){const first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}}}
  const tab=event.target.closest('[role="tab"]');if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=[...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')],index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;const id=tabs[next].dataset.tab;ui.tab=id;render();document.querySelector(`[data-tab="${id}"]`)?.focus();}
});

refresh(true).catch(error => { $('app').innerHTML = `<main class="page"><div class="card"><h1>工作区暂时无法连接</h1><p>${esc(error.message)}</p><p>请确认本地服务已启动，再刷新页面。</p><button data-action="reload">刷新</button></div></main>`; });
let polling = false;
setInterval(async () => {
  if (polling || ui.busy || !ui.state || (!activeRuns().length && !ui.state.activity?.busy)) return;
  polling = true;
  try { await refresh(); }
  catch (error) { if (!ui.notice?.error) { ui.notice = { error: true, text: error.message }; render(); } }
  finally { polling = false; }
}, 1500);
