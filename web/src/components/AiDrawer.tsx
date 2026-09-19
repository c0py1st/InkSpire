import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConsistencyIssue, ProposalKind } from '../../../shared/src/types';
import { PROPOSAL_LABELS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn } from './primitives';
import { DiffView } from './DiffView';

/** ReAct 轨迹步骤：工具名 + 一行摘要 + 是否已完成 */
interface AgentStep { name: string; detail: string; done: boolean }
/** 对话内提案卡（agent 的 propose_* 工具产出，采纳才落盘） */
interface ChatProposal {
  id: number;
  kind: 'chapter' | 'summary';
  chapterId: string;
  content: string;
  decided: boolean;
}

interface Proposal {
  id: number;
  kind: ProposalKind;
  instruction: string;
  label?: string;          // 卡片标题（迭代版显示"…·迭代"）
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
  const [messages, setMessages] = useState<Array<{
    role: 'user' | 'assistant'; content: string;
    steps?: AgentStep[]; proposals?: ChatProposal[];
  }>>([]);
  const [input, setInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatCtlRef = useRef<AbortController | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [issues, setIssues] = useState<'idle' | 'loading' | Issue[] | null>('idle');
  const [issuesOpen, setIssuesOpen] = useState(false);

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
    // 依赖数组只放 nonce：这是"按钮点一次、跑一次"的触发信号，
    // 补全其余依赖会让章节内容每变一次就重发提案请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProposal?.nonce]);

  async function runProposal(
    start: number, end: number, original: string, kind: ProposalKind, instruction: string,
    prevText?: string,
  ) {
    if (!slug || !chapter) return;
    const id = propSeq++;
    const label = prevText ? `${PROPOSAL_LABELS[kind]}·迭代` : PROPOSAL_LABELS[kind];
    const proposal: Proposal = { id, kind, instruction, label, original, range: { start, end }, text: '', streaming: true };
    setProposals((ps) => [proposal, ...ps]);
    try {
      await api.propose(slug, {
        chapterId: chapter.id, start, end, original, instruction, kind, prevText,
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

  /* ---------- 对话（ReAct：工具轨迹 + 提案卡 + 可中断） ---------- */
  let propId = 0; // 仅会话内唯一即可
  const patchLast = (fn: (m: { content: string; steps?: AgentStep[]; proposals?: ChatProposal[] }) => { content: string; steps?: AgentStep[]; proposals?: ChatProposal[] }) => {
    setMessages((ms) => {
      const next = [...ms];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return ms;
      const patch = fn(last);
      next[next.length - 1] = { ...last, ...patch };
      return next;
    });
  };

  async function send() {
    if (!slug || chatBusy || !input.trim()) return;
    const question = input.trim();
    setInput('');
    const history = [...messages.map((m) => ({ role: m.role, content: m.content })), { role: 'user' as const, content: question }];
    setMessages((ms) => [...ms, { role: 'assistant', content: '' }]);
    setChatBusy(true);
    setTab('chat');
    const ctl = new AbortController();
    chatCtlRef.current = ctl;
    let truncated = false;
    try {
      await api.chat(slug, {
        messages: history,
        chapterId: chapter?.id,
        selection: selection?.text,
      }, (delta) => {
        patchLast((m) => ({ content: m.content + delta }));
        scrollBottom();
      }, (obj) => { if (obj.truncated === true) truncated = true; }, ctl.signal, (obj) => {
        if (obj.type === 'tool') {
          const name = String(obj.name ?? '');
          const phase = String(obj.phase ?? '');
          patchLast((m) => {
            const steps = [...(m.steps ?? [])];
            if (phase === 'start') steps.push({ name, detail: '', done: false });
            else {
              let idx = -1;
              for (let k = steps.length - 1; k >= 0; k--) {
                if (steps[k].name === name && !steps[k].done) { idx = k; break; }
              }
              if (idx >= 0) steps[idx] = { ...steps[idx], detail: String(obj.detail ?? ''), done: true };
            }
            return { content: m.content, steps };
          });
          scrollBottom();
        } else if (obj.type === 'proposal') {
          const p: ChatProposal = { id: ++propId, kind: obj.kind as 'chapter' | 'summary', chapterId: String(obj.chapterId), content: String(obj.content), decided: false };
          patchLast((m) => ({ content: m.content, proposals: [...(m.proposals ?? []), p] }));
          scrollBottom();
        }
      });
      if (truncated) {
        patchLast((m) => ({ content: m.content + '\n\n（回答达到长度上限被截断了——把问题拆细一点再问，或回复"继续"）' }));
        scrollBottom();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patchLast((m) => ({ content: m.content + '\n\n（已停止）' }));
      } else {
        toast((err as Error).message, 'error');
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          return last?.role === 'assistant' && !last.content && !last.steps?.length ? ms.slice(0, -1) : ms;
        });
      }
    } finally {
      setChatBusy(false);
      chatCtlRef.current = null;
    }
  }

  function stopChat() {
    chatCtlRef.current?.abort();
  }

  /** 采纳对话提案：正文走 saveChapter(backup)+刷新，摘要走 saveSummary */
  async function acceptChatProposal(p: ChatProposal) {
    if (!slug) return;
    try {
      if (p.kind === 'chapter') {
        await api.saveChapter(slug, p.chapterId, { content: p.content, backup: true });
        const st = useStore.getState();
        if (st.chapter?.id === p.chapterId) {
          useStore.setState({ chapter: { ...st.chapter, content: p.content }, saveState: 'saved' });
        }
        await st.reloadBundle();
        toast(`已采纳：《${p.chapterId}》正文已更新（旧稿已备份）`, 'ok');
      } else {
        await api.saveSummary(slug, p.chapterId, p.content);
        await useStore.getState().reloadBundle();
        toast('已采纳：本章摘要已写入记忆', 'ok');
      }
      patchLast((m) => ({
        content: m.content,
        proposals: (m.proposals ?? []).map((x) => (x.id === p.id ? { ...x, decided: true } : x)),
      }));
    } catch (err) {
      toast(`采纳失败：${(err as Error).message}`, 'error');
    }
  }

  function rejectChatProposal(p: ChatProposal) {
    patchLast((m) => ({
      content: m.content,
      proposals: (m.proposals ?? []).map((x) => (x.id === p.id ? { ...x, decided: true } : x)),
    }));
  }

  /* ---------- 一致性检查 ---------- */
  const [issuesChapter, setIssuesChapter] = useState('');
  async function checkConsistency() {
    if (!slug || !chapter) return;
    setIssues('loading');
    setIssuesOpen(true);
    try {
      const res = await api.consistency(slug, chapter.id);
      setIssues(res.issues);
      setIssuesChapter(chapter.title);
    } catch (err) {
      setIssues(null);
      setIssuesOpen(false);
      toast((err as Error).message, 'error');
    }
  }

  if (!drawerOpen) return null;

  const sugg = bundle?.suggestions ?? [];
  const suggBadge = sugg.length - suggestionsSeen;

  return (
    <>
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
                {m.steps?.length ? (
                  <div className="agent-steps">
                    {m.steps.map((s, k) => (
                      <div key={k} className={`agent-step${s.done ? '' : ' running'}`}>
                        <span className="st-name">{s.name === '_degraded' ? '⚠' : s.name.replace(/_/g, ' ')}</span>
                        <span className="st-detail">{s.done ? s.detail : '执行中…'}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {m.content || (chatBusy && i === messages.length - 1 && !m.steps?.some((s) => !s.done) ? '…' : '')}
                {m.proposals?.length ? (
                  <div className="chat-proposals">
                    {m.proposals.map((p) => (
                      <div key={p.id} className="chat-proposal">
                        <div className="cp-head">{p.kind === 'chapter' ? `📝 整章正文修订提案 · ${p.chapterId}` : '🧠 摘要重写提案 · ' + p.chapterId}</div>
                        <div className="cp-preview">{p.content.slice(0, 600)}{p.content.length > 600 ? '……（采纳后可在正文查看全文，旧稿已可经「历史」恢复）' : ''}</div>
                        {p.decided
                          ? <div className="cp-done">已处理</div>
                          : (
                            <div className="cp-actions">
                              <Btn small primary onClick={() => void acceptChatProposal(p)}>采纳</Btn>
                              <Btn small ghost onClick={() => rejectChatProposal(p)}>放弃</Btn>
                            </div>
                          )}
                      </div>
                    ))}
                  </div>
                ) : null}
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
                  <span className="kind">{p.label ?? PROPOSAL_LABELS[p.kind]}</span>
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
                    <Btn small onClick={() => {
                      const fb = window.prompt('对这一版哪里不满意？（会基于这一版定向改，不推倒重来）');
                      if (fb !== null) void runProposal(p.range.start, p.range.end, p.original, p.kind, fb.trim() || '更好一些', p.text);
                    }} title="在上一版基础上，按你的反馈定向修改">按反馈再改</Btn>
                    <Btn small onClick={() => void runProposal(p.range.start, p.range.end, p.original, p.kind, p.instruction)}>推倒重来</Btn>
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
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · {s.kind === 'character' ? '人物' : s.kind === 'state' ? '状态更新' : '世界观'}</span>
                {/* 来源章：旧数据无此字段时标"更早"，避免分不清是哪章攒下的 */}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · {s.sourceChapterTitle ? `来自《${s.sourceChapterTitle}》` : '更早'}</span>
                <div style={{ marginTop: 4 }}>{s.content}{s.note && <span style={{ color: 'var(--text-faint)' }}>（依据：{s.note}）</span>}</div>
                <div className="s-actions">
                  <Btn small primary onClick={() => void acceptSuggestion(s.id)}>{s.kind === 'state' ? '采纳并更新人物卡' : '采纳入设定集'}</Btn>
                  <Btn small ghost onClick={() => void dismissSuggestion(s.id)}>忽略</Btn>
                </div>
              </div>
            ))}

            {Array.isArray(issues) && (
              <button className="issue-reopen" onClick={() => setIssuesOpen(true)}>
                上次检查《{issuesChapter}》：{issues.length === 0 ? '未发现明显矛盾' : `${issues.length} 个问题`} · 重新查看
              </button>
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
              {chatBusy
                ? <Btn small danger onClick={stopChat} title="中断本轮回答与工具调用">停止</Btn>
                : <Btn small primary disabled={!input.trim()} onClick={() => void send()}>发送</Btn>}
            </div>
          </>
        ) : (
          <div className="hint">
            <span>切到「对话」标签可以输入文字与 agent 交流。</span>
          </div>
        )}
      </div>
      </aside>

      {issuesOpen && (
        <BuDialog open onClose={() => setIssuesOpen(false)} floating ariaTitle={`一致性检查 · ${issuesChapter}`}>
          <div className="m-head">
            一致性检查结果
            {issuesChapter && <span className="sub" style={{ fontWeight: 400, marginLeft: 8 }}>《{issuesChapter}》</span>}
            <div style={{ flex: 1 }} />
            <Btn ghost small onClick={() => setIssuesOpen(false)}>关闭</Btn>
          </div>
          <div className="m-body issues-body">
            {issues === 'loading' && (
              <>
                <div className="progress-line" />
                <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 8 }}>
                  正在对照设定集、前情与伏笔登记表检查本章……
                </div>
              </>
            )}
            {Array.isArray(issues) && (
              <>
                {issues.length === 0 && <div style={{ color: 'var(--ok)', fontSize: 13 }}>未发现明显矛盾。</div>}
                {issues.map((it, i) => (
                  <div key={i} className={`issue sev-${it.severity}`}>
                    <span className="sev">{it.severity === 'high' ? '严重' : it.severity === 'medium' ? '中等' : '轻微'}</span>
                    {it.description}
                    {it.quote && <div className="quote">「{it.quote}」</div>}
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="m-foot">
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>检查只报告问题，不会改动正文；改完可再点一次复查。</span>
            <div className="spacer" />
            <Btn small onClick={() => void checkConsistency()} disabled={issues === 'loading'}>重新检查</Btn>
          </div>
        </BuDialog>
      )}
    </>
  );
}
