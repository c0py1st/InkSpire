import { useEffect } from 'react';
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

export default function App() {
  const { init, slug, focusMode, drawerOpen, toasts, settingsOpen, wizardOpen, centerView } = useStore();

  useEffect(() => {
    void init();
  }, []);

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
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
