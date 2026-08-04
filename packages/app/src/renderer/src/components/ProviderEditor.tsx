import type { ProviderInfo } from '@tiny-schedule/shared';
import { Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import type { ProviderDraft } from '../stores/data';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function ProviderEditor({
  draft,
  registry,
  onChange,
  onRemove,
}: {
  draft: ProviderDraft;
  registry: ProviderInfo[];
  onChange: (d: ProviderDraft) => void;
  onRemove: () => void;
}) {
  const def = registry.find((r) => r.id === draft.registryId);
  const [testResult, setTestResult] = useState<string | null>(null);

  const test = async () => {
    setTestResult('测试中…');
    const res = await api().aiTestProvider(draft.id);
    setTestResult(res.ok ? '✓ 连接成功' : `✗ ${res.error ?? '连接失败'}`);
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-xs font-bold uppercase">
          {(def?.icon ?? '?').slice(0, 2)}
        </span>
        <span className="text-sm font-medium">{def?.name ?? draft.registryId}</span>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })}
          />
          默认
        </label>
        <Button variant="ghost" size="icon" aria-label="删除" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Input
          type="password"
          placeholder="API Key"
          value={draft.apiKey === '<unchanged>' ? '' : draft.apiKey}
          onChange={(e) => onChange({ ...draft, apiKey: e.target.value || '<unchanged>' })}
        />
        <Input
          placeholder="模型名，如 gpt-4o"
          list={`models-${draft.id}`}
          value={draft.model}
          onChange={(e) => onChange({ ...draft, model: e.target.value })}
        />
        <datalist id={`models-${draft.id}`}>
          {(def?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {draft.registryId === 'custom' && (
          <Input
            className="col-span-2"
            placeholder="Base URL，如 https://api.example.com/v1"
            value={draft.baseUrl ?? ''}
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          />
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void test()}>
          <Zap className="mr-1 h-3 w-3" />
          连接测试
        </Button>
        {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
      </div>
    </div>
  );
}
