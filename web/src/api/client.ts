/** 与后端的全部交互。SSE 统一走 sse()。 */
import type {
  AppConfig, Bundle, ChapterFile, CharacterCard, Kernel, Outline, ProjectMeta, ProposalRequest, Volume,
} from '../../../shared/src/types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function get<T>(url: string): Promise<T> {
  return fetch(url).then((r) => json<T>(r));
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r));
}

function put<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r));
}

function del<T>(url: string): Promise<T> {
  return fetch(url, { method: 'DELETE' }).then((r) => json<T>(r));
}

/** SSE 流式调用。onFinal 收到最后一条 final 事件；返回 final 对象或 null。signal 可中断（同时会掐断上游请求）。 */
export async function sse<T = unknown>(
  url: string,
  body: unknown,
  onDelta: (text: string) => void,
  onFinal?: (obj: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final: T | null = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break outer;
        try {
          const obj = JSON.parse(payload) as { type: string; text?: string; message?: string };
          if (obj.type === 'delta' && obj.text) onDelta(obj.text);
          else if (obj.type === 'final') {
            final = obj as unknown as T;
            onFinal?.(obj);
          } else if (obj.type === 'error') throw new Error(obj.message ?? '模型调用失败');
        } catch (err) {
          if (err instanceof SyntaxError) continue; // 非 JSON 行忽略
          throw err;
        }
      }
    }
  }
  return final;
}

/* ---------------- 设置 ---------------- */

export const api = {
  getSettings: () => get<AppConfig>('/api/settings'),
  saveSettings: (cfg: AppConfig) => put<{ ok: true }>('/api/settings', cfg),
  testProvider: (p: unknown) => post<{ ok: boolean; message: string }>('/api/settings/test', p),
  listModels: (p: unknown) => post<{ ok: boolean; models: string[]; message?: string }>('/api/settings/models', p),

  listProjects: () => get<ProjectMeta[]>('/api/projects'),
  createProject: (title: string, logline: string) => post<ProjectMeta>('/api/projects', { title, logline }),
  completeProject: (payload: { meta: { title: string; logline: string; wordsPerChapter?: number }; outline: Outline; characters: CharacterCard[]; worldview: string }) =>
    post<ProjectMeta>('/api/projects/complete', payload),
  deleteProject: (slug: string) => del<{ ok: true }>(`/api/projects/${slug}`),

  getBundle: (slug: string) => get<Bundle & { wordCounts: Record<string, number> }>(`/api/projects/${slug}/bundle`),
  getChapter: (slug: string, id: string) => get<ChapterFile>(`/api/projects/${slug}/chapter/${id}`),
  saveChapter: (slug: string, id: string, payload: { content: string; status?: string; title?: string; backup?: boolean }) =>
    put<{ wordCount: number }>(`/api/projects/${slug}/chapter/${id}`, payload),
  listBackups: (slug: string, id: string) =>
    get<Array<{ stamp: string; epoch: number; chars: number; title: string }>>(`/api/projects/${slug}/chapter/${id}/backups`),
  getBackup: (slug: string, id: string, stamp: string) =>
    get<ChapterFile>(`/api/projects/${slug}/chapter/${id}/backups/${encodeURIComponent(stamp)}`),
  saveOutline: (slug: string, outline: Outline) => put<{ ok: true }>(`/api/projects/${slug}/outline`, outline),
  saveCharacters: (slug: string, chars: CharacterCard[]) => put<{ ok: true }>(`/api/projects/${slug}/characters`, chars),
  saveWorldview: (slug: string, text: string) => put<{ ok: true }>(`/api/projects/${slug}/worldview`, { text }),

  acceptSuggestion: (slug: string, id: string) => post<{ ok: true }>(`/api/projects/${slug}/suggestions/${id}/accept`, {}),
  dismissSuggestion: (slug: string, id: string) => del<{ ok: true }>(`/api/projects/${slug}/suggestions/${id}`),

  finalizeChapter: (slug: string, chapterId: string, content: string) =>
    post<{ summary: string; newSuggestions: Array<{ id: string; kind: string; name: string; content: string }> }>(
      `/api/projects/${slug}/finalize-chapter/${chapterId}`, { content },
    ),
  consistency: (slug: string, chapterId: string) =>
    post<{ issues: Array<{ severity: string; quote: string; description: string }> }>(
      `/api/projects/${slug}/check-consistency/${chapterId}`, {},
    ),
  refineVolume: (slug: string, volIndex: number, chapterCount: number) =>
    post<{ ok: true; volume: Volume }>(`/api/projects/${slug}/refine-volume/${volIndex}`, { chapterCount }),

  // 流式任务
  wizardKernel: (ideaPrompt: string, scale: { volumeCount: number; chaptersPerVolume: number; wordsPerChapter: number }, onDelta: (t: string) => void) =>
    sse<{ kernel: Kernel }>('/api/wizard/kernel', { ideaPrompt, scale }, onDelta),
  wizardVolumes: (kernel: Kernel, volumeCount: number, onDelta: (t: string) => void) =>
    sse<{ volumes: Array<{ title: string; summary: string }> }>('/api/wizard/volumes', { kernel, volumeCount }, onDelta),
  wizardBeats: (kernel: Kernel, volumes: Volume[], volIndex: number, chapterCount: number, onDelta: (t: string) => void) =>
    sse<{ chapters: Array<{ title: string; beat: string; pov?: string; characters?: string[] }> }>(
      '/api/wizard/beats', { kernel, volumes, volIndex, chapterCount }, onDelta,
    ),
  wizardBible: (kernel: Kernel, volumes: Volume[], onDelta: (t: string) => void) =>
    sse<{ bible: { characters: CharacterCard[]; worldview: string } }>('/api/wizard/bible', { kernel, volumes }, onDelta),

  generateChapter: (slug: string, chapterId: string, mode: 'full' | 'continue', onDelta: (t: string) => void, signal?: AbortSignal) =>
    sse<{ chapterId: string }>(`/api/projects/${slug}/generate-chapter/${chapterId}`, { mode }, onDelta, undefined, signal),
  chat: (slug: string, payload: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; chapterId?: string; selection?: string }, onDelta: (t: string) => void) =>
    sse(`/api/projects/${slug}/chat`, payload, onDelta),
  propose: (slug: string, payload: ProposalRequest, onDelta: (t: string) => void) =>
    sse(`/api/projects/${slug}/propose`, payload, onDelta),

  exportUrl: (slug: string, format: 'md' | 'txt') => `/api/projects/${slug}/export?format=${format}`,
};
