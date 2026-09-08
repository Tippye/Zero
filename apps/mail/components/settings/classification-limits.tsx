import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import type { Outputs } from '@zero/server/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { m } from '@/paraglide/messages';
import { useId, useState } from 'react';
import { toast } from 'sonner';

type Settings = Outputs['mailboxes']['classificationSettings']['settings'];
type Draft = Record<keyof Settings, string>;
const toDraft = (settings: Settings) =>
  Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value)])) as Draft;

export function ClassificationLimits() {
  const trpc = useTRPC(),
    cache = useQueryClient(),
    id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const query = useQuery(
    trpc.mailboxes.classificationSettings.queryOptions(undefined, {
      staleTime: 30000,
      retry: false,
      meta: { persist: false, noGlobalError: true },
    }),
  );
  const save = useMutation(
    trpc.mailboxes.saveClassificationSettings.mutationOptions({
      onSuccess: ({ settings }) => {
        cache.setQueryData(trpc.mailboxes.classificationSettings.queryKey(), (previous) =>
          previous ? { ...previous, settings } : previous,
        );
        setDraft(null);
        void cache.invalidateQueries({ queryKey: trpc.mailboxes.syncStatus.pathKey() });
        toast.success(m['classificationLimits.saved']());
      },
      onError: () => toast.error(m['classificationLimits.saveFailed']()),
    }),
  );
  const fields = [
    { key: 'concurrency', label: m['classificationLimits.concurrency'](), min: 1, max: 4 },
    { key: 'batch_size', label: m['classificationLimits.batchSize'](), min: 1, max: 50 },
    { key: 'interval_seconds', label: m['classificationLimits.interval'](), min: 2, max: 3600 },
    { key: 'timeout_seconds', label: m['classificationLimits.timeout'](), min: 5, max: 120 },
    { key: 'recent_days', label: m['classificationLimits.recentDays'](), min: 1, max: 365 },
    {
      key: 'history_every_batches',
      label: m['classificationLimits.historyEvery'](),
      min: 1,
      max: 100,
    },
  ] as const;
  const data = query.data;
  if (query.isError)
    return (
      <div role="alert" className="space-y-2 border-t pt-4">
        <p className="text-sm">{m['classificationLimits.loadFailed']()}</p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          {m['pages.settings.retry']()}
        </Button>
      </div>
    );
  if (!data)
    return (
      <p role="status" className="text-sm">
        {m['common.actions.loading']()}
      </p>
    );
  if (!data.enabled) return null;
  const value = draft || toDraft(data.settings);
  const valid = fields.every(
    ({ key, min, max }) =>
      value[key].trim() !== '' &&
      Number.isInteger(Number(value[key])) &&
      Number(value[key]) >= min &&
      Number(value[key]) <= max,
  );
  const dirty = fields.some(({ key }) => Number(value[key]) !== data.settings[key]);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 border-t pt-4"
      data-classification-limits
    >
      <div className="space-y-1">
        <h3 id={`${id}-title`} className="text-sm font-medium">
          {m['classificationLimits.title']()}
        </h3>
        <p className="text-muted-foreground text-sm">{m['classificationLimits.description']()}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!valid || !dirty || save.isPending) return;
          save.mutate(
            Object.fromEntries(fields.map(({ key }) => [key, Number(value[key])])) as Settings,
          );
        }}
        className="space-y-4"
      >
        <fieldset disabled={save.isPending} className="grid gap-4 md:grid-cols-2">
          <legend className="sr-only">{m['classificationLimits.title']()}</legend>
          {fields.map(({ key, label, min, max }) => (
            <label key={key} className="space-y-2 text-sm">
              <span>{label}</span>
              <Input
                type="number"
                name={key}
                required
                min={min}
                max={max}
                step={1}
                value={value[key]}
                aria-describedby={`${id}-${key}-range`}
                onChange={(event) => setDraft({ ...value, [key]: event.target.value })}
              />
              <span id={`${id}-${key}-range`} className="text-muted-foreground block text-xs">
                {min}–{max}
              </span>
            </label>
          ))}
        </fieldset>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {valid
            ? m['classificationLimits.summary']({
                count: Number(value.concurrency) * Number(value.batch_size),
              })
            : m['classificationLimits.invalid']()}
        </p>
        <p className="text-muted-foreground text-sm">{m['classificationLimits.priorityHint']()}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!valid || !dirty || save.isPending}>
            {save.isPending ? m['classificationLimits.saving']() : m['classificationLimits.save']()}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => setDraft(toDraft(data.defaults))}
          >
            {m['classificationLimits.defaults']()}
          </Button>
        </div>
      </form>
    </section>
  );
}
