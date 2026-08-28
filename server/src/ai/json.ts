/**
 * 从模型输出中稳健地取出 JSON：剥 code fence、截取首个平衡的花括号块。
 * 模型偶尔会在 JSON 前后加解释文字，这里统一兜住。
 */
export function extractJson<T = unknown>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) throw new Error('模型未返回 JSON');

  // 截取从第一个 { 开始、括号平衡（且不在字符串内）的片段
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch (err) {
          throw new Error(`JSON 解析失败：${(err as Error).message}`);
        }
      }
    }
  }
  throw new Error('JSON 不完整（模型输出被截断？）');
}
