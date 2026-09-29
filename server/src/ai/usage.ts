/**
 * usage 度量解析：把 provider 返回的 usage 对象归一为 {prompt, cached, miss}。
 * 纯函数、不抛错——度量属于观测面，任何形状异常都只是"不记录"，绝不影响主流程。
 */

export interface UsageDelta {
  prompt: number;   // 本次输入 token 总量
  cached: number;   // 其中前缀缓存命中量
  miss: number;     // 未命中（计费更贵的部分）
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** 无法识别（连 prompt 总量都没有）时返回 null */
export function parseUsage(u: unknown): UsageDelta | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const prompt = num(o.prompt_tokens) ?? num(o.input_tokens);
  if (prompt === null) return null;
  const details = o.prompt_tokens_details && typeof o.prompt_tokens_details === 'object'
    ? o.prompt_tokens_details as Record<string, unknown>
    : null;
  const cached = num(o.prompt_cache_hit_tokens) ?? (details ? num(details.cached_tokens) : null);
  const miss = num(o.prompt_cache_miss_tokens);
  if (cached === null && miss === null) return { prompt, cached: 0, miss: prompt }; // 不报缓存的端点按全未命中记
  let c = cached ?? 0;
  let m = miss ?? Math.max(0, prompt - c);
  if (c > prompt) c = prompt;
  if (c + m > prompt) m = Math.max(0, prompt - c);
  return { prompt, cached: c, miss: m };
}
