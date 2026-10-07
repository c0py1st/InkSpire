/** 跨端共用的小工具：id、slug、字数统计 */

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function volumeId(n: number): string {
  return `v${pad2(n)}`;
}

export function chapterId(volNum: number, chNum: number): string {
  return `v${pad2(volNum)}c${pad3(chNum)}`;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Windows 安全的文件 slug；中文标题保留汉字 */
export function slugify(title: string): string {
  const s = title
    .trim()
    .replace(/[\\/:*?"<>|.]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return s || 'untitled';
}

/** 中文语境的字数统计：非空白字符数 */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

const PARAGRAPH_INDENT = '\u3000\u3000'; // 全角空格 ×2

/**
 * 保证每个自然段以两个全角空格开头：
 * - 空行保持为空；
 * - 行首原有空白（半角空格/全角空格/Tab）统一规整为 　　；
 * - 其余非空行补 　　 前缀。
 */
export function ensureParagraphIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/^[ \t\u3000]+/, '');
      if (!trimmed) return '';
      return PARAGRAPH_INDENT + trimmed;
    })
    .join('\n');
}

/** 判断某个偏移是否位于自然段开头（正文起始或紧跟换行），用于给插入片段补缩进 */
export function atParagraphStart(text: string, offset: number): boolean {
  return offset === 0 || text[offset - 1] === '\n';
}

/**
 * 章上移/下移（大纲数组就地操作，返回是否发生了移动）：
 * 卷内交换；卷首再上移 → 落入上一卷末尾、卷尾再下移 → 落入下一卷开头（跨卷搬移）。
 * 章正文按 id 存文件、id 不随位置变，所以跨卷搬动只动大纲数组——文件名/摘要/事件全部无感。
 */
export function moveChapterAcrossVolumes(
  volumes: Array<{ chapters: Array<{ id: string }> }>,
  vi: number, ci: number, dir: -1 | 1,
): boolean {
  const arr = volumes[vi]?.chapters;
  if (!arr) return false;
  const j = ci + dir;
  if (j >= 0 && j < arr.length) {
    [arr[ci], arr[j]] = [arr[j], arr[ci]];
    return true;
  }
  if (j < 0 && vi > 0) {
    volumes[vi - 1].chapters.push(arr[ci]);
    arr.splice(ci, 1);
    return true;
  }
  if (j >= arr.length && vi < volumes.length - 1) {
    volumes[vi + 1].chapters.unshift(arr[ci]);
    arr.splice(ci, 1);
    return true;
  }
  return false;
}

/**
 * 通读模式搜索高亮用：找出 query 在 text 中所有不重叠命中区间 [start,end)。
 * 大小写不敏感（中文经 toLowerCase 恒等，无需分支）；query 含换行/为空返回 []；
 * 纯 indexOf 扫描，不走 RegExp——任意用户输入无注入/回溯风险。
 */
export function findTextRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.includes('\n')) return [];
  const hay = text.toLowerCase();
  const out: Array<[number, number]> = [];
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push([i, i + needle.length]);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}
