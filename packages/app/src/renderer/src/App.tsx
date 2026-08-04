import { useEffect } from 'react';
import { Layout } from './components/Layout';
import { Sidebar } from './components/Sidebar';
import { useDataStore } from './stores/data';
import { useUiStore } from './stores/ui';
import { applyTheme } from './theme';

function Placeholder({ name }: { name: string }) {
  return <div className="p-4 text-muted-foreground">{name} 页面待实现</div>;
}

export default function App() {
  const data = useDataStore((s) => s.data);
  const load = useDataStore((s) => s.load);
  const view = useUiStore((s) => s.view);
  const theme = data?.settings.theme;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (!data) return <div className="p-4">加载中…</div>;

  const page =
    view.type === 'today' ? (
      <Placeholder name="今日" />
    ) : view.type === 'project' ? (
      <Placeholder name="项目" />
    ) : view.type === 'tag' ? (
      <Placeholder name="标签" />
    ) : view.type === 'upcoming' ? (
      <Placeholder name="Upcoming" />
    ) : view.type === 'ai' ? (
      <Placeholder name="AI 分析" />
    ) : view.type === 'export' ? (
      <Placeholder name="导入导出" />
    ) : (
      <Placeholder name="设置" />
    );

  return (
    <Layout
      sidebar={<Sidebar />}
      timerBar={<div className="p-3 text-sm text-muted-foreground">计时条待实现</div>}
    >
      {page}
    </Layout>
  );
}
