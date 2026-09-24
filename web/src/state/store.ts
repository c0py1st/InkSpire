import { create } from 'zustand';
import type {
  AppConfig, Bundle, ChapterStatus, CharacterCard, Foreshadow, GenChapterResult, Outline, ProjectMeta, ProposalKind,
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

/** 应用内确认框请求：resolve 以 Promise 形式把用户选择交还给调用方 */
export interface ConfirmRequest {
  title: string;
  message: string;
  okLabel: string;
  resolve: (ok: boolean) => void;
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
  confirmReq: ConfirmRequest | null;

  // 数据
  config: AppConfig | null;
  projects: ProjectMeta[];
  slug: string | null;
  bundle: (Bundle & { wordCounts: Record<string, number> }) | null;

  // 编辑器
  chapter: ChapterDraft | null;
  saveState: SaveState;
  generating: boolean;
  finalizing: boolean;                  // 「完成本章」归档进行中（与后台生成监视器独立，不共用 generating）
  generatingChapterId: string | null;   // 正在生成的目标章（连写时是当前队列章）
  genQueue: { index: number; total: number } | null; // 连写进度（单章生成时为 null）
  selection: Selection | null;
  pendingProposal: { kind: ProposalKind; instruction: string; nonce: number } | null;
  pendingJump: { chapterId: string; offset: number; query: string; nonce: number } | null; // 检索跳转：目标章载入后定位并选中
  suggestionsSeen: number;

  // actions
  init: () => Promise<void>;
  setTheme: (pref: ThemePref) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  /** 应用内确认框（替代原生 window.confirm，内嵌 WebView 中原生框不可见会挂死页面）；确认 true / 取消或关闭 false */
  confirmAsk: (message: string, opts?: { title?: string; okLabel?: string }) => Promise<boolean>;
  answerConfirm: (ok: boolean) => void;
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
  startMarathon: () => Promise<void>;
  cancelGeneration: () => void;
  syncGenerationStatus: () => Promise<void>;
  finishGenerationWatch: (status: string, error?: string, wordCount?: number, truncated?: boolean, results?: GenChapterResult[]) => Promise<void>;

  setSelection: (sel: Selection | null) => void;
  requestProposal: (kind: ProposalKind, instruction?: string) => void;
  consumeProposal: () => void;
  jumpTo: (chapterId: string, offset: number, query: string) => Promise<void>;

  updateOutlineLocal: (outline: Outline) => void;
  persistOutline: (outline: Outline) => Promise<void>;
  persistCharacters: (chars: CharacterCard[]) => Promise<void>;
  persistWorldview: (text: string) => Promise<void>;
  persistForeshadows: (items: Foreshadow[]) => Promise<void>;
  updateForeshadowsLocal: (items: Foreshadow[]) => void;

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
let envListenersBound = false;           // StrictMode 下 init() 跑两遍，守卫避免重复注册全局监听
// 连写回显：按"当前流式章"累积增量；章切换时归零重攒，仅回显打开着的那章
let genAcc: { chapterId: string; text: string } | null = null;

/** 挂载对服务端后台队列的监视：SSE 增量回显 + 状态轮询收尾（单章与连写共用） */
function beginGenerationWatch(slug: string, originId: string, queue: { index: number; total: number } | null) {
  genSlug = slug;
  genAcc = null;
  useStore.setState({ generating: true, generatingChapterId: originId, genQueue: queue });

  closeGenStream = api.openGenerationStream(slug, originId, (text, deltaChapterId) => {
    const cur = useStore.getState();
    const cid = deltaChapterId ?? originId;
    if (cur.generatingChapterId !== cid) {
      // 队列推进到下一章：切换目标章，从头回显
      useStore.setState({ generatingChapterId: cid });
      if (cur.chapter?.id === cid) cur.setStreamContent('');
    }
    if (!genAcc || genAcc.chapterId !== cid) genAcc = { chapterId: cid, text: '' };
    genAcc.text += text;
    const now = useStore.getState();
    if (now.chapter?.id === cid && now.slug === genSlug) now.setStreamContent(genAcc.text);
  });

  pollTimer = setInterval(() => void useStore.getState().syncGenerationStatus(), 1500);
  void useStore.getState().syncGenerationStatus();
}

export const useStore = create<Store>((set, get) => ({
  theme: initialThemePref(),
  centerView: 'outline',
  drawerOpen: true,
  focusMode: false,
  settingsOpen: false,
  wizardOpen: false,
  toasts: [],
  confirmReq: null,

  config: null,
  projects: [],
  slug: null,
  bundle: null,

  chapter: null,
  saveState: 'idle',
  generating: false,
  finalizing: false,
  generatingChapterId: null,
  genQueue: null,
  selection: null,
  pendingProposal: null,
  pendingJump: null,
  suggestionsSeen: 0,

  async init() {
    applyTheme(get().theme);
    if (!envListenersBound) {
      envListenersBound = true;
      // 跟随系统模式下，系统切换深浅色时实时跟随
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (get().theme === 'system') applyTheme('system');
      });
      // 页面从后台回到前台时立即同步一次生成状态（服务端可能已完成落盘）
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void get().syncGenerationStatus();
      });
    }
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

  confirmAsk(message, opts) {
    // 理论上不会并发弹确认框；若有旧的挂起请求，先按「取消」了结，避免 Promise 悬挂
    const prev = get().confirmReq;
    if (prev) {
      prev.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      set({ confirmReq: { title: opts?.title ?? '请确认', message, okLabel: opts?.okLabel ?? '确定', resolve } });
    });
  },

  answerConfirm(ok) {
    const req = get().confirmReq;
    if (!req) return;
    set({ confirmReq: null });
    req.resolve(ok);
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

    // 冲刷防抖窗口内的未保存输入：服务端从磁盘读正文，不先落盘会丢最后几笔
    if (get().saveState === 'dirty') {
      await get().saveChapter();
    }

    try {
      await api.startBackgroundGeneration(st.slug, targetId, mode);
    } catch (err) {
      genInFlight = false;
      get().toast(`启动生成失败：${(err as Error).message}`, 'error');
      return;
    }
    beginGenerationWatch(st.slug, targetId, null);
    // 清空目标章显示（从头生成时），从服务端增量流实时回显
    if (mode === 'full' && get().chapter?.id === targetId) get().setStreamContent('');
  },

  /** 挂机连写：从当前打开章起按大纲顺序连写 N 章（有正文的章服务端自动跳过） */
  async startMarathon() {
    const st = get();
    if (!st.slug || !st.chapter || st.generating || genInFlight) return;
    const input = window.prompt('从本章起按大纲顺序连写几章？（已有正文的章会自动跳过）', '5');
    if (input === null) return;
    const count = Math.max(1, Math.min(50, Number(input) || 5));
    genInFlight = true;
    const originId = st.chapter.id;

    if (get().saveState === 'dirty') {
      await get().saveChapter();
    }

    try {
      const r = await api.startMarathon(st.slug, originId, count);
      if (r.planned === 0) {
        genInFlight = false;
        get().toast(`范围内 ${r.skipped} 章都已有正文，没有可写的空白章`, 'info');
        return;
      }
      beginGenerationWatch(st.slug, originId, { index: 0, total: r.planned });
    } catch (err) {
      genInFlight = false;
      get().toast(`启动连写失败：${(err as Error).message}`, 'error');
    }
  },

  /** 轮询/回前台时同步服务端生成状态；任务结束则收尾（重新拉取已落盘的章节内容） */
  async syncGenerationStatus() {
    const st = get();
    if (!st.generating || !genSlug || !st.generatingChapterId) return;
    let s: Awaited<ReturnType<typeof api.generationStatus>>;
    try {
      s = await api.generationStatus(genSlug, st.generatingChapterId);
    } catch { return; } // 网络抖动，下个轮询再试
    if (s.status === 'running') {
      // 每次轮询刷新队列进度（连写时 index 随章推进；单章 total=1 无需显示）
      if (s.queue && s.queue.total > 1) {
        set({ genQueue: { index: s.queue.index, total: s.queue.total } });
      }
      return;
    }
    await get().finishGenerationWatch(s.status, s.error, s.wordCount, s.truncated, s.queue?.results);
  },

  async finishGenerationWatch(status, error, wordCount, truncated, results) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (closeGenStream) { closeGenStream(); closeGenStream = null; }
    genAcc = null;
    const wasMarathon = get().genQueue !== null;
    set({ generating: false, generatingChapterId: null, genQueue: null });
    genInFlight = false;
    const slug = genSlug;
    const targetId = get().chapter?.id ?? null;
    if (!slug) return;

    // 结果已在服务端落盘：重新拉取当前章内容与全量 bundle（字数/摘要/建议都已更新）
    try {
      if (targetId) {
        const ch = await api.getChapter(slug, targetId);
        const now = get();
        if (now.slug === slug && now.chapter?.id === targetId) {
          set({ chapter: { ...now.chapter, content: ch.content, status: ch.status, title: ch.title }, saveState: 'saved' });
        }
      }
      const fresh = get();
      if (fresh.slug === slug && fresh.bundle) {
        await fresh.reloadBundle();
      }
      if (wasMarathon && results) {
        const doneN = results.filter((r) => r.status === 'done').length;
        const skipN = results.filter((r) => r.status === 'skipped').length;
        const truncN = results.filter((r) => r.truncated).length;
        const totalWords = results.reduce((a, r) => a + (r.wordCount ?? 0), 0);
        const bits = [`连写结束：写了 ${doneN} 章${skipN ? `、跳过有正文的 ${skipN} 章` : ''}，共 ${totalWords.toLocaleString()} 字`];
        if (truncN) bits.push(`${truncN} 章结尾可能不完整，可打开该章点「续写」补完`);
        bits.push('摘要已进记忆、设定建议攒在批注抽屉');
        if (status === 'cancelled') bits.unshift('已停止——');
        else if (status === 'error') bits.unshift(`中途失败（${error ?? '未知错误'}）：`);
        get().toast(bits.join('；'), status === 'error' ? 'error' : 'ok');
        return;
      }
      if (!targetId) return;
      const title = get().bundle?.outline?.volumes.flatMap((v) => v.chapters).find((c) => c.id === targetId)?.title ?? '本章';
      if (status === 'done') {
        get().toast(
          truncated
            ? `《${title}》已生成 ${(wordCount ?? 0).toLocaleString()} 字，达到输出上限被截断——点「续写」可补完`
            : `《${title}》生成完毕（${(wordCount ?? 0).toLocaleString()} 字）`,
          truncated ? 'info' : 'ok',
        );
      }
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
          // 走 persistOutline：内部 catch + toast；裸 api 调用失败会产生无人处理的 rejection
          void get().persistOutline(b.outline);
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
    set({ chapter: { ...ch, content: next }, selection: null }); // 选区已被替换，清除工具条
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

  async jumpTo(chapterId, offset, query) {
    set({ pendingJump: { chapterId, offset, query, nonce: Date.now() } });
    await get().openChapter(chapterId); // 内含脏稿冲刷与视图切换；pendingJump 留给 EditorView 消费
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

  async persistForeshadows(items) {
    const { slug, bundle } = get();
    if (!slug || !bundle) return;
    set({ bundle: { ...bundle, foreshadows: items } });
    try {
      await api.saveForeshadows(slug, items);
    } catch (err) {
      get().toast(`保存伏笔表失败：${(err as Error).message}`, 'error');
    }
  },

  /** 只改内存（打字过程中用），失焦时再 persistForeshadows 落盘 */
  updateForeshadowsLocal(items) {
    const bundle = get().bundle;
    if (!bundle) return;
    set({ bundle: { ...bundle, foreshadows: items } });
  },

  async acceptSuggestion(id) {
    const { slug, bundle } = get();
    if (!slug) return;
    const kind = bundle?.suggestions.find((s) => s.id === id)?.kind;
    try {
      await api.acceptSuggestion(slug, id);
      await get().reloadBundle();
      get().toast(kind === 'state' ? '人物卡状态已更新' : '已加入人物卡', 'ok');
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
