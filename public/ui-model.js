export const PRIMARY_NAV = Object.freeze([
  { id: 'dashboard', label: '工作台' },
  { id: 'tasks', label: '内容任务' },
  { id: 'library', label: '内容与账号' },
  { id: 'review', label: '复盘' },
]);

export const SECONDARY_TOOLS = Object.freeze([
  { id: 'assets', label: '内容资产' },
  { id: 'collaboration', label: '作者协作' },
  { id: 'campaigns', label: '投放实验' },
  { id: 'replay', label: '过程与证据' },
  { id: 'evaluations', label: '发布前检查' },
  { id: 'leads', label: '真实咨询' },
  { id: 'profile', label: '账号档案' },
  { id: 'logs', label: 'AI 过程与证据' },
]);

export function isCurrentReview(draft, quality) {
  return Boolean(draft?.review && !draft.reviewStale && !draft.evidenceNeedsReview && !['blocked', 'unreviewed', 'stale'].includes(quality?.readiness));
}

export function taskEvidenceLabel(task = {}, sources = []) {
  if (/^公开资料实践/.test(task.title || '')) return '公开资料实践';
  if (/演示|虚构练习/.test(`${task.title || ''} ${task.brief || ''}`)) return '演示模式';
  const labels = (task.sourceIds || []).map(id => sources.find(source => source.id === id)).filter(Boolean).map(contentLabel);
  return ['演示模式', '历史项目自述', '待核验'].find(label => labels.includes(label)) || contentLabel(task);
}

export function filterTasks(tasks = [], { filter = 'all', search = '', includeDemo = false, sources = [], drafts = [], runs = [], quality = {} } = {}) {
  const query = search.trim().toLowerCase();
  return tasks.filter(task => {
    if (!includeDemo && taskEvidenceLabel(task, sources) === '演示模式') return false;
    if (filter !== 'archived' && task.status === 'archived') return false;
    const stage = stageForTask(task, drafts, runs, quality);
    const matches = filter === 'all' || (filter === 'input' ? ['brief', 'materials'].includes(stage) : filter === 'review' ? stage === 'review' : filter === 'delivery' ? stage === 'delivery' : task.status === filter);
    return matches && (!query || `${task.title || ''} ${task.brief || ''}`.toLowerCase().includes(query));
  });
}

export function stageForTask(task = {}, drafts = [], runs = [], quality = {}) {
  const taskDrafts = drafts.filter(draft => draft.taskId === task.id);
  const currentDraft = [...taskDrafts].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || Number(b.version || 0) - Number(a.version || 0))[0] || null;
  const taskRuns = runs.filter(run => run.taskId === task.id);
  if (taskRuns.some(run => ['queued', 'running'].includes(run.status))) return 'production';
  // An imported draft does not make missing requirements or sources complete.
  if (task.status === 'needs_input' && !task.sourceIds?.length) return 'brief';
  const leaves = taskDrafts.filter(draft => !draft.id || !taskDrafts.some(child => child.parentId && child.parentId === draft.id));
  const latestDelivered = currentDraft ? leaves.every(draft => draft.status === 'accepted' && isCurrentReview(draft, quality[draft.id])) : ['accepted', 'delivered'].includes(task.status) || task.publication;
  if (latestDelivered) return 'delivery';
  if (leaves.some(draft => draft.reviewStale || draft.evidenceNeedsReview || ['blocked', 'stale'].includes(quality[draft.id]?.readiness))) return 'review';
  if (currentDraft?.review || (!currentDraft && ['needs_review', 'changes_requested'].includes(task.status))) return 'review';
  if (taskDrafts.length) return 'review';
  if (!task.sourceIds?.length || task.status === 'needs_input' || !task.assignment) return 'brief';
  return 'materials';
}

export function nextActionForTask(task = {}, drafts = [], runs = [], quality = {}) {
  const stage = stageForTask(task, drafts, runs, quality);
  const labels = {
    brief: ['补充主题', '先写清楚要讲什么、给谁看'],
    materials: ['准备资料', '选择本次允许 AI 使用的资料'],
    production: ['查看生成进度', 'AI 正在生成；完成后检查内容与依据'],
    review: ['审核并修改', '逐条确认风险，修改后重新检查'],
    delivery: ['发布后复盘', '手动记录发布结果，生成下一步建议'],
  };
  if (stage === 'review') {
    const currentDraft = drafts.filter(draft => draft.taskId === task.id).sort((a,b)=>String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || Number(b.version || 0)-Number(a.version || 0))[0];
    if (currentDraft && (!currentDraft.review || currentDraft.reviewStale || currentDraft.evidenceNeedsReview)) {
      return { stage, label: currentDraft.reviewStale ? '重新审核当前稿件' : '开始稿件审核', hint: '稿件已保存；确认资料后启动审核，不代表已经通过检查' };
    }
  }
  const [label, hint] = labels[stage] || labels.brief;
  return { stage, label, hint };
}

export function contentLabel(entity = {}) {
  if (entity.demo || entity.isDemo || entity.identity === 'planning') return '演示模式';
  if (entity.category === 'method' || entity.sourceLevel === 'first_hand') return '历史项目自述';
  if (entity.verificationStatus && entity.verificationStatus !== 'verified') return '待核验';
  return '';
}

export function pageToPrimary(page) {
  if (page === 'work') return 'dashboard';
  if (page === 'sources' || page === 'profile' || page === 'assets' || page === 'collaboration') return 'library';
  if (page === 'analytics' || page === 'evaluations' || page === 'campaigns') return 'review';
  if (page === 'leads' || page === 'replay') return 'dashboard';
  return PRIMARY_NAV.some(item => item.id === page) ? page : 'dashboard';
}

export function legacyPageForPrimary(page) {
  return ({ work: 'work', tasks: 'work', library: 'sources', review: 'analytics' }[page] || 'work');
}
