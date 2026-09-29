import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 与其他存储层测试同法：import 前把数据目录指到临时区，不碰真实书稿
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-cache-'));
process.env.MOGE_DATA_DIR = tmp;

const { parseUsage } = await import('./ai/usage');
const { emptyCacheStats, sanitizeCacheStats, recordUsage, loadCacheStats, resetCacheStats, CACHE_RECENT_MAX } = await import('./cache-stats');

describe('parseUsage', () => {
  it('DeepSeek 形状：hit/miss 直取', () => {
    expect(parseUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 }))
      .toEqual({ prompt: 1000, cached: 640, miss: 360 });
  });

  it('OpenAI 形状：prompt_tokens_details.cached_tokens', () => {
    expect(parseUsage({ prompt_tokens: 800, prompt_tokens_details: { cached_tokens: 500 } }))
      .toEqual({ prompt: 800, cached: 500, miss: 300 });
  });

  it('完全不报缓存的端点：按全未命中记录', () => {
    expect(parseUsage({ prompt_tokens: 200, total_tokens: 260 })).toEqual({ prompt: 200, cached: 0, miss: 200 });
  });

  it('只有 prompt 总量都没有 → null（不记录）', () => {
    expect(parseUsage({ completion_tokens: 5 })).toBeNull();
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage('junk')).toBeNull();
  });

  it('脏值钳制：负数/字符串/超过 prompt 的 cached 都不产生非法计数', () => {
    expect(parseUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: -5, prompt_cache_miss_tokens: 'x' }))
      .toEqual({ prompt: 100, cached: 0, miss: 100 });
    expect(parseUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 5 }))
      .toEqual({ prompt: 100, cached: 100, miss: 0 });
  });
});

describe('sanitizeCacheStats', () => {
  it('非对象输入退化为全零档案', () => {
    for (const bad of [null, undefined, 42, 'x', []]) expect(sanitizeCacheStats(bad)).toEqual(emptyCacheStats());
  });

  it('合法形状保留、脏字段丢弃但整档不丢', () => {
    const s = sanitizeCacheStats({
      version: 1,
      totals: { calls: 3, prompt: 900, cached: 400, miss: 500 },
      bySource: { prose: { calls: 2, prompt: 800, cached: 400, miss: 400 }, junk: 'x' },
      recent: [{ at: 't', source: 'prose', chapterId: 'v01c001', prompt: 400, cached: 200, miss: 200 }, null, { prompt: 1 }],
    });
    expect(s.totals.calls).toBe(3);
    expect(s.bySource.prose.cached).toBe(400);
    expect(s.bySource.junk).toBeUndefined();          // 非计数对象条目被丢
    expect(s.recent).toHaveLength(1);                  // 脏 recent 条目丢弃
    expect(s.recent[0].chapterId).toBe('v01c001');
  });

  it('recent 超长截断', () => {
    const big = { recent: Array.from({ length: CACHE_RECENT_MAX + 30 }, () => ({ at: 't', source: 's', prompt: 1, cached: 0, miss: 1 })) };
    expect(sanitizeCacheStats(big).recent).toHaveLength(CACHE_RECENT_MAX);
  });
});

describe('recordUsage / loadCacheStats 落盘往返', () => {
  const slug = 'book-a';

  it('记录两次 → 累计、按来源分桶、recent 最新在前', () => {
    const ok1 = recordUsage(slug, { source: 'prose', chapterId: 'v01c001', usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 } });
    const ok2 = recordUsage(slug, { source: 'prose', chapterId: 'v01c002', usage: { prompt_tokens: 1100, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 100 } });
    expect(ok1 && ok2).toBe(true);
    const st = loadCacheStats(slug);
    expect(st.totals).toEqual({ calls: 2, prompt: 2100, cached: 1000, miss: 1100 });
    expect(st.bySource.prose.calls).toBe(2);
    expect(st.recent[0].chapterId).toBe('v01c002');
    // 落在 .index/ 下（可重建缓存，备份排除该目录）
    expect(fs.existsSync(path.join(tmp, slug, '.index', 'cache-stats.json'))).toBe(true);
  });

  it('无效 usage 不写不报错', () => {
    const before = JSON.stringify(loadCacheStats(slug));
    expect(recordUsage(slug, { source: 'prose', usage: { nonsense: 1 } })).toBe(false);
    expect(JSON.stringify(loadCacheStats(slug))).toBe(before);
  });

  it('文件被手改成脏 → 读取即消毒；reset 删除文件', () => {
    fs.writeFileSync(path.join(tmp, slug, '.index', 'cache-stats.json'), '{ broken', 'utf8');
    expect(loadCacheStats(slug)).toEqual(emptyCacheStats());
    recordUsage(slug, { source: 'chat', usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 0 } });
    expect(loadCacheStats(slug).totals.calls).toBe(1);
    resetCacheStats(slug);
    expect(loadCacheStats(slug)).toEqual(emptyCacheStats());
  });
});
