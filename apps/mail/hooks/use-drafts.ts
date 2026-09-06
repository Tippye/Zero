import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';

export const useDraft = (id: string | null, preview?: import('../../server/src/lib/driver/types').ParsedDraft) => {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const draftQuery = useQuery(
    trpc.drafts.get.queryOptions(
      { id: id! },
      { enabled: !!session?.user.id && !!id && !preview, placeholderData: preview, staleTime: 1000 * 60 * 60 },
    ),
  );
  return draftQuery;
};
