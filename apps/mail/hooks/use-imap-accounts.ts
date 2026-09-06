import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { useSession } from '@/lib/auth-client';

export function useImapAccounts() {
  const trpc = useTRPC();
  const { data: session } = useSession();
  return useQuery(trpc.imap.accounts.queryOptions(undefined, {
    enabled: !!session?.user.id,
    retry: false,
    gcTime: 0,
    meta: { persist: false },
    trpc: { abortOnUnmount: true },
  }));
}
