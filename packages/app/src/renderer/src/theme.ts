import type { ThemeMode } from '@tiny-schedule/shared';

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    const dark = mode === 'dark' || (mode === 'system' && mq.matches);
    root.classList.toggle('dark', dark);
  };
  mq.removeEventListener('change', update);
  mq.addEventListener('change', update);
  update();
}
