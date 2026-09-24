import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store';
import { TopBar } from './components/TopBar';
import { Home } from './components/Home';
import { LeftPanel } from './components/LeftPanel';
import { OutlineView } from './components/OutlineView';
import { BibleView } from './components/BibleView';
import { EditorView } from './components/EditorView';
import { AiDrawer } from './components/AiDrawer';
import { SettingsModal } from './components/SettingsModal';
import { Wizard } from './components/Wizard';
import { ConfirmDialog } from './components/ConfirmDialog';

export default function App() {
  const { init, slug, focusMode, drawerOpen, toasts, settingsOpen, wizardOpen, centerView, confirmReq } =
    useStore(useShallow((s) => ({
      init: s.init, slug: s.slug, focusMode: s.focusMode, drawerOpen: s.drawerOpen,
      toasts: s.toasts, settingsOpen: s.settingsOpen, wizardOpen: s.wizardOpen, centerView: s.centerView,
      confirmReq: s.confirmReq,
    })));

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <TopBar />
      {slug ? (
        <div className={`work${drawerOpen ? ' drawer-open' : ''}${focusMode ? ' focus-mode' : ''}`}>
          <LeftPanel />
          <main className="center">
            {centerView === 'outline' && <OutlineView />}
            {centerView === 'editor' && <EditorView />}
            {centerView === 'bible' && <BibleView />}
          </main>
          <AiDrawer />
        </div>
      ) : (
        <Home />
      )}
      {settingsOpen && <SettingsModal />}
      {wizardOpen && <Wizard />}
      {confirmReq && <ConfirmDialog />}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
