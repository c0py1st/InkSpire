import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, ProviderProfile, ToolCall } from '../../shared/src/types';
import type { ChatMessage, StreamOptions, streamChat } from './ai/provider';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-chat-'));
process.env.INKSPIRE_DATA_DIR = tmp; // 一切读写（含工具落 .index）都进临时目录，不碰真书
const { runChatReact } = await import('./routes/ai');

const cfg = { providers: [], creativeId: null, assistId: null, mockMode: false } as unknown as AppConfig;
const profile = { id: 'p', name: 'p', baseURL: 'https://x.invalid/v1', apiKey: 'k', model: 'm', temperature: 1.2 } as unknown as ProviderProfile;

interface Ev { type: string; [k: string]: unknown }
function fakeSse() {
  const events: Ev[] = [];
  return {
    events,
    send: (o: unknown) => { events.push(o as Ev); },
    delta: (t: string) => { events.push({ type: 'delta', text: t }); },
    answer: () => events.filter((e) => e.type === 'delta').map((e) => String(e.text ?? '')).join(''),
    final: () => events.filter((e) => e.type === 'final').at(-1),
  };
}

interface Round { text?: string; finish?: string; calls?: ToolCall[]; throws?: string }
/** 脚本化假流：按轮回放，并记录每轮请求里是否带了 tools、消息快照长什么样 */
function scripted(...rounds: Round[]) {
  const seen: Array<{ withTools: boolean; msgs: ChatMessage[] }> = [];
  let i = 0;
  const fake: typeof streamChat = async function* (_c, _p, messages, opts: StreamOptions = {}) {
    const r = rounds[i++] ?? { text: '', finish: 'stop' };
    seen.push({ withTools: Array.isArray(opts.tools) && opts.tools.length > 0, msgs: [...messages] });
    if (r.throws) throw new Error(r.throws);
    if (r.text) yield r.text;
    if (r.calls?.length) opts.onToolCalls?.(r.calls);
    if (r.finish) opts.onMeta?.({ finishReason: r.finish });
  };
  return Object.assign(fake, { seen: () => seen, used: () => i });
}

const call: ToolCall = { id: 't1', type: 'function', function: { name: 'search_chapters', arguments: '{"query":"测试"}' } };
const go = (sse: ReturnType<typeof fakeSse>, st: ReturnType<typeof scripted>) =>
  runChatReact(sse, new AbortController().signal, cfg, profile, '对话测试书', 'sys', '作者的问题是：X', st);

describe('侧边对话 ReAct 控制流（假流协议测）', () => {
  it('单轮直接回答：缓冲后一次落泡，不重复投喂', async () => {
    const sse = fakeSse();
    const st = scripted({ text: '直接给结论。', finish: 'stop' });
    await go(sse, st);
    expect(sse.answer()).toBe('直接给结论。');
    expect(st.seen()[0].withTools).toBe(true); // 首轮允许工具 → 内容按旁白风险缓冲
    expect(sse.events.some((e) => e.type === 'note')).toBe(false);
    expect(sse.final()).toMatchObject({ steps: 0 });
  });

  it('工具轮独白进 note 轨迹，答案气泡只含最终回答', async () => {
    const sse = fakeSse();
    const st = scripted(
      { text: '我认为你想问的是另一个问题。', finish: 'tool_calls', calls: [call] },
      { text: '这才是查完书的答案。', finish: 'stop' },
    );
    await go(sse, st);
    expect(sse.answer()).toBe('这才是查完书的答案。'); // 独白没混进气泡
    const notes = sse.events.filter((e) => e.type === 'note');
    expect(notes).toHaveLength(1);
    expect(String(notes[0].text)).toContain('我认为你想问的');
    expect(sse.events.some((e) => e.type === 'tool' && e.phase === 'start')).toBe(true);
    expect(st.seen()[1].msgs.some((m) => m.role === 'tool')).toBe(true); // 工具结果回灌了对话
    expect(sse.final()).toMatchObject({ steps: 1 });
  });

  it('收敛保证①：轮次用尽仍停在工具调用 → 追加禁工具强制答案轮', async () => {
    const sse = fakeSse();
    const toolRounds: Round[] = Array.from({ length: 5 }, () => ({ text: '', finish: 'tool_calls', calls: [call] }));
    const st = scripted(...toolRounds, { text: '被强制出来的最终答案', finish: 'stop' });
    await go(sse, st);
    expect(st.used()).toBe(6);
    expect(st.seen()[5].withTools).toBe(false); // 追加分轮物理禁工具
    expect(sse.answer()).toBe('被强制出来的最终答案');
    expect(sse.final()).toMatchObject({ steps: 5 });
  });

  it('收敛保证②：finish=length 自动续写一次，续写请求带断点上下文', async () => {
    const sse = fakeSse();
    const st = scripted(
      { text: '前半段答案', finish: 'length' },
      { text: '后半段续写', finish: 'stop' },
    );
    await go(sse, st);
    expect(sse.answer()).toBe('前半段答案后半段续写');
    const cont = st.seen()[1];
    expect(cont.withTools).toBe(false);
    expect(cont.msgs.at(-2)).toMatchObject({ role: 'assistant', content: '前半段答案' });
    expect(String(cont.msgs.at(-1)?.content)).toContain('从你停下的地方');
    expect(sse.final()).toMatchObject({ steps: 0 });
    expect(sse.final()?.truncated).toBeUndefined(); // 续写完成，摘掉截断标记
  });

  it('平台不支持 tools：降级普通对话重试，不消耗轮次、答案照常交付', async () => {
    const sse = fakeSse();
    const st = scripted(
      { throws: '400 Invalid请求：tools 参数不支持' },
      { text: '降级后的正常答案', finish: 'stop' },
    );
    await go(sse, st);
    expect(sse.events.some((e) => e.type === 'tool' && e.name === '_degraded')).toBe(true);
    expect(st.seen()[1].withTools).toBe(false); // 重试轮不再带 tools
    expect(sse.answer()).toBe('降级后的正常答案');
    expect(sse.final()).toMatchObject({ steps: 0 });
  });

  it('问答低温纪律：每一轮请求都显式带 temperature=0.4，不随创作档 1.2', async () => {
    const sse = fakeSse();
    const temps: Array<number | undefined> = [];
    const fake: typeof streamChat = async function* (_c, _p, _m, opts: StreamOptions = {}) {
      temps.push(opts.temperature);
      yield '答案';
      opts.onMeta?.({ finishReason: 'stop' });
    };
    await runChatReact(sse, new AbortController().signal, cfg, profile, '对话测试书', 'sys', 'X', fake);
    expect(temps.length).toBeGreaterThan(0);
    expect(temps.every((t) => t === 0.4)).toBe(true);
  });
});
