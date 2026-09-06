import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useComposerMailbox } from './use-mailboxes';

export function useEmailAliases() {
  const trpc = useTRPC();
  const { account: connection } = useComposerMailbox();
  const emailAliasesQuery = useQuery(
    trpc.mail.getEmailAliases.queryOptions({ accountId: connection?.id }, {
      enabled: !!connection?.id,
      trpc: { abortOnUnmount: true },
      initialData: [] as { email: string; name: string; primary?: boolean }[],
    }),
  );
  return emailAliasesQuery;
}
