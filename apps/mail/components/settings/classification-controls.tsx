import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClassificationLimits } from './classification-limits';
import { useTRPC } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { SettingsCard } from './settings-card';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

export function classificationErrorMessage(code: string) {
  if (code === 'INVALID_RESPONSE') return m['classification.invalid']();
  if (code === 'OUTPUT_LIMIT') return m['classification.outputLimit']();
  if (code === 'AUTH_FAILED' || code === 'CONFIGURATION') return m['classification.auth']();
  if (code === 'RATE_LIMIT') return m['classification.rateLimit']();
  if (code === 'TIMEOUT') return m['classification.timeout']();
  return m['classification.provider']();
}

export function ClassificationControls() {
  return (
    <SettingsCard
      title={m['classification.title']()}
      description={m['classification.description']()}
    >
      <div className="space-y-4">
        <ClassificationStatus />
        <ClassificationLimits />
      </div>
    </SettingsCard>
  );
}

function ClassificationStatus() {
  const trpc = useTRPC(),
    cache = useQueryClient();
  const { data, isError } = useQuery(
    trpc.mailboxes.syncStatus.queryOptions(
      {},
      {
        refetchInterval: (query) =>
          query.state.error
            ? 30000
            : query.state.data?.accounts.some((a) => a.classificationRunning)
              ? 5000
              : 30000,
        staleTime: 5000,
        retry: false,
        meta: { persist: false, noGlobalError: true },
      },
    ),
  );
  const { data: provider } = useQuery(
    trpc.llm.list.queryOptions(undefined, {
      meta: { persist: false },
    }),
  );
  const control = useMutation(
    trpc.mailboxes.classify.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries({ queryKey: trpc.mailboxes.syncStatus.pathKey() });
        void cache.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() });
      },
      onError: () => toast.error(m['classification.failed']()),
    }),
  );
  if (!data?.enabled)
    return isError ? <p role="alert">{m['classification.loadFailed']()}</p> : null;
  const total = data.accounts.reduce((n, a) => n + a.classificationTotal, 0);
  const completed = data.accounts.reduce((n, a) => n + a.classifiedCount, 0);
  const paused = data.accounts.length > 0 && data.accounts.every((a) => a.classificationPaused);
  const running = data.accounts.some((a) => a.classificationRunning);
  return (
    <div className="space-y-3" data-classification-controls>
      <p role="status" className="text-sm">
        {!data.classifierOnline
          ? m['sync.offline']()
          : paused
            ? m['classification.paused']()
            : !total
              ? m['classification.noMail']()
              : completed === total
                ? m['classification.complete']()
                : running
                  ? m['classification.running']()
                  : m['classification.waiting']()}
      </p>
      <progress
        aria-label={m['classification.title']()}
        value={completed}
        max={total || 1}
        className="accent-primary h-3 w-full"
      />
      <p className="text-muted-foreground text-sm">
        {m['mailCategories.progress']({ completed, total })}
      </p>
      {data.accounts
        .filter((a) => a.classificationError && !a.classificationPaused)
        .map((a) => (
          <p key={a.accountId} className="text-sm" role="status">
            {a.email}：{classificationErrorMessage(a.classificationError!)}{' '}
            {data.classifierOnline &&
              a.classificationRetryAt &&
              m['classification.retry']({
                time: new Date(a.classificationRetryAt).toLocaleTimeString(),
              })}
          </p>
        ))}
      {!provider?.ready && (
        <p className="text-muted-foreground text-sm">{m['mailCategories.configureHint']()}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={
            control.isPending || !total || !provider?.ready || !data.classifierOnline || running
          }
          onClick={() =>
            control.mutate({ action: !paused && total === completed ? 'restart' : 'start' })
          }
        >
          {paused
            ? m['classification.resume']()
            : total > 0 && total === completed
              ? m['classification.restart']()
              : m['classification.start']()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={control.isPending || paused || !total}
          onClick={() => control.mutate({ action: 'pause' })}
        >
          {m['classification.pause']()}
        </Button>
      </div>
    </div>
  );
}
