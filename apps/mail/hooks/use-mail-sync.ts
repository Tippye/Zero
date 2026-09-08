import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMailboxScope } from './use-mailboxes';
import { useTRPC } from '@/providers/query-provider';
import { useEffect, useRef, useCallback } from 'react';

// Mount once in the visible mail list. Categories share this query's live status.
export function useMailSync() {
  const trpc = useTRPC(), cache = useQueryClient(), accountId = useMailboxScope();
  const { data } = useQuery(trpc.mailboxes.syncStatus.queryOptions({ accountId }, {
    refetchInterval: (query) => query.state.error ? 30000 : query.state.data?.accounts.some(a => a.queued || a.status === 'syncing' || a.classificationRunning) ? 5000 : 30000,
    staleTime: 5000, retry: false, meta: { persist: false, noGlobalError: true },
  }));
  const sync = useMutation(trpc.mailboxes.syncNow.mutationOptions({
    onSuccess: () => cache.invalidateQueries({ queryKey: trpc.mailboxes.syncStatus.pathKey() }),
  }));
  const stamp = JSON.stringify(data?.accounts.map(a => [a.accountId, a.status, a.errorCode,
    a.folderErrors, a.lastSyncedAt, a.cachedCount, a.classificationUpdatedAt, a.classifiedCount]));
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previous.current && previous.current !== stamp)
      void cache.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() });
    previous.current = stamp;
  }, [stamp, cache, trpc]);
  const synchronize = useCallback(async () => {
    if (data?.enabled) await sync.mutateAsync({ accountId });
  }, [data?.enabled, sync.mutateAsync, accountId]);
  return { synchronize, isPending: sync.isPending || !!data?.accounts.some(a => a.queued || a.status === 'syncing') };
}
