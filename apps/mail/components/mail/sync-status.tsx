import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMailboxScope } from '@/hooks/use-mailboxes';
import { useTRPC } from '@/providers/query-provider';
import { useEffect, useRef } from 'react';
import { m } from '@/paraglide/messages';
export function MailSyncStatus() {
  const trpc = useTRPC(),
    cache = useQueryClient(),
    accountId = useMailboxScope();
  const { data } = useQuery(
    trpc.mailboxes.syncStatus.queryOptions(
      { accountId },
      { refetchInterval: 5000, meta: { persist: false, noGlobalError: true } },
    ),
  );
  const sync = useMutation(
    trpc.mailboxes.syncNow.mutationOptions({
      onSuccess: () => cache.invalidateQueries({ queryKey: trpc.mailboxes.syncStatus.queryKey() }),
    }),
  );
  const stamp = (data?.accounts || [])
      .map((a) => a.accountId + ':' + a.lastSyncedAt + ':' + a.cachedCount + ':' + a.classificationUpdatedAt + ':' + a.classifiedCount)
      .join('|'),
    previous = useRef('');
  useEffect(() => {
    if (previous.current && previous.current !== stamp)
      void cache.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() });
    previous.current = stamp;
  }, [stamp, cache, trpc]);
  if (!data?.enabled || !data.accounts.length) return null;
  const syncing = data.accounts.some(
    (a) => a.status === 'syncing' || a.status === 'pending' || a.queued,
  );
  const failures = data.accounts.filter((a) => a.status === 'error');
  const last = data.accounts
    .map((a) => a.lastSyncedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return (
    <div className="mx-2 mt-2 rounded border px-3 py-2 text-xs" role="status">
      <div className="flex items-center justify-between gap-2">
        <span>
          {!data.workerOnline
            ? m['sync.offline']()
            : syncing
              ? m['sync.syncing']()
              : m['sync.local']()}
        </span>
        <button
          className="shrink-0 underline disabled:opacity-50"
          disabled={sync.isPending || syncing || !data.workerOnline}
          onClick={() => sync.mutate({ accountId })}
        >
          {m['sync.now']()}
        </button>
      </div>
      <p className="text-muted-foreground mt-1">
        {last ? m['sync.updated']({ time: new Date(last).toLocaleString() }) : m['sync.initial']()}
      </p>
      {failures.map((a) => (
        <p key={a.accountId} className="mt-1">
          {a.email}：
          {a.errorCode === 'RATE_LIMIT'
            ? m['mailboxes.rateLimited']()
            : a.errorCode === 'DISCONNECTED'
              ? m['mailboxes.reconnect']()
              : m['sync.failed']()}
        </p>
      ))}
      {sync.isError && <p>{m['sync.failed']()}</p>}
    </div>
  );
}
