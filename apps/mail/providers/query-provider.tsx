import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import {
  QueryCache,
  QueryClient,
  hashKey,
  defaultShouldDehydrateQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, splitLink } from '@trpc/client';
import { splitMailboxId } from '../../server/src/lib/mailboxes/ids';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useMemo, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { CACHE_BURST_KEY } from '@/lib/constants';
import { showLlmSetup } from '@/lib/llm-notice';
import { signOut } from '@/lib/auth-client';
import { bimiLink } from '@/lib/bimi-link';
import { get, set, del } from 'idb-keyval';
import superjson from 'superjson';

function createIDBPersister(idbValidKey: IDBValidKey = 'zero-query-cache') {
  return {
    persistClient: async (client: PersistedClient) => {
      await set(idbValidKey, client);
    },
    restoreClient: async () => {
      return await get<PersistedClient>(idbValidKey);
    },
    removeClient: async () => {
      await del(idbValidKey);
    },
  } satisfies Persister;
}

export const makeQueryClient = (connectionId: string | null) =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (err, { meta }) => {
        if (meta && meta.noGlobalError === true) return;
        if (meta && typeof meta.customError === 'string') console.error(meta.customError);
        else if (
          err.message === 'Required scopes missing' ||
          err.message.includes('Invalid connection')
        ) {
          signOut({
            fetchOptions: {
              onSuccess: () => {
                if (window.location.href.includes('/login')) return;
                window.location.href = '/login?error=required_scopes_missing';
              },
            },
          });
        } else console.error(err.message || 'Something went wrong');
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        queryKeyHashFn: (queryKey) => hashKey([{ connectionId }, ...queryKey]),
        gcTime: 1000 * 60 * 60 * 24, // 24 hours,
      },
      mutations: {
        onError: (err) => console.error(err.message),
      },
    },
  });

let browserQueryClient = {
  queryClient: null,
  activeConnectionId: null,
} as {
  queryClient: QueryClient | null;
  activeConnectionId: string | null;
};

const getQueryClient = (connectionId: string | null) => {
  if (typeof window === 'undefined') {
    return makeQueryClient(connectionId);
  } else {
    if (!browserQueryClient.queryClient || browserQueryClient.activeConnectionId !== connectionId) {
      browserQueryClient.queryClient = makeQueryClient(connectionId);
      browserQueryClient.activeConnectionId = connectionId;
    }
    return browserQueryClient.queryClient;
  }
};

const getUrl = () => import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/trpc';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.path.startsWith('bimi.'),
      true: bimiLink(getUrl()),
      false: httpBatchLink({
        transformer: superjson,
        headers: () => {
          const params = new URLSearchParams(window.location.search);
          const messageAccount = splitMailboxId(
            params.get('threadId') || params.get('draftId') || '',
          )?.accountId;
          return {
            'X-Mailbox-Account':
              messageAccount || params.get('senderId') || params.get('accountId') || 'all',
          };
        },
        url: getUrl(),
        methodOverride: 'POST',
        maxItems: 1,
        fetch: (url, options) =>
          fetch(url, { ...options, credentials: 'include' }).then(async (res) => {
            if (!res.ok && (await res.clone().text()).includes('LLM_NOT_CONFIGURED'))
              showLlmSetup();
            const currentPath = new URL(window.location.href).pathname;
            const redirectPath = res.headers.get('X-Zero-Redirect');
            if (!!redirectPath && redirectPath !== currentPath) {
              window.location.href = redirectPath;
              res.headers.delete('X-Zero-Redirect');
            }
            return res;
          }),
      }),
    }),
  ],
});

type TrpcHook = ReturnType<typeof useTRPC>;
export function QueryProvider({
  children,
  connectionId,
}: PropsWithChildren<{ connectionId: string | null }>) {
  const persister = useMemo(
    () => createIDBPersister(`zero-query-cache-${connectionId ?? 'default'}`),
    [connectionId],
  );
  const queryClient = useMemo(() => getQueryClient(connectionId), [connectionId]);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        buster: CACHE_BURST_KEY,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            query.meta?.persist !== false && defaultShouldDehydrateQuery(query),
        },
      }}
      onSuccess={() => {
        const threadQueryKey = [['mail', 'listThreads'], { type: 'infinite' }];
        queryClient.setQueriesData(
          { queryKey: threadQueryKey },
          (data: InfiniteData<TrpcHook['mail']['listThreads']['~types']['output']>) => {
            if (!data) return data;
            // We only keep few pages of threads in the cache before we invalidate them
            // invalidating will attempt to refetch every page that was in cache, if someone have too many pages in cache, it will refetch every page every time
            // We don't want that, just keep like 3 pages (20 * 3 = 60 threads) in cache
            return {
              pages: data.pages.slice(0, 3),
              pageParams: data.pageParams.slice(0, 3),
            };
          },
        );
        // invalidate the query, it will refetch when the data is it is being accessed
        queryClient.invalidateQueries({ queryKey: threadQueryKey });
      }}
    >
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}
