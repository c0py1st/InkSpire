import { useRef, useState } from 'react';
import type { CharacterCard, Kernel } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { Btn, Field } from './primitives';

interface WizChapter { title: string; beat: string; pov: string; characters: string }
interface WizVolume { title: string; summary: string; chapters: WizChapter[] }

const STEPS = ['构想', '内核', '分卷', '章节细纲', '设定集', '成书'];

export function Wizard() {
  const { setWizardOpen, openProject, toast, config } = useStore();
  const demo = !config?.mockMode && !(config?.providers ?? []).some((p) => p.apiKey.trim());

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);

  const [idea, setIdea] = useState('');
  const [scale, setScale] = useState({ volumeCount: 3, chaptersPerVolume: 10, wordsPerChapter: 2500 });

  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [volumes, setVolumes] = useState<WizVolume[]>([]);
  const [bibleChars, setBibleChars] = useState<CharacterCard[]>([]);
  const [worldview, setWorldview] = useState('');
  const [activeVol, setActiveVol] = useState(0);
  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');

  function patchVol(i: number, patch: Partial<WizVolume>) {
    setVolumes((vs) => vs.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  }
  function patchChapter(vi: number, ci: number, patch: Partial<WizChapter>) {
    setVolumes((vs) => vs.map((v, k) => (k === vi ? { ...v, chapters: v.chapters.map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : v)));
  }

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setStream('');
    try {
      await task();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const onDelta = (t: string) => {
    setStream((s) => {
      const next = s + t;
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
      return next;
    });
  };

  /* ---------- 各步生成 ---------- */

  const genKernel = () =>
    run(async () => {
      const final = await api.wizardKernel(idea, scale, onDelta);
      if (!final?.kernel) throw new Error('未取到内核结果');
      setKernel(final.kernel);
      setStep(1);
    });

  const genVolumes = () =>
    run(async () => {
      if (!kernel) return;
      const final = await api.wizardVolumes(kernel, scale.volumeCount, onDelta);
      if (!final?.volumes?.length) throw new Error('未取到分卷结果');
      setVolumes(final.volumes.map((v) => ({ title: v.title, summary: v.summary, chapters: [] })));
    });

  const genBeats = (vi: number) =>
    run(async () => {
      if (!kernel) return;
      const final = await api.wizardBeats(kernel, volumes as never, vi, scale.chaptersPerVolume, onDelta);
      if (!final?.chapters?.length) throw new Error('未取到章节细纲');
      patchVol(vi, {
        chapters: final.chapters.map((c) => ({
          title: c.title, beat: c.beat, pov: c.pov ?? '', characters: (c.characters ?? []).join('、'),
        })),
      });
    });

  const genBible = () =>
    run(async () => {
      if (!kernel) return;
      const final = await api.wizardBible(kernel, volumes as never, onDelta);
      if (!final?.bible) throw new Error('未取到设定集');
      setBibleChars(final.bible.characters.map((c, i) => ({ ...c, id: `wc-${i}` })));
      setWorldview(final.bible.worldview);
    });

  const finish = () =>
    run(async () => {
      if (!kernel) return;
      const outline = {
        premise: kernel.premise,
        genre: kernel.genre,
        coreConflict: kernel.coreConflict,
        endingVision: kernel.endingVision,
        styleGuide: kernel.styleGuide,
        volumes: volumes.map((v) => ({
          id: '', title: v.title, summary: v.summary,
          chapters: v.chapters.map((c) => ({
            id: '', title: c.title, beat: c.beat, pov: c.pov,
            characters: c.characters.split(/[、,，\s]+/).filter(Boolean), status: 'todo' as const,
          })),
        })),
      };
      const meta = await api.completeProject({
        meta: { title: title || kernel.premise.slice(0, 12), logline: logline || kernel.premise },
        outline,
        characters: bibleChars,
        worldview,
      });
      setWizardOpen(false);
      await openProject(meta.slug);
    });

  const canNext = [idea.trim().length > 10, !!kernel, volumes.length > 0, volumes.some((v) => v.chapters.length > 0), true, title.trim().length > 0][step];

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="m-head">
          开新书
          <div className="wiz-steps">
            {STEPS.map((s, i) => (
              <span key={s} className={`step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}>{s}</span>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <Btn ghost small onClick={() => setWizardOpen(false)}>关闭</Btn>
        </div>

        <div className="m-body">
          {demo && step === 0 && (
            <div className="suggestion" style={{ marginBottom: 14 }}>
              当前是<b className="s-name">演示模式</b>（未配置 API Key）：可以完整走一遍流程，内容为本地生成的占位文字。正式使用请在设置里填入密钥。
            </div>
          )}

          {step === 0 && (
            <>
              <Field label="你的构想" hint="题材、人物、脑洞、想看的桥段、文风偏好……想到什么写什么">
                <textarea
                  style={{ minHeight: 180 }}
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="例：我想写一个古代小捕快卷入州府大案的故事，主角认死理但重情义，节奏偏快，每章结尾要有钩子……"
                />
              </Field>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <Field label="卷数">
                  <input type="number" min={1} max={20} style={{ width: 90 }} value={scale.volumeCount}
                    onChange={(e) => setScale({ ...scale, volumeCount: Math.max(1, Number(e.target.value) || 1) })} />
                </Field>
                <Field label="每卷章数">
                  <input type="number" min={1} max={60} style={{ width: 90 }} value={scale.chaptersPerVolume}
                    onChange={(e) => setScale({ ...scale, chaptersPerVolume: Math.max(1, Number(e.target.value) || 1) })} />
                </Field>
                <Field label="每章目标字数">
                  <input type="number" min={500} max={20000} step={100} style={{ width: 110 }} value={scale.wordsPerChapter}
                    onChange={(e) => setScale({ ...scale, wordsPerChapter: Math.max(500, Number(e.target.value) || 2000) })} />
                </Field>
              </div>
              <Btn primary disabled={busy || idea.trim().length <= 10} onClick={genKernel}>
                生成故事内核 →
              </Btn>
            </>
          )}

          {step === 1 && kernel && (
            <>
              <Field label="一句话内核"><textarea style={{ minHeight: 52 }} value={kernel.premise} onChange={(e) => setKernel({ ...kernel, premise: e.target.value })} /></Field>
              <Field label="题材"><input type="text" value={kernel.genre} onChange={(e) => setKernel({ ...kernel, genre: e.target.value })} /></Field>
              <Field label="主线冲突"><textarea style={{ minHeight: 60 }} value={kernel.coreConflict} onChange={(e) => setKernel({ ...kernel, coreConflict: e.target.value })} /></Field>
              <Field label="结局走向"><textarea style={{ minHeight: 60 }} value={kernel.endingVision} onChange={(e) => setKernel({ ...kernel, endingVision: e.target.value })} /></Field>
              <Field label="文风约定" hint="会写进每一章的生成约束里"><textarea style={{ minHeight: 70 }} value={kernel.styleGuide} onChange={(e) => setKernel({ ...kernel, styleGuide: e.target.value })} /></Field>
              <div style={{ display: 'flex', gap: 10 }}>
                <Btn disabled={busy} onClick={() => setStep(0)}>← 返回</Btn>
                <Btn disabled={busy} onClick={genKernel}>重掷内核</Btn>
                <div style={{ flex: 1 }} />
                <Btn primary disabled={busy} onClick={() => setStep(2)}>继续 · 生成分卷 →</Btn>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {volumes.map((v, i) => (
                <div key={i} className="vol-block" style={{ padding: 12 }}>
                  <div className="row1" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input type="text" className="ch-title" style={{ flex: 1 }} value={v.title}
                      onChange={(e) => patchVol(i, { title: e.target.value })} />
                    <Btn small danger ghost onClick={() => setVolumes((vs) => vs.filter((_, k) => k !== i))}>删卷</Btn>
                  </div>
                  <textarea style={{ width: '100%', minHeight: 54 }} value={v.summary}
                    onChange={(e) => patchVol(i, { summary: e.target.value })} />
                </div>
              ))}
              <Btn small ghost onClick={() => setVolumes((vs) => [...vs, { title: `新卷 ${vs.length + 1}`, summary: '', chapters: [] }])}>＋ 加一卷</Btn>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <Btn disabled={busy} onClick={() => setStep(1)}>← 返回</Btn>
                <Btn disabled={busy} onClick={genVolumes}>重掷分卷</Btn>
                <div style={{ flex: 1 }} />
                <Btn primary disabled={busy} onClick={() => { setActiveVol(0); setStep(3); }}>继续 · 细化章节 →</Btn>
              </div>
            </>
          )}

          {step === 3 && volumes.length > 0 && (
            <>
              <div className="left-tabs" style={{ marginBottom: 14 }}>
                {volumes.map((v, i) => (
                  <button key={i} className={i === activeVol ? 'active' : ''} onClick={() => setActiveVol(i)}>
                    {v.title || `卷${i + 1}`}
                  </button>
                ))}
              </div>
              {volumes[activeVol] && (
                <div className="vol-block" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <b style={{ fontSize: 13 }}>{volumes[activeVol].title}</b>
                    <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                      {volumes[activeVol].chapters.length ? `${volumes[activeVol].chapters.length} 章` : '尚未生成细纲'}
                    </span>
                    <div style={{ flex: 1 }} />
                    <Btn small disabled={busy} onClick={() => genBeats(activeVol)}>
                      {volumes[activeVol].chapters.length ? '重新生成本卷细纲' : '生成本卷细纲'}
                    </Btn>
                  </div>
                  {volumes[activeVol].chapters.map((c, ci) => (
                    <div key={ci} className="ch-edit" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                      <div className="row1">
                        <span className="ch-id">第{ci + 1}章</span>
                        <input type="text" className="ch-title" value={c.title} onChange={(e) => patchChapter(activeVol, ci, { title: e.target.value })} />
                      </div>
                      <textarea className="beat" value={c.beat} onChange={(e) => patchChapter(activeVol, ci, { beat: e.target.value })} />
                      <div className="row2">
                        <input type="text" placeholder="视角人物" value={c.pov} onChange={(e) => patchChapter(activeVol, ci, { pov: e.target.value })} />
                        <input type="text" placeholder="出场人物（顿号分隔）" value={c.characters} onChange={(e) => patchChapter(activeVol, ci, { characters: e.target.value })} />
                        <Btn small ghost danger onClick={() => patchVol(activeVol, { chapters: volumes[activeVol].chapters.filter((_, j) => j !== ci) })}>删</Btn>
                      </div>
                    </div>
                  ))}
                  {volumes[activeVol].chapters.length > 0 && (
                    <Btn small ghost style={{ marginTop: 8 }} onClick={() => patchVol(activeVol, { chapters: [...volumes[activeVol].chapters, { title: '新章', beat: '', pov: '', characters: '' }] })}>
                      ＋ 手动加一章
                    </Btn>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <Btn disabled={busy} onClick={() => setStep(2)}>← 返回</Btn>
                <div style={{ flex: 1 }} />
                <Btn primary disabled={busy || !volumes.some((v) => v.chapters.length)} onClick={() => setStep(4)}>继续 · 生成设定集 →</Btn>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <Btn disabled={busy} onClick={genBible}>{bibleChars.length ? '重新生成设定集' : '生成设定集'}</Btn>
              {bibleChars.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {bibleChars.map((c, i) => (
                    <div key={c.id} className="prov-card">
                      <div className="row">
                        <input type="text" value={c.name} onChange={(e) => setBibleChars((cs) => cs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="姓名" />
                        <input type="text" value={c.role} onChange={(e) => setBibleChars((cs) => cs.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)))} placeholder="定位（主角/反派…）" />
                      </div>
                      <textarea style={{ width: '100%', minHeight: 44 }} value={c.personality} onChange={(e) => setBibleChars((cs) => cs.map((x, k) => (k === i ? { ...x, personality: e.target.value } : x)))} placeholder="性格" />
                    </div>
                  ))}
                  <Field label="世界观骨架">
                    <textarea style={{ minHeight: 110 }} value={worldview} onChange={(e) => setWorldview(e.target.value)} />
                  </Field>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <Btn disabled={busy} onClick={() => setStep(3)}>← 返回</Btn>
                <div style={{ flex: 1 }} />
                <Btn primary disabled={busy || !bibleChars.length} onClick={() => setStep(5)}>继续 · 成书 →</Btn>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <Field label="书名"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给这本书起个名字" /></Field>
              <Field label="简介（会显示在书架上）">
                <textarea style={{ minHeight: 70 }} value={logline} onChange={(e) => setLogline(e.target.value)} placeholder={kernel?.premise} />
              </Field>
              <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginBottom: 14 }}>
                共 {volumes.length} 卷 / {volumes.reduce((a, v) => a + v.chapters.length, 0)} 章 / {bibleChars.length} 张人物卡。落盘后随时可以在应用里继续修改大纲。
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Btn disabled={busy} onClick={() => setStep(4)}>← 返回</Btn>
                <div style={{ flex: 1 }} />
                <Btn primary disabled={busy || !title.trim()} onClick={finish}>落盘成书并打开</Btn>
              </div>
            </>
          )}

          {busy && (
            <div>
              <div className="progress-line" />
              <div className="stream-preview" ref={streamRef}>{stream || '正在生成……'}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
