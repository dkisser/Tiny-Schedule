import { useEffect } from 'react';
import { api } from './api';
import { Layout } from './components/Layout';
import { applyTheme } from './theme';

export default function App() {
  useEffect(() => {
    api()
      .dataLoad()
      .then((d) => applyTheme(d.settings.theme))
      .catch(() => {});
  }, []);
  return (
    <Layout
      sidebar={<div className="p-3 text-sm text-muted-foreground">Sidebar 待实现</div>}
      timerBar={<div className="p-3 text-sm text-muted-foreground">计时条待实现</div>}
    >
      <div className="p-4">主内容区待实现</div>
    </Layout>
  );
}
