# AGENTS.md — 本项目的协作约定（会话压缩/新开会话后请先读这份）

## 硬性要求（作者明确指令，优先级最高）

1. **未经允许不推送**：commit 可自主，但 `git push` 必须等作者说"推送"。
2. **完成标准**：每批改动须过全量门禁 `npm run check && npm run lint && npm test && npm run build`，
   并做真实验证（浏览器/接口实测，不是"编译通过就算完"）；未能端到端验证的部分要在汇报中明说。
3. **提交规范**：conventional commits，中文正文，写清"改了什么 + 为什么 + 如何验证"。
4. **一步一步来**：多阶段任务按既定优先级逐阶段提交，不合并成巨构。
5. **新增工具一律装 E 盘**（作者 2026-10-05 明令）：不得往 C 盘安装任何新增工具；
   开发工具集中在 `E:\dev-rust\`（Rust 工具链、cargo、tauri 的 NSIS），E 盘根目录可建
   `E:\<工具名>` 形式的工具目录。C 盘 `%LOCALAPPDATA%` 等系统约定路径无法改时，用
   **目录 junction 指回 E 盘**（如 `%LOCALAPPDATA%\tauri → E:\dev-rust\tauri`）。

## 设计宪法（作者亲自确认的理念）

- **不要过多依赖**：能用 Node 内置能力就不引库（node:sqlite、手写 tar/diff 都是这个精神）。
  - **例外（作者 2026-10-05 拍板）**：桌面分发 C1 使用 Tauri——破例只发生在**打包层**：
    运行期仍是 Node + Express + 文件真相源（node.exe/服务端 bundle/前端 dist 全部作为
    Tauri 资源随行，外壳只做"起进程-等健康-开窗-带 Job"）。产品代码零改动。
- **文件是真相源**：`data/<书>/` 下的 Markdown/JSON 人类可读、可手改、可 git；
  `.index/`（搜索索引）与 `recaps.json`（卷回本）是**可重建缓存**，删了不影响数据。
- **降级要活着**：环境能力缺失（旧 Node 无 node:sqlite、模型不支持 tools、无 API Key）时自动退回保守路径，不许崩。
- UI：奶油纸质感 + 黛青强调色、大圆角、不动三栏骨架；「纸/墨/跟随系统」三主题。

## 环境操作须知（Windows）

- Bash 工具走 Git Bash；中文路径/slug 用 `node -e` 的 fetch 代替 curl（curl 会按 GBK 编码中文 URL）。
- `node -e` 里避免 shell 变量插值展开的 Windows 反斜杠路径，改从文件读（如 `.recap-e2e-dir` 模式）。
- dev 启动：`npm run dev`（5173 前端 / 8787 后端，仅绑 127.0.0.1 + Host 白名单守卫）。
- 内嵌 WebView 里禁一切 `window.confirm`（用 `store.confirmAsk` 应用内确认框）。
- 测试碰到真实 `data/` 前必须先备份（记 md5），测完还原并核对。
- 桌面打包（desktop/）**本机环境契约**（作者 2026-10-07 实测确认，助手同日复核通过）：
  - 本项目是 **Tauri 2 + NSIS**，与 Electron 无关。
  - `CARGO_HOME=E:\dev-rust\cargo`、`RUSTUP_HOME=E:\dev-rust\rustup`（已固化为用户环境变量）；
    默认工具链 `stable-x86_64-pc-windows-gnu`（GNU，链接用 `D:\MinGW64` 的 gcc/dlltool，
    **勿装 VS Build Tools**）；cargo/rustc 1.99。
    注意工具链路径**必须纯 ASCII**——中文用户名家目录会让 mingw ld 报假
    "cannot find rlib"（实测过），所以既不能回 C:\Users\郑扬程\ 也不建议挪去含中文的路径。
  - crates 镜像在 `E:\dev-rust\cargo\config.toml`（rsproxy-sparse）。
  - `%LOCALAPPDATA%\tauri` 是 **junction → E:\dev-rust\tauri**：`makensis.exe` 与
    `NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll` 均在位，
    **打 NSIS 安装包无需再联网取 tauri-utils**。
  - Rust 构建产物留在项目内 `desktop/src-tauri/target`（D 盘），**不要搬去 C 盘**；
    C 盘空间有限（约 50GB 空闲），任何构建缓存/下载物都不得堆 C 盘。
  - **项目内不得写死 `C:\Users` 路径**（缓存类一律走 E 盘、项目目录或系统 API 解析）——
    全库 grep 验证过零命中，改动时保持这条。
  - Git-Bash 会把 `/S` 当路径转掉：调 NSIS 安装/卸载器必须先 `export MSYS2_ARG_CONV_EXCL='*'`；
    静默安装默认落 `%LOCALAPPDATA%\墨阁`（不是 Programs 子目录，排查时别看错）。
  - **Release 发行物用英文名（作者定，2026-10-07）**：仓库已名 InkSpire；**下次发布前**把
    tauri.conf 的 `productName` 改为 "InkSpire"，NSIS 产物即 `InkSpire_x.y.z_x64-setup.exe`——
    从源头规避"gh 经 Git-Bash 传中文文件名毁资产名"（v0.1.0 实测踩坑：'墨阁_…'被咬成'_…'，
    当时靠 cp 改名规避）。界面内品牌文案不变，仍显示"墨阁"。
    注意：productName 变更会改安装目录/卸载项名（%LOCALAPPDATA%\墨阁 → \InkSpire），
    新旧安装互不识别——发首个英文名版本时，在 Release 说明里提醒"先卸载旧版再装新版"。
  - 桌面版固定端口 **47821**；数据目录三级策略：**exe 旁有 `data/` 即自动便携** >
    `MOGE_HOME=<目录>` 显式指定 > 默认 `%APPDATA%\app.inkspire.moge\data`。
  - `desktop/` 是**独立 npm 项目**（不在根 workspaces 里，有自己的 package-lock 与
    node_modules；esbuild 自声明），纯 WebUI 的 `npm install` 不触碰 Tauri。
  - 发版：`npm run desktop:bump <x.y.z>`（写齐 4 处版本）→ `npm run desktop:build` →
    tag + push → `gh release create`（gh 经 scoop 装在 `E:\Scoop`）上传 setup.exe；
    **二进制一律走 Releases，不进 git**。

## 当前工程状态速查

- 分支同步情况看 `git status -sb`；**近期决策与未闭环事项看 `git log` 提交信息**（写得很全）。
- 未闭环清单：已清零。卷回本分层注入做过隔离 E2E（假 provider 捕获真实 prompt，8/8 通过）；
  人物状态时间线（stateHistory）做过全链路 E2E（归档→建议→采纳→按章时点注入→UI 实测，10/10）。
- 路线（作者 2026-09-29 拍板，按序推进）：
  - [完成] A 前缀缓存：usage 度量（`.index/cache-stats.json`）+ prosePrompt 稳定前缀排布 + 摘要量化滑窗
  - [完成] B 评审三件套：L0 预检(ca6ea73) / 引证验真(f6c1e30) / 大纲修订建议卡(f33b81f)
  - [完成] C 体检面板：进度/伏笔回收率与逾期/人物出场/L0 汇总/模型用量（冲突率类仍走一致性检查，不自动跑 LLM）
  - [完成] D 世界事件时间线：events.json 双轨(auto/manual)+归档提取+read_timeline 工具+时间线视图(过滤/补记/删除，浏览器实测)
  - [完成] E 网文模式全家桶（作者拍板兼容路线+全做）：E1 爽点/钩子字段+按书开关(b648da5)
    / E3 节奏红线(44e4836) / E2 读者评审(c4ffb52) / E4 黄金三章(4d709a3)+两 bug 修复(89ea06d)
  - [完成] F Lorebook-lite 世界书：lorebook.json 真相源+命中激活（触发词子串/scope 卷段章段/
    常驻/契约条豁免预算/优先级整条进出）+prosePrompt 注入+`.index/lore-activated.json` 留痕+设定集编辑器
  - [拍板 2026-10-04] 下一批按序：A1 read_lorebook → B1 通读模式 → A2 风格范文库 → B2 世界书 UI 增强 → C1 Tauri 打包（需另议"零依赖"破例）
  - [完成] A1 对话 agent 的 read_lorebook 工具：世界书进 ReAct 查询链（keyword/章生效范围过滤，含停用与契约标注）
  - [完成] B1 通读模式：GET /:slug/read-through 只读连排 + 前端全书搜索高亮（findTextRanges 纯函数+单测）
    逐处跳转（Enter/Shift+Enter）+ 章题跳编辑器 + IntersectionObserver 分块懒加载（浏览器实测 9 处命中跳转）
  - [完成] A2 风格范文库：评审契约 highlights+逐字验真丢弃假引文 → 评审面板一键收录（去重）→
    exemplars.json 真相源 → 复用 activateLore 独立预算（1500）注入【风格范文】块 → 留痕 style 段；
    设定集编辑段；浏览器实测（mock 评审摘真句→收录落盘→已收录态→再收不重复）
  - [完成] B2 世界书 UI 增强：explainLoreActivation 激活解释器（与 activateLore 同源判定）+
    GET /:slug/lore-test 路由 + 设定集内嵌测试器（选章看每条为何进/没进，含预算占用）+ 按激活频次排序
  - [完成] C1 Tauri 桌面打包（作者 2026-10-05 拍板宪法破例·仅打包层）：desktop/ 工作区——
    esbuild 服务端单文件 + node.exe/前端 dist 作 Tauri 资源随行；Rust 壳只做
    起子进程→健康等待→开窗→Job(KILL_ON_JOB_CLOSE) 防孤儿；固定端口 47821；MOGE_HOME 便携模式；
    NSIS 安装器 43.9MB：静默安装→安装版实测（API/SPA 200、%APPDATA% 数据、硬杀零残留）→已卸载还原
  - [下一站] 可选：A3 FTS5 检索反哺生成 prompt（调研清单遗留的最后一项能力层）
  - 每阶段独立提交、过全量门禁；推送等作者说"推送"

## 记忆分层同构提示

本项目给小说 agent 设计的记忆（逐章摘要 → 卷回本 → 大纲契约）与助手自身的会话记忆
（对话上下文 → 压缩摘要 → 本文件 + git 历史）是同一套思想：**越远的越粗、原文永远是真相**。
上下文被压缩后，本文件 + `git log` 就是"卷回本"，按它重建状态即可。
