import type { ReactElement } from 'react';
import { useStore, type ThemePref } from '../state/store';

function SunIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19" />
    </svg>
  );
}

function MoonIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M20.6 13.3A8.4 8.4 0 1 1 10.7 3.4a6.8 6.8 0 0 0 9.9 9.9z" />
    </svg>
  );
}

function SystemIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="4.5" width="18" height="12" rx="1.2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </svg>
  );
}

const OPTIONS: Array<{ key: ThemePref; label: string; Icon: () => ReactElement }> = [
  { key: 'light', label: '浅色主题', Icon: SunIcon },
  { key: 'dark', label: '深色主题', Icon: MoonIcon },
  { key: 'system', label: '跟随系统', Icon: SystemIcon },
];

/** 顶栏右上角的主题开关：太阳=浅色，月亮=深色，显示器=跟随系统 */
export function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <div className="theme-toggle" role="group" aria-label="界面主题">
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          className={theme === key ? 'active' : ''}
          title={label}
          aria-label={label}
          aria-pressed={theme === key}
          onClick={() => setTheme(key)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
