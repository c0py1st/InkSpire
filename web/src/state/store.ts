import { create } from 'zustand';
import type {
  AppConfig, Bundle, ChapterStatus, CharacterCard, Outline, ProjectMeta, ProposalKind,
} from '../../../shared/src/types';
import { atParagraphStart, ensureParagraphIndent } from '../../../shared/src/util';
import { api } from '../api/client';

export type CenterView = 'outline' | 'editor' | 'bible';
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';
export type ThemePref = 'light' | 'dark' | 'system';

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

function initialThemePref(): ThemePref {
  const saved = localStorage.getItem('moge-theme') as ThemePref | null;
  const pref: ThemePref = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  applyTheme(pref);
  return pref;
}

export interface ChapterDraft {
  id: string;
  title: string;
  status: ChapterStatus;
  content: string;
}

export interface Selection {
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ok';
}

interface Store {
  // UI
  theme: ThemePref;
  centerView: CenterView;
  drawerOpen: boolean;
  focusMode: boolean;
  settingsOpen: boolean;
  wizardOpen: boolean;
  toasts: Toast[];

  // 数据
  config: AppConfig | null;
  projects: ProjectMeta[];
  slug: string | null;
  bundle: (Bundle & { wordCounts: Record<string, number> }) | null;

  // 编辑器
  chapter: ChapterDraft | null;
  saveState: SaveState;
  generating: boolean;
  generatingChapterId: string | null;   // 正在生成的目标章（可能不是当前打开的章）
  selection: Selection | null;
  pendingProposal: { kind: ProposalKind; instruction: string; nonce: number } | null;
  suggestionsSeen: number;

  // actions
  init: () => Promise<void>;
  setTheme: (pref: ThemePref) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  setView: (v: CenterView) => void;
  setDrawer: (open: boolean) => void;
  setFocus: (on: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setWizardOpen: (open: boolean) => void;

  loadConfig: () => Promise<void>;
  saveConfig: (cfg: AppConfig) => Promise<void>;
  loadProjects: () => Promise<void>;
  openProject: (slug: string) => Promise<void>;
  backHome: () => void;
  reloadBundle: () => Promise<void>;

  openChapter: (id: string) => Promise<void>;
  setContent: (text: string) => void;
  setStreamContent: (text: string) => void;
  setChapterTitle: (title: string) => void;
  setChapterStatus: (status: ChapterStatus) => void;
  saveChapter: () => Promise<void>;
  applyReplacement: (start: number, end: number, text: string) => Promise<void>;

  startGeneration: (mode: 'full' | 'continue') => Promise<void>;
  cancelGeneration: () => void;
  syncGenerationStatus: () => Promise<void>;
  finishGenerationWatch: (status: string, error?: string, wordCount?: number) => Promise<void>;

  setSelection: (sel: Selection | null) => void;
  requestProposal: (kind: ProposalKind, instruction?: string) => void;
  consumeProposal: () => void;

  updateOutlineLocal: (outline: Outline) => void;
  persistOutline: (outline: Outline) => Promise<void>;
  persistCharacters: (chars: CharacterCard[]) => Promise<void>;
  persistWorldview: (text: string) => Promise<void>;

  acceptSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => Promise<void>;
  markSuggestionsSeen: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 1;
let genInFlight = false; // 模块级防重入：双击/快速连点不会发出第二个生成请求
let genSlug: string | null = null;       // 后台生成任务所属作品
let pollTimer: ReturnType<typeof setInterval> | null = null;
let closeGenStream: (() => void) | null = null;

export const useStore = create<Store>((set, get) => ({
  theme: initialThemePref(),
  centerView: 'outline',
  drawerOpen: true,
  focusMode: false,
  settingsOpen: false,
  wizardOpen: false,
  toasts: [],

  config: null,
  projects: [],
  slug: null,
  bundle: null,

  chapter: null,
  saveState: 'idle',
  generating: false,
  generatingChapterId: null,
  selection: null,
  pendingProposal: null,
  suggestionsSeen: 0,

  async init() {
    applyTheme(get().theme);
    // 跟随系统模式下，系统切换深浅色时实时跟随
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (get().theme === 'system') applyTheme('system');
    });
    // 页面从后台回到前台时立即同步一次生成状态（服务端可能已完成落盘）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void get().syncGenerationStatus();
    });
    await Promise.all([get().loadConfig(), get().loadProjects()]);
  },

  setTheme(pref) {
    localStorage.setItem('moge-theme', pref);
    applyTheme(pref);
    set({ theme: pref });
  },

  toast(text, kind = 'info') {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
  },

  setView: (centerView) => set({ centerView, focusMode: false }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setFocus: (focusMode) => set({ focusMode }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),

  async loadConfig() {
    try {
      set({ config: await api.getSettings() });
    } catch (err) {
      get().toast(`读取设置失败：${(err as Error).message}`, 'error');
    }
  },

  async saveConfig(cfg) {
    await api.saveSettings(cfg);
    set({ config: cfg });
    get().toast('设置已保存', 'ok');
  },

  async loadProjects() {
    set({ projects: await api.listProjects() });
  },

  async openProject(slug) {
    try {
      const bundle = await api.getBundle(slug);
      set({ slug, bundle, centerView: 'outline', chapter: null, suggestionsSeen: bundle.suggestions.length });
    } catch (err) {
      get().toast(`打开作品失败：${(err as Error).message}`, 'error');
    }
  },

  backHome() {
    const prev = get();
    if (prev.chapter && prev.saveState === 'dirty') {
      void prev.saveChapter();
    }
    set({ slug: null, bundle: null, chapter: null, centerView: 'outline' });
    void get().loadProjects();
  },

  async reloadBundle() {
    const { slug } = get();
    if (!slug) return;
    const bundle = await api.getBundle(slug);
    set({ bundle });
  },

  async openChapter(id) {
    // 冲刷上一章 900ms 防抖窗口内尚未落盘的输入，避免切章丢字。
    // （后台生成只写目标章，不影响这里）
    const prev = get();
    if (prev.chapter && prev.saveState === 'dirty') {
      await prev.saveChapter();
    }
    const { slug } = get();
    if (!slug) return;
    try {
      const ch = await api.getChapter(slug, id);
      // 段首缩进规整：老章节第一次打开时自动补 　　 并回存
      const normalized = ensureParagraphIndent(ch.content);
      set({ chapter: { id: ch.id, title: ch.title, status: ch.status, content: normalized }, saveState: 'idle', selection: null });
      get().setView('editor');
      if (normalized !== ch.content) void get().saveChapter();
    } catch (err) {
      get().toast(`打开章节失败：${(err as Error).message}`, 'error');
    }
  },

  setContent(text) {
    const ch = get().chapter;
    if (!ch) return;
    set({ chapter: { ...ch, content: text }, saveState: 'dirty' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveChapter(), 900);
  },

  setStreamContent(text) {
    const ch = get().chapter;
    if (!ch) return;
    set({ chapter: { ...ch, content: text } });
  },

  /**
   * 按 beat 生成一章正文。
   * 生成由服务端后台执行并直接落盘：页面切走、刷新甚至关闭都不影响。
   * 前端通过 progress SSE 订阅增量（页面在前台时可实时看到打字），轮询状态兜底；
   * 页面回到前台时立即同步一次状态。期间可以随意切章/切视图。
   */
  async startGeneration(mode) {
    const st = get();
    if (!st.slug || !st.chapter || st.generating || genInFlight) return;
    genInFlight = true;
    const targetId = st.chapter.id;

    try {
      await api.startBackgroundGeneration(st.slug, targetId, mode);
    } catch (err) {
      genInFlight = false;
      get().toast(`启动生成失败：${(err as Error).message}`, 'error');
      return;
    }
    genSlug = st.slug;
    set({ generating: true, generatingChapterId: targetId });

    // 清空目标章显示（从头生成时），从服务端增量流实时回显
    let acc = mode === 'continue' ? st.chapter.content : '';
    if (mode === 'full' && get().chapter?.id === targetId) get().setStreamContent('');

    closeGenStream = api.openGenerationStream(genSlug, targetId, (delta) => {
      acc += delta;
      const cur = get();
      if (cur.chapter?.id === targetId && cur.slug === genSlug) cur.setStreamContent(acc);
    });

    pollTimer = setInterval(() => void get().syncGenerationStatus(), 1500);
    void get().syncGenerationStatus();
  },

  /** 轮询/回前台时同步服务端生成状态；任务结束则收尾（重新拉取已落盘的章节内容） */
  async syncGenerationStatus() {
    const st = get();
    if (!st.generating || !genSlug || !st.generatingChapterId) return;
    let s: Awaited<ReturnType<typeof api.generationStatus>>;
    try {
      s = await api.generationStatus(genSlug, st.generatingChapterId);
    } catch { return; } // 网络抖动，下个轮询再试
    if (s.status === 'running') return;
    await get().finishGenerationWatch(s.status, s.error, s.wordCount);
  },

  async finishGenerationWatch(status, error, wordCount) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (closeGenStream) { closeGenStream(); closeGenStream = null; }
    const targetId = get().generatingChapterId;
    const slug = genSlug;
    set({ generating: false, generatingChapterId: null });
    genInFlight = false;
    if (!targetId || !slug) return;

    // 结果已在服务端落盘：重新拉取章节内容与字数
    try {
      const cur = get();
      const ch = await api.getChapter(slug, targetId);
      if (cur.slug === slug && cur.chapter?.id === targetId) {
        set({ chapter: { ...cur.chapter, content: ch.content, status: ch.status, title: ch.title }, saveState: 'saved' });
      }
      const fresh = get();
      if (fresh.slug === slug && fresh.bundle) {
        await fresh.reloadBundle();
      }
      const title = ch.title;
      if (status === 'done') get().toast(`《${title}》生成完毕（${(wordCount ?? 0).toLocaleString()} 字）`, 'ok');
      else if (status === 'cancelled') get().toast(`已停止，《${title}》保留了 ${(wordCount ?? 0).toLocaleString()} 字`, 'ok');
      else get().toast(`生成失败：${error ?? '未知错误'}${(wordCount ?? 0) > 0 ? '（已保留部分内容）' : ''}`, 'error');
    } catch (err) {
      get().toast(`生成已结束，但读取结果失败：${(err as Error).message}`, 'error');
    }
  },

  cancelGeneration() {
    const st = get();
    if (genSlug && st.generatingChapterId) {
      void api.cancelBackgroundGeneration(genSlug, st.generatingChapterId);
    }
  },

  setChapterTitle(title) {
    const ch = get().chapter;
    if (!ch) return;
    set({ chapter: { ...ch, title }, saveState: 'dirty' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveChapter(), 900);
  },

  setChapterStatus(status) {
    const ch = get().chapter;
    if (!ch) return;
    set({ chapter: { ...ch, status }, saveState: 'dirty' });
    void get().saveChapter();
  },

  async saveChapter() {
    const { slug, chapter } = get();
    if (!slug || !chapter) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ saveState: 'saving' });
    try {
      const { wordCount } = await api.saveChapter(slug, chapter.id, {
        content: chapter.content, status: chapter.status, title: chapter.title,
      });
      const bundle = get().bundle;
      if (bundle) {
        set({
          saveState: 'saved',
          bundle: {
            ...bundle,
            wordCounts: { ...bundle.wordCounts, [chapter.id]: wordCount },
          },
        });
      } else {
        set({ saveState: 'saved' });
      }
      // 同步大纲里的标题
      const b = get().bundle;
      if (b?.outline) {
        let changed = false;
        for (const vol of b.outline.volumes) {
          for (const c of vol.chapters) {
            if (c.id === chapter.id && c.title !== chapter.title) {
              c.title = chapter.title;
              changed = true;
            }
          }
        }
        if (changed) {
          set({ bundle: { ...b, outline: { ...b.outline } } });
          void api.saveOutline(slug, b.outline);
        }
      }
    } catch (err) {
      set({ saveState: 'dirty' });
      get().toast(`保存失败：${(err as Error).message}`, 'error');
    }
  },

  async applyReplacement(start, end, text) {
    const ch = get().chapter;
    if (!ch) return;
    // 片段落在自然段开头时，让替换文本也保持段首缩进
    const next = ch.content.slice(0, start)
      + (atParagraphStart(ch.content, start) ? ensureParagraphIndent(text) : text)
      + ch.content.slice(end);
    set({ chapter: { ...ch, content: next } });
    await get().saveChapter();
  },

  setSelection(selection) {
    set({ selection });
  },

  requestProposal(kind, instruction = '') {
    set({ pendingProposal: { kind, instruction, nonce: Date.now() } });
    set({ drawerOpen: true });
  },

  consumeProposal() {
    set({ pendingProposal: null });
  },

  updateOutlineLocal(outline) {
    const bundle = get().bundle;
    if (!bundle) return;
    set({ bundle: { ...bundle, outline } });
  },

  async persistOutline(outline) {
    const { slug } = get();
    if (!slug) return;
    get().updateOutlineLocal(outline);
    try {
      await api.saveOutline(slug, outline);
    } catch (err) {
      get().toast(`保存大纲失败：${(err as Error).message}`, 'error');
    }
  },

  async persistCharacters(chars) {
    const { slug, bundle } = get();
    if (!slug || !bundle) return;
    set({ bundle: { ...bundle, characters: chars } });
    await api.saveCharacters(slug, chars);
  },

  async persistWorldview(text) {
    const { slug, bundle } = get();
    if (!slug || !bundle) return;
    set({ bundle: { ...bundle, worldview: text } });
    await api.saveWorldview(slug, text);
  },

  async acceptSuggestion(id) {
    const { slug } = get();
    if (!slug) return;
    try {
      await api.acceptSuggestion(slug, id);
      await get().reloadBundle();
      get().toast('已加入人物卡', 'ok');
    } catch (err) {
      get().toast((err as Error).message, 'error');
    }
  },

  async dismissSuggestion(id) {
    const { slug, bundle } = get();
    if (!slug || !bundle) return;
    try {
      await api.dismissSuggestion(slug, id);
      set({
        bundle: { ...bundle, suggestions: bundle.suggestions.filter((s) => s.id !== id) },
        suggestionsSeen: bundle.suggestions.length - 1,
      });
    } catch (err) {
      get().toast((err as Error).message, 'error');
    }
  },

  markSuggestionsSeen() {
    const { bundle } = get();
    if (bundle) set({ suggestionsSeen: bundle.suggestions.length });
  },
}));
