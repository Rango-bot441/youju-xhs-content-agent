# 小红书内容运营 Agent Implementation Plan

**Goal:** 用真实资料跑通账号档案、选题、图文草稿、质检、多轮修改、版本和导出，提供可查看的真实模型及工具执行记录。

**Architecture:** 本机 Node HTTP 服务 + SQLite 持久化 + 原生 HTML/CSS/JS 工作台。独立目录，与已有个人网站和工具隔离。模型通过现有本机模型配置或显式环境变量连接，资料先存储分段，再由模型调用检索/读取工具；有界运行，不伪造模型结果。页面继承个人网站暖白与朱橙配色。

**Tech Stack:** Node 26 / node:sqlite / linkedom / vanilla browser JS。单用户本地版，监听 127.0.0.1。

## 已确认范围与边界
- 用户已经明确要求先实现，不再等待设计确认。无历史原始业务材料，首轮用用户公开网站与明确标注的个人经验资料验证。
- 不编造账号、销量、笔记后台数据或体验。无模型时诚实失败；没有真实发布数据，不做增长效果判定。
- 上传首版支持文本、Markdown、HTML；不承诺平台爬虫、PDF/OCR、自动发布或线上多用户部署。
- 资料为不可信输入，不能更改系统规则。公开 URL 导入校验协议、DNS 和重定向，禁止内网访问。
- 凭据留服务端，日志与浏览器不输出密钥。写操作校验同源，防止第三方网页调用本地服务。

## 任务与文件所有权
1. 主 Agent：server.mjs、lib/workflow.mjs、tests/workflow.test.mjs，接口、工具循环、集成与浏览器验收。
2. 界面 Agent：public/index.html、public/app.js、public/styles.css。完整桌面/手机交互，不写其他文件。
3. 数据 Agent：lib/store.mjs、lib/sources.mjs、tests/store.test.mjs、tests/sources.test.mjs。SQLite、来源分段、公开链接获取与持久化。
4. 模型 Agent：lib/provider.mjs、tests/provider.test.mjs。安全解析已配置模型、Responses API、流式兼容、错误脱敏、真实连接检查。

## 共享接口契约
所有 API 的错误为 {error:string}；日期为 ISO 字符串。字符串 ID 使用带前缀的 UUID。run 状态 queued/running/completed/failed。

GET /api/state 返回 {profile,sources,tasks,runs,drafts,feedback,provider}。
profile={name,audience,positioning,tone,productFacts,restrictions}，默认空白字段（可填提示，不预造账号）。
source={id,title,url,text,chunks:[{id,text}],createdAt,kind}；chunk.id 形如 sourceId:p1，citation 使用此完整值。
task={id,title,brief,sourceIds,createdAt,updatedAt,plan:null|{summary,topics:[{id,title,audience,angle,goal,format,why,sourceRefs:[],gaps:[]}],questions:[]}}。
run={id,taskId,action,status,instruction,createdAt,finishedAt,error,events:[{at,kind,title,status,detail,durationMs}],usage:{inputTokens,outputTokens},model}。
draft={id,taskId,topicId,title,body,cover,pages:[{heading,text}],tags:[],evidence:[{claim,sourceRef}],gaps:[],review:null|{verdict,issues:[{severity,quote,reason,sourceRef,suggestion}]},version,parentId,createdAt,status}。
feedback={id,draftId,decision:accepted|needs_changes,comment,createdAt}。
provider={ready,model,source,error?} 不含 key。

POST /api/profile body profile → profile。
POST /api/sources body {title,text?,url?,kind?} → source；有 text 优先导入文本，否则获取 url。
POST /api/tasks body {brief,sourceIds} → task。
POST /api/tasks/:id/runs body {action:plan|draft|review|revise,instruction?,topicId?,draftId?} → 202 run；前端每 1.5 秒轮询 /api/state。
POST /api/runs/:id/cancel → run。
POST /api/drafts/:id/feedback body {decision,comment} → feedback。
GET /api/drafts/:id/export?format=md|json → 文件下载。
POST /api/provider/check → {ready,model,message,usage?}；真实短请求，无伪造成功。
资料引用在界面可定位原文；本地数据重启不丢失。运行中按钮防重入，错误能重试；不隐藏模型错误。

## 数据模块契约
export createStore(dbPath) 返回 {getState(),getProfile(),saveProfile(profile),listSources(),getSource(id),addSource(source),listTasks(),getTask(id),addTask(task),updateTask(id,patch),listRuns(),getRun(id),addRun(run),updateRun(id,patch),appendEvent(runId,event),listDrafts(),getDraft(id),addDraft(draft),updateDraft(id,patch),addFeedback(feedback),close()}。
store 创建实体时补 id/时间/缺省值；addSource 自动调用 chunkText；getState 包含 profile,sources,tasks,runs,drafts,feedback，不包含 provider。
export chunkText(text,sourceId) → [{id,text}]；export importSource({title,text,url,kind}) async → {title,text,url,kind}；export searchChunks(sources,query,limit=6) → [{sourceId,sourceTitle,id,text,score}]。

## 模型模块契约
export getProviderInfo() async → {ready,model,source,error?}。
export callModel({instructions,input,tools=[],signal,maxOutputTokens=4500}) async → {output,usage:{inputTokens,outputTokens},model,requestId,durationMs}。
input/output 使用 OpenAI Responses items（message/function_call/function_call_output）；输出不在服务器存储推理文本，只存工具参数、结果概要与公开产物。
export checkProvider() async → {ready,model,message,usage?}，无修改用户原配置。
优先 XHS_API_KEY/XHS_BASE_URL/XHS_MODEL，其次 OPENAI_*，否则读取本机当前 Codex provider 配置与匹配凭据，仅在内存中使用。无配置则 ready=false。不要改用户全局配置，也不要把凭据复制进本项目。

## 验收
- 规则/存储验证：引用必须存在、空资料不生成、版本及反馈不覆盖、来源获取失败与内网地址拒绝。
- 真实模型验证：以用户公开网站导入资料，完整选题→草稿及质检→修改→导出，并保留调用与 token 记录。
- 浏览器验证：桌面和手机无横向溢出，创建任务、定位引用、查看历史、下载可用；失败状态可见。
- 验证报告仅记录实测结果；费用无单价时只显示 token，不编金额。上线发布与实际增长效果不作为本地首版已完成能力。

## 首版实测结果（2026-09-23）
- 完成：后端、资料导入、模型工具循环、独立审核、版本反馈、响应式工作台。
- 真实资料：用户公开网站，提取 4462 字符、5 个片段；已分别验证网页 URL 导入与 HTML 正文导入。
- 真实模型：当前本机配置的 gpt-5.6-terra；完成 3 个选题、1 篇正文及 4 页文字大纲、独立审核、反馈修改后的 v2 与再次审核。历史项目业绩不归因于本工具。
- 保留首轮 90 秒超时失败记录；后续调整为单请求 180 秒、GPT-5/6 low reasoning，整体运行 8 分钟上限。npm start 只读沿用 macOS 现有代理，不改变系统或全局配置。
- 修正实测问题：审稿阶段误将其他选题判为本篇缺项；仅填 URL 时空 text 阻断导入；审核失败后重试应继续审核已有稿件。已有稿件的任务保留原计划，重新规划须新建任务，避免版本错配。
- 自动化：完整测试 60 项通过；最后工作流增量修正后对应 8 项回归通过。覆盖来源访问边界、凭据隔离、模型断流、未读引用拒绝、取消、版本不覆盖及重启恢复。
- 浏览器：1440px 桌面与 390px 手机页面宽度均等于视口；引用抽屉、v1/v2 切换、Markdown 下载、执行记录检查通过，最终控制台无错误。图文预览容器支持横向滚动，不造成页面横向溢出。
- 独立内存验收工作区实测网页导入、空档案保存、新建任务、取消及重试；重试成功产出 1 个选题，未混入正式工作区。
- 服务重启后核验正式数据仍为 1 份资料、1 个任务、2 版草稿；JSON 导出正文与保存正文一致。
- 使用：项目目录运行 npm start；访问 http://127.0.0.1:4318。凭据仅从现有配置或环境读取，数据保存在 .local/workspace.sqlite。
- 未实现/未验证：线上部署与多人权限、生成成品图片、登录态平台抓取、自动发布、真实账号数据回流、节省时长与增长收益评估。独立审核为同一模型的新上下文调用，引用使用字面检索，不是语义向量检索。
