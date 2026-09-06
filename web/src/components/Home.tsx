import { useEffect, useState } from 'react';
import type { ProjectMeta } from '../../../shared/src/types';
import { api } from '../api/client';
import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn } from './primitives';

export function Home() {
  const { projects, openProject, setWizardOpen, setSettingsOpen, loadProjects, toast } = useStore();
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, []);

  return (
    <div className="home">
      <div className="home-inner">
        <h1>墨<span>阁</span></h1>
        <div className="tagline">本地长篇小说创作台 —— 大纲即契约，AI 按你的大纲写正文。</div>

        <div className="home-actions">
          <Btn primary onClick={() => setWizardOpen(true)}>开新书 · 从提示词生成大纲</Btn>
          <Btn onClick={() => setSettingsOpen(true)}>模型与密钥设置</Btn>
        </div>

        {projects.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            还没有作品。点上面的按钮，把你的想法写成一段提示词，agent 会帮你搭出故事内核、分卷大纲、逐章细纲和设定集。
          </div>
        )}

        {projects.map((p: ProjectMeta) => (
          <div key={p.slug} className="book-card" onClick={() => void openProject(p.slug)}>
            <div style={{ minWidth: 0 }}>
              <div className="b-title">{p.title}</div>
              <div className="b-logline">{p.logline || '（暂无简介）'}</div>
            </div>
            <div className="b-meta">
              <div>更新于 {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</div>
              <button
                className="icon-btn danger"
                title="删除本书（磁盘文件一并删除）"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmSlug(p.slug);
                }}
              >删除</button>
            </div>
          </div>
        ))}

        {confirmSlug && (
          <ConfirmDelete
            slug={confirmSlug}
            onCancel={() => setConfirmSlug(null)}
            onDone={async () => {
              try {
                await api.deleteProject(confirmSlug);
                await loadProjects();
                toast('已删除', 'ok');
              } catch (err) {
                toast((err as Error).message, 'error');
              }
              setConfirmSlug(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ConfirmDelete(props: { slug: string; onCancel: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <BuDialog open onClose={props.onCancel} closeOnOutsidePress ariaTitle="删除作品" size="narrow">
        <div className="m-head">删除作品</div>
        <div className="m-body" style={{ fontSize: 13 }}>
          将删除 <b>{props.slug}</b> 的全部磁盘文件（正文、大纲、设定），且无法恢复。确定吗？
        </div>
        <div className="m-foot">
          <div className="spacer" />
          <Btn onClick={props.onCancel}>取消</Btn>
          <Btn danger disabled={busy} onClick={() => { setBusy(true); void props.onDone(); }}>确认删除</Btn>
        </div>
    </BuDialog>
  );
}
