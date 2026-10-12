import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import * as model from '../public/ui-model.js';
import * as actions from '../public/task-actions.js';
import * as visuals from '../public/visuals.js';
import * as safety from '../public/export-safety.js';
import * as metrics from '../public/business-metrics.js';

// Isolated unit-test records only; no application database or model is used.
function harness({ sensitive = false, stale = false, fetch = async () => { throw new Error('Unexpected network request in render test'); } } = {}) {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  const context = vm.createContext({ ...model, ...actions, ...visuals, ...safety, ...metrics, evidenceLabel:model.taskEvidenceLabel, window, document, localStorage:{getItem:()=>null,setItem:()=>{}}, structuredClone, URL, Blob, console, fetch, setTimeout:()=>{}, setInterval:()=>{} });
  window.scrollTo = () => {};
  let source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  source=source.slice(0,source.indexOf('refresh(true).catch'));
  vm.runInContext(source+'\nglobalThis.appTest={ui,render,renderModal,dashboardPage,draftPanel,workPage};',context);
  const state={provider:{ready:false},tasks:[{id:'t',title:'单元测试任务',brief:'测试要求',sourceIds:['s'],status:'needs_review',messages:[]}],sources:[{id:'s',title:'单元测试来源',text:'仅用于单元测试',verificationStatus:'verified'}],accounts:[{id:'a',name:'单元测试账号',identity:'planning',audience:'测试受众'}],drafts:[{id:'d',taskId:'t',title:'单元测试稿件',body:sensitive?'api_key=abcdefghijklmnop':'测试正文',cover:'测试封面',pages:[{heading:'测试页',text:'测试内容'}],tags:[],gaps:[],evidence:[],review:{verdict:'需人工核对',facts:[],issues:[]},reviewRevision:'review-1',reviewStale:stale,reviewStaleReason:stale?'测试资料已更新':'',status:stale?'draft':'accepted',version:1}],runs:[],feedback:[],issueDecisions:[],quality:{d:{readiness:stale?'stale':'ready',issues:[],facts:[],checks:[]}},leads:[]};
  Object.assign(context.appTest.ui,{state,taskId:'t',draftId:'d',page:'work',tab:'draft',inbox:false});
  return {...context.appTest,document,window};
}

test('review view keeps delivery forms off the active surface and states AI coverage', () => {
  const app=harness();app.render();
  assert.ok(app.document.querySelector('#draft-review'));
  assert.equal(app.document.querySelector('[data-form="publication"]'),null);
  assert.equal(app.document.querySelector('.visual-delivery'),null);
  assert.match(app.document.body.textContent,/已识别事实核查/);
  assert.match(app.document.body.textContent,/可能漏抽/);
  assert.ok(app.document.querySelector('[data-action="review"]').disabled);
  assert.equal(app.document.querySelector('[data-action="edit-draft"]').disabled,false);
});

test('workbench home leads with one review action, public practice, model state and four-step flow', () => {
  const app=harness();
  app.ui.state.tasks.push({id:'public',title:'公开资料实践｜公开练习任务',brief:'仅用于公开资料核验练习',sourceIds:['s'],status:'needs_review',messages:[]});
  app.ui.page='work';app.ui.inbox=true;app.render();
  assert.match(app.document.body.textContent,/开始审核一份外稿/);
  assert.ok(app.document.querySelector('[data-action="deliver-draft"]'));
  assert.ok(app.document.querySelector('[data-action="open-task"][data-id="public"]'));
  assert.match(app.document.body.textContent,/模型未配置/);
  assert.match(app.document.body.textContent,/不会显示预设审核结果/);
  assert.match(app.document.body.textContent,/任务要求/);
  assert.match(app.document.body.textContent,/资料与稿件/);
  assert.match(app.document.body.textContent,/AI 核验/);
  assert.match(app.document.body.textContent,/人工处理与导出/);
  assert.ok(app.document.querySelector('.dashboard-boundary'));
});

test('delivery view is separate and sensitive drafts cannot crash it or expose downloads', () => {
  const app=harness({sensitive:true});app.ui.tab='delivery';app.render();
  assert.equal(app.document.querySelector('#draft-review'),null);
  assert.ok(app.document.querySelector('[data-form="publication"]'));
  assert.match(app.document.body.textContent,/已禁止文案和图片导出/);
  assert.equal(app.document.querySelector('.visual-card'),null);
  assert.equal(app.document.querySelector('a[href*="/export?format=md"]'),null);
  assert.ok(app.document.querySelector('[data-action="download-visuals"]').disabled);
});

test('stale review visibly blocks acceptance', () => {
  const app=harness({stale:true});app.render();
  assert.match(app.document.body.textContent,/旧审核不能继续用于采纳或交付/);
  assert.ok(app.document.querySelector('[data-action="accept"]').disabled);
});

test('saving a consultation stays available without a configured model', () => {
  const app=harness();app.ui.page='leads';app.render();
  assert.ok(app.document.querySelector('[name="runTriage"]').disabled);
  assert.equal(app.document.querySelector('[data-form="lead"] button[type="submit"]').disabled,false);
});

test('editing and task-local delivery are bound to explicit modal record IDs', () => {
  const app=harness();app.ui.modal='task-edit';app.ui.modalTaskId='t';app.render();
  assert.equal(app.document.querySelector('[data-form="task-update"]').dataset.taskId,'t');
  assert.equal(app.document.querySelector('[name="accountId"]').disabled,false);
  app.ui.modal='deliver';app.render();
  assert.equal(app.document.querySelector('[data-form="draft-import"]').dataset.taskId,'t');
  assert.equal(app.document.querySelector('[name="taskTitle"]'),null);
  assert.match(app.document.body.textContent,/沿用账号、资料和协作记录/);
  app.ui.modal='account';app.ui.modalAccountId='a';app.ui.modalTaskId=null;app.render();
  assert.equal(app.document.querySelector('[data-form="account"]').dataset.recordId,'a');
  assert.equal(app.document.querySelector('[name="name"]').value,'单元测试账号');
});

test('task-header delivery click carries task ID rather than inferring it from current mode', () => {
  const app=harness();app.render();
  const button=app.document.querySelector('[data-action="deliver-draft"]');
  assert.equal(button.dataset.taskId,'t');
  button.dispatchEvent(new app.window.Event('click',{bubbles:true}));
  assert.equal(app.document.querySelector('[data-form="draft-import"]').dataset.taskId,'t');
  assert.equal(app.document.querySelector('[name="taskTitle"]'),null);
  app.ui.modal=null;app.ui.page='tasks';app.render();
  app.document.querySelector('[data-action="deliver-draft"]').dispatchEvent(new app.window.Event('click',{bubbles:true}));
  assert.equal(app.document.querySelector('[data-form="draft-import"]').dataset.taskId,'');
  assert.ok(app.document.querySelector('[name="taskTitle"]'));
});

test('actual click handler retains task A across feedback await and navigation to task B', async () => {
  let releaseFeedback;
  const gate = new Promise(resolve => { releaseFeedback=resolve; });
  const calls=[];
  let app;
  const response = data => ({ok:true,status:200,headers:{get:()=>null},json:async()=>data});
  app=harness({fetch:async(path,options)=>{
    const payload=options?.body?JSON.parse(options.body):null;
    calls.push({path,payload});
    if(path==='/api/drafts/d/feedback'){await gate;return response({});}
    if(path==='/api/state')return response(app.ui.state);
    if(path==='/api/evaluations')return response({reports:[]});
    return response({});
  }});
  app.ui.state.provider.ready=true;
  app.ui.state.tasks.push({id:'B',title:'测试 B',brief:'B',sourceIds:[],messages:[],status:'ready'});
  app.render();
  app.document.querySelector('[name="instruction"]').value='改写第一段';
  app.document.querySelector('[data-action="revise-submit"]').dispatchEvent(new app.window.Event('click',{bubbles:true}));
  assert.equal(calls[0].path,'/api/drafts/d/feedback');
  app.ui.taskId='B';app.ui.draftId=null;app.ui.tab='plan';
  releaseFeedback();
  for(let i=0;i<20 && app.ui.busy;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls[1].path,'/api/tasks/t/runs');
  assert.equal(calls[1].payload.draftId,'d');
  assert.equal(app.ui.taskId,'B');
  assert.equal(app.ui.tab,'plan');
});
