import { useEffect, useRef, useState } from 'react';
import type { ProposalKind } from '../../../shared/src/types';
import { PROPOSAL_LABELS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';

const QUICK_ACTIONS: Array<{ kind: ProposalKind; label: string }> = [
  { kind: 'polish', label: '润色' },
  { kind: 'expand', label: '扩写' },
  { kind: 'condense', label: '缩写' },
  { kind: 'rewrite', label: '换个写法' },
];

export function EditorView() {
  const {
    slug, bundle, chapter, setChapterTitle, setChapterStatus, setContent, setStreamContent,
    finishGeneration, generating, saveState, selection, setSelection,
    requestProposal, toast, saveChapter,
  } = useStore();

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'full' | 'continue'>('full');

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

  async function generate(m: 'full' | 'continue') {
    if (!slug || generating) return;
    setMode(m);
    useStore.setState({ generating: true });
    let acc = m === 'continue' ? chapter!.content : '';
    if (m === 'full') setStreamContent('');
    try {
      await api.generateChapter(slug, chapter!.id, m, (delta) => {
        acc += delta;
        setStreamContent(acc);
        // 让光标跟随：滚动到底
        const ta = taRef.current;
        if (ta) ta.scrollTop = ta.scrollHeight;
      });
      await finishGeneration();
      toast('本章生成完毕。点「完成本章」可以让 agent 记忆本章并更新设定建议。', 'ok');
    } catch (err) {
      useStore.setState({ generating: false });
      // 保存已生成的部分
      await saveChapter();
      toast(`生成中断：${(err as Error).message}`, 'error');
    }
  }

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
      const center = useStore.getState().centerView;
      void center;
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
        <span className="save-state">{chapter.content.replace(/\s/g, '').length.toLocaleString()} 字</span>
        <span className={`save-state${saveState === 'dirty' ? ' dirty' : ''}`}>
          {saveState === 'saving' ? '保存中' : saveState === 'dirty' ? '待保存' : '已保存'}
        </span>
        <div style={{ flex: 1 }} />
        {!generating && (
          <>
            {chapter.content.trim()
              ? <Btn small onClick={() => void generate('continue')}>续写</Btn>
              : null}
            <Btn small onClick={() => void generate('full')} title="按大纲 beat 从头生成本章（会覆盖现有内容，旧稿自动备份）">
              {chapter.content.trim() ? '重新生成本章' : '生成本章'}
            </Btn>
            <Btn small primary onClick={() => void finalize()} disabled={!chapter.content.trim()} title="写入本章记忆摘要并扫描新设定">
              完成本章
            </Btn>
            <ExportMenu slug={slug} />
          </>
        )}
        {generating && <span className="save-state dirty">生成中…</span>}
      </div>

      <div className="center-scroll" style={{ position: 'relative' }}>
        <div className="manuscript-wrap">
          <textarea
            ref={taRef}
            className="manuscript"
            value={chapter.content}
            placeholder={beat ? `本章大纲：\n${beat}\n\n直接开写，或点上方「生成本章」让 agent 按大纲执笔。` : '（本章还没有 beat，先去大纲页填写，或直接开写）'}
            onChange={(e) => setContent(e.target.value)}
            onSelect={captureSelection}
            onKeyUp={captureSelection}
            onMouseUp={captureSelection}
            disabled={generating}
          />
          {generating && <span className="caret-blink">▍</span>}
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
    </>
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
