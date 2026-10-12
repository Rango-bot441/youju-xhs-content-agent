import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIMARY_NAV, SECONDARY_TOOLS, contentLabel, nextActionForTask, pageToPrimary, stageForTask, filterTasks, isCurrentReview } from '../public/ui-model.js';

test('primary navigation keeps the four workbench areas and secondary areas available', () => {
  // 审核看板定位：主导航四项——工作台 / 内容任务 / 内容与账号 / 复盘。
  assert.deepEqual(PRIMARY_NAV.map(item => item.id), ['dashboard', 'tasks', 'library', 'review']);
  assert.equal(PRIMARY_NAV.length, 4);
  assert.ok(SECONDARY_TOOLS.some(item => item.id === 'evaluations'));
  assert.ok(SECONDARY_TOOLS.some(item => item.id === 'assets'));
});

test('task status maps to a conventional five-stage workflow', () => {
  const base = { id: 'task_1', sourceIds: ['source_1'], assignment: {} };
  assert.equal(stageForTask({ ...base, status: 'ready', sourceIds: [] }), 'brief');
  assert.equal(stageForTask({ ...base, status: 'ready' }, [], []), 'materials');
  assert.equal(stageForTask({ ...base, status: 'in_progress' }, [], [{ taskId: 'task_1', status: 'running' }]), 'production');
  assert.equal(stageForTask({ ...base, status: 'needs_review' }, [{ taskId: 'task_1', review: { verdict: 'changes_requested' } }]), 'review');
  assert.equal(stageForTask({ ...base, status: 'delivered' }), 'delivery');
});

test('each stage exposes one next action with a plain-language hint', () => {
  const task = { id: 'task_1', status: 'needs_review', sourceIds: ['source_1'], assignment: {} };
  const result = nextActionForTask(task, [{ taskId: 'task_1', review: {} }]);
  assert.deepEqual(result, { stage: 'review', label: '审核并修改', hint: '逐条确认风险，修改后重新检查' });
});

test('latest unreviewed version is not promoted by an older reviewed draft', () => {
  const task = { id:'task_1', status:'needs_review', sourceIds:['source_1'], assignment:{} };
  const old = {taskId:'task_1',version:1,createdAt:'2026-09-01',review:{}};
  const fresh = {taskId:'task_1',version:2,createdAt:'2026-09-02',review:null};
  assert.equal(stageForTask(task,[fresh,old]),'review');
  assert.equal(stageForTask(task,[old,fresh]),'review');
  assert.equal(stageForTask({...task,status:'accepted',publication:{draftId:'old'}},[{...fresh,id:'new'},{...old,id:'old',status:'accepted'}]),'review');
});

test('saved drafts need review while missing-source intake remains incomplete', () => {
  const task={id:'t',title:'公开资料实践｜测试',status:'needs_input',sourceIds:[]};
  for(const origin of ['imported','manual','ai']) {
    const draft={id:'d',taskId:'t',origin,review:null,status:'draft'};
    assert.equal(stageForTask(task,[draft]),'brief');
    assert.equal(stageForTask({...task,status:'needs_review',sourceIds:['s']},[draft]),'review');
    assert.equal(nextActionForTask({...task,status:'needs_review',sourceIds:['s']},[draft]).label,'开始稿件审核');
    assert.equal(stageForTask({...task,status:'in_progress',sourceIds:['s']},[draft]),'review');
    assert.equal(stageForTask(task,[draft],[{taskId:'t',status:'running'}]),'production');
  }
});

test('labels preserve evidence boundaries for demo and historical material', () => {
  assert.equal(contentLabel({ demo: true }), '演示模式');
  assert.equal(contentLabel({ category: 'method' }), '历史项目自述');
  assert.equal(contentLabel({ verificationStatus: 'unverified' }), '待核验');
  assert.equal(contentLabel({ verificationStatus: 'verified' }), '');
});

test('stale, blocked or other unaccepted lineages cannot enter delivery', () => {
  const task = {id:'t',status:'accepted'};
  const accepted = {id:'a',taskId:'t',status:'accepted',review:{},createdAt:'2026-09-30'};
  assert.equal(stageForTask(task,[accepted]),'delivery');
  assert.equal(stageForTask(task,[{...accepted,reviewStale:true}]),'review');
  assert.equal(stageForTask(task,[accepted],[],{a:{readiness:'blocked'}}),'review');
  assert.notEqual(stageForTask(task,[accepted,{id:'b',taskId:'t',status:'draft',review:{}}]),'delivery');
  assert.equal(isCurrentReview({...accepted,evidenceNeedsReview:true}),false);
});

test('dashboard and inbox use identical stage and demo predicates', () => {
  const tasks = [{id:'a',status:'needs_review'}, {id:'b',status:'changes_requested'}, {id:'c',status:'needs_review',sourceIds:['demo']}, {id:'d',status:'delivered'}, {id:'e',status:'archived'}];
  const sources = [{id:'demo',isDemo:true}];
  assert.deepEqual(filterTasks(tasks,{filter:'review',sources}).map(t=>t.id),['a','b']);
  assert.deepEqual(filterTasks(tasks,{filter:'delivery',sources}).map(t=>t.id),['d']);
  assert.deepEqual(filterTasks(tasks,{filter:'review',sources,includeDemo:true}).map(t=>t.id),['a','b','c']);
});

test('legacy pages resolve to the new primary areas without deleting old routes', () => {
  assert.equal(pageToPrimary('sources'), 'library');
  assert.equal(pageToPrimary('profile'), 'library');
  assert.equal(pageToPrimary('assets'), 'library');
  assert.equal(pageToPrimary('collaboration'), 'library');
  assert.equal(pageToPrimary('campaigns'), 'review');
  assert.equal(pageToPrimary('evaluations'), 'review');
  assert.equal(pageToPrimary('replay'), 'dashboard');
  assert.equal(pageToPrimary('unknown'), 'dashboard');
});
