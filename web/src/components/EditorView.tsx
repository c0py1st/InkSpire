import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChapterStatus, ProposalKind } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn } from './primitives';

const QUICK_ACTIONS: Array<{ kind: ProposalKind; label: string }> = [
  { kind: 'polish', label: '润色' },
  { kind: 'expand', label: '扩写' },
  { kind: 'condense', label: '缩写' },
  { kind: 'rewrite', label: '换个写法' },
];

export function EditorView() {
  const {
    slug, bundle, chapter, setChapterTitle, setChapterStatus, setContent,
    generating, generatingChapterId, startGeneration, cancelGeneration,
    saveState, selection, setSelection, requestProposal, toast, saveChapter,
  } = useStore();

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const genHere = generating && generatingChapterId === chapter?.id;
  const genTitle = (() => {
    if (!generating || !bundle?.outline) return '';
    for (const vol of bundle.outline.volumes) {
      const hit = vol.chapters.find((c) => c.id === generatingChapterId);
      if (hit) return hit.title;
    }
    return '当前章节';
  })();

  useEffect(() => {
    // 切章时清掉选区
    setSelection(null);
  }, [chapter?.id]);

  if (!chapter) {
    return (
      <div className="center-scroll">
        <div className="pane-pad" style={{ textAlign: 'center', marginTop: 120, color: 'var(--text-dim)' }}>
          从左侧选择一章开始写作。空章可以先点「生成本章」，或直接手写。
        </div>
      </div>
    );
  }

  const beat = (() => {
    if (!bundle?.outline) return '';
    for (const vol of bundle.outline.volumes) {
      const found = vol.chapters.find((c) => c.id === chapter.id);
      if (found) return found.beat;
    }
    return '';
  })();

  const curChars = chapter.content.replace(/\s/g, '').length;
  const target = bundle?.meta.wordsPerChapter ?? 0;
  const pct = target > 0 ? Math.min(100, Math.round((curChars / target) * 100)) : 0;

  async function finalize() {
    if (!slug || !chapter?.content.trim()) return;
    useStore.setState({ generating: true });
    try {
      await saveChapter();
      const res = await api.finalizeChapter(slug, chapter.id, chapter.content);
      if (res?.newSuggestions?.length) {
        toast(`agent 新增 ${res.newSuggestions.length} 条设定建议，去批注抽屉查看`, 'ok');
      } else {
        toast('本章已归档：摘要已写入记忆', 'ok');
      }
    } catch (err) {
      toast(`归档失败：${(err as Error).message}`, 'error');
    } finally {
      useStore.setState({ generating: false });
    }
  }

  function captureSelection() {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart < selectionEnd) {
      const rect = ta.getBoundingClientRect();
      setSelection({
        start: selectionStart,
        end: selectionEnd,
        text: chapter!.content.slice(selectionStart, selectionEnd),
        x: rect.left + rect.width / 2,
        y: rect.top + 70,
      });
    } else {
      setSelection(null);
    }
  }

  /** 回车换段：非空行后回车自动带 　　 缩进；空行回车仅换行（用于段落间空行） */
  function handleEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const text = chapter!.content;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    const curLineEmpty = text.slice(lineStart, s).trim() === '';
    const insert = curLineEmpty ? '\n' : '\n\u3000\u3000';
    setContent(text.slice(0, s) + insert + text.slice(en));
    const caret = s + insert.length;
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.setSelectionRange(caret, caret);
    });
  }

  const sel = selection;

  return (
    <>
      <div className="editor-head">
        <input
          type="text" className="ch-input" value={chapter.title}
          onChange={(e) => setChapterTitle(e.target.value)}
        />
        <select value={chapter.status} onChange={(e) => setChapterStatus(e.target.value as never)}>
          <option value="todo">未写</option>
          <option value="draft">草稿</option>
          <option value="revised">定稿</option>
        </select>
        <span className="save-state">{curChars.toLocaleString()}{target ? ` / ${target.toLocaleString()}` : ''} 字</span>
        {target > 0 && (
          <span className={`wc-bar${pct >= 100 ? ' done' : ''}`} title={`本章目标 ${target.toLocaleString()} 字，已完成 ${pct}%`}>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className={`save-state${saveState === 'dirty' ? ' dirty' : ''}`}>
          {saveState === 'saving' ? '保存中' : saveState === 'dirty' ? '待保存' : '已保存'}
        </span>
        <div style={{ flex: 1 }} />
        {generating && (
          <span className="save-state dirty">
            {genHere ? '生成中…' : `后台生成《${genTitle}》…`}
          </span>
        )}
        {generating ? (
          <Btn small danger onClick={cancelGeneration} title="停止生成，已生成的部分会保留并保存">停止生成</Btn>
        ) : (
          <>
            {chapter.content.trim() ? <Btn small onClick={() => void startGeneration('continue')}>续写</Btn> : null}
            <Btn small onClick={() => void startGeneration('full')} title="按大纲 beat 从头生成本章（会覆盖现有内容，旧稿自动备份）">
              {chapter.content.trim() ? '重新生成本章' : '生成本章'}
            </Btn>
            <Btn small primary onClick={() => void finalize()} disabled={!chapter.content.trim()} title="写入本章记忆摘要并扫描新设定">
              完成本章
            </Btn>
            <Btn small onClick={() => setHistoryOpen(true)} disabled={!chapter.content.trim()} title="查看自动备份的历史版本并恢复">历史</Btn>
            <ExportMenu slug={slug} />
          </>
        )}
      </div>

      <div className="center-scroll" style={{ position: 'relative' }}>
        <div className="manuscript-wrap">
          <textarea
            ref={taRef}
            className="manuscript"
            value={chapter.content}
            placeholder={beat ? `本章大纲：\n${beat}\n\n直接开写，或点上方「生成本章」让 agent 按大纲执笔。` : '（本章还没有 beat，先去大纲页填写，或直接开写）'}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleEnter}
            onSelect={captureSelection}
            onKeyUp={captureSelection}
            onMouseUp={captureSelection}
            disabled={genHere}
          />
          {genHere && <span className="caret-blink">▍</span>}
        </div>

        {sel && !generating && (
          <div className="sel-toolbar" style={{ left: Math.max(120, sel.x - 140), top: 8 }}>
            {QUICK_ACTIONS.map((a) => (
              <button key={a.kind} onClick={() => requestProposal(a.kind)}>{a.label}</button>
            ))}
            <button onClick={() => {
              const instr = window.prompt('对选中片段的要求：');
              if (instr) requestProposal('custom', instr);
            }}>自定义…</button>
            <button onClick={() => setSelection(null)}>×</button>
          </div>
        )}
      </div>

      {historyOpen && slug && (
        <HistoryModal
          slug={slug}
          chapterId={chapter.id}
          chapterTitle={chapter.title}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}

/** 历史版本：查看自动备份并一键恢复（恢复前会先把当前内容强制备份一份） */
function HistoryModal(props: { slug: string; chapterId: string; chapterTitle: string; onClose: () => void }) {
  const { slug, chapterId, chapterTitle, onClose } = props;
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Array<{ stamp: string; epoch: number; chars: number; title: string }> | null>(null);
  const [preview, setPreview] = useState<{ stamp: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setList(await api.listBackups(slug, chapterId));
      } catch (err) {
        toast(`读取历史版本失败：${(err as Error).message}`, 'error');
        setList([]);
      }
    })();
  }, [slug, chapterId]);

  async function previewStamp(stamp: string) {
    if (preview?.stamp === stamp) { setPreview(null); return; }
    try {
      const doc = await api.getBackup(slug, chapterId, stamp);
      setPreview({ stamp, text: doc.content });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function restore(stamp: string) {
    if (!window.confirm('恢复该版本？当前正文会先自动备份一份，可随时再恢复回来。')) return;
    setBusy(true);
    try {
      const doc = await api.getBackup(slug, chapterId, stamp);
      await api.saveChapter(slug, chapterId, { content: doc.content, status: doc.status, title: doc.title, backup: true });
      const st = useStore.getState();
      await st.reloadBundle();
      if (st.chapter?.id === chapterId) {
        useStore.setState({
          chapter: { ...useStore.getState().chapter!, content: doc.content, status: doc.status as ChapterStatus, title: doc.title },
          saveState: 'saved',
        });
      }
      toast('已恢复该版本', 'ok');
      onClose();
    } catch (err) {
      toast(`恢复失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <BuDialog open onClose={onClose} closeOnOutsidePress ariaTitle={`历史版本 · ${chapterTitle}`}>
        <div className="m-head">
          历史版本 · 《{chapterTitle}》
          <div style={{ flex: 1 }} />
          <Btn ghost small onClick={onClose}>关闭</Btn>
        </div>
        <div className="m-body">
          {list === null && <div className="progress-line" />}
          {list?.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12.8 }}>
              还没有历史版本。当你「重新生成本章」覆盖旧稿、或做大幅删改时，应用会自动在这里留下备份。
            </div>
          )}
          {list && list.length > 0 && (
            <div className="hist-list">
              {list.map((b) => (
                <div key={b.stamp} className="hist-row">
                  <span style={{ fontWeight: 600 }}>{new Date(b.epoch).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span style={{ color: 'var(--text-faint)' }}>{b.chars.toLocaleString()} 字</span>
                  <div style={{ flex: 1 }} />
                  <Btn small onClick={() => void previewStamp(b.stamp)}>{preview?.stamp === b.stamp ? '收起预览' : '预览'}</Btn>
                  <Btn small primary disabled={busy} onClick={() => void restore(b.stamp)}>恢复此版本</Btn>
                </div>
              ))}
            </div>
          )}
          {preview && (
            <div className="hist-preview">{preview.text}</div>
          )}
        </div>
        <div className="m-foot">
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>恢复前会自动备份当前内容；每章最多保留 20 份备份。</span>
          <div className="spacer" />
        </div>
    </BuDialog>
  );
}

/** 整本导出：从后端拿合并后的 md/txt 下载 */
function ExportMenu({ slug }: { slug: string | null }) {
  const [open, setOpen] = useState(false);
  if (!slug) return null;
  const download = (format: 'md' | 'txt') => {
    const a = document.createElement('a');
    a.href = api.exportUrl(slug, format);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <Btn small onClick={() => setOpen((o) => !o)} title="导出整本书稿">导出</Btn>
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 40,
            background: 'var(--panel)', border: '1px solid var(--line-strong)', borderRadius: 'var(--rad)',
            boxShadow: '0 2px 6px rgba(0,0,0,.25)', padding: 4, minWidth: 96,
          }}
        >
          <button className="icon-btn" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px' }} onClick={() => download('md')}>Markdown</button>
          <button className="icon-btn" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px' }} onClick={() => download('txt')}>纯文本 TXT</button>
        </div>
      )}
    </div>
  );
}
