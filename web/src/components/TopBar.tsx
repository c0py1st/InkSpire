import { useStore } from '../state/store';
import { ThemeToggle } from './ThemeToggle';

export function TopBar() {
  const {
    slug, bundle, focusMode, setFocus, drawerOpen, setDrawer,
    setSettingsOpen, setWizardOpen, backHome, centerView, setView,
  } = useStore();

  // 直接求和即可：bundle 变化频率本就不高，无需手动 memo（React Compiler 也不认可此写法）
  const totalWords = bundle?.wordCounts
    ? Object.values(bundle.wordCounts).reduce((a, b) => a + b, 0)
    : 0;

  const noKey = !bundle && !slug && !useStore.getState().config?.mockMode
    && !(useStore.getState().config?.providers ?? []).some((p) => p.apiKey.trim());

  return (
    <header className="topbar">
      <div className="brand" onClick={backHome} title="回到书架">墨<span>阁</span></div>
      {slug && bundle && (
        <>
          <div className="book-title" title={bundle.meta.title}>{bundle.meta.title}</div>
          <div className="spacer" />
          <div className="meta-info">{centerView === 'editor' ? '写作' : centerView === 'bible' ? '设定' : '大纲'}</div>
          <div className="meta-info">全稿 {totalWords.toLocaleString()} 字</div>
          <button className="btn ghost small" onClick={() => setView('outline')} title="大纲视图">大纲</button>
          <button className="btn ghost small" onClick={() => setView('bible')} title="设定集">设定</button>
          <button className="btn ghost small" onClick={() => setFocus(!focusMode)} title="专注模式（隐藏两侧）">
            {focusMode ? '退出专注' : '专注'}
          </button>
          <button className="btn ghost small" onClick={() => setDrawer(!drawerOpen)} title="AI 批注抽屉">
            {drawerOpen ? '收起批注' : '展开批注'}
          </button>
        </>
      )}
      {!slug && noKey && <div className="mock-dot">演示模式：设置里填入 API Key 后开始真写作</div>}
      <div className="spacer" />
      <button className="btn ghost small" onClick={() => setWizardOpen(true)} title="从一段提示词生成整本大纲">＋ 开新书</button>
      <ThemeToggle />
      <button className="btn ghost small" onClick={() => setSettingsOpen(true)}>设置</button>
    </header>
  );
}
