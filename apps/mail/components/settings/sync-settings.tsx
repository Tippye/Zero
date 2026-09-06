import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { SettingsCard } from './settings-card';
import { Input } from '@/components/ui/input';
import { useEffect, useState } from 'react';
import { m } from '@/paraglide/messages';
export function useSyncSettings() {
  const trpc = useTRPC(),
    cache = useQueryClient();
  const { data, isError } = useQuery(
    trpc.mailboxes.syncSettings.queryOptions(undefined, { meta: { persist: false } }),
  );
  const [value, setValue] = useState({
    max_messages: 500,
    max_age_days: 90,
    body_budget_mb: 50,
    interval_seconds: 120,
  });
  useEffect(() => {
    if (data?.settings) setValue(data.settings);
  }, [data]);
  const save = useMutation(
    trpc.mailboxes.saveSyncSettings.mutationOptions({
      onSuccess: () => {
        void cache.invalidateQueries({ queryKey: trpc.mailboxes.syncSettings.queryKey() });
        void cache.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() });
        void cache.invalidateQueries({ queryKey: trpc.ai.translation.pathKey() });
      },
    }),
  );
  return {
    data,
    isError,
    value,
    setValue,
    isSaving: save.isPending,
    save: async () => {
      if (data?.enabled && JSON.stringify(value) !== JSON.stringify(data.settings)) {
        await save.mutateAsync(value);
      }
    },
  };
}

export function SyncSettings({ settings }: { settings: ReturnType<typeof useSyncSettings> }) {
  const { data, isError, value, setValue } = settings;
  if (!data?.enabled) return isError ? <p>{m['sync.failed']()}</p> : null;
  const fields = [
    { key: 'max_messages', label: m['sync.maxMessages'](), min: 50, max: 5000 },
    { key: 'max_age_days', label: m['sync.maxDays'](), min: 7, max: 3650 },
    { key: 'body_budget_mb', label: m['sync.maxBody'](), min: 5, max: 1024 },
    { key: 'interval_seconds', label: m['sync.interval'](), min: 60, max: 3600 },
  ] as const;
  return (
    <SettingsCard title={m['sync.title']()} description={m['sync.description']()}>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {fields.map((f) => (
            <label key={f.key} className="space-y-2 text-sm">
              <span>{f.label}</span>
              <Input
                type="number"
                required
                min={f.min}
                max={f.max}
                step={1}
                value={value[f.key]}
                onChange={(e) => setValue((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
              />
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">{m['sync.localOnly']()}</p>
        <p className="text-muted-foreground text-sm">{m['sync.searchHint']()}</p>
      </div>
    </SettingsCard>
  );
}
