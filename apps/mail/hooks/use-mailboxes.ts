import { useSession } from '@/lib/auth-client';
import { splitMailboxId } from '../../server/src/lib/mailboxes/ids';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { useQueryState } from 'nuqs';
export { splitMailboxId };
export function useMailboxes() {
  const trpc = useTRPC();
  const { data: session } = useSession();
  return useQuery(
    trpc.mailboxes.accounts.queryOptions({ workspaceId: session?.user.id }, {
      enabled: !!session?.user.id,
      staleTime: 30_000,
      meta: { persist: false },
    }),
  );
}
export function useMailboxScope() {
  const [accountId] = useQueryState('accountId');
  const location = useLocation();
  if (accountId) return accountId;
  if (location.pathname.startsWith('/settings')) {
    const from = new URLSearchParams(location.search).get('from');
    if (from?.startsWith('/mail/'))
      return new URL(from, 'http://localhost').searchParams.get('accountId') || undefined;
  }
  return undefined;
}
export function useComposerMailbox() {
  const [accountId] = useQueryState('accountId');
  const [draftId] = useQueryState('draftId');
  const [threadId] = useQueryState('threadId');
  const [senderId, setSenderId] = useQueryState('senderId');
  const { data: accounts = [] } = useMailboxes();
  const id = splitMailboxId(draftId || threadId || '')?.accountId || senderId || accountId;
  const account =
    accounts.find((a) => a.id === id) || (!id ? accounts.find((a) => a.connected) : undefined);
  return { account, accounts, setSenderId };
}
