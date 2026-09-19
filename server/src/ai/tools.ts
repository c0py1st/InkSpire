import type { Foreshadow, ToolCall, ToolSpec } from '../../../shared/src/types';
import {
  loadCharacters, loadForeshadows, loadOutline, readChapter, saveForeshadows, searchChapters,
} from '../fs-store';
import { locateChapter } from './memory';

/**
 * Agent 工具层：schema 定义 + 权限策略 + 参数校验 + 执行器。
 * 策略两级：
 *  - execute：只读或低风险可撤销写，服务端直接执行并把结果回灌模型；
 *  - propose：高风险写（正文/摘要），转成提案卡片等作者采纳，绝不静默落盘。
 */

const CHAPTER_ID_RE = /^v\d{2}c\d{3}$/;
const RESULT_CAP = 4000; // 工具结果回灌前的统一截断，防上下文爆炸

export type ToolPolicy = 'execute' | 'propose';

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  search_chapters: 'execute',
  read_character_card: 'execute',
  read_foreshadow_list: 'execute',
  read_chapter: 'execute',
  register_foreshadow: 'execute',
  propose_chapter_content: 'propose',
  propose_summary: 'propose',
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'search_chapters',
      description: '在整本书的所有章节正文里搜索一个词或短句，返回命中的章、位置和上下文摘录。回答"某句话/某个道具/某个人在哪一章出现过"类问题前使用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要搜索的词或短语，不超过 30 字' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_character_card',
      description: '按姓名读取某个人物的完整设定卡（性格/背景/关系/口癖/当前状态）。回答人物相关问题时以卡片为准。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '人物姓名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_foreshadow_list',
      description: '读取全书伏笔登记表：每条伏笔的埋设章、内容、计划回收章、状态。讨论剧情规划、检查坑是否填了之前使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter',
      description: '读取指定章节的标题、大纲 beat 与正文（超长会截断）。需要看某章原文时使用，chapterId 形如 v01c003。',
      parameters: {
        type: 'object',
        properties: { chapterId: { type: 'string', description: '章节 id，如 v01c003' } },
        required: ['chapterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_foreshadow',
      description: '向伏笔登记表新增一条伏笔（作者口头让你"记一下这个坑"时使用）。只增不删改，登记结果作者可见可撤销。',
      parameters: {
        type: 'object',
        properties: {
          setupChapterId: { type: 'string', description: '埋设（或揭示线索）的章节 id，如 v01c003' },
          content: { type: 'string', description: '伏笔内容，一句话，不超过 80 字' },
          payoffChapterId: { type: 'string', description: '计划回收的章节 id，未定可留空' },
        },
        required: ['setupChapterId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_chapter_content',
      description: '对某一章提交一份完整正文修订提案（作者要求改写/续写整章时使用）。不会直接改正文，而是生成提案卡由作者采纳。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '目标章节 id，如 v01c003' },
          content: { type: 'string', description: '建议的完整正文（自然段开头两个全角空格缩进）' },
        },
        required: ['chapterId', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_summary',
      description: '对某一章提交一份剧情摘要提案（作者认为现有摘要不准、要求重写记忆时使用）。不会直接写记忆，由作者采纳。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '目标章节 id，如 v01c003' },
          summary: { type: 'string', description: '100 字以内的剧情摘要' },
        },
        required: ['chapterId', 'summary'],
      },
    },
  },
];

export interface ToolOutcome {
  ok: boolean;
  /** 回灌给模型的工具结果文本（JSON 字符串或纯文本） */
  content: string;
  /** 给 UI 轨迹行的一行摘要，如 "搜「铜牌」→ 3 处命中" */
  detail: string;
  /** propose 策略工具产出的提案，由路由层转 SSE 事件 */
  proposal?: { kind: 'chapter' | 'summary'; chapterId: string; content: string };
}

function fail(msg: string): ToolOutcome {
  return { ok: false, content: JSON.stringify({ error: msg }), detail: `✗ ${msg}` };
}

function cap(s: string): string {
  return s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) + '…（已截断）' : s;
}

function parseArgs(call: ToolCall): Record<string, unknown> | string {
  try {
    const v = JSON.parse(call.function.arguments || '{}');
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : '参数必须是 JSON 对象';
  } catch {
    return 'arguments 不是合法 JSON';
  }
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** 校验章节 id 存在且在大纲中，返回标题；否则 undefined */
function knownChapter(slug: string, chapterId: string): { title: string } | undefined {
  if (!CHAPTER_ID_RE.test(chapterId)) return undefined;
  const outline = loadOutline(slug);
  if (!outline) return undefined;
  try {
    return { title: locateChapter(outline, chapterId).chapter.title };
  } catch {
    return undefined;
  }
}

export function executeTool(slug: string, call: ToolCall): ToolOutcome {
  const name = call.function.name;
  const policy = TOOL_POLICIES[name];
  if (!policy) return fail(`未知工具 ${name}`);
  const args = parseArgs(call);
  if (typeof args === 'string') return fail(args);

  switch (name) {
    case 'search_chapters': {
      const q = str(args.query, 30);
      if (!q) return fail('query 不能为空');
      const hits = searchChapters(slug, q);
      if (!hits.length) return { ok: true, content: '没有命中。', detail: `搜「${q}」→ 0 处` };
      return {
        ok: true,
        content: cap(JSON.stringify(hits.map((h) => ({ 章: `${h.chapterId} ${h.chapterTitle}`, 上下文: h.snippet })))),
        detail: `搜「${q}」→ ${hits.length} 处命中`,
      };
    }
    case 'read_character_card': {
      const want = str(args.name, 20);
      if (!want) return fail('name 不能为空');
      const chars = loadCharacters(slug);
      const exact = chars.find((c) => c.name === want);
      const hit = exact ?? chars.find((c) => c.name.includes(want) || want.includes(c.name));
      if (!hit) {
        return { ok: true, content: `没有名为「${want}」的人物卡。现有：${chars.map((c) => c.name).join('、') || '（空）'}`, detail: `读卡「${want}」→ 未找到` };
      }
      return {
        ok: true,
        content: cap(JSON.stringify({ name: hit.name, role: hit.role, personality: hit.personality, background: hit.background, relations: hit.relations, speechHabit: hit.speechHabit ?? '', state: hit.state ?? '（未记录）' })),
        detail: `读卡「${hit.name}」`,
      };
    }
    case 'read_foreshadow_list': {
      const items = loadForeshadows(slug);
      if (!items.length) return { ok: true, content: '伏笔登记表为空。', detail: '读伏笔表 → 空' };
      const outline = loadOutline(slug);
      const titleOf = (cid?: string) => {
        if (!cid || !outline) return cid ?? '';
        try { return `${cid}《${locateChapter(outline, cid).chapter.title}》`; } catch { return cid; }
      };
      const text = items.map((f) => `- [${f.status === 'open' ? '未收' : f.status === 'resolved' ? '已收' : '废弃'}] ${f.content}（埋${titleOf(f.setupChapterId)}${f.payoffChapterId ? `，收${titleOf(f.payoffChapterId)}` : ''}）`).join('\n');
      return { ok: true, content: cap(text), detail: `读伏笔表 → ${items.length} 条` };
    }
    case 'read_chapter': {
      const cid = str(args.chapterId, 10) ?? '';
      const known = knownChapter(slug, cid);
      if (!known) return fail(`chapterId「${cid}」不在大纲中（形如 v01c003）`);
      const ch = readChapter(slug, cid);
      const outline = loadOutline(slug)!;
      const beat = locateChapter(outline, cid).chapter.beat;
      return {
        ok: true,
        content: cap(`《${ch.title}》 beat：${beat}\n正文：\n${ch.content}`),
        detail: `读章 ${cid}《${ch.title}》`,
      };
    }
    case 'register_foreshadow': {
      const setup = str(args.setupChapterId, 10) ?? '';
      const content = str(args.content, 80);
      const payoff = str(args.payoffChapterId, 10);
      if (!content) return fail('content 不能为空');
      if (!knownChapter(slug, setup)) return fail(`setupChapterId「${setup}」不在大纲中`);
      if (payoff && !knownChapter(slug, payoff)) return fail(`payoffChapterId「${payoff}」不在大纲中`);
      const items = loadForeshadows(slug);
      if (items.some((f) => f.status === 'open' && f.content === content)) {
        return { ok: true, content: '该伏笔已在登记表中，未重复登记。', detail: `登记伏笔 → 已存在，跳过` };
      }
      const fresh: Foreshadow = {
        id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        setupChapterId: setup, content, ...(payoff ? { payoffChapterId: payoff } : {}),
        status: 'open', createdAt: new Date().toISOString(),
      };
      saveForeshadows(slug, [...items, fresh]);
      return { ok: true, content: `已登记伏笔（id ${fresh.id}），作者可在大纲页查看。`, detail: `📌 登记伏笔：${content.slice(0, 20)}…` };
    }
    case 'propose_chapter_content': {
      const cid = str(args.chapterId, 10) ?? '';
      const content = str(args.content, 60000);
      if (!content) return fail('content 不能为空');
      const known = knownChapter(slug, cid);
      if (!known) return fail(`chapterId「${cid}」不在大纲中`);
      return {
        ok: true,
        content: '修订提案已发送给作者，等待其在提案卡片中采纳或放弃。',
        detail: `📝 正文修订提案 → ${cid}《${known.title}》`,
        proposal: { kind: 'chapter', chapterId: cid, content },
      };
    }
    case 'propose_summary': {
      const cid = str(args.chapterId, 10) ?? '';
      const summary = str(args.summary, 500);
      if (!summary) return fail('summary 不能为空');
      const known = knownChapter(slug, cid);
      if (!known) return fail(`chapterId「${cid}」不在大纲中`);
      return {
        ok: true,
        content: '摘要提案已发送给作者，等待采纳。',
        detail: `🧠 摘要提案 → ${cid}《${known.title}》`,
        proposal: { kind: 'summary', chapterId: cid, content: summary },
      };
    }
    default:
      return fail(`未知工具 ${name}`);
  }
}
