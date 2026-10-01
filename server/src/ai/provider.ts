import { AppConfig, ProviderProfile, ToolCall, ToolSpec } from '../../../shared/src/types';

/**
 * OpenAI 兼容协议的唯一实现：POST /chat/completions (stream: true)。
 * 换任何供应商 = 在设置页改 baseURL / apiKey / model，不需要动这里。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 消息可携带模型发起的工具调用 */
  tool_calls?: ToolCall[];
  /** tool 消息回填对应调用的结果 */
  tool_call_id?: string;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 演示模式下用于挑选灌水内容的任务类型 */
  kind?: 'json' | 'prose' | 'summary';
  /** 流结束时回传 finish_reason 等元信息（如 length=被截断） */
  onMeta?: (meta: { finishReason?: string; usage?: unknown }) => void;
  /** 函数调用：发给模型的 tools 定义与选择策略（缺省不带，行为与旧版一致） */
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  /** 流内聚合完的工具调用回调（finish_reason=tool_calls 时必有非空数组） */
  onToolCalls?: (calls: ToolCall[]) => void;
}

export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function* mockStream(kind: 'json' | 'prose' | 'summary', promptHint: string): Generator<string> {
  // 简单可重复的伪随机，保证演示内容随输入略有变化
  let seed = [...promptHint].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed % n;
  };
  const sentences = [
    '夜色像一层浸了水的绒布，沉沉压在长街尽头。',
    '他没有回答，只是把袖口攥得更紧了些。',
    '风从窗缝里钻进来，烛火矮了一寸。',
    '远处传来更夫的梆子声，三长两短。',
    '"你确定要这么做？"她的声音很轻，像怕惊动什么。',
    '他笑了笑，笑意却没到眼底。',
    '刀出鞘的声音很短，短得像一句道别。',
    '雨落下来的时候，整座城都在往下沉。',
  ];
  const paraCount = 8 + rnd(6);
  for (let p = 0; p < paraCount; p++) {
    const n = 3 + rnd(3);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(sentences[(rnd(sentences.length) + i) % sentences.length]);
    yield '\n\n' + parts.join('');
  }
}

function yieldMockJson(promptHint: string): string {
  // 依据各任务提示词里最独特的字样判定任务类型（提示词都是中文）
  // 注意顺序：bible 提示词里也含"分卷大纲"，必须先于 volumes 判定
  if (promptHint.includes('设定集初稿') || promptHint.includes('产出这本书') || promptHint.includes('设定集为')) {
    return JSON.stringify({
      characters: [
        { name: '李慎', role: '主角', personality: '外冷内热，认死理，对"程序正义"有执念', background: '县衙捕快出身，父亲因旧案获罪而死', relations: '师从老仵作秦伯；与周主簿互相试探', speechHabit: '习惯反问："凭据呢？"' },
        { name: '宋九娘', role: '女主/盟友', personality: '爽利泼辣，市井智慧极强', background: '漕帮遗孤，经营车马行', relations: '欠李慎一条命的因果', speechHabit: '喜欢用生意行话打比方' },
      ],
      worldview: '【演示】架空王朝"晏"，重开漕运后中央与州府博弈加剧。仵作行会被官府收编，验尸记录成为刑名凭据的核心。底层有过所文书制度，行走千里皆需勘合。',
    });
  }
  if (promptHint.includes('逐章细纲') || promptHint.includes('逐章')) {
    const chapters: Array<{ title: string; beat: string; pov: string; characters: string[] }> = [];
    const starts = ['雪夜来客', '盐车疑云', '停尸房的灯', '第一个证人', '递错的钥匙', '旧档缺页', '酒肆暗语', '门房之死', '反咬一口', '立字为据', '冬汛将至', '裂缝更深'];
    starts.forEach((t, i) => {
      chapters.push({
        title: t,
        beat: `本章推进：${t}相关的线索浮出水面，主角做出一个小决定，引出下一章的麻烦。`,
        pov: '李慎',
        characters: i % 2 === 0 ? ['李慎', '宋九娘'] : ['李慎', '周主簿'],
      });
    });
    return JSON.stringify({ chapters });
  }
  if (promptHint.includes('分卷大纲')) {
    return JSON.stringify({
      volumes: [
        { title: '卷一·初雪案的裂缝', summary: '一桩小案撕开大幕，主角被迫入局并立下查案之约。' },
        { title: '卷二·州府的水', summary: '越查越深，官面上的力量开始反扑，盟友与敌人界线模糊。' },
        { title: '卷三·换印之夜', summary: '集齐关键人证，借一场大典完成绝地反击。' },
      ],
    });
  }
  if (promptHint.includes('卷回本') || promptHint.includes('未决事项')) {
    return JSON.stringify({
      recap: '【演示回本】本卷李慎由城门浮尸入手，与秦伯验尸锁定勒杀伪冻毙，线索牵至城北旧盐仓与周主簿；至卷末其右手带伤、暂压尸格、收到匿名"撤呈"警告，已与周主簿正面为敌。未决事项：盐仓账目与铜牌来历未查清；匿名警告来源不明；秦伯安危存疑。',
    });
  }
  if (promptHint.includes('剧情摘要') || promptHint.includes('本章摘要')) {
    // 演示：正文带「演示·大纲漂移」标记时，模拟一次"已成事实偏离 beat 且给出新 beat"
    const drift = promptHint.includes('演示·大纲漂移');
    return JSON.stringify({
      summary: '【演示摘要】李慎查验盐车命案发现致命伤不在车轮而在咽喉，锁定第一嫌疑人周主簿，同时收到匿名警告信。',
      newCharacters: [],
      worldNotes: [],
      stateChanges: [{ name: '李慎', newState: '右手在停尸房被锈蚀铁架划伤，已用烧酒简单处理，验尸时开始结痂发痒', reason: '本章查验盐车时留下新伤' }],
      events: [{ title: '盐车命案首次开堂验尸，物证封匣入库', detail: '李慎当众指出致命伤在咽喉而非车轮，县令命将沾血车辙布收匣封存', actors: ['李慎', '秦伯', '周主簿'], when: '雪夜当夜' }],
      ...(drift ? {
        beatDrift: {
          drifted: true,
          problem: '正文里周主簿已当面撕破脸，比原 beat 的"暗中试探"更进一步，成为后续不可回退的事实',
          newBeat: '周主簿当面对质后撕破脸，李慎与其公开为敌——原"暗中试探"已被正文事实取代。',
        },
      } : {}),
    });
  }
  if (promptHint.includes('逐项检查') || promptHint.includes('一致性检查')) {
    return JSON.stringify({ issues: [] });
  }
  if (promptHint.includes('逐章裁决')) {
    return JSON.stringify({
      chapters: [
        { index: 1, title: '第一章', chapterId: 'v01c001', verdict: 'REVISE', hookNote: '钩子有但偏软，靠环境异常收束',
          grievances: [{ quote: '更声三长两短', issue: '开篇前 300 字无冲突，靠氛围描写拖住读者' }] },
        { index: 2, title: '第二章', chapterId: 'v01c002', verdict: 'GO', hookNote: '仓门上锁的收尾够逼着点下一章',
          grievances: [{ quote: '账目亏空浮出', issue: '金手指存在感弱，验尸翻盘来得太顺' }] },
        { index: 3, title: '第三章', chapterId: 'v01c003', verdict: 'GO', hookNote: '', grievances: [] },
      ],
      retentionScore: 6,
      overall: '前两章能留人，开篇的慢热是最大流失点。',
      fixes: ['第一章首屏放进尸体或威胁', '让翻盘多一次受阻再成立', '第二章补一句李慎验尸手法的特殊性'],
    });
  }
  if (promptHint.includes('三类目标读者') || promptHint.includes('读者身份')) {
    return JSON.stringify({
      personas: [
        { name: '读者一', overall: 7, wouldContinue: true, praise: '验尸一段的冷细节立住了主角的专业感。',
          grievances: [{ quote: '他把勘合收进袖中', issue: '收勘合这个动作来得突然，前文没交代为什么带着它。' }] },
        { name: '读者二', overall: 6, wouldContinue: true, praise: '对话干净。',
          grievances: [{ quote: '雪光刺眼', issue: '上一章刚下过雪，这里又「第一次」见到雪光，环境在复读。' }] },
        { name: '读者三', overall: 5, wouldContinue: false, praise: '',
          grievances: [{ quote: '他想起师父的话', issue: '插叙出现得没有契机，读到这儿节奏断了。' }] },
      ],
      verdict: '骨架能读下去，但三处小断裂累积起来正在消耗信任。',
      topFixes: ['收勘合前补一笔为何携带', '雪光改写成与上一章不同的质感', '师父插叙改为被眼前事物勾起'],
    });
  }
  // 默认：故事内核（"提炼成一份故事内核"是最靠前的步骤）
  return JSON.stringify({
    premise: '【演示】一个身负旧案的小捕快，卷入州府夺印之争，被迫在律法与恩义之间选边站。',
    genre: '古风悬疑',
    coreConflict: '小人物想守住律法底线，而握权者要用他的手洗清私账。',
    endingVision: '真相大白之日，他被升为提刑官，却也永远失去了当年同袍的信任。',
    styleGuide: '第三人称限制视角；克制冷静的短句为主，动作与物象推动情绪；避免现代词汇。',
    volumeSummariesDraft: [
      '卷一·初雪案的裂缝：外来盐车压死孤儿牵出三年前旧案，主角被迫接手。',
      '卷二·州府的水：证据指向州府内宅，盟友接连倒戈。',
      '卷三·换印之夜：以小搏大，在朝堂监察面前掀桌翻案。',
    ],
  });
}

/** 流式输出一段助手回复。演示模式下走本地灌水生成器。 */
export async function* streamChat(
  cfg: AppConfig,
  profile: ProviderProfile | null,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  if (!profile) throw new ProviderError('尚未配置模型，请先到设置页选择模型');

  if (cfg.mockMode || !profile.apiKey.trim()) {
    // 演示模式：带 tools 的对话请求直接忽略工具、单轮普通回答，
    // 保证 ReAct 循环在演示模式下不报错（调用方靠 finish_reason 判定收敛）。
    const hint = messages.map((m) => m.content ?? '').join(' ');
    if (opts.kind === 'json') {
      const json = yieldMockJson(hint);
      for (const chunk of splitChunks(json, 24)) yield chunk;
      return;
    }
    let text = '';
    for (const chunk of mockStream(opts.kind ?? 'prose', hint)) text += chunk;
    for (const chunk of splitChunks(text, 12)) yield chunk;
    return;
  }

  const url = profile.baseURL.replace(/\/+$/, '') + '/chat/completions';
  // 正文生成给足输出预算（思考+正文共享 max_tokens；思考长度随任务波动很大，
  // 过小的上限会把正文拦腰截断）。上限下限只对 DeepSeek 官方端点抬高，
  // 其他平台保持用户设置，避免超出平台模型上限被 400。
  const isDeepSeekHost = /deepseek/i.test(profile.baseURL);
  const maxTokens = opts.maxTokens
    ?? (isDeepSeekHost ? Math.max(16384, profile.maxTokens ?? 0) : (profile.maxTokens ?? 8192));
  const body = JSON.stringify({
    model: profile.model,
    messages,
    stream: true,
    // JSON 结构任务要的是格式稳定，与文风发散无关，固定低温；
    // 正文/改写任务才跟随 profile（或调用方显式传入的按任务温度）。
    temperature: opts.temperature ?? (opts.kind === 'json' ? 0.35 : profile.temperature ?? 1.1),
    max_tokens: maxTokens,
    // DeepSeek 官方端点：关闭深度思考。推理长度不可控（实测会耗尽全部输出预算、
    // content 为 0 或把正文拦腰截断），结构化与正文任务均禁用；且思考与正文
    // 共享 max_tokens，禁用后速度与产出都稳定。
    ...(isDeepSeekHost ? { thinking: { type: 'disabled' }, stream_options: { include_usage: true } } : {}),
    // 函数调用：仅在调用方显式给了 tools 时注入，旧路径零影响
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
  });

  // 限流(429)/网络抖动自动退避重试。仅在尚未产出任何增量时重试才安全，
  // 429 恰好发生在请求建立阶段，此处总是安全的。
  const MAX_ATTEMPTS = 3;
  let attempt = 0;
  while (true) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey}`,
        },
        body,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // 用户主动停止，不重试
      if (attempt >= MAX_ATTEMPTS) throw new ProviderError(`连接模型失败：${(err as Error).message}`);
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      // 尊重服务端的 Retry-After，否则指数退避 + 抖动；释放连接后重试
      const ra = Number(res.headers.get('retry-after'));
      void res.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt));
      continue;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        throw new ProviderError('模型限流(429)：已自动重试 3 次仍被拒绝，请等一两分钟再试，或避开高峰时段', 429);
      }
      throw new ProviderError(`模型请求失败(${res.status})：${text.slice(0, 300)}`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let yielded = 0;
    let lineCount = 0;
    let rawHead = '';
    // 工具调用分片聚合：arguments 是流式拼出来的 JSON 字符串，按 index 归位
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    const flushToolCalls = () => {
      if (!opts.onToolCalls || toolAcc.size === 0) return;
      const calls: ToolCall[] = [...toolAcc.entries()].sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } }));
      if (calls.some((c) => c.function.name)) opts.onToolCalls(calls);
      toolAcc.clear();
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!rawHead && chunk.trim()) rawHead = chunk.slice(0, 300);
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        lineCount++;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          if (yielded === 0 && toolAcc.size === 0) console.error('[moge:streamChat] 空流诊断: 收到[DONE]但无增量 status=' + res.status + ' lines=' + lineCount + ' rawHead=' + JSON.stringify(rawHead));
          flushToolCalls();
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const delta: string | undefined = obj.choices?.[0]?.delta?.content;
          if (delta) { yielded++; yield delta; }
          const tcs: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined
            = obj.choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(tcs)) {
            for (const t of tcs) {
              const i = typeof t.index === 'number' ? t.index : 0;
              const cur = toolAcc.get(i) ?? { id: '', name: '', args: '' };
              if (t.id) cur.id = t.id;
              if (t.function?.name) cur.name += t.function.name;
              if (t.function?.arguments) cur.args += t.function.arguments;
              toolAcc.set(i, cur);
            }
          }
          const fr: string | undefined = obj.choices?.[0]?.finish_reason;
          if (fr) opts.onMeta?.({ finishReason: fr, usage: obj.usage });
        } catch {
          /* 忽略心跳等非 JSON 行 */
        }
      }
    }
    if (yielded === 0 && toolAcc.size === 0) console.error('[moge:streamChat] 空流诊断: 流结束无增量 status=' + res.status + ' lines=' + lineCount + ' rawHead=' + JSON.stringify(rawHead));
    flushToolCalls();
    return; // 流正常结束
  }
}

function backoffMs(attempt: number): number {
  const base = 2000 * 2 ** (attempt - 1); // 2s / 4s
  return base + Math.floor(Math.random() * 800);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function splitChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 非流式的一次性调用（内部收集全部 delta） */
export async function chatOnce(
  cfg: AppConfig,
  profile: ProviderProfile | null,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): Promise<string> {
  let acc = '';
  for await (const d of streamChat(cfg, profile, messages, opts)) acc += d;
  return acc;
}

/** 设置页的"测试连接" */
export async function testProvider(cfg: AppConfig, p: ProviderProfile): Promise<string> {
  if (!p.apiKey.trim() || cfg.mockMode) return '演示模式可用（未配置真实密钥）';
  const url = p.baseURL.replace(/\/+$/, '') + '/chat/completions';  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
    // 平台无响应时不能让设置页永远转圈
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) return `连接成功（HTTP ${res.status}）`;
  const t = await res.text().catch(() => '');
  throw new Error(`HTTP ${res.status}：${t.slice(0, 200)}`);
}
