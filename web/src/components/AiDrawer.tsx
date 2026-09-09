import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConsistencyIssue, ProposalKind } from '../../../shared/src/types';
import { PROPOSAL_LABELS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn } from './primitives';
import { DiffView } from './DiffView';

interface Proposal {
  id: number;
  kind: ProposalKind;
  instruction: string;
  original: string;
  range: { start: number; end: number };
  text: string;
  streaming: boolean;
  error?: string;
}

type Issue = ConsistencyIssue;

let propSeq = 1;

export function AiDrawer() {
  const drawerOpen = useStore((s) => s.drawerOpen);
  const slug = useStore((s) => s.slug);
  const bundle = useStore((s) => s.bundle);
  const chapter = useStore((s) => s.chapter);
  const selection = useStore((s) => s.selection);
  const pendingProposal = useStore((s) => s.pendingProposal);
  const suggestionsSeen = useStore((s) => s.suggestionsSeen);
  const {
    consumeProposal, applyReplacement, acceptSuggestion, dismissSuggestion, markSuggestionsSeen, toast,
  } = useStore(useShallow((s) => ({
    consumeProposal: s.consumeProposal, applyReplacement: s.applyReplacement, acceptSuggestion: s.acceptSuggestion,
    dismissSuggestion: s.dismissSuggestion, markSuggestionsSeen: s.markSuggestionsSeen, toast: s.toast,
  })));

  const [tab, setTab] = useState<'chat' | 'props' | 'assist'>('chat');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [issues, setIssues] = useState<'idle' | 'loading' | Issue[] | null>('idle');

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 切换作品时清空会话
    setMessages([]);
    setProposals([]);
    setIssues('idle');
  }, [slug]);

  const scrollBottom = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  /* ---------- 提案：响应编辑器里的选区快捷操作 ---------- */
  useEffect(() => {
    if (!pendingProposal || !slug || !chapter) return;
    const sel = useStore.getState().selection;
    consumeProposal();
    if (!sel || !sel.text.trim()) {
      toast('请先在正文中选中一段文字', 'error');
      return;
    }
    setTab('props');
    runProposal(sel.start, sel.end, sel.text, pendingProposal.kind, pendingProposal.instruction);
  }, [pendingProposal?.nonce]);

  async function runProposal(start: number, end: number, original: string, kind: ProposalKind, instruction: string) {
    if (!slug || !chapter) return;
    const id = propSeq++;
    const proposal: Proposal = { id, kind, instruction, original, range: { start, end }, text: '', streaming: true };
    setProposals((ps) => [proposal, ...ps]);
    try {
      await api.propose(slug, {
        chapterId: chapter.id, start, end, original, instruction, kind,
      }, (delta) => {
        setProposals((ps) => ps.map((p) => (p.id === id ? { ...p, text: p.text + delta } : p)));
      });
      setProposals((ps) => ps.map((p) => (p.id === id ? { ...p, streaming: false } : p)));
    } catch (err) {
      setProposals((ps) => ps.map((p) => (p.id === id ? { ...p, streaming: false, error: (err as Error).message } : p)));
    }
  }

  async function acceptProposal(p: Proposal) {
    // 以当前实际内容校准范围：若选区文本已变，提示重新选
    const ch = useStore.getState().chapter;
    if (!ch) return;
    const current = ch.content.slice(p.range.start, p.range.end);
    if (current !== p.original) {
      toast('正文在此期间已被修改，提案已失效，请重新选中文本再试', 'error');
      setProposals((ps) => ps.filter((x) => x.id !== p.id));
      return;
    }
    await applyReplacement(p.range.start, p.range.end, p.text);
    setProposals((ps) => ps.filter((x) => x.id !== p.id));
    toast('已采纳并保存', 'ok');
  }

  /* ---------- 对话 ---------- */
  async function send() {
    if (!slug || chatBusy || !input.trim()) return;
    const question = input.trim();
    setInput('');
    const history = [...messages, { role: 'user' as const, content: question }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setChatBusy(true);
    setTab('chat');
    try {
      await api.chat(slug, {
        messages: history,
        chapterId: chapter?.id,
        selection: selection?.text,
      }, (delta) => {
        setMessages((ms) => {
          const next = [...ms];
          next[next.length - 1] = { role: 'assistant', content: next[next.length - 1].content + delta };
          return next;
        });
        scrollBottom();
      });
    } catch (err) {
      toast((err as Error).message, 'error');
      setMessages((ms) => ms.slice(0, -1));
    } finally {
      setChatBusy(false);
    }
  }

  /* ---------- 一致性检查 ---------- */
  async function checkConsistency() {
    if (!slug || !chapter) return;
    setTab('assist');
    setIssues('loading');
    try {
      const res = await api.consistency(slug, chapter.id);
      setIssues(res.issues);
    } catch (err) {
      setIssues('idle');
      toast((err as Error).message, 'error');
    }
  }

  if (!drawerOpen) return null;

  const sugg = bundle?.suggestions ?? [];
  const suggBadge = sugg.length - suggestionsSeen;

  return (
    <aside className="ai-drawer">
      <div className="drawer-head">
        批注
        <span className="sub">{chapter ? `《${chapter.title}》` : '全书上下文'}</span>
        <div style={{ flex: 1 }} />
        <Btn small ghost onClick={checkConsistency} disabled={!chapter} title="检查本章与设定/前情的矛盾">一致性检查</Btn>
      </div>
      <div className="drawer-tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>对话</button>
        <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>
          提案{proposals.length ? ` (${proposals.length})` : ''}
        </button>
        <button className={tab === 'assist' ? 'active' : ''} onClick={() => { setTab('assist'); markSuggestionsSeen(); }}>
          建议{suggBadge > 0 ? <span className="badge">{suggBadge}</span> : null}
        </button>
      </div>

      <div className="drawer-body" ref={bodyRef}>
        {tab === 'chat' && (
          <>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: 12.5, lineHeight: 1.8 }}>
                随便问：剧情逻辑、人物动机、大纲调整建议……<br />
                若当前打开着某一章，agent 会带着本章全文与设定来回答。<br />
                想改文字：先在正文里选中一段，用选区工具条发起提案。
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="who">{m.role === 'user' ? '你' : '编辑'}</div>
                {m.content || (chatBusy && i === messages.length - 1 ? '…' : '')}
              </div>
            ))}
          </>
        )}

        {tab === 'props' && (
          <>
            {proposals.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: 12.5, lineHeight: 1.8 }}>
                在正文中选中一段文字，选择「润色 / 扩写 / 缩写 / 换个写法 / 自定义」。<br />
                agent 给出方案后，这里会显示校对式对比，确认后才会写入正文。
              </div>
            )}
            {proposals.map((p) => (
              <div key={p.id} className="proposal">
                <div className="p-head">
                  <span className="kind">{PROPOSAL_LABELS[p.kind]}</span>
                  <span className="p-instr">{p.instruction ? `“${p.instruction}”` : ''}</span>
                  <div style={{ flex: 1 }} />
                  {p.streaming && <span style={{ color: 'var(--warn)', fontSize: 11 }}>生成中…</span>}
                </div>
                <div className="p-body">
                  {p.error
                    ? <span style={{ color: 'var(--danger)' }}>{p.error}</span>
                    // 流式期间只显示纯文本：逐字重跑字符级 diff 是 O(n²)
                    : p.streaming
                      ? <div className="diff">{p.text || '…'}</div>
                      : <DiffView original={p.original} next={p.text} />}
                </div>
                {!p.streaming && !p.error && (
                  <div className="p-actions">
                    <Btn small primary onClick={() => void acceptProposal(p)}>采纳</Btn>
                    <Btn small onClick={() => void runProposal(p.range.start, p.range.end, p.original, p.kind, p.instruction)}>再来一版</Btn>
                    <div style={{ flex: 1 }} />
                    <Btn small ghost onClick={() => setProposals((ps) => ps.filter((x) => x.id !== p.id))}>放弃</Btn>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'assist' && (
          <>
            {sugg.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
                还没有设定建议。点「完成本章」归档后，agent 会把新出现的人物/设定汇总到这里。
              </div>
            )}
            {sugg.map((s) => (
              <div key={s.id} className="suggestion">
                <span className="s-name">{s.name}</span>
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · {s.kind === 'character' ? '人物' : '世界观'}</span>
                <div style={{ marginTop: 4 }}>{s.content}</div>
                <div className="s-actions">
                  <Btn small primary onClick={() => void acceptSuggestion(s.id)}>采纳入设定集</Btn>
                  <Btn small ghost onClick={() => void dismissSuggestion(s.id)}>忽略</Btn>
                </div>
              </div>
            ))}

            {issues === 'loading' && <div className="progress-line" />}
            {Array.isArray(issues) && (
              <>
                <div style={{ fontWeight: 700, fontSize: 12.5, marginTop: 6 }}>一致性检查结果</div>
                {issues.length === 0 && <div style={{ color: 'var(--ok)', fontSize: 12.5 }}>未发现明显矛盾。</div>}
                {issues.map((it, i) => (
                  <div key={i} className={`issue sev-${it.severity}`}>
                    <span className="sev">{it.severity === 'high' ? '严重' : it.severity === 'medium' ? '中等' : '轻微'}</span>
                    {it.description}
                    {it.quote && <div className="quote">「{it.quote}」</div>}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      <div className="drawer-input">
        {tab === 'chat' ? (
          <>
            <textarea
              value={input}
              placeholder="问点什么都行，Enter 发送，Shift+Enter 换行"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="hint">
              <span>{chapter ? '上下文：当前章节 + 设定集 + 前情摘要' : '上下文：全书设定'}</span>
              <Btn small primary disabled={chatBusy || !input.trim()} onClick={() => void send()}>发送</Btn>
            </div>
          </>
        ) : (
          <div className="hint">
            <span>切到「对话」标签可以输入文字与 agent 交流。</span>
          </div>
        )}
      </div>
    </aside>
  );
}
