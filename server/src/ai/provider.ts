import { AppConfig, ProviderProfile } from '../../../shared/src/types';

/**
 * OpenAI 兼容协议的唯一实现：POST /chat/completions (stream: true)。
 * 换任何供应商 = 在设置里改 baseURL / apiKey / model，不需要动这里。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 演示模式下用于挑选灌水内容的任务类型 */
  kind?: 'json' | 'prose' | 'summary';
  /** 流结束时回传 finish_reason 等元信息（如 length=被截断） */
  onMeta?: (meta: { finishReason?: string; usage?: unknown }) => void;
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
  let paraCount = 8 + rnd(6);
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
  if (promptHint.includes('剧情摘要') || promptHint.includes('本章摘要')) {
    return JSON.stringify({
      summary: '【演示摘要】李慎查验盐车命案发现致命伤不在车轮而在咽喉，锁定第一嫌疑人周主簿，同时收到匿名警告信。',
      newCharacters: [],
      worldNotes: [],
    });
  }
  if (promptHint.includes('逐项检查') || promptHint.includes('一致性检查')) {
    return JSON.stringify({ issues: [] });
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
    // 演示模式
    const hint = messages.map((m) => m.content).join(' ');
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
    temperature: opts.temperature ?? (opts.kind === 'json' ? 1.0 : profile.temperature ?? 1.1),
    max_tokens: maxTokens,
    // DeepSeek 官方端点：关闭深度思考。推理长度不可控（实测会耗尽全部输出预算、
    // content 为 0 或把正文拦腰截断），结构化与正文任务均禁用；且思考与正文
    // 共享 max_tokens，禁用后速度与产出都稳定。
    ...(isDeepSeekHost ? { thinking: { type: 'disabled' }, stream_options: { include_usage: true } } : {}),
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
          if (yielded === 0) console.error('[moge:streamChat] 空流诊断: 收到[DONE]但无增量 status=' + res.status + ' lines=' + lineCount + ' rawHead=' + JSON.stringify(rawHead));
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const delta: string | undefined = obj.choices?.[0]?.delta?.content;
          if (delta) { yielded++; yield delta; }
          const fr: string | undefined = obj.choices?.[0]?.finish_reason;
          if (fr) opts.onMeta?.({ finishReason: fr, usage: obj.usage });
        } catch {
          /* 忽略心跳等非 JSON 行 */
        }
      }
    }
    if (yielded === 0) console.error('[moge:streamChat] 空流诊断: 流结束无增量 status=' + res.status + ' lines=' + lineCount + ' rawHead=' + JSON.stringify(rawHead));
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
  });
  if (res.ok) return `连接成功（HTTP ${res.status}）`;
  const t = await res.text().catch(() => '');
  throw new Error(`HTTP ${res.status}：${t.slice(0, 200)}`);
}
