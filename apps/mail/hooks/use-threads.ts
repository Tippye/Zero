import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useMailboxScope, useMailboxes, splitMailboxId } from './use-mailboxes';
import type { IGetThreadResponse } from '../../server/src/lib/driver/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { mailReadRetryOptions } from '@/lib/mail-read-retry';
import { useSearchValue } from '@/hooks/use-search-value';
import { useTRPC } from '@/providers/query-provider';
import useSearchLabels from './use-labels-search';
import { useSession } from '@/lib/auth-client';
import { useAtom, useAtomValue } from 'jotai';
import { useParams } from 'react-router';
import { useMemo } from 'react';

export const useThreads = () => {
  const accountId = useMailboxScope();
  const mailboxQuery = useMailboxes();
  const { folder } = useParams<{ folder: string }>();
  const { data: session } = useSession();
  const [searchValue] = useSearchValue();
  const [backgroundQueue] = useAtom(backgroundQueueAtom);
  const isInQueue = useAtomValue(isThreadInBackgroundQueueAtom);
  const trpc = useTRPC();
  const { labels } = useSearchLabels();

  const threadsQuery = useInfiniteQuery(
    trpc.mail.listThreads.infiniteQueryOptions(
      {
        accountId,
        q: searchValue.value,
        folder,
        labelIds: labels,
      },
      {
        // Global hotkeys and the command palette also mount on settings pages.
        enabled: !!folder && !!session?.user.id,
        trpc: { abortOnUnmount: true },
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        staleTime: 60 * 1000 * 1, // 1 minute
        refetchOnMount: true,
        refetchIntervalInBackground: true,
      },
    ),
  );

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo(() => {
    return threadsQuery.data
      ? threadsQuery.data.pages
          .flatMap((e) => e.threads)
          .filter(Boolean)
          .filter((item) =>
            mailboxQuery.data?.some(
              (account) =>
                account.id ===
                ((item as { accountId?: string }).accountId || splitMailboxId(item.id)?.accountId),
            ),
          )
          .filter((e) => !isInQueue(`thread:${e.id}`))
      : [];
  }, [
    threadsQuery.data,
    threadsQuery.dataUpdatedAt,
    isInQueue,
    backgroundQueue,
    mailboxQuery.data,
  ]);

  const isEmpty = useMemo(() => threads.length === 0, [threads]);
  const isReachingEnd =
    isEmpty ||
    (threadsQuery.data &&
      !threadsQuery.data.pages[threadsQuery.data.pages.length - 1]?.nextPageToken);

  const loadMore = async () => {
    if (threadsQuery.isLoading || threadsQuery.isFetching) return;
    await threadsQuery.fetchNextPage();
  };

  return [
    { ...threadsQuery, isLoading: threadsQuery.isLoading || mailboxQuery.isLoading },
    threads,
    isReachingEnd,
    loadMore,
  ] as const;
};

export const useThread = (threadId: string | null, preview?: IGetThreadResponse) => {
  const { folder } = useParams<{ folder: string }>();
  const { data: session } = useSession();
  const id = threadId;
  const trpc = useTRPC();

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
        ...(folder === 'sent' ? { fresh: true } : {}),
      },
      {
        enabled: !!id && !!session?.user.id && !preview,
        placeholderData: preview,
        trpc: { abortOnUnmount: false },
        ...mailReadRetryOptions,
        staleTime: folder === 'sent' ? 30_000 : 1000 * 60 * 60,
        // Nested readers share fresh data; exhausted retries require user action.
        refetchOnMount: true,
      },
    ),
  );

  const threadData = preview || threadQuery.data;
  const { latestDraft, isGroupThread, finalData } = useMemo(() => {
    if (!threadData) {
      return {
        latestDraft: undefined,
        isGroupThread: false,
        finalData: undefined,
      };
    }

    const latestDraft = threadData.latest?.id
      ? threadData.messages.findLast((e) => e.isDraft)
      : undefined;

    const isGroupThread = threadData.latest?.id
      ? (() => {
          const totalRecipients = [
            ...(threadData.latest.to || []),
            ...(threadData.latest.cc || []),
            ...(threadData.latest.bcc || []),
          ].length;
          return totalRecipients > 1;
        })()
      : false;

    const nonDraftMessages = threadData.messages.filter((e) => !e.isDraft);

    const finalData: IGetThreadResponse = {
      ...threadData,
      messages: nonDraftMessages,
    };

    return { latestDraft, isGroupThread, finalData };
  }, [threadData]);

  return { ...threadQuery, data: finalData, isGroupThread, latestDraft };
};
