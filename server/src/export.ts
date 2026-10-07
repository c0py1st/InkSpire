import type { ChapterFile, Outline, ProjectMeta } from '../../shared/src/types';

/**
 * 整本导出的纯文本拼装（路由只做取数与下发）。
 * md：完整 markdown 层级（# 书名 / ## 卷 / ### 章）；
 * txt：给连载平台粘贴用——所有标记剥净，只留「卷名行 / 章题行 / 正文」。
 */
export function buildExportText(meta: ProjectMeta, outline: Outline, chapters: ChapterFile[], format: 'md' | 'txt'): string {
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const parts: string[] = [format === 'md' ? `# ${meta.title}\n` : `${meta.title}\n`];
  if (meta.logline) parts.push(format === 'md' ? `> ${meta.logline}\n` : `${meta.logline}\n`);
  for (const vol of outline.volumes) {
    parts.push(format === 'md' ? `\n## ${vol.title}\n` : `\n\n${vol.title}\n`);
    for (const ch of vol.chapters) {
      const raw = byId.get(ch.id)?.content ?? '';
      // 只剥尾部空白：JS trim 会连段首全角缩进（U+3000）一起吃掉，导出到平台就丢了段首缩进
      const bodyText = raw.trim() ? raw.replace(/\s+$/, '') : '（未完成）';
      parts.push(format === 'md' ? `\n### ${ch.title}\n\n${bodyText}\n` : `\n\n${ch.title}\n\n${bodyText}\n`);
    }
  }
  return format === 'txt' ? parts.join('\n').replace(/\*\*/g, '') : parts.join('\n');
}
