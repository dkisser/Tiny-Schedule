import type { ProviderInfo } from '@tiny-schedule/shared';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ProviderEditor } from '../components/ProviderEditor';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { type ProviderDraft, useDataStore } from '../stores/data';

export function SettingsPage() {
  const data = useDataStore((s) => s.data);
  const updateSettings = useDataStore((s) => s.updateSettings);
  const [registry, setRegistry] = useState<ProviderInfo[]>([]);
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api().aiRegistry().then(setRegistry);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the avatar source changes
  useEffect(() => {
    setAvatarBroken(false);
  }, [data?.settings.avatar]);

  // initialize drafts from saved providers (keys masked as <unchanged>)
  // Re-init only when provider count changes; per brief, not on every data object change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional per-brief dependency
  useEffect(() => {
    if (!data) return;
    setDrafts(
      data.settings.aiProviders.map((p) => ({
        id: p.id,
        registryId: p.registryId,
        apiKey: '<unchanged>',
        baseUrl: p.baseUrl,
        model: p.model,
        isDefault: p.isDefault,
      })),
    );
  }, [data?.settings.aiProviders.length]);

  if (!data) return null;
  const { settings } = data;

  const saveProviders = (next: ProviderDraft[]) => {
    setDrafts(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void updateSettings({ aiProviders: next });
    }, 500);
  };

  const addProvider = (registryId: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const next = [
      ...drafts.map((d) => ({ ...d, isDefault: false })),
      {
        id: `p_${Date.now().toString(36)}`,
        registryId,
        apiKey: '',
        model: registry.find((r) => r.id === registryId)?.models[0] ?? '',
        isDefault: drafts.length === 0,
      },
    ];
    void updateSettings({ aiProviders: next }).then(() => setDrafts(next));
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">设置</h1>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-muted-foreground">用户信息</h2>
        <div className="mt-2 flex items-center gap-4">
          {settings.avatar && !avatarBroken ? (
            <img
              src={settings.avatar}
              alt="头像"
              className="h-14 w-14 rounded-full object-cover"
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-lg">
              {settings.userName.slice(0, 1) || '?'}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Input
              placeholder="用户名"
              defaultValue={settings.userName}
              onBlur={(e) => void updateSettings({ userName: e.target.value })}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void api()
                    .selectAvatar()
                    .then((url) => {
                      if (url) return updateSettings({ avatar: url });
                    })
                }
              >
                选择本地图片
              </Button>
              {settings.avatar && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void updateSettings({ avatar: null })}
                >
                  移除
                </Button>
              )}
            </div>
            <Input
              placeholder="或粘贴头像 URL"
              defaultValue={settings.avatar?.startsWith('http') ? settings.avatar : ''}
              onBlur={(e) =>
                e.target.value.trim() && void updateSettings({ avatar: e.target.value.trim() })
              }
            />
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">主题</h2>
        <div className="mt-2 flex gap-2">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <Button
              key={mode}
              variant={settings.theme === mode ? 'default' : 'outline'}
              onClick={() => void updateSettings({ theme: mode })}
            >
              {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
            </Button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">AI Providers</h2>
        <div className="mt-2 flex flex-col gap-3">
          {drafts.map((d) => (
            <ProviderEditor
              key={d.id}
              draft={d}
              registry={registry}
              onChange={(nd) => {
                let next = drafts.map((x) => (x.id === nd.id ? nd : x));
                if (nd.isDefault) next = next.map((x) => ({ ...x, isDefault: x.id === nd.id }));
                saveProviders(next);
              }}
              onRemove={() => saveProviders(drafts.filter((x) => x.id !== d.id))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {registry.map((r) => (
              <Button key={r.id} variant="outline" size="sm" onClick={() => addProvider(r.id)}>
                <Plus className="mr-1 h-3 w-3" />
                {r.name}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">
          AI 分析 Prompt（留空使用内置默认）
        </h2>
        <Textarea
          className="mt-2 font-mono text-xs"
          rows={6}
          placeholder={'支持占位符：{{date}} {{data}}'}
          defaultValue={settings.aiPrompt}
          onBlur={(e) => void updateSettings({ aiPrompt: e.target.value })}
        />
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.autoAiAnalyzeOnFinishDay}
            onChange={(e) => void updateSettings({ autoAiAnalyzeOnFinishDay: e.target.checked })}
          />
          Finish Day 时自动触发 AI 分析
        </label>
      </section>
    </div>
  );
}
