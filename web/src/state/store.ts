import { create } from 'zustand';
import type {
  AppConfig, Bundle, ChapterStatus, CharacterCard, Outline, ProjectMeta, ProposalKind,
} from '../../../shared/src/types';
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
  finishGeneration: () => Promise<void>;
  setChapterTitle: (title: string) => void;
  setChapterStatus: (status: ChapterStatus) => void;
  saveChapter: () => Promise<void>;
  applyReplacement: (start: number, end: number, text: string) => Promise<void>;

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
    const { slug } = get();
    if (!slug) return;
    try {
      const ch = await api.getChapter(slug, id);
      set({ chapter: { id: ch.id, title: ch.title, status: ch.status, content: ch.content }, saveState: 'idle', selection: null });
      get().setView('editor');
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

  async finishGeneration() {
    const { slug, chapter } = get();
    if (!slug || !chapter) return;
    const status: ChapterStatus = chapter.status === 'todo' ? 'draft' : chapter.status;
    set({ chapter: { ...chapter, status }, generating: false });
    await get().saveChapter();
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
    const next = ch.content.slice(0, start) + text + ch.content.slice(end);
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
