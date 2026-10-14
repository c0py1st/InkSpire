/**
 * 专名串改扫描（零模型、零依赖、只读）。
 * 思路：从人物卡/世界书/正文「」引用收集"种子专名"，对种子表做近似聚类
 * （编辑距离 ≤1~2），若一多一少的近似对同时出现在正文 → 疑似串改/笔误，
 * 低频方连同出现位置上报。只报告不动稿——判定权留给作者。
 */
import type { NameAuditHit, NameAuditPair, NameAuditReport, NameSeed } from '../../shared/src/types';
import { loadCharacters, loadLorebook, listChapters, readChapter } from './fs-store';

/** 有界编辑距离：只区分 ≤1 / ≤2 / 更远。长度差 >2 直接出局。 */
function nearDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return 9;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff++;
    return diff;
  }
  // 长度差 1~2：短串逐字符在长串中顺序对齐，跳跃数即近似距离
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let jumps = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; } else { jumps++; j++; }
  }
  return jumps + (short.length - i);
}

/** 专名尾字启发集：地名/器物/建筑类高频尾字（轻量"NER"，只认结尾不认开头） */
const NAME_SUFFIX = '城江河湖海山湖岭峰崖涧渡津关州府县村落庄园阁楼轩斋堂殿寺观塔台桥船剑刀枪戟弓盾甲旗印令符珠佩环鼎炉镜琴笛镖匣囊图卷经丹露霜雪云雾霞烟岚屿岫礁壑垣墙阙亭榭墅寨堡圩坪坡野陌阡径蹊源流泉瀑潭池渊沟渠港湾澳';

/** 绝不作为专名开头的虚词/常见字：滤掉"了临江城""的江城"这类前导垃圾窗口 */
const NO_HEAD = new Set(('的了是在有和与就都而被把让向从对为之其此等把那一不没未很更最再又已曾经由' + '于以及或但却又还只同样这那些哪个什么').split(''));

/**
 * 正文启发种子：滑动枚举 2~3 字中文窗口，尾字落在专名尾字表、首字非虚词即候选
 * （"临沂城""青冥剑"这类没登记进卡/世界书的地名器物也能被兜住）。
 * 若某候选是另一更长候选的后缀（"江城"⊂"临江城"）则丢弃，只留最大形式，防碎片刷屏。
 * 窗口封 3 字：4 字名（司马无咎）由 card/lore 权威种子覆盖，启发层不越权以免误伤。
 */
export function heuristicSeeds(text: string): NameSeed[] {
  const cands = new Set<string>();
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    for (let len = 2; len <= 3; len++) {
      const w = chars.slice(i, i + len).join('');
      if (w.length < len) break;
      if (!/^[一-鿿]+$/.test(w)) break;
      if (NO_HEAD.has(w[0])) continue;
      if (NAME_SUFFIX.includes(w[w.length - 1])) cands.add(w);
    }
  }
  const arr = [...cands];
  return arr
    .filter((w) => !arr.some((v) => v !== w && v.endsWith(w)))
    .map((word) => ({ word, source: 'quote' as const }));
}

/** 清洗：长度 2~8、纯中文、按强弱出处去重 */
export function cleanSeeds(seeds: NameSeed[]): NameSeed[] {
  const seen = new Map<string, NameSeed['source']>();
  for (const s of seeds) {
    const w = s.word.trim();
    if (w.length < 2 || w.length > 8) continue;
    if (!/^[一-鿿][一-鿿·]*$/.test(w)) continue;
    const prev = seen.get(w);
    // 出处优先级：card > lore > quote（同词多源保留更强出处）
    if (!prev || prev === 'quote' || (prev === 'lore' && s.source === 'card')) seen.set(w, s.source);
  }
  return [...seen.entries()].map(([word, source]) => ({ word, source }));
}

/** 正文「」内高频引用（≥2 次）当候选专名 */
export function quoteSeeds(text: string, minCount = 2): NameSeed[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/「([^」\n]{2,8})」/g)) {
    const w = m[1].trim();
    if (/^[一-鿿][一-鿿·]*$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c >= minCount).map(([word]) => ({ word, source: 'quote' as const }));
}

function countWord(text: string, w: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(w, i)) >= 0) { n++; i += w.length; }
  return n;
}

/** 低频方在正文的全部出现（带上下文段） */
function collectHits(texts: Array<{ id: string; title: string; text: string }>, w: string, cap = 8): NameAuditHit[] {
  const out: NameAuditHit[] = [];
  for (const t of texts) {
    for (const m of t.text.matchAll(new RegExp(`[^\\n]{0,24}${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]{0,24}`, 'g'))) {
      out.push({ chapterId: t.id, title: t.title, context: m[0].trim() });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * 纯扫描核心：种子表 × 章节文本 → 可疑近似对。
 * 判定：距离 ≤1（长 ≥4 放宽到 2）；高频方 ≥3 次且低频方 ≤ max(2, 高频/10)。
 */
export function auditNamePairs(seeds: NameSeed[], texts: Array<{ id: string; title: string; text: string }>): NameAuditPair[] {
  const all = texts.map((t) => t.text).join('\n');
  const withCount = cleanSeeds(seeds)
    .map((s) => ({ ...s, count: countWord(all, s.word) }))
    .filter((s) => s.count > 0)
    .sort((x, y) => x.count - y.count);
  const pairs: NameAuditPair[] = [];
  const claimed = new Set<string>();
  for (let i = 0; i < withCount.length; i++) {
    for (let j = i + 1; j < withCount.length; j++) {
      const lo = withCount[i];
      const hi = withCount[j];
      const maxD = Math.min(lo.word.length, hi.word.length) >= 4 ? 2 : 1;
      const d = nearDistance(lo.word, hi.word);
      if (d === 0 || d > maxD) continue;
      if (hi.count < 3) continue;
      if (lo.count > Math.max(2, Math.floor(hi.count / 10))) continue;
      if (claimed.has(lo.word)) continue; // 低频词只挂最频的近似主，防刷屏
      claimed.add(lo.word);
      pairs.push({
        a: hi.word,
        b: lo.word,
        ca: hi.count,
        cb: lo.count,
        bothSeeded: lo.source !== 'quote' && hi.source !== 'quote',
        hits: collectHits(texts, lo.word),
      });
    }
  }
  // 低频方越少越像铁证笔误，排前；封顶 40 防刷屏
  pairs.sort((x, y) => x.cb - y.cb);
  return pairs.slice(0, 40);
}

export function runNameAudit(slug: string): NameAuditReport {
  const chapters = listChapters(slug);
  const texts = chapters.map((c) => ({
    id: c.id,
    title: c.title,
    text: readChapter(slug, c.id).content,
  }));
  const seeds: NameSeed[] = [
    ...loadCharacters(slug).map((ch) => ({ word: ch.name, source: 'card' as const })),
    ...loadLorebook(slug).flatMap((e) => [...e.keys.map((k) => ({ word: k, source: 'lore' as const })), { word: e.title, source: 'lore' as const }]),
    ...texts.flatMap((t) => quoteSeeds(t.text)),
    ...texts.flatMap((t) => heuristicSeeds(t.text)),
  ];
  const pairs = auditNamePairs(seeds, texts);
  const dedup = new Set(seeds.map((s) => s.word.trim()));
  return { pairs, scanned: { chapters: texts.length, seeds: dedup.size } };
}
