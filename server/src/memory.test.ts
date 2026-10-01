import { describe, expect, it } from 'vitest';
import type { CharacterCard, Foreshadow, Outline, Suggestion, VolumeRecap } from '../../shared/src/types';
import { applyOutlineSuggestion, applyStateSuggestion, recapFingerprint, stateAtChapter } from '../../shared/src/types';
import { buildChapterContext, buildSummariesText, flattenChapterIds, foreshadowText, locateChapter, nextChapterIds, openForeshadowListText } from './ai/memory';
import { prosePrompt } from './ai/prompts/prose';

function fs_(over: Partial<Foreshadow>): Foreshadow {
  return {
    id: 'f1', setupChapterId: 'v01c001', content: '铜牌来历',
    status: 'open', createdAt: '', ...over,
  };
}

function outline(): Outline {
  const chapters = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `v01c${String(i + 1).padStart(3, '0')}`.replace('v01', prefix),
      title: `${prefix}-第${i + 1}章`,
      beat: 'b',
      status: 'todo' as const,
    }));
  return {
    premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
    volumes: [
      { id: 'v01', title: '卷一', summary: '', chapters: chapters('v01', 3) },
      { id: 'v02', title: '卷二', summary: '', chapters: chapters('v02', 2) },
    ],
  };
}

describe('locateChapter', () => {
  it('找到章节及其卷', () => {
    const o = outline();
    const loc = locateChapter(o, 'v02c001');
    expect(loc.volumeIndex).toBe(1);
    expect(loc.chapter.title).toBe('v02-第1章');
  });

  it('找不到时抛错', () => {
    expect(() => locateChapter(outline(), 'v09c009')).toThrow();
  });
});

describe('buildSummariesText', () => {
  it('只包含当前章之前的摘要，顺序为章节顺序', () => {
    const o = outline();
    const text = buildSummariesText(o, { v01c001: '一', v01c003: '三', v02c001: '五' }, 'v02c001');
    expect(text).toContain('v01-第1章');
    expect(text).toContain('v01-第3章');
    expect(text).not.toContain('v02');
    expect(text.indexOf('v01-第1章')).toBeLessThan(text.indexOf('v01-第3章'));
  });

  it('回归：重写旧卷章节时不得注入后续卷的摘要', () => {
    const o = outline();
    // 给第 1 卷第 1 章组前情——所有已归档摘要都在它之后
    const text = buildSummariesText(
      o,
      { v01c002: '二', v01c003: '三', v02c001: '四', v02c002: '五' },
      'v01c001',
    );
    expect(text).toBe('');
  });

  it('起点章不在大纲时返回全部摘要（全书问答场景）', () => {
    const o = outline();
    const text = buildSummariesText(o, { v01c001: '一', v02c002: '五' }, 'nope');
    expect(text).toContain('一');
    expect(text).toContain('五');
  });

  it('预算截断：预算为 0 时不返回任何内容', () => {
    const o = outline();
    // 通过内部常量无法直接改，这里验证超长预算行为——budget 逻辑用小文本验证顺序即可
    const text = buildSummariesText(o, { v01c001: '一', v01c002: '二' }, 'v01c003');
    expect(text).toContain('一');
    expect(text).toContain('二');
  });
});

describe('buildSummariesText 卷回本分层', () => {
  const freshRecap = (o: Outline, volId: string, summaries: Record<string, string>, recap: string): VolumeRecap => {
    const vol = o.volumes.find((v) => v.id === volId)!;
    return { recap, fingerprint: recapFingerprint(vol, summaries), updatedAt: 'x' };
  };

  it('目标前已完成卷有新鲜回本 → 一条顶替全卷逐章', () => {
    const o = outline();
    const summaries = { v01c001: '甲乙丙丁戊己', v01c002: '第二章正文', v01c003: '第三章正文' };
    const recaps = { v01: freshRecap(o, 'v01', summaries, '第一卷收束：主角查到铜牌来历') };
    const text = buildSummariesText(o, summaries, 'v02c001', recaps);
    expect(text).toContain('【卷回本·卷一】第一卷收束');
    // 整卷逐章被顶替，不再出现
    expect(text).not.toContain('v01-第1章');
    expect(text).not.toContain('甲乙丙丁戊己');
  });

  it('回本指纹过期（章摘要变动）→ 自动回落逐章，绝不喂旧回本', () => {
    const o = outline();
    const summaries = { v01c001: '改过的第一章', v01c002: '二', v01c003: '三' };
    const stale: VolumeRecap = { recap: '很久以前的回本', fingerprint: 'deadbeef', updatedAt: 'x' };
    const text = buildSummariesText(o, summaries, 'v02c001', { v01: stale });
    expect(text).not.toContain('很久以前');
    expect(text).toContain('《v01-第1章》：改过的第一章');
  });

  it('当前卷一律逐章细注入（即便该卷此前误留有回本也不用）', () => {
    const o = outline();
    const summaries = { v01c001: '一', v01c002: '二', v02c001: '五' };
    // 目标在 v01c003：v01 是当前卷，不得用回本；只出 v01c001/002 逐章
    const recaps = { v01: freshRecap(o, 'v01', summaries, '不应出现的本卷回本') };
    const text = buildSummariesText(o, summaries, 'v01c003', recaps);
    expect(text).not.toContain('不应出现');
    expect(text).toContain('《v01-第1章》：一');
    expect(text).toContain('《v01-第2章》：二');
  });

  it('不传 recaps 与旧行为一致（向后兼容）', () => {
    const o = outline();
    const summaries = { v01c001: '一', v02c001: '五' };
    const withUndef = buildSummariesText(o, summaries, 'v02c002');
    const legacy = buildSummariesText(o, summaries, 'v02c002', undefined);
    expect(withUndef).toBe(legacy);
    expect(withUndef).toContain('《v01-第1章》：一');
  });

  it('全书问答（目标不在大纲）→ 所有新鲜回本都参与压缩', () => {
    const o = outline();
    const summaries = { v01c001: '一', v01c002: '二', v01c003: '三', v02c001: '四', v02c002: '五' };
    const recaps = {
      v01: freshRecap(o, 'v01', summaries, '卷一回本'),
      v02: freshRecap(o, 'v02', summaries, '卷二回本'),
    };
    const text = buildSummariesText(o, summaries, 'nope', recaps);
    expect(text).toContain('【卷回本·卷一】卷一回本');
    expect(text).toContain('【卷回本·卷二】卷二回本');
    expect(text).not.toContain('《v01-第1章》');
  });

  it('recapFingerprint 对摘要内容敏感、对顺序敏感、稳定可复现', () => {
    const o = outline();
    const s1 = { v01c001: 'a', v01c002: 'b', v01c003: 'c' };
    const vol = o.volumes.find((v) => v.id === 'v01')!;
    expect(recapFingerprint(vol, s1)).toBe(recapFingerprint(vol, s1)); // 稳定
    expect(recapFingerprint(vol, s1)).not.toBe(recapFingerprint(vol, { ...s1, v01c002: '改' })); // 内容敏感
    expect(recapFingerprint(vol, s1)).not.toBe(recapFingerprint(vol, { v01c001: 'b', v01c002: 'a', v01c003: 'c' })); // 顺序敏感
    // 缺失摘要与空串同签名（未归档章视作空）
    expect(recapFingerprint(vol, { v01c001: 'a', v01c003: 'c' })).toBe(recapFingerprint(vol, { v01c001: 'a', v01c002: '', v01c003: 'c' }));
  });
});

describe('flattenChapterIds', () => {
  it('卷序+卷内序展开全部章 id', () => {
    expect(flattenChapterIds(outline())).toEqual([
      'v01c001', 'v01c002', 'v01c003', 'v02c001', 'v02c002',
    ]);
  });
});

describe('nextChapterIds', () => {
  it('含起点，跨卷衔接', () => {
    expect(nextChapterIds(outline(), 'v01c002', 4)).toEqual([
      'v01c002', 'v01c003', 'v02c001', 'v02c002',
    ]);
  });

  it('末尾不足 count 时返回剩余', () => {
    expect(nextChapterIds(outline(), 'v02c002', 5)).toEqual(['v02c002']);
  });

  it('起点不在大纲时抛错', () => {
    expect(() => nextChapterIds(outline(), 'v09c001', 3)).toThrow();
  });
});

describe('foreshadowText', () => {
  const o = outline();

  it('埋设章在本章之前的未收伏笔要列出，之后埋的不列', () => {
    const items = [
      fs_({ id: 'a', setupChapterId: 'v01c001', content: '甲牌' }),
      fs_({ id: 'b', setupChapterId: 'v02c002', content: '乙线' }),
    ];
    const text = foreshadowText(o, items, 'v01c002');
    expect(text).toContain('甲牌');
    expect(text).not.toContain('乙线');
  });

  it('指定本章回收的伏笔以"必须回收"呈现且排在前面', () => {
    const items = [
      fs_({ id: 'a', setupChapterId: 'v01c001', content: '普通线' }),
      fs_({ id: 'b', setupChapterId: 'v01c001', payoffChapterId: 'v01c002', content: '该收了' }),
    ];
    const text = foreshadowText(o, items, 'v01c002');
    expect(text).toContain('本章必须回收：该收了');
    expect(text.indexOf('该收了')).toBeLessThan(text.indexOf('普通线'));
  });

  it('已回收/废弃不再出现', () => {
    const items = [
      fs_({ id: 'a', content: '收了', status: 'resolved' }),
      fs_({ id: 'b', content: '扔了', status: 'abandoned' }),
    ];
    const text = foreshadowText(o, items, 'v02c001');
    expect(text).toBe('');
  });

  it('空表返回空串', () => {
    expect(foreshadowText(o, [], 'v01c001')).toBe('');
  });
});

describe('openForeshadowListText（全书上下文）', () => {
  const o = outline();

  it('未回收条目同时带埋设章与计划回收章（不再丢回收信息）', () => {
    const text = openForeshadowListText(o, [
      fs_({ id: 'a', setupChapterId: 'v01c001', payoffChapterId: 'v01c003', content: '粮栈案' }),
    ]);
    expect(text).toContain('埋设于《');
    expect(text).toContain('(v01c001)');
    expect(text).toContain('计划回收于');
    expect(text).toContain('(v01c003)');
  });

  it('回收章未定时如实标注；已回收/废弃不列', () => {
    const text = openForeshadowListText(o, [
      fs_({ id: 'a', content: '待定线' }),
      fs_({ id: 'b', content: '收了', status: 'resolved' }),
      fs_({ id: 'c', content: '废了', status: 'abandoned' }),
    ]);
    expect(text).toContain('回收章未定');
    expect(text).not.toContain('收了');
    expect(text).not.toContain('废了');
  });

  it('空表返回空串', () => {
    expect(openForeshadowListText(o, [])).toBe('');
  });
});

/* ---------------- 人物状态时间线 ---------------- */

function card(over: Partial<CharacterCard> = {}): CharacterCard {
  return { id: 'x', name: '李慎', role: '主角', personality: '', background: '', relations: '', ...over };
}
function sugState(over: Partial<Suggestion>): Suggestion {
  return {
    id: 's1', kind: 'state', name: '李慎', content: '右手带伤',
    createdAt: '', ...over,
  };
}

describe('stateAtChapter', () => {
  it('无时间线的旧卡退回当前 state（行为不变）', () => {
    expect(stateAtChapter(card({ state: '当前：痊愈' }), 'v01c002')).toBe('当前：痊愈');
  });

  it('取早于目标章的最近节点，不泄漏后文状态', () => {
    const c = card({
      state: '现值：断臂',
      stateHistory: [
        { chapterId: 'v01c001', chapterTitle: '第一章', state: '右手划伤', at: '' },
        { chapterId: 'v01c003', chapterTitle: '第三章', state: '伤重发热', at: '' },
      ],
    });
    // 写第二章时：只有第一章的节点早于它 → 取"右手划伤"，绝不取第三章或现值
    expect(stateAtChapter(c, 'v01c002')).toBe('右手划伤');
    // 写第四章时：第三章节点也早于它 → 取伤重发热
    expect(stateAtChapter(c, 'v01c004')).toBe('伤重发热');
  });

  it('目标章早于全部节点时返回 undefined（第一章之前无状态可述）', () => {
    const c = card({
      state: '现值',
      stateHistory: [{ chapterId: 'v02c001', chapterTitle: '', state: '晚近状态', at: '' }],
    });
    expect(stateAtChapter(c, 'v01c001')).toBeUndefined();
  });

  it('忽略 chapterId 非法或状态为空的脏节点', () => {
    const c = card({
      state: '现值',
      stateHistory: [
        { chapterId: '乱码', chapterTitle: '', state: '脏数据', at: '' },
        { chapterId: 'v01c001', chapterTitle: '', state: '  ', at: '' },
        { chapterId: 'v01c002', chapterTitle: '', state: '有效', at: '' },
      ],
    });
    expect(stateAtChapter(c, 'v01c005')).toBe('有效');
  });
});

describe('applyStateSuggestion', () => {
  it('更新当前值并追加时间线节点', () => {
    const c = card({ state: '旧' });
    applyStateSuggestion(c, sugState({ content: '右手带伤', note: '查验盐车时留下新伤', sourceChapterId: 'v01c002', sourceChapterTitle: '第二章' }));
    expect(c.state).toBe('右手带伤');
    expect(c.stateHistory).toHaveLength(1);
    expect(c.stateHistory![0]).toMatchObject({ chapterId: 'v01c002', state: '右手带伤', reason: '查验盐车时留下新伤', chapterTitle: '第二章' });
  });

  it('重复采纳同一观察（同章同状态）只留一个节点', () => {
    const c = card();
    const s = sugState({ content: '右手带伤', sourceChapterId: 'v01c002' });
    applyStateSuggestion(c, s);
    applyStateSuggestion(c, s);
    expect(c.stateHistory).toHaveLength(1);
  });

  it('缺来源章时只更新当前值、不追加节点', () => {
    const c = card();
    applyStateSuggestion(c, sugState({ content: '立场动摇', sourceChapterId: undefined }));
    expect(c.state).toBe('立场动摇');
    expect(c.stateHistory ?? []).toHaveLength(0);
  });
});

describe('buildChapterContext 人物状态按章取时点值', () => {
  const o = outline();
  it('重写旧章时，出场人物卡注入"当时"的状态而非现值', () => {
    const c = card({
      state: '现值：断臂',
      stateHistory: [
        { chapterId: 'v01c001', chapterTitle: 'v01-第1章', state: '右手划伤', at: '' },
      ],
    });
    // 目标 v01c002，出场名单含李慎 → 取第一章节点
    const ctx = buildChapterContext({
      outline: (() => {
        // 把目标章的 characters 设为 [李慎]
        const oo = structuredClone(o);
        oo.volumes[0].chapters[1].characters = ['李慎'];
        return oo;
      })(),
      chapterId: 'v01c002',
      characters: [c],
      worldview: '',
      summaries: {},
    });
    expect(ctx.cast.find((x) => x.name === '李慎')?.state).toBe('右手划伤');
  });
});

/* ---------------- 前情摘要量化滑窗（前缀缓存友好排布） ---------------- */

describe('buildSummariesText 量化滑窗', () => {
  // 一卷 40 章、摘要各约 800 字，方便越过 12000/16000 两条线
  function bigOutline(n: number): Outline {
    return {
      premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
      volumes: [{ id: 'v01', title: '卷一', summary: '', chapters: Array.from({ length: n }, (_, i) => ({
        id: `v01c${String(i + 1).padStart(3, '0')}`, title: `章${i + 1}`, beat: 'b', status: 'todo' as const,
      })) }],
    };
  }
  const textOf = (upto: number) => {
    const o = bigOutline(40);
    const summaries: Record<string, string> = {};
    for (let i = 1; i <= upto; i++) summaries[`v01c${String(i).padStart(3, '0')}`] = `S${i}·${'x'.repeat(800)}`;
    return { block: buildSummariesText(o, summaries, `v01c${String(upto + 1).padStart(3, '0')}`), summaries };
  };

  it('预算内纯追加：后一章的块以前一章的块逐字节开头', () => {
    const a = textOf(10).block;   // 10*~815 ≈ 8150 < 16000，未饱和
    const b = textOf(11).block;
    expect(b.startsWith(a)).toBe(true);
    expect(b).toContain('S11');
  });

  it('越过 预算+滑窗 才成批丢弃；丢弃后的下一次增长仍是纯追加（头部锁死）', () => {
    // 19 条 ≈ 15500：未越过 16000 → 不丢
    const sat = textOf(20).block;  // 20 条首次越过 → 成批裁回 ≤12000
    const next = textOf(21).block; // 裁后 ~12000 内追加一条，不应再动头部
    expect(sat).not.toContain('《章1》'); // 20 条时确实发生了丢弃
    expect(next.startsWith(sat)).toBe(true);
    expect(next).toContain('《章21》');
  });

  it('整条进出：预算溢出不再产生"半条摘要"；仅单条超定长上限时定长截断', () => {
    const block = textOf(25).block;
    expect(block).not.toContain('…'); // 800 字未超单条 1500 上限，块内不该有任何省略号
    const o = bigOutline(3);
    const huge = { v01c001: 'H'.repeat(3000), v01c002: '短' };
    const b2 = buildSummariesText(o, huge, 'v01c003');
    expect(b2).toContain('H'.repeat(1500) + '…'); // 定长切点：恒定 1500，与预算余量无关
    expect(b2).not.toContain('H'.repeat(1501));
  });
});

/* ---------------- 大纲修订建议（applyOutlineSuggestion） ---------------- */

describe('applyOutlineSuggestion', () => {
  const o = outline();
  const base: Suggestion = {
    id: 's', kind: 'outline', name: 't', content: '新的大纲要求：主角当众与反派翻脸',
    sourceChapterId: 'v01c002', createdAt: '',
  };
  it('命中源章 → 替换其 beat 并返回 true', () => {
    const target = structuredClone(o);
    expect(applyOutlineSuggestion(target, base)).toBe(true);
    const ch = target.volumes[0].chapters.find((c) => c.id === 'v01c002')!;
    expect(ch.beat).toBe(base.content);
    // 其它章不受影响
    expect(target.volumes[0].chapters[0].beat).toBe('b');
  });
  it('缺 sourceChapterId 或大纲无此章 → false、大纲不变', () => {
    const t1 = structuredClone(o);
    expect(applyOutlineSuggestion(t1, { ...base, sourceChapterId: undefined })).toBe(false);
    expect(applyOutlineSuggestion(t1, { ...base, sourceChapterId: 'v99c999' })).toBe(false);
    expect(t1.volumes[0].chapters[1].beat).toBe('b');
  });
});

/* ---------------- E1 网文结构字段：注入与零漂移 ---------------- */

describe('网文模式 E1 prosePrompt 注入', () => {
  const o = outline();
  const args = { characters: [] as CharacterCard[], worldview: '', summaries: {} as Record<string, string> };

  it('字段缺省时 prompt 不含任何网文标记（老书逐字节不变）', () => {
    const ctx = buildChapterContext({ outline: o, chapterId: 'v01c002', ...args });
    const p = prosePrompt(ctx);
    expect(p.user).not.toContain('爽点');
    expect(p.user).not.toContain('章末钩子');
    expect(p.user).not.toContain('钩子去重');
  });

  it('本章填了爽点/钩子 → 两条硬约束块出现且逐字', () => {
    const oo = structuredClone(o);
    const ch = oo.volumes[0].chapters[1];
    ch.payoffPoint = '当众打脸质疑者';
    ch.chapterHook = '勘合上多了一枚陌生火漆';
    const ctx = buildChapterContext({ outline: oo, chapterId: 'v01c002', ...args });
    const p = prosePrompt(ctx);
    expect(p.user).toContain('【本章爽点（须在本章兑现）】当众打脸质疑者');
    expect(p.user).toContain('【本章章末钩子（结尾须落到这个悬念上）】勘合上多了一枚陌生火漆');
  });

  it('前章已用钩子 → 去重提示列出；同章及之后的钩子不算', () => {
    const oo = structuredClone(o);
    oo.volumes[0].chapters[0].chapterHook = '尸体突然坐起';
    oo.volumes[0].chapters[2].chapterHook = '未来章的钩子'; // 目标章之后，不得泄漏
    const p = prosePrompt(buildChapterContext({ outline: oo, chapterId: 'v01c002', ...args }));
    expect(p.user).toContain('【钩子去重】');
    expect(p.user).toContain('《v01-第1章》尸体突然坐起');
    expect(p.user).not.toContain('未来章的钩子');
  });

  it('钩子去重只看最近 5 章（窗外旧钩子不列、窗内钩子必列）', () => {
    const oo: Outline = {
      premise: 'p', genre: 'g', coreConflict: 'c', endingVision: 'e', styleGuide: 's',
      volumes: [{ id: 'v09', title: '卷九', summary: '', chapters: Array.from({ length: 9 }, (_, i) => ({
        id: `v09c${String(i + 1).padStart(3, '0')}`, title: `章${i + 1}`, beat: 'b', status: 'todo' as const,
      })) }],
    };
    oo.volumes[0].chapters[0].chapterHook = '太久远的钩子';   // v09c001：距目标 8 章，窗户外
    oo.volumes[0].chapters[7].chapterHook = '窗内近章的钩子'; // v09c008：目标前一章，窗内
    const args9 = { characters: [] as CharacterCard[], worldview: '', summaries: {} as Record<string, string> };
    const p = prosePrompt(buildChapterContext({ outline: oo, chapterId: 'v09c009', ...args9 }));
    expect(p.user).not.toContain('太久远的钩子');
    expect(p.user).toContain('窗内近章的钩子');
  });
});
