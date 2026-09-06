import { useMailboxes, useMailboxScope } from './use-mailboxes';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';

export const useConnections = () => {
  const trpc = useTRPC();
  const connectionsQuery = useQuery(trpc.connections.list.queryOptions());
  return connectionsQuery;
};

export const useActiveConnection = () => {
  const query = useMailboxes();
  const accountId = useMailboxScope();
  return { ...query, data: query.data?.find(a => a.id === accountId) || null };
};
