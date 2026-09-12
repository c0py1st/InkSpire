# 墨阁 · 本地长篇小说创作 Agent

[![CI](https://github.com/c0py1st/NovelTest/actions/workflows/ci.yml/badge.svg)](https://github.com/c0py1st/NovelTest/actions/workflows/ci.yml)

一个完全跑在本机的写作工具：**你给一段提示词，它整理出大纲并严格按照大纲写正文**。
所有数据都是磁盘上的普通文件（Markdown + JSON），随时可以用其他编辑器打开，也方便进版本管理。

## 特性

- **开书向导**：一段构想 → 故事内核 → 分卷大纲 → 逐章 beat → 设定集，每一步可重掷、可手改，确认后才落盘。
- **大纲即契约**：写第 N 章时自动注入该章 beat、相邻章走向、出场人物卡、全书文风约定、全部前情摘要与上一章结尾，agent 不许偏离剧情。
- **记忆闭环**：每章「完成」后自动写摘要进记忆，并探测新人物/新设定与已建档人物的状态变化（受伤、立场转变、关键物品得失），全部以待确认建议卡呈现，不静默改你的设定集。
- **批注抽屉**：边写边问；选中正文任意片段可让 agent 出「润色/扩写/缩写/换个写法」方案，校对式 diff 预览，采纳才生效；不满意可「按反馈再改」，让 agent 基于上一版定向修改而不是推倒重掷。
- **前文检索**：左栏一键搜索全书正文——某句话、某个伏笔、某个人物第一次出场在哪，点命中行直接跳进章节并选中该词。
- **一致性检查**：一键核对正文与设定集、前情的时间线与性格矛盾。
- **后台生成与可中断**：生成期间可随意切章、切视图，随时「停止生成」，已生成部分自动保留回目标章。
- **挂机连写**：从任意章起按大纲顺序连写 N 章——已有正文的章自动跳过；每章写完自动归档进记忆（下一章即刻读得到）；某章失败则整队停止、已完成的全部保留；结尾被输出上限截断的章自动续写补完一次。关掉浏览器照样跑。
- **字数节奏**：编辑器顶部显示本章目标字数进度（向导里设定），一眼掌握节奏。
- **历史版本**：覆盖重写/大幅删改自动留备份，界面内预览与一键恢复（恢复前再备份一份）。
- **模型自选**：任何 OpenAI 兼容接口都能接（DeepSeek / 硅基流动 / Kimi / OpenRouter / 本地 Ollama），创作与辅助两个槽位可分别配置，模型列表一键拉取。
- **扁平化 UI**：中性灰阶 + 单一强调色，「纸 / 墨 / 跟随系统」三档主题，专注模式隐藏一切干扰；正文字体本地打包，离线也统一。

## 快速开始

### 1. 获取代码

本项目以源码形式分发，没有安装包——克隆仓库即可：

```bash
git clone https://github.com/c0py1st/NovelTest.git
cd NovelTest
```

需要 Node.js ≥ 20（建议 22+；依赖的 `fetch`/`node:` 前缀模块与 Vite 6 都要求此版本），npm 随装。

### 2. 安装依赖并启动

```bash
npm install
npm run dev
```

然后浏览器打开 http://127.0.0.1:5173 （后端 API 在同机 8787，由前端代理转发，无需单独访问）。

1. 先进「设置」：默认预置了 DeepSeek 官方配置档，把你的 API Key 粘进去，点「测试连接」。
2. 回首页点「开新书」，把你的想法写成一段提示词，跟着向导走完六步。
3. 左栏选一章 → 「生成本章」→ 阅读修改 → 「完成本章」归档记忆。

> 没填 Key 也能玩：应用处于**演示模式**，完整流程可用，只是内容是本地生成的占位文字。

> 你的书稿都在 `data/` 目录里，该目录不入库；换机器时整个文件夹拷走即可。

## 生产模式（可选）

```bash
npm run build   # 构建前端到 web/dist
npm start       # 仅启动后端，同时托管前端静态文件，访问 http://127.0.0.1:8787
```

日常写作也可以一直用 `npm run dev`，两者功能没有差别。

## 数据放在哪

```
data/
  .config.json            # 模型配置与密钥（仅本机）
  <你的书>/
    meta.json             # 书名、简介
    outline.json          # ★ 结构化大纲 = agent 的契约
    bible/characters.json # 人物卡
    bible/worldview.md    # 世界观自由文本
    chapters/v01c001.md   # 每章正文（带 frontmatter）
    summaries.json        # agent 维护的前情摘要
    chapters/.backups/    # 大幅删改前的自动备份
```

## 目录结构

```
server/   Express 后端：文件存储层、模型接入层、agent 编排、SSE 流式路由
  src/ai/prompts/   ★ 所有提示词模板都在这里，想调教文风直接改文件
  src/ai/memory.ts  上下文组装（前情摘要预算、人物卡挑选）
web/      React + Vite 前端：手写 CSS 设计系统；仅弹窗使用 Base UI 无头组件（不带任何样式）
shared/   前后端共享类型
```

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（后端 8787 + 前端 5173） |
| `npm run check` | 前后端 TypeScript 类型检查 |
| `npm test` | 后端单元测试（vitest） |
| `npm run build` / `npm start` | 构建前端 + 生产模式运行 |

## 路线图

- 章内场景级 beat 细分
- 时间线/伏笔登记表

## 致谢与第三方

本项目的界面在两个开源项目的基础上做了少量集成：

- [Radix Colors](https://www.radix-ui.com/colors)（MIT）——明暗两套主题的灰阶色板取自其 **sand**（暖灰）12 级色阶，以 CSS 自定义属性形式内联在 `web/src/styles/global.css` 的量表区，未引入运行时依赖。
- [Base UI](https://base-ui.com)（MIT）——所有弹窗（设置、开书向导、历史版本、确认框）的行为层使用其无头 `Dialog` 组件（npm 依赖 `@base-ui-components/react`，提供 Escape/焦点圈定/ARIA/滚动锁定）；视觉样式全部仍由本项目手写 CSS 完成。

另有随包分发的正文字体 [霞鹜文楷屏幕版 lxgw-wenkai-screen-webfont](https://github.com/lxgw/LxgwWenKai-Screen)（SIL OFL 1.1，npm 依赖），保证稿纸区字体离线统一。

## 许可证

本项目代码以 [MIT](LICENSE) 发布（Copyright © 2026 c0py1st）。上游依赖与字体的许可要求已在「致谢与第三方」中注明。