'use client';
import { useEffect, useState } from 'react';
import { THEME_KEY, type Theme } from './theme';

/** 默认浅色;切换写入 localStorage */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(
    () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    [],
  );
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`切换到${next === 'dark' ? '深色' : '浅色'}主题`}
      className="rounded-control border border-line bg-panel px-3 py-1.5 text-[13px] text-muted transition-colors duration-200 ease-out hover:text-fg"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_KEY, next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? '浅色' : '深色'}
    </button>
  );
}
