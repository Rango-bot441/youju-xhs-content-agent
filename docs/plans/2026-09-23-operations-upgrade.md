# 小红书内容交付工作台 Implementation Plan

## 持续优化验收（2026-09-24，进行中）
- [x] 核对当前工作区与持久数据：6 tasks / 7 sources / 14 drafts / 23 runs / 1 lead / 3 accounts；基线121项测试通过。
- [x] 质量边界：无引用事实阻断、整句范围声明检查、教育结果承诺、人工处理不等同事实支持、引用资料时效提醒；模型目录/直接上下文/读取工具传递资料台账。
- [ ] 并行整合：后端请求互斥/线索纠错与历史/发布数据约束；前端表单保持/同链版本/逐字段定位；图文完整分页和桌面/手机布局。
- [ ] 隔离数据库操作验收、桌面与390px浏览器交互、实际图文下载和控制台检查。
- [ ] 完整测试、后台停启与数据保留复验、交付。

历史记录中的“7条评测”“未安装Playwright”仅描述当时状态。本轮已启动Playwright浏览器，API已含23条历史运行（列表有分页/数量上限）；当前验收结论以本节完成记录为准。

**Goal:** 将现有原型增量升级为可交稿、分配、审阅、补料、修订、比较与评估的本地运营工作台，保留所有历史数据并完成真实材料验收。

**Architecture:** 沿用 Node HTTP + SQLite + 原生前端。增加业务实体与统一质量检查模块；现有受控模型工具循环按阶段路由，小资料直接提供证据、复杂资料继续检索。UI 改为任务收件箱与稿件工作区，保留既有导入/生成/审核能力。

**Tech Stack:** 现有 Node 26、node:sqlite、linkedom、HTML/CSS/JS；不引入服务框架或外部数据库。

## 既有授权与边界
用户已要求按完整评审一次性修改到位；沿用暖白朱橙视觉，不再逐项确认。此任务授权业务功能、交互、质量和本地运行改进；不部署线上、不自动发内容、不伪造账号、历史稿件、业务数据、用户反馈或人工测评。软件测试输入仅供隔离的程序回归，不能作为业务默认数据。真实验收使用已保存网站、实际生成稿及用户已有经历文件；历史方法需标历史自述，不当作现行平台规则或亲历素材。

## 功能验收与模块所有权
1. 数据/API Agent：lib/store.mjs、server.mjs、tests/store.test.mjs、tests/server.test.mjs。增量兼容、资料分类、账号、多任务、交稿、补料、版本编辑、审核决定、状态、导出、状态ETag。
2. 工作流 Agent：lib/workflow.mjs、lib/provider.mjs、tests/workflow.test.mjs、tests/provider.test.mjs。任务单/澄清、受控生成、逐句事实审查、局部修改、来源快照、请求追踪、恢复、简单资料优化。
3. 前端 Agent：public/。运营收件箱、紧凑稿件工作区、直接编辑、局部改稿、版本diff、引用双向定位、问题处理、任务单/对话、账号与资料、真实评估页面、手机/键盘/工作位置保持。
4. 主 Agent：lib/quality.mjs、tests/quality.test.mjs、scripts/evaluate.mjs、start.mjs、package.json、计划、集成与浏览器验收。与各模块约定统一质量/差异函数。

## 共享实体（全部增量，旧记录使用缺省值）
account={id,name,audience,positioning,tone,productFacts,restrictions,owner,identity:'real'|'planning',createdAt,updatedAt,archived:false}。不创建默认虚构账号。旧profile仍读写，未选择account时仅作legacy上下文。
source增加category:'reference'|'product'|'experience'|'method'|'policy'、note、archived:false。不修改已保存正文；更新只允许元信息，避免历史引用失效。
task增加accountId:null、owner:''、status:'ready'|'needs_input'|'in_progress'|'needs_review'|'changes_requested'|'accepted'|'delivered'|'archived'、assignment:null、messages:[]、publication:null。
assignment={audience,objective,angle,facts:[],materials:[],deliverables:[],criteria:[],questions:[]}，文本项不可捏造。messages=[{id,role:'user'|'assistant',text,createdAt}]。资料不足保存questions并设置needs_input；用户补充后可重新任务单/计划/审稿，无需丢弃稿件。
draft增加origin:'ai'|'imported'|'manual'、author:''、changeNote:''、editingSeconds:null、lockedFields:[]、evidenceNeedsReview:false；正文仍不可覆盖。新人工版本清空review，保留来源但evidenceNeedsReview=true。
review保留verdict/issues兼容，新增facts:[{claim,sourceRef,sourceQuote,status:'supported'|'unsupported'|'conflicting',reason}]。issue新增id、category:'fact'|'fit'|'expression'|'material'、field:'title'|'body'|'cover'|'pages'、locationVerified、blocking:boolean；既有issue照常显示。
issueDecision={id,draftId,issueKey,decision:'resolved'|'dismissed',comment,createdAt}，作为独立追加记录，不删除模型意见，不宣称人工反馈即证明模型正确。
run新增promptVersion、toolVersion、contextSnapshot、trace:[]、failedRequests、usageUnknown、scope:null、lockedFields:[]。trace仅保存脱敏公开输入、工具参数/输出和交付物，不保存模型推理文本。
evaluation记录由主Agent脚本写独立.local/evaluations/*.json，API GET /api/evaluations读取；必须明确自动检查/模型评判/真人反馈各自范围，不混为准确率。

## API契约
GET /api/state继续提供旧字段，并新增accounts,issueDecisions,capabilities。ETag支持304；前端仅活跃运行轮询，无变化不重绘。GET /api/sources/:id获取资料详情；GET /api/health提供版本与状态。
POST /api/accounts 新建account；POST /api/accounts/:id增量编辑（仅已知字段）；POST /api/sources/:id仅改category,note,archived。
POST /api/tasks支持{title,brief,sourceIds,accountId?,owner?}；POST /api/tasks/:id支持{title?,owner?,accountId?,status?,sourceIds?,assignment?,publication?}。资料只能增补不能破坏旧引用。账号变更已有稿件时禁止，要求新任务。
POST /api/tasks/:id/messages {text,sourceIds?}→保存用户补充，合并资料，status ready（不自动付费运行）。模型从最近消息理解已回答问题。
POST /api/tasks/:id/drafts {title,body,cover?,pages?,tags?,author?,changeNote?}→导入现成稿件；evidence=[]、review=null、origin=imported；不强制先生成选题。可无资料交稿，但审核前必须补资料。
POST /api/drafts/:id/versions {title?,body?,cover?,pages?,tags?,lockedFields?,changeNote?,editingSeconds?}→新人工版本；必填changeNote、可编辑最新版本；禁止覆写原稿或跨任务。
GET /api/drafts/:id/compare?base=ID→{baseId,draftId,fields:[{field,before,after,changed,diff:[{type:'same'|'add'|'remove',text}]}]}。base必须同一版本链。
GET /api/drafts/:id/quality→qualityReport(draft,sources,peerDrafts,issueDecisions)。公开输入+静态规则结果，不额外模型调用。
POST /api/drafts/:id/issues {issueKey,decision,comment}→issueDecision；只允许真实存在issue id/key。resolve为用户处理声明，保留日志。
POST /api/drafts/:id/feedback兼容；accepted前阻断未审核/未处理blocking问题；普通警告可人工采纳。task同步accepted/changes_requested。
POST /api/tasks/:id/runs action增加brief；支持{scope?:{field:'title'|'body'|'cover'|'pages',text?:string},lockedFields?:string[]}。部分改稿只替换选区或所选字段，其他字段由程序保留。POST /api/runs/:id/retry恢复保存选项，若已有结果稿则只重新审核，保留原记录。
导出format=md|json；默认只稿件内容（适合交付），includeEvidence=1显式导出本稿实际引用片段/审核，不导出所有资料。额外GET /api/tasks/:id/export导出任务单。
GET /api/evaluations→{reports:[]}。没有真实测评则显示空状态，不填基准数。

## 主Agent质量模块接口（其他模块直接导入）
export inspectDraft(draft)→兼容severity/quote/reason/sourceRef/suggestion，加id/category/field/blocking，修正否定承诺误报；规则无法穷尽语义。
export locateQuote(draft,quote,field?)→{field,start,end}|null；所有审核quote先核实存在，无法定位的意见需标识，不能当硬阻断。
export normalizeReview(review,draft,sources)→review，检查sourceQuote是否属于sourceRef原文，归一issues与facts，未支持关键事实形成blocking意见，来源自述不等于独立事实。
export qualityReport(draft,sources=[],peers=[],decisions=[])→{checks:[{id,label,status:'pass'|'warn'|'fail',detail}],issues:[],duplicates:[{draftId,title,similarity,excerpt}],readiness:'unreviewed'|'blocked'|'needs_confirmation'|'ready',limitations:[]}。重复是可解释文本重合，不宣称抄袭或平台判断。
export compareDrafts(base,draft)→{baseId,draftId,fields:[{field,before,after,changed,diff:[]}]}。
export redactSensitive(text)→string；电话号码/邮箱/密钥样式脱敏，供模型输入与trace，资料原文留本地。

## 实施顺序与验收
1. 数据库备份；计划契约落盘；3个独立模块并行，主Agent质量函数。
2. 先跑领域回归：旧库兼容、外部交稿、版本不覆盖、无依据事实、否定句、选区/锁定、跨任务引用、澄清消息、采纳门槛、导出最小范围。
3. 集成后真实资料试跑：导入历史方法作为method；真实稿件交稿→任务单→审核→补料→人工修改/局部AI修改→版本对比→处理审核→导出。历史稿保留。
4. 用真实保存任务/稿件建立自动评测报告；固定输入比较同模型单次直接结果与工作流结果，记录要求满足、引用支持检查、耗时、token；人工评分留空，不能声称真人提效。
5. 浏览器验证桌面/390px，首屏见稿件或任务；引用、diff、输入保留、对话、错误重试与恢复、导出可用；控制台无错误。
6. 本地启动提供健康检查和项目内后台启动/停止（只操作验证过的自身PID，不修改系统服务），正常重启保留数据。交付报告明确已验证范围与外部依赖。

## 集成验收记录（2026-09-23）
- `npm test`: 109/109 passed；`node --check server.mjs public/app.js lib/quality.mjs` passed。
- 默认数据库下，`GET /api/evaluations`现会包含真实运行轨迹；`GET /api/state`继续保持ETag语义，评测视图独立刷新。自动稿件评测不允许空样本或未审核稿件。
- 真实资料的人工v2仅按正文3页/封面另计的要求完成一次模型审核：1次请求、输入5855 tokens、输出963 tokens、约20秒。抓到一项确实超出历史自述来源的“反馈机制”断言并阻止采纳；一个“将方法变得更可执行”的非阻断表达建议。未经用户人工决策，稿件仍保持blocked。
- 页面实际启动于`http://127.0.0.1:4318/`；本轮浏览器确认收件箱、实际稿件及质检意见和账号空态可见。Playwright旧会话曾累计147条由服务停止窗口造成的`ERR_CONNECTION_REFUSED`历史事件；恢复服务并刷新后页面正常，旧日志未清理。移动端截图、引用抽屉/diff/表单完整交互本轮未完成验收，不据此宣称通过。
- 本地持久数据：2 tasks / 2 sources / 4 drafts / 7 runs；评测页显示7条真实运行审计。后台停启通过，重启后数据仍在。

## 区域教育获客工作流补充验收（2026-09-23）
- 新建区域教育任务时可填写地区、年级、学科/主题、家长问题、内容目标及小红书/小绿书形式；字段被整理进持久任务说明，创建任务不自动触发模型。
- 政府网页正文抽取补充支持海淀教育专题页 `.studyMap` 结构，并保留 `.zysx_box` 页面注释。实测导入海淀区政府“美丽海淀”专题页：17个学区及学校列表；原文限定其为按地理位置列示的学校校址分布，入学以具体学校公告为准，数据截止2023年8月。2026入学意见页面仍只有标题元数据，正文是空占位符，未作为政策内容材料使用。
- 真实模型 gpt-5.6-terra 执行选题规划 1 次（输入6737、输出1114 tokens）、生成带封面与3页大纲的图文草稿 1 次（输入15276、输出1491 tokens）及独立审核。首稿出现一条无法与来源原文匹配的表述，质检拦截；人工建立不可覆盖的v2-v4并多轮复核，最终模型审核未发现阻断问题。仍有两项素材边界警告：未导入2026政策/具体学校最新公告，且目标年级未指定；当前内容仅限说明信息边界，不适合作为入学政策答复。模型判定不是独立事实核验或真人审核。
- 稿件区新增销售线索交接CSV模板下载，地区、年级、学科、家长原始问题等真实线索栏保持空白，明确待真实咨询后填写，不生成虚构家长信息。HTTP实测返回200，CSV UTF-8 BOM格式。
- 新增官方区域页抽取、标题-only空页面拒绝、区域任务字段持久化、线索CSV边界及政策范围免责声明回归；`npm test`: 114/114通过，四个改动模块`node --check`通过。服务后台重启后健康检查通过，原SQLite数据保留。
- 当前未验证：真实家长咨询与线索交给销售、真实平台发布、账号评论互动、拉新数量变化、内容视觉成图、移动端完整交互、真人审核与节省时长。当前最终稿未被人工采纳或发布；工作台未自动发布。

## 可用性优化（2026-09-23）
- 文章事实审核会将明确的“本文仅解释/不解读”等文首范围说明保留在事实记录，但不再把无外部来源的范围说明另生为事实错误；范围识别限于简短首分句，避免覆盖其后的其他句子。回归覆盖范围说明与项目历史事实边界。
- 工作区状态API的运行列表改为轻量摘要，完整快照和工具轨迹仍保存在本机数据库，只在状态中报告是否有快照和轨迹条数。回归确认大型快照/轨迹不会泄漏到摘要。
- 稿件质检区把内部状态翻译成运营可读文字，列出下一步，并在已有核查结果未加载时不显示可采纳按钮；待确认稿件仍需人工处理，但“采纳”明确不等于发布。系统核查不被标为真实性保证。
- 线索交接CSV现在预填任务brief中的区域、年级、主题和家长问题，并标出当前稿件与版本、稿件质检及待确认的下一步；真实咨询个人信息和需求判断仍空白。
- `npm test`: 117/117通过；改动模块`node --check`通过；服务在`http://127.0.0.1:4318/`健康检查通过。真实保存的状态JSON由约934KB降到约392KB（仍含稿件、计划和审核结果）；线索CSV HTTP返回200且任务字段预填。
- 本机没有安装Playwright/Chromium，因此没做浏览器像素级和移动端截图验收；已通过Codex内置浏览器打开实际工作台并读取任务收件箱。仍需真人最终核对政策事实，平台发布及真实获客链路未验证。

## 最大化收口验收（2026-09-27）
- [x] 前端增量优化：任务搜索框补充明确无障碍名称；评测报告文件系统独立于工作区 revision，ETag 返回304时在评测页/强制刷新仍会同步新报告，避免质量记录滞后。
- [x] 桌面浏览器验收：实际打开 `http://127.0.0.1:4318/`，确认内容任务、区域资料、质量评测、AI案例回放可进入；质量页可读取历史执行轨迹与稿件核查，案例回放展示输入、资料范围、模型动作、人工版本与核验边界。刷新后未出现新的控制台错误。
- [x] 390px 移动端验收：收件箱和区域资料页面截图已保存到 `output/playwright/inbox-mobile.png`、`output/playwright/quality-mobile.png`；任务质检页也实测 `window.innerWidth=390`、`document.documentElement.scrollWidth=390`，确认无横向溢出，导航可横向滑动，核心按钮、搜索、稿件质检与待处理意见可见。
- [x] 持久化与服务生命周期：停启前后真实数据计数均为 6 tasks / 7 sources / 14 drafts / 23 runs / 1 lead / 3 accounts；健康检查返回 ready、busy=false、activeRuns=0，服务由项目自身登记PID管理。
- [x] 回归验证：`npm test` 147/147 passed；`node --check public/app.js server.mjs lib/store.mjs lib/workflow.mjs` 全部通过。
- [ ] 外部依赖仍需用户在自己的环境配置模型凭据后才能新跑 AI；当前页面诚实显示“模型待配置”，不会伪造一次成功调用。既有运行记录和核查报告可离线回放；政策事实、真人采纳、真实平台发布、真实线索转交及业务指标仍未被本作品自动证明。

## 前台信息架构重构（2026-09-28，已完成首轮）
- [x] 产品外壳从“区域获客工作台”收敛为“小红书矩阵内容协作”，一级导航从 7 项压缩为“工作台 / 内容任务 / 内容与账号 / 复盘”4 项。
- [x] 新增工作台首页：只突出新建任务、导入稿件、待补充/待审核/待交付和当前任务下一步；演示模式、待核验、历史项目自述均显式标记，未删除旧数据。
- [x] 新增内容与账号、复盘聚合页；资料台账、账号档案、发布复盘、发布前检查保留为二级入口，旧页面兼容访问。
- [x] 任务详情增加五阶段显示：需求卡 → 账号与资料 → AI 产出 → 审核与修改 → 交付与复盘；把原“任务单 / 稿件与质检 / 执行记录”改成用户可理解的“需求与资料 / AI 产出与审核 / 过程与证据”。
- [x] 新增 `public/ui-model.js` 与 `tests/ui-model.test.mjs`，覆盖阶段映射、唯一下一步、历史/演示/待核验标签和旧页面兼容；回归测试由 147 项增至 153 项，全部通过（含账号矩阵角色和投放/转化口径测试）。
- [x] 浏览器实际验收：1280px 桌面首页、任务列表、内容与账号、复盘、任务详情；390px 任务详情无横向溢出（`scrollWidth=390`），截图为 `output/playwright/workbench-mobile.png`。
- [x] 辅助能力入口已从“内容与账号”和“复盘”聚合页收口，并补充“更多工具”入口；面试案例脚本已落盘到 `docs/demo/xhs-matrix-interview-runbook.md`。
- [ ] 外部依赖仍未被虚构为已完成：模型凭据、真实平台发布、真人采纳和真实业务指标仍需在用户自己的工作环境中补齐。

## 业务真实性复核（2026-09-29）
- [x] 任务创建从区域教育字段收敛为业务背景、目标人群/阶段、内容目标和成功指标，保留旧数据兼容但不再把旧场景当作默认工作流。
- [x] 账号档案增加“矩阵角色”，可记录经验分享、问题解答、产品承接等真实分工；账号仍明确区分真实账号与规划中账号。
- [x] “内容与账号”补充内容资产入口，只展示真实保存且完成过审核的稿件，支持从资产回到原任务，不把未审核 AI 初稿当成可复用模板。
- [x] 发布记录增加自然流量、效果投放、素人种草、企业账号投放四类流量来源，并补充点击、关注、咨询、转化、消耗、收入等原始字段；复盘页只在分子、分母和观察日期完整时计算 CTR、CVR、获客成本和 ROI。
- [x] 工作台默认不把虚构演示任务计入运营待办；演示数据仍可在全部任务和回放中查看并明确标记。
- [ ] JD 中“真实平台投放、平台后台数据、GMV/ROI 结果、真人采纳”仍不能由本机作品自动证明；当前提供的是可落地的数据录入口径、计算规则和人工边界，不把空白字段包装成效果。

## 最终业务收口与下一层模型（2026-09-29）

本次收口以用户的真实工作痛点为验收标准：矩阵账号分工、外部/兼职交稿、内容质量不稳定、需求反复、发布后无法回到选题和稿件复盘。以下内容区分“当前已落地”与“接入真实业务后的下一层”，不把设计预留写成已经发生的业务结果。

### 当前已落地的协作闭环

- [x] 任务卡记录业务背景、受众阶段、内容目标、成功指标、账号、资料和负责人。
- [x] 外部交稿可以直接进入任务，保存作者、来源、版本、修改说明和审核结果；没有资料时先收稿，审核前仍要求补足依据。
- [x] 人工修改生成不可覆盖的新版本，保留原稿、差异和处理理由；模型意见与人工决定分开记录。
- [x] 账号档案增加矩阵角色，允许区分经验分享、问题解答、产品承接等内容职责；规划中账号不会被表述为真实账号。
- [x] 已审核稿件进入内容资产区，可回到来源任务；未审核初稿不作为可复用资产。

### 外部作者与供应链的扩展模型

如果进入真实团队协作，建议在现有任务/稿件/版本关系上增量增加 `contributor`、`deliveryBatch` 和 `reviewCycle` 三类记录：

- `contributor`：作者类型（内部、兼职、外包、合作账号）、可承担的账号角色、负责范围和状态；不保存不必要的个人隐私。
- `deliveryBatch`：批次、截止时间、任务数量、交付状态和关联稿件；支持一次交稿多篇内容。
- `reviewCycle`：首审、返工、复审、采纳或退回，以及每次处理原因和耗时。

由此可以计算一次通过率、返工原因分布、交付准时率和不同供给方的质量趋势。以上指标必须来自真实交付记录，不能用当前演示数据代替。

### 投放与内容实验的扩展模型

当前发布记录已经保存流量来源和原始指标，并仅在字段完整时计算 CTR、CVR、获客成本和 ROI。要满足 JD 中“投放优化、信息流和数据迭代”的完整演示，下一层应增加：

- `campaign`：投放目标、平台、预算、时间窗、受众和归因口径；
- `creativeVariant`：同一选题的标题、封面、正文或账号变体；
- `experiment`：待验证假设、主指标、护栏指标、分流方式、观察窗口和结论；
- `attribution`：内容、点击、咨询、有效线索、转化和收入之间的来源链路。

每次实验必须先写假设，再录入观察数据，最后由人工填写结论。系统可以帮助比较变体和发现异常，但不能从没有分母、时间窗或归因依据的记录推导增长结论。

### 外部平台边界

当前作品没有宣称以下能力已经接通：小红书账号后台同步、内容自动发布、聚光/信息流投放、评论/私信抓取、CRM 自动回传、真实 GMV 或 ROI 结果。原因是这些能力依赖平台授权、数据权限和真实业务环境。

当前保留的接口边界是：人工录入和 CSV 导入 → 字段校验 → 来源与观察日期留痕 → 统一口径计算 → 内容/账号/实验复盘。未来接入平台时只增加数据适配器，不改变任务、审核、版本和证据链。

### 最终面试演示路径

1. 从首页点击“新建内容任务”，填写业务背景、目标人群、内容目标和成功指标。
2. 选择一个矩阵角色和两份经过标记的资料，说明资料决定可说范围。
3. 运行 AI 生成标题、正文、封面和分页，展示运行记录及失败恢复能力。
4. 打开一条事实或表达问题，定位原句和来源，人工处理后生成新版本并查看差异。
5. 打开发布前检查，确认账号人设、搜索词、评论承接和风险边界。
6. 录入一条真实发布记录；没有真实指标时保持空白，演示系统不会补零或伪造 ROI。
7. 最后展示内容资产和复盘页，说明如何把一次交付沉淀为后续选题、账号分工和实验输入。

面试讲解顺序固定为“业务痛点 → 任务卡 → 资料约束 → AI 产出 → 人工质检 → 版本交付 → 数据复盘”，避免从数据库、模型参数或后台日志开始讲。

## 2026-09-30 已批准方案执行清单

目标：完成上一轮自检指出的内部缺口，不扩大为自动投放、自动发布或多人在线 SaaS。沿用 Node.js、SQLite 和原生前端，保留既有记录与四个一级导航。

- [x] 后端：在 `lib/store.mjs`、`server.mjs` 接通作者、协作交付、活动、实验；审核留痕、关联校验、未知指标不补零；对应 store/server 测试。
- [x] 前端：在 `public/app.js`、`public/ui-model.js`、`public/styles.css` 简化首页，辅助功能后置；统一泛用文案，资产按历史/演示筛选，清理旧重复表单；保留原数据。
- [x] 数据：新增纯函数 CSV 解析和指标模块；导入先预览校验再确认，关联真实任务/稿件，事务提交、重复跳过、冲突不覆盖；区分 ROAS 与利润 ROI。
- [x] 验收：全套测试、服务安全重启、正式库只读计数核对、隔离测试库实际交互、桌面/移动页面及错误检查。无凭据不伪造 AI 成功，未授权平台不声称已接通。

模块之间先约定接口再集成；所有新业务样例仅存在隔离验收库，不写入用户工作库。最终交付必须报告实测证据与外部依赖。

### 2026-09-30 最终验收证据

以上更新取代 09-29 节中作者协作、投放记录及 CSV“下一层设计”的状态：这些功能现已落地为可保存、校验和回看历史的本机功能。自动发布、自动投放、平台同步和多人身份权限仍未实现。

- `npm test`：175 / 175 通过，退出码 0；前后端与新增导入/指标模块语法检查退出码 0。
- 正式服务安全停启后 `/api/health` 为 ready；原库仍有任务 6、资料 7、稿件 14、运行 23、线索 1、账号 3。新协作/计划/实验均为 0，未植入虚构业务记录。备份：`.local/backups/workspace-before-final-2026-09-30-1790739383154.sqlite`。
- 隔离内存库浏览器操作：新建任务、保存现有稿件、创建作者、创建返工协作单、改为验收、创建投放计划与双变体实验、CSV 预览后确认保存均走通；返工历史仍保留，空白花费仍为 null。这些程序验收记录不是业务样本或增长证据。
- 桌面 1280px 首页和移动 390px 首页、发布复盘（含展开 ID 对照）、实验编辑无横向溢出；正式与隔离浏览器控制台均 0 errors / 0 warnings。
- 截图：`output/playwright/final-workbench-desktop.png`、`final-workbench-mobile.png`、`final-experiment-mobile-isolated.png`。
- 交互补修：新建无稿任务进入需求与资料；旧稿审核不推动新稿状态；无模型/无资料外稿按钮只承诺保存；实验观察数据渐进展开；CSV 中文状态与逐行核对、ID 对照可用。
- 当前模型 `ready=false`，本轮没有进行新付费模型调用，不能声称真实 AI 端到端已重新验收。真实平台、授权数据、人工使用反馈与业务效果仍待用户环境验证。

### 2026-09-30 review 修复后的补充验收

本节记录当日后续修复结果，不抹去上方 175 项测试的历史阶段。当前全量为 **211 / 211 通过**，语法检查、正式服务安全停启、原记录逐条保留检查均通过。审核与业务上下文绑定，旧审核/旧页面人审不能跨版本放行；异步改稿固定原任务；凭据阻断和联系方式隐藏覆盖文案、证据包、文件名及图片出口。

任务详情拆为需求与资料、产出与审核、交付与复盘。真实浏览器验证交稿仍在原任务、首次补账号和账号编辑可保存；桌面及 390px 手机无横向溢出，控制台 0 errors / 0 warnings；SVG、PNG 和 Markdown 实际下载通过脱敏核对。

正式库原 57 条记录和 settings 不变，新增一份成人 AI 学习内容公开资料实践（资料、任务、稿件各 1 条），明确不是历史任职成果或已投放业务样本。当前账号 3、资料 8、任务 7、稿件 15、运行 23、线索 1。模型凭据仍未配置，新增稿件保持未审核，**新真实模型端到端验收未完成**。完整证据见 `2026-09-28-xhs-matrix-content-workbench-implementation-plan.md` 的“本轮验收结论”。
