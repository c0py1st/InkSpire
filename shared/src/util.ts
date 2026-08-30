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
