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
let genCtl: AbortController | null = null;

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
   * 生成在"后台"进行：期间可以随意切章/切视图；delta 只写入目标章（若它正被打开则实时可见），
   * 结束（完成或用户停止）后无论打开的是哪章，都会把已生成内容保存回目标章。
   */
  async startGeneration(mode) {
    const st = get();
    if (!st.slug || !st.chapter || st.generating) return;
    const slug = st.slug;
    const targetId = st.chapter.id;
    const targetTitle = st.chapter.title;
    // 目标章之前的状态：未写→草稿，草稿/定稿→保持
    const prevStatus: ChapterStatus = (() => {
      for (const vol of st.bundle?.outline?.volumes ?? []) {
        const hit = vol.chapters.find((c) => c.id === targetId);
        if (hit) return hit.status;
      }
      return 'draft';
    })();
    const status: ChapterStatus = prevStatus === 'todo' ? 'draft' : prevStatus;

    const ctl = new AbortController();
    genCtl = ctl;
    set({ generating: true, generatingChapterId: targetId });

    let acc = mode === 'continue' ? st.chapter.content : '';
    if (mode === 'full' && get().chapter?.id === targetId) get().setStreamContent('');

    let aborted = false;
    try {
      await api.generateChapter(slug, targetId, mode, (delta) => {
        acc += delta;
        const cur = get();
        if (cur.chapter?.id === targetId) cur.setStreamContent(acc);
      }, ctl.signal);
    } catch (err) {
      aborted = ctl.signal.aborted;
      if (!aborted) {
        set({ generating: false, generatingChapterId: null });
        genCtl = null;
        get().toast(`生成失败：${(err as Error).message}`, 'error');
        return;
      }
    }
    genCtl = null;

    // 无论当前打开的是哪一章，都把结果保存回目标章（生成结果统一做段首缩进规整）
    acc = ensureParagraphIndent(acc);
    try {
      const title = (() => {
        for (const vol of get().bundle?.outline?.volumes ?? []) {
          const hit = vol.chapters.find((c) => c.id === targetId);
          if (hit) return hit.title;
        }
        return targetTitle;
      })();
      const { wordCount } = await api.saveChapter(slug, targetId, { content: acc, status, title });
      const cur = get();
      if (cur.bundle) {
        set({ bundle: { ...cur.bundle, wordCounts: { ...cur.bundle.wordCounts, [targetId]: wordCount } } });
      }
      if (cur.chapter?.id === targetId) {
        set({ chapter: { ...cur.chapter, content: acc, status }, saveState: 'saved' });
      }
      get().toast(
        aborted ? `已停止，《${title}》保留了 ${wordCount.toLocaleString()} 字` : `《${title}》生成完毕（${wordCount.toLocaleString()} 字）`,
        'ok',
      );
    } catch (err) {
      get().toast(`保存生成结果失败：${(err as Error).message}`, 'error');
    }
    set({ generating: false, generatingChapterId: null });
  },

  cancelGeneration() {
    genCtl?.abort();
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
