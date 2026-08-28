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
