# 多方案内容工作台 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有小红书内容工作台中实现“输入一次、生成 3 套完整方案、选择后审核修改、复制发布包”的可用 MVP。

**Architecture:** 保留现有 Node HTTP + SQLite + 原生 HTML/CSS/JS。模型层新增一个结构化多方案交付阶段，存储层用同一任务下的候选稿标记保存结果；选中方案后复用现有 `review`、`revise`、版本链、质量报告和导出能力。基础规则检查在候选结果保存后本地执行，完整 AI 审核只针对选中方案。

**Tech Stack:** Node.js 24、Node HTTP、SQLite、原生 ES modules、原生 HTML/CSS/JS、现有 OpenAI Responses-compatible provider。

---

### Task 1: 扩展稿件模型以表达候选方案

**Files:**
- Modify: `xhs-content-agent/lib/store.mjs`
- Modify: `xhs-content-agent/lib/workflow.mjs`
- Test: `xhs-content-agent/tests/workflow.test.mjs`

**Step 1: Write the failing tests**

增加测试覆盖：

- 多方案结果保存为同一任务下的 3 个候选稿；
- 候选稿带有 `variantStatus: "candidate"` 和稳定的候选序号；
- 候选稿未被误认为已审核或可交付；
- 选择候选稿后可以沿用现有审核工作流。

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="候选"`

Expected: FAIL because the workflow only accepts one `deliver_draft` result.

**Step 2: Implement minimal storage support**

在稿件默认值和校验中增加候选元数据：

- `variantStatus`: `candidate` / `selected` / `archived`；
- `variantIndex`: 1-5；
- `variantAngle`；
- `variantAudience`；
- `variantGoal`；
- `selectedAt`。

旧稿件缺省时按非候选稿处理，避免旧数据迁移破坏历史记录。

**Step 3: Run the focused tests**

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="候选"`

Expected: storage and backward-compatibility tests pass.

**Step 4: Commit**

```bash
git add xhs-content-agent/lib/store.mjs xhs-content-agent/tests/workflow.test.mjs
git commit -m "feat: model content variants"
```

---

### Task 2: 增加多方案结构化模型工作流

**Files:**
- Modify: `xhs-content-agent/lib/workflow.mjs`
- Modify: `xhs-content-agent/server.mjs`
- Test: `xhs-content-agent/tests/workflow.test.mjs`

**Step 1: Write the failing tests**

测试模型一次返回 3 个完整方案时：

- 每套都有标题、正文、话题、封面和分页结构；
- 资料引用和缺口分别保存；
- 模型返回少于 1 套、超过 5 套或重复方案时拒绝；
- 没有模型凭据时不写入伪造结果。

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="多方案工作流"`

Expected: FAIL because no `variants` action or schema exists.

**Step 2: Add schema and validation**

在 `workflow.mjs` 中增加：

- `VARIANT`：角度、受众、目标、稿件字段、证据和缺口；
- `VARIANTS`：1-5 套方案及输入摘要；
- `validateVariants`：复用现有 `validateDraft` 的字段和引用约束，并检查标题/正文差异。

不复制模型隐性推理，只保存结构化结果和运行摘要。

**Step 3: Add execution branch**

新增 `action: "variants"`：

- 输入主题、草稿、资料、账号边界和高级要求；
- 一次真实模型调用；
- 交付后逐套执行 `inspectDraft` 本地规则检查；
- 分别保存候选稿和运行结果；
- 任务状态改为 `variants_ready` 或兼容的 `needs_review`；
- 不自动把候选稿标成 accepted。

保留现有 `draft` action 供旧任务和兼容入口使用。

**Step 4: Add route support**

在 `server.mjs` 的 run 参数白名单和状态输出中允许 `variants`，但继续使用现有 `/api/tasks/:id/runs` 接口，避免新增一套 API。

**Step 5: Run focused and full tests**

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="多方案工作流|直接模式|审核"`

Expected: focused tests pass; then `npm test` remains green.

**Step 6: Commit**

```bash
git add xhs-content-agent/lib/workflow.mjs xhs-content-agent/server.mjs xhs-content-agent/tests/workflow.test.mjs
git commit -m "feat: generate structured content variants"
```

---

### Task 3: 增加候选方案选择接口和基础检查结果

**Files:**
- Modify: `xhs-content-agent/lib/store.mjs`
- Modify: `xhs-content-agent/server.mjs`
- Test: `xhs-content-agent/tests/store.test.mjs`

**Step 1: Write the failing tests**

覆盖：

- 只能选择当前任务的候选稿；
- 选择后同任务其他候选稿变为 archived；
- 选择动作不会自动通过审核；
- 已有后续版本时不能重新选择旧候选稿；
- 选择后任务可以启动 review。

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="选择候选"`

Expected: FAIL because no candidate-selection route exists.

**Step 2: Implement the selection mutation**

在 store 中增加 `selectDraftVariant(draftId)`，保存 `selectedAt`、状态和变更记录；在 server 中增加：

`POST /api/drafts/:id/select`

响应当前选中稿件和任务状态。候选基础检查直接由 `qualityReport`/`inspectDraft` 计算，不写成 AI 审核通过。

**Step 3: Run tests**

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="选择候选"`

Expected: PASS.

**Step 4: Commit**

```bash
git add xhs-content-agent/lib/store.mjs xhs-content-agent/server.mjs xhs-content-agent/tests/store.test.mjs
git commit -m "feat: select a content variant"
```

---

### Task 4: 重做首页输入与多方案结果界面

**Files:**
- Modify: `xhs-content-agent/public/app.js`
- Modify: `xhs-content-agent/public/styles.css`
- Modify: `xhs-content-agent/public/index.html`

**Step 1: Add the direct variant submission form**

将首页输入从“主题 + 生成一篇”改为：

- 大文本框：主题、草稿或参考资料；
- 收起的高级要求；
- 方案数量默认 3，可选 1/3/5；
- 生成按钮文案为“生成内容方案”。

现有 task brief 仍按兼容格式保存，但新增 `variantCount` 和 `inputMode`。

**Step 2: Render candidate cards**

在同一工作区中展示 3 张方案卡，每张显示：

- 方案角度、受众和目标；
- 标题、正文摘要、话题；
- 封面和分页摘要；
- 基础检查状态；
- `审核并完善` 按钮；
- `复制草案` 仅作为草稿复制，不绕过完整审核。

不再要求用户先进入任务列表、任务单或选题规划。

**Step 3: Wire selection**

点击 `审核并完善` 调用 `/api/drafts/:id/select`，选中后打开当前稿件审核区，并显示“开始完整审核”。

**Step 4: Add responsive styles**

桌面端采用三列方案卡，窄屏改为单列；保留现有暖色设计，不引入渐变或新框架。

**Step 5: Run browser smoke test**

启动本地服务后检查：

- 首页 10 秒内能看懂输入和生成按钮；
- 无模型配置时按钮禁用且不显示假成功；
- 候选卡不横向溢出；
- 390px 下可滚动查看所有方案。

**Step 6: Commit**

```bash
git add xhs-content-agent/public/app.js xhs-content-agent/public/styles.css xhs-content-agent/public/index.html
git commit -m "feat: add multi-variant writing surface"
```

---

### Task 5: 将审核问题变成可执行修改入口

**Files:**
- Modify: `xhs-content-agent/public/app.js`
- Modify: `xhs-content-agent/public/styles.css`
- Modify: `xhs-content-agent/lib/quality.mjs`
- Test: `xhs-content-agent/tests/quality.test.mjs`

**Step 1: Write failing tests**

测试基础风险表达至少能识别并提供可替换目标；事实问题没有来源时不能自动换成新事实；修改后旧稿件仍保留。

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="风险替换|版本"`

Expected: FAIL because issues currently only show text and generic revision form.

**Step 2: Add deterministic replacement suggestions**

在 `quality.mjs` 为确定性承诺增加有限的、可解释的建议映射，例如：

- `保证/百分百/必然` → 删除结果承诺，改为“可以帮助梳理/建议结合实际情况判断”；
- 联系方式/凭据 → 仅提示移除，不提供自动替换。

不声称覆盖全部平台敏感词；模型审核仍负责语义问题。

**Step 3: Render issue actions**

每条可定位问题显示：原句、原因、建议、`一键替换`、`AI 修改`、`手动编辑`。一键替换调用现有版本接口生成新稿，再自动要求重新审核。

**Step 4: Preserve copy gates**

保留现有安全门槛：未审核、硬阻断、凭据和过期审核不能复制为发布稿；普通待核验事实继续明确提示。

**Step 5: Run tests and smoke test**

Run: `cd xhs-content-agent && npm test`

检查一条命中风险表达的稿件：点击替换后出现新版本，旧版本仍可回放，重新审核后复制按钮按状态变化。

**Step 6: Commit**

```bash
git add xhs-content-agent/public/app.js xhs-content-agent/public/styles.css xhs-content-agent/lib/quality.mjs xhs-content-agent/tests/quality.test.mjs
git commit -m "feat: make review issues actionable"
```

---

### Task 6: 完善发布包复制和后置复盘入口

**Files:**
- Modify: `xhs-content-agent/public/app.js`
- Modify: `xhs-content-agent/public/styles.css`
- Test: `xhs-content-agent/tests/export.test.mjs` (若现有测试目录无此文件则新增)

**Step 1: Write failing tests**

覆盖复制文本按以下顺序包含：标题、正文、话题、封面/分页文案；未达到复制门槛时导出函数继续拒绝硬阻断稿件。

Run: `cd xhs-content-agent && npm test -- --test-name-pattern="发布包|复制"`

Expected: FAIL because current copy action只包含标题、正文和话题。

**Step 2: Implement field-level copy actions**

增加：

- 复制标题；
- 复制正文；
- 复制话题；
- 复制配图分页文案；
- 复制完整发布包。

完整发布包复制仍调用现有导出安全检查，不包含证据内部引用。

**Step 3: Add post-publication entry points**

在审核通过结果页提供“记录已发布”和“发布后复盘”入口，链接到现有人工发布记录表单；不改变自动发布边界。

**Step 4: Run full tests and browser checks**

Run: `cd xhs-content-agent && npm test`

浏览器检查桌面端和 390px：审核通过后四种复制按钮可见；发布记录入口不遮挡正文；复盘无数据时显示空状态而非虚构指标。

**Step 5: Commit**

```bash
git add xhs-content-agent/public/app.js xhs-content-agent/public/styles.css xhs-content-agent/tests/export.test.mjs
git commit -m "feat: complete publish pack actions"
```

---

### Task 7: 最终验收与交付

**Files:**
- Inspect: `xhs-content-agent/docs/superpowers/specs/2026-10-09-content-workbench-multi-variant-design.md`
- Inspect: all modified files

**Step 1: Run syntax and unit checks**

Run: `cd xhs-content-agent && node --check server.mjs && node --check lib/workflow.mjs && node --check lib/store.mjs && npm test`

Expected: all syntax checks pass and all tests pass.

**Step 2: Start the local service**

Run: `cd xhs-content-agent && node start.mjs --background`

Expected: `/api/health` reports `ready` or `running`; service URL remains `http://127.0.0.1:4318/` unless occupied.

**Step 3: Browser acceptance**

Use the local browser to verify the actual page at desktop and 390px widths. Check the complete path with a configured model or a previously saved result; do not claim real model generation if no provider credentials are available.

**Step 4: Inspect diff and report boundaries**

Confirm no unrelated files changed, no mock business metrics were added, no automatic Xiaohongshu API claim was introduced, and all unverified platform integrations remain explicitly labeled.

**Step 5: Commit**

```bash
git add xhs-content-agent
git commit -m "feat: complete content production workflow MVP"
```
