import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChatMessageRecord, ChatProposalRecord, ConsistencyIssue, ProposalKind, ReaderReview, StyleExemplar } from '../../../shared/src/types';
import { PROPOSAL_LABELS } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn } from './primitives';
import { DiffView } from './DiffView';

/** 对话内提案卡（agent 的 propose_* 工具产出，采纳才落盘）；会话消息直接用落盘记录类型 */
type ChatProposal = ChatProposalRecord;

/** 提案卡 id 模块级自增：跨刷新/跨会话不查重（会话内唯一即可，恢复值不会与之相撞） */
let chatPropSeq = 0;

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
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatCtlRef = useRef<AbortController | null>(null);
  // 切书加载完成前不回写，避免把上一本书的尾部消息存进新书
  const chatHydratedRef = useRef<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [issues, setIssues] = useState<'idle' | 'loading' | Issue[] | null>('idle');
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [review, setReview] = useState<'idle' | 'loading' | ReaderReview | null>('idle');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewChapter, setReviewChapter] = useState('');
  // A2：本次评审里已点过"收录"的高亮候选下标（重审时清零）
  const [collectedIdx, setCollectedIdx] = useState<Set<number>>(new Set());

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 切换作品：清空会话后从盘上接续本书对话
    setMessages([]);
    setProposals([]);
    setIssues('idle');
    setReview('idle');
    chatHydratedRef.current = null;
    if (!slug) return;
    let alive = true;
    void api.getChat(slug).then((recs) => {
      if (!alive) return;
      chatHydratedRef.current = slug;
      // 加载期间用户已抢先发消息则不覆盖（罕见竞态，保持本地为准）
      setMessages((cur) => (cur.length ? cur : recs));
    }).catch(() => {
      if (alive) chatHydratedRef.current = slug; // 读失败按空会话继续，允许后续保存
    });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    // 消息变化防抖落盘；只写已加载完成的那本书
    if (!slug || chatHydratedRef.current !== slug) return;
    const t = setTimeout(() => { void api.saveChat(slug, messages).catch(() => { /* 静默：下轮变化会再试 */ }); }, 700);
    return () => clearTimeout(t);
  }, [messages, slug]);

  async function clearChat() {
    if (!slug) return;
    if (!await useStore.getState().confirmAsk('清空本书的全部对话记录？（不影响正文、摘要与伏笔表）', { title: '清空对话', okLabel: '清空' })) return;
    setMessages([]);
    chatHydratedRef.current = slug;
    try {
      await api.saveChat(slug, []);
    } catch { /* ignore */ }
  }

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

  /* ---------- 对话（ReAct：工具轨迹 + 提案卡 + 可中断；记录持久化到 chat.json） ---------- */
  const patchLast = (fn: (m: ChatMessageRecord) => Partial<ChatMessageRecord>) => {
    setMessages((ms) => {
      const next = [...ms];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return ms;
      next[next.length - 1] = { ...last, ...fn(last) };
      return next;
    });
  };

  async function send() {
    if (!slug || chatBusy || !input.trim()) return;
    const question = input.trim();
    setInput('');
    const now = new Date().toISOString();
    // 用户消息一并入列：刷新后的转写才有问有答，服务端摊平历史也才拿得到作者原话
    setMessages((ms) => [...ms, { role: 'user', content: question, at: now }, { role: 'assistant', content: '', at: now }]);
    const history = [...messages, { role: 'user' as const, content: question }].map((m) => ({ role: m.role, content: m.content }));
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
          // register_foreshadow 是直接落盘的写工具：重拉 bundle，伏笔登记表立即出现新行
          if (phase === 'end' && name === 'register_foreshadow') void useStore.getState().reloadBundle();
          scrollBottom();
        } else if (obj.type === 'proposal') {
          const p: ChatProposal = { id: ++chatPropSeq, kind: obj.kind as 'chapter' | 'summary', chapterId: String(obj.chapterId), content: String(obj.content), decided: false };
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
  async function acceptChatProposal(mi: number, p: ChatProposal) {
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
      markProposalDecided(mi, p.id);
    } catch (err) {
      toast(`采纳失败：${(err as Error).message}`, 'error');
    }
  }

  function rejectChatProposal(mi: number, p: ChatProposal) {
    markProposalDecided(mi, p.id);
  }

  /** 提案卡按所在消息下标定位（持久化后未处理卡可能躺在任意一条历史消息里） */
  function markProposalDecided(mi: number, propId: number) {
    setMessages((ms) => ms.map((m, k) => (
      k === mi ? { ...m, proposals: (m.proposals ?? []).map((x) => (x.id === propId ? { ...x, decided: true } : x)) } : m
    )));
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

  /* ---------- 读者模拟评审 ---------- */
  async function runReview() {
    if (!slug || !chapter) return;
    setReview('loading');
    setReviewOpen(true);
    setCollectedIdx(new Set());
    try {
      const res = await api.review(slug, chapter.id);
      setReview(res.report);
      setReviewChapter(chapter.title);
    } catch (err) {
      setReview(null);
      setReviewOpen(false);
      toast((err as Error).message, 'error');
    }
  }

  /* A2：把验真通过的高亮候选收录进风格范文库（整批或单条；按正文去重，重复收录无副作用） */
  async function collectHighlights(one?: number) {
    if (!slug || !chapter || !review || review === 'loading' || review === 'idle' || !review.highlights?.length) return;
    const list = one === undefined ? review.highlights : [review.highlights[one]];
    try {
      const existing = await api.getExemplars(slug);
      const seen = new Set(existing.map((e) => e.content));
      const fresh: StyleExemplar[] = list
        .filter((h) => !seen.has(h.excerpt))
        .map((h, i) => ({
          id: `x-${Date.now()}-${i}`,
          title: `《${chapter.title}》·${h.sceneTag || '范文'}`,
          content: h.excerpt,
          keys: h.keys,
          ...(h.sceneTag ? { sceneTag: h.sceneTag } : {}),
          sourceChapterId: chapter.id,
          sourceChapterTitle: chapter.title,
          at: new Date().toISOString(),
        }));
      if (!fresh.length) { toast('所选段落均已在风格库中', 'ok'); }
      else {
        await api.saveExemplars(slug, [...existing, ...fresh]);
        toast(`已收录 ${fresh.length} 段进风格范文库`, 'ok');
      }
      setCollectedIdx((s) => {
        const n = new Set(s);
        if (one === undefined) review.highlights!.forEach((_, i) => n.add(i));
        else n.add(one);
        return n;
      });
    } catch (err) {
      toast(`收录失败：${(err as Error).message}`, 'error');
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
        <Btn small ghost onClick={runReview} disabled={!chapter} title="三类目标读者给本章的阅读体验打分（抱怨带原文引证并验真）">读者评审</Btn>
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
                              <Btn small primary onClick={() => void acceptChatProposal(i, p)}>采纳</Btn>
                              <Btn small ghost onClick={() => rejectChatProposal(i, p)}>放弃</Btn>
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
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · {s.kind === 'character' ? '人物' : s.kind === 'state' ? '状态更新' : s.kind === 'outline' ? '大纲修订' : '世界观'}</span>
                {/* 来源章：旧数据无此字段时标"更早"，避免分不清是哪章攒下的 */}
                <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · {s.sourceChapterTitle ? `来自《${s.sourceChapterTitle}》` : '更早'}</span>
                <div style={{ marginTop: 4 }}>{s.content}{s.note && <span style={{ color: 'var(--text-faint)' }}>（依据：{s.note}）</span>}</div>
                <div className="s-actions">
                  <Btn small primary onClick={() => void acceptSuggestion(s.id)}>{s.kind === 'state' ? '采纳并更新人物卡' : s.kind === 'outline' ? '采纳并更新大纲' : '采纳入设定集'}</Btn>
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
              <span style={{ flex: 1 }} />
              {messages.length > 0 && !chatBusy && (
                <Btn small ghost onClick={() => void clearChat()} title="清空本书对话记录（不影响正文与设定）">清空</Btn>
              )}
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
                {issues.length > 0 && issues.some((it) => it.verified === false) && (
                  <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 6 }}>
                    {issues.filter((it) => it.verified === false).length} 条问题的引文在正文中逐字找不到（模型可能臆造引证），已置底降级，请谨慎据此改稿。
                  </div>
                )}
                {[...issues].sort((a, b) => (a.verified === false ? 1 : 0) - (b.verified === false ? 1 : 0)).map((it, i) => (
                  <div key={i} className={`issue sev-${it.severity}${it.verified === false ? ' unverified' : ''}`}>
                    <span className="sev">{it.severity === 'high' ? '严重' : it.severity === 'medium' ? '中等' : '轻微'}</span>
                    {it.verified === false && <span className="sev" title="引文未命中原文">引证存疑</span>}
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

      {reviewOpen && (
        <BuDialog open onClose={() => setReviewOpen(false)} floating ariaTitle={`读者评审 · ${reviewChapter}`}>
          <div className="m-head">
            读者评审
            {reviewChapter && <span className="sub" style={{ fontWeight: 400, marginLeft: 8 }}>《{reviewChapter}》</span>}
            <div style={{ flex: 1 }} />
            <Btn ghost small onClick={() => setReviewOpen(false)}>关闭</Btn>
          </div>
          <div className="m-body issues-body">
            {review === 'loading' && (
              <>
                <div className="progress-line" />
                <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>三类读者正在翻阅这一章…</div>
              </>
            )}
            {review && review !== 'idle' && review !== 'loading' && (
              <>
                {review.personas.map((p, i) => {
                  const fakeCount = p.grievances.filter((g) => g.verified === false).length;
                  return (
                    <div key={i} className="vol-block" style={{ padding: '10px 12px', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontWeight: 700 }}>{p.name}</span>
                        <span className={`rv-continue ${p.wouldContinue ? 'yes' : 'no'}`}>
                          {p.wouldContinue ? '会追下去' : '想弃'}
                        </span>
                        <span className="rv-score-faint" title="读者主观综合分，同章重跑会上下浮动，参考即可">综合 {p.overall}</span>
                      </div>
                      {p.praise && <div style={{ fontSize: 12.5, color: 'var(--ok)', marginTop: 4 }}>＋ {p.praise}</div>}
                      {p.grievances.map((g, k) => (
                        <div key={k} style={{ marginTop: 5, fontSize: 12.5 }}>
                          <span style={{ color: 'var(--danger)' }}>－ </span>{g.issue}
                          {g.quote && (
                            <div className={`quote${g.verified === false ? ' unver' : ''}`}>「{g.quote}」{g.verified === false ? '（正文中找不到此引文）' : ''}</div>
                          )}
                        </div>
                      ))}
                      {fakeCount > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>该读者有 {fakeCount} 条抱怨的引证未通过原文校验，权重自负。</div>
                      )}
                    </div>
                  );
                })}
                {review.verdict && <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 8px' }}>总评：{review.verdict}</div>}
                {review.topFixes.length > 0 && (
                  <div className="rv-fixes">
                    <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 4 }}>改稿优先级</div>
                    {review.topFixes.map((f, i) => <div key={i} className="rv-fix">{i + 1}. {f}</div>)}
                  </div>
                )}
                {review.highlights && review.highlights.length > 0 && (
                  <div className="rv-fixes" style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 1 }}>
                        以下段落已逐字验真——收录进风格范文库后，写同类场景的章会按触发词命中注入（只学笔法不抄情节）
                      </span>
                      <Btn small ghost onClick={() => void collectHighlights()} disabled={[...review.highlights.keys()].every((i) => collectedIdx.has(i))}>
                        全部收录
                      </Btn>
                    </div>
                    {review.highlights.map((h, i) => (
                      <div key={i} className="rv-fix" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          「{h.excerpt.length > 90 ? h.excerpt.slice(0, 90) + '…' : h.excerpt}」
                          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>　触发：{h.keys.join('、') || '（无，需手动补）'}{h.sceneTag ? `｜${h.sceneTag}` : ''}</span>
                        </span>
                        <Btn small ghost onClick={() => void collectHighlights(i)} disabled={collectedIdx.has(i)}>
                          {collectedIdx.has(i) ? '已收录' : '收录'}
                        </Btn>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="m-foot">
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>评审模拟读者体验，不改正文；每条抱怨的引文已逐字比对原文。综合分是主观手感，重跑会浮动，看引证和改稿优先级即可。</span>
            <div className="spacer" />
            <Btn small onClick={() => void runReview()} disabled={review === 'loading'}>重审本章</Btn>
          </div>
        </BuDialog>
      )}
    </>
  );
}
