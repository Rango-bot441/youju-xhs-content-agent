# 小红书矩阵内容协作工作台前台重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不破坏现有 SQLite 数据、AI 工作流和质量边界的前提下，把前台从“多模块运营后台”收敛为易理解的小红书矩阵内容协作工作台。

**Architecture:** 保留现有 Node HTTP + SQLite + 原生 HTML/CSS/JS 和全部 API；主要重构 `public/app.js` 的页面状态与信息架构，增加显示层阶段映射，把复杂能力从一级导航移到任务详情的可展开区域。后端只做必要的兼容字段读取和演示/历史素材标识，不重写已有实体、不删除历史记录。

**Tech Stack:** Node 26、node:sqlite、原生 JavaScript、原生 CSS、现有 Playwright CLI、node:test。

---

## 实施约束

- 工作目录：项目根目录。
- 所有代码编辑使用 `apply_patch`；不覆盖数据库、不删除历史稿件、不自动发布。
- 保留当前 `tasks / sources / drafts / runs / reviews / issueDecisions / publication / leads / evaluations` 数据结构。
- 不把历史项目自述、虚构演示资料或旧运行记录包装成新的业务效果。
- 本项目无 Git 仓库；计划中的“提交”步骤改为保存文件、运行测试和 readback 核对，不伪造 commit。

## 目标信息架构

一级入口控制为四个：

1. 工作台：今日待处理、当前任务、主操作。
2. 内容任务：任务收件箱、搜索、筛选、新建和直接交稿。
3. 内容与账号：账号档案、资料台账、可复用内容和交付模板。
4. 复盘：发布记录、问题归因、下一轮建议。

AI 案例回放、质量评测、执行记录、线索分拣和模型连接改为任务/稿件详情中的二级入口。旧页面不删除，使用兼容路由或“更多工具”入口访问。

## 任务阶段映射

前台统一显示五个阶段，内部状态不变：

- 需求卡：`ready`、`needs_input`。
- 账号与资料：任务资料为空或 assignment 缺资料时显示补充状态。
- AI 产出：`in_progress`、正在执行的 runs。
- 审核与修改：`needs_review`、`changes_requested`、当前 draft 有 review。
- 交付与复盘：`accepted`、`delivered`、publication 记录。

## Task 1: 建立显示层模型与回归护栏

**Files:**
- Modify: `public/app.js`
- Create: `tests/ui-model.test.mjs`
- Test: `tests/*.test.mjs`

**Step 1: Write the failing tests**

抽取为可测试的纯函数或在现有前端模块中导出测试用函数，覆盖：

- 内部 task status 到五阶段的映射；
- 当前阶段只有一个推荐下一步；
- demo/history/source verification 标签不会被误读成真实业务效果；
- 旧页面 id 仍能解析到兼容入口。

**Step 2: Run the focused test**

Run: `node --test tests/ui-model.test.mjs`

Expected: FAIL，因为新的阶段映射和显示模型尚未存在。

**Step 3: Implement the minimal display model**

在 `public/app.js` 中增加轻量的 `stageForTask(task, drafts, runs)`、`nextActionForTask(task, draft)`、`contentLabel(entity)` 等纯函数。函数只读状态，不修改保存数据，不把模型内部运行状态暴露为一级业务概念。

**Step 4: Run focused and full tests**

Run: `node --test tests/ui-model.test.mjs && npm test`

Expected: 新测试与现有全部测试通过。

**Step 5: Read back the changed code**

Run: `node --check public/app.js`，并检查新函数没有直接调用 `fetch`、没有写数据库、没有删除实体。

## Task 2: 重做应用壳与一级导航

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/ui-model.test.mjs`

**Step 1: Add shell assertions**

为显示模型补充断言：一级导航只返回 `work / tasks / library / review` 四项；二级工具包含 `replay / evaluations / leads / profile / logs`；导航标签不出现 engineering-only 术语。

**Step 2: Implement the four-entry shell**

修改 `renderShell`/导航渲染：

- 使用“工作台、内容任务、内容与账号、复盘”四个一级入口；
- 模型状态移入系统状态区域，只在 AI 操作附近提示；
- 旧页面保留内部渲染函数，通过二级入口打开；
- 统一页面标题和品牌文案为“小红书矩阵内容协作工作台”；
- 保留跳过链接、键盘可访问按钮和当前页 selected 状态。

**Step 3: Simplify shell styles**

在现有暖白/朱橙设计上做减法：减少侧栏密度、隐藏一级导航计数、保留一条主按钮层级；移动端一级导航允许横向滚动但不产生页面横向溢出。

**Step 4: Verify shell**

Run: `node --check public/app.js && node --test tests/ui-model.test.mjs`

Expected: 四个一级入口、旧页面兼容入口和响应式样式均无语法错误。

## Task 3: 重做“工作台”首页

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/ui-model.test.mjs`

**Step 1: Define dashboard contract**

首页只渲染：`新建内容任务`、`导入现成稿件`、待补充、待审核、待交付三个摘要、当前任务列表和每项下一步。禁止渲染运行总数、评测总数和技术指标卡作为首屏主内容。

**Step 2: Implement dashboard**

将现有 `inboxPage` 的收件箱能力拆成：

- `dashboardPage()`：工作台首页；
- `tasksPage()`：完整任务收件箱；
- `taskCard(task)`：统一显示账号、阶段、最新版本和下一步。

历史/演示数据不删除；若 entity 有 demo 标记或历史来源限制，在卡片上显示“演示模式/历史项目自述/待核验”标签，并单独提供演示入口，不混入默认主案例。

**Step 3: Verify real state**

使用当前持久数据库读取状态，确认首页不创建新数据、不改变任务排序的持久值、不隐藏历史记录，只改变显示分组。

## Task 4: 把任务详情改为五阶段单页流程

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/ui-model.test.mjs`, `tests/server.test.mjs`

**Step 1: Add stage rendering tests**

覆盖没有资料、没有稿件、已有审核问题、已有人工版本、已交付五种真实状态，确保每种状态只出现一个主要下一步。

**Step 2: Implement stage timeline**

重组 `workPage`、`planPanel`、`draftPanel`、`logsPanel`：

- 顶部显示任务标题、账号和五阶段进度；
- 需求卡直接显示需求字段和补充对话；
- 资料阶段显示来源等级、核验状态和缺口；
- AI 产出阶段显示选题/稿件结果，运行轨迹放在可展开的“过程与证据”；
- 审核阶段显示必须修改、建议优化、待确认和引用定位；
- 交付阶段集中导出、发布前检查和复盘入口。

保留现有 API 调用、版本不覆盖、锁定字段、问题处理、引用 drawer、diff、失败重试和取消逻辑。

**Step 3: Rename user-facing terms only**

替换界面文案：

- 任务单 → 需求卡；
- 稿件质检/质量评测 → 发布前检查；
- 执行记录 → AI 过程与证据；
- 问题决定 → 处理审核意见；
- 采纳 → 人工确认交付。

API 字段名、数据库列名和历史 JSON 不改。

**Step 4: Verify backend contracts**

Run: `npm test`

Expected: 既有 147 项及新增状态测试全部通过；现有导出、compare、issue decision、retry 和 evaluation API 行为不变。

## Task 5: 把辅助能力收进任务上下文

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/ui-model.test.mjs`

**Step 1: Define secondary tools**

在任务详情的“更多工具”中提供：

- 过程与证据：AI 案例回放、运行 trace 摘要；
- 发布前检查：自动核查报告和限制说明；
- 版本比较：同链版本 diff；
- 资料与账号：跳到对应局部编辑区域；
- 真实咨询：仅当已有真实线索时显示线索分拣。

**Step 2: Implement non-blocking drawers/sections**

辅助面板默认折叠，不阻塞核心内容；打开后保留当前任务、稿件和 tab，关闭后回到原位置。所有下载、引用定位和导出按钮继续使用现有接口。

**Step 3: Add truthful empty states**

没有真实发布数据、线索或模型配置时，展示明确的空状态和下一步，不生成演示数据、不显示“已完成”类假状态。

## Task 6: 视觉与移动端收口

**Files:**
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Test: Playwright browser session `xhs-matrix-review`

**Step 1: Desktop verification**

在 1280×900 打开首页、任务详情、稿件审核和复盘，检查首屏是否只突出一个主操作、文字层级和卡片密度是否可读。

**Step 2: Mobile verification**

在 390×844 检查首页、任务详情、审核意见、引用 drawer 和导出操作。验证 `document.documentElement.scrollWidth === window.innerWidth`，确认无横向溢出和按钮遮挡。

**Step 3: Accessibility verification**

检查搜索框、select、tab、dialog、drawer、状态标签和主要按钮都有可读名称；键盘 Tab 顺序不跳出当前任务上下文；减少动效设置仍生效。

## Task 7: 面试演示案例与文案收口

**Files:**
- Modify: `public/app.js`
- Modify: `docs/plans/2026-09-23-operations-upgrade.md`
- Create: `docs/demo/xhs-matrix-interview-runbook.md`

**Step 1: Write the three-minute demo script**

只使用已有、明确标记证据边界的任务；脚本包含需求、资料、AI 初稿、事实风险、人工版本、再次质检和导出，不写虚构业务指标。

**Step 2: Add in-product guidance**

在空态和案例回放中增加一句话说明：系统解决内容协作与质检问题，不证明真实平台增长效果；历史方法和演示数据均有标签。

**Step 3: Verify content boundary**

Run: `rg -n "GMV|粉丝|线索|增长|转化" public/app.js docs/demo/xhs-matrix-interview-runbook.md`

逐条确认所有数字和效果都来自明确历史口径或留空，不把系统运行记录写成业务成果。

## Task 8: 全量验收与交付

**Files:**
- Modify: `docs/plans/2026-09-23-operations-upgrade.md`
- Test: `tests/*.test.mjs`, Playwright session, service lifecycle

**Step 1: Run automated validation**

Run: `npm test && node --check public/app.js && node --check server.mjs && node --check lib/store.mjs && node --check lib/workflow.mjs`

Expected: 全部通过，测试数量不低于当前 147 项。

**Step 2: Validate API and persistence**

记录停启前的任务、资料、稿件、运行、线索和账号数量；执行 `npm run stop && npm run start:background && npm run status`；再次读取 `/api/state`，确认数量一致且 `busy=false`。

**Step 3: Validate browser flow**

完成一条不调用新模型的只读演示：工作台 → 内容任务 → 打开任务 → 查看稿件/审核 → 展开过程与证据 → 查看版本差异 → 返回工作台。再验证质量报告和演示/历史标签。

**Step 4: Update evidence log**

在 `docs/plans/2026-09-23-operations-upgrade.md` 追加实际测试数量、截图路径、服务 PID 状态、数据库保留结果和未验证的外部依赖；不清理旧验收记录。

## 交付判定

只有同时满足以下条件才称为本轮完成：

- 首页十秒内可解释，一级导航不超过四个；
- 任务详情按五阶段运行，用户不需要先理解内部工程术语；
- 现有质量、版本、引用、导出和失败恢复能力无回退；
- 桌面与 390px 移动端通过浏览器检查；
- `npm test`、语法检查、服务停启保留和 readback 均有实际证据；
- 面试脚本只使用真实/历史自述边界，不虚构当前业务效果。

## 2026-09-30 全面 review 后的修复执行单

本轮按用户已确认的 review 方案继续，不重新扩功能或换架构。采用现有文件增量修改；保存工作库一致备份，测试数据仅进入内存或隔离库。

### 并行分工与依赖

- 后端：`lib/store.mjs`、`lib/workflow.mjs`、`lib/publication-import*.mjs` 及对应测试。审核绑定业务上下文，变更使旧审核失效；复审撤销当前采纳；修正实验快照、同轮日期纠错和 CSV 当前快照优先级。
- 前端：`public/app.js`、`public/ui-model.js`、`public/styles.css` 及前端测试。固定异步操作对象；补齐任务/账号编辑、当前任务交稿；共用计数筛选；需求/审核/交付分区，细节后置。
- 导出：`lib/quality.mjs`、`public/visuals.js`、`server.mjs` 及对应测试。所有格式共用敏感内容策略；凭据硬拦截，联系方式默认隐藏；原稿保持不变。
- 主任务：交叉审查接口，维护岗位相关案例和演示说明；完成跨模块回归、浏览器验收和服务停启保留验证。

### 每项执行与验收

1. 先增加 review 中可复现失败路径的回归测试，再实施最小修复，运行对应测试。
2. 前后端对齐审核失效字段及凭据导出拦截协议，验证旧数据只读兼容。
3. 在隔离库跑通：新需求 → 补账号 → 原任务交稿 → 审核/修改 → 导出 → 数据纠错。
4. 强制复现：A 请求途中切换 B、更新资料后沿用旧审核、复审阻断后已采纳标签、敏感标题/正文/标签/图片/文件名出口、只改实验名、交稿日期纠错、历史 CSV 再导入。
5. 运行 `npm test`、语法检查；浏览器验证桌面与 390px 手机、主要表单与下载、控制台和横向溢出。
6. 正式库旧记录数量保留；新增公开资料实践必须标注用途，不编造账号表现、客户线索、转化或 ROI。

### 进度

- [x] 用户确认 review 修复方案；文件归属和并行范围已核对。
- [x] 实现安全、审核状态、业务流程和数据正确性修复。
- [x] 全量测试、隔离协议端到端与浏览器交互、正式服务只读验收；新真实模型运行受凭据限制，未验收。
- [x] 补齐演示说明、实际验证结果和外部能力限制。

### 本轮验收结论（2026-09-30）

- 最终全量测试 211 / 211 通过，退出码 0；前端、状态模型、异步动作、导出安全、图片、服务、存储和工作流语法检查退出码均为 0。
- 隔离 HTTP 流程覆盖需求、原任务交稿、首次补账号、审核、采纳、需求变更使采纳过期、复审、旧轮次人工请求拒绝。模型响应使用测试协议替代，不是新的真实模型业务验收。
- 实际浏览器完成原任务交稿、补关联账号、账号编辑、任务分区切换；SVG、PNG、Markdown 均实际下载成功并隐藏测试邮箱，原始稿件仍保留原文。隔离交互未新增模型运行。
- 正式首页和公开资料实践、隔离历史审核页均完成桌面 1440px 与手机 390px 验收，无横向溢出，控制台 0 errors / 0 warnings。历史审核页默认高度由此前 3995 / 7893px 降为 2232 / 3315px；仅说明同任务页面分区效果，不作为业务提效指标。
- 正式服务停启后 ready、busy=false。原库 57 条记录逐条 JSON 比对，无删除、无改写，settings 一致；仅新增公开资料实践的资料、任务和未审核稿各 1 条。重启后账号 3、资料 8、任务 7、稿件 15、运行 23、线索 1。
- 备份：`.local/backups/workspace-before-review-fixes-2026-09-30-1790744303913.sqlite`。
- 截图：`output/playwright/fixes-0930-home-desktop.png`、`fixes-0930-review-desktop.png`、`fixes-0930-review-mobile.png`、`fixes-0930-public-practice-desktop.png`、`fixes-0930-public-practice-mobile.png`。
- 外部限制：当前模型 ready=false，未找到可用凭据。成人 AI 公开资料案例保持未审核，来源待人工核验。本轮无新真实模型调用、无平台接入、无真实用户提效或增长测量，不能据自动测试声称生产上线或业务效果成立。
