import { splitMailboxId, useMailboxes } from './use-mailboxes';
import { mailReadRetryOptions } from '@/lib/mail-read-retry';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import type { Attachment } from '@/types';

export const useAttachments = (messageId: string, included: Attachment[] = []) => {
  const { data: accounts } = useMailboxes();
  const accountId = splitMailboxId(messageId)?.accountId;
  const account = accounts?.find((account) => account.id === accountId);
  const isImap = account?.providerId === 'imap';
  const { data: session } = useSession();
  const trpc = useTRPC();
  const AttachmentsQuery = useQuery(
    trpc.mail.getMessageAttachments.queryOptions(
      { messageId },
      {
        enabled: !!session?.user.id && !!messageId && !!account && !isImap,
        staleTime: 1000 * 60 * 60,
        ...mailReadRetryOptions,
      },
    ),
  );

  return { ...AttachmentsQuery, data: isImap ? included : AttachmentsQuery.data };
};
