import { useQuery, useQueryClient } from '@tanstack/react-query';
import { mailReadRetryOptions } from '@/lib/mail-read-retry';
import { useTRPC } from '@/providers/query-provider';
import type { Outputs } from '@zero/server/trpc';
import { MailAiPanel } from './mail-ai-panel';
import { MailContent } from './mail-content';
import { useEffect, useState } from 'react';
import { m } from '@/paraglide/messages';
import { Languages } from 'lucide-react';
import { Button } from '../ui/button';

export type MailTranslation = NonNullable<Outputs['ai']['translation']>;

export function MailReader({
  threadId,
  messageId,
  html,
  subject,
  senderEmail,
  showAi,
}: {
  threadId: string;
  messageId: string;
  html: string;
  subject: string;
  senderEmail: string;
  showAi: boolean;
}) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const [translated, setTranslated] = useState(false);
  const [now, setNow] = useState(Date.now());
  const options = trpc.ai.translation.queryOptions(
    { threadId, messageId },
    {
      enabled: showAi,
      meta: { persist: false },
      staleTime: 60_000,
      ...mailReadRetryOptions,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
    },
  );
  const { data } = useQuery(options);
  const available = !!data && data.expiresAt > now;
  const translatedId = `${messageId}:translation:${data?.language || ''}`;

  useEffect(() => {
    const clearRenderedTranslation = () =>
      cache.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === 'email-content-v2' &&
          typeof query.queryKey[1] === 'string' &&
          query.queryKey[1].startsWith(`${messageId}:translation:`),
      });
    if (!data) {
      setTranslated(false);
      clearRenderedTranslation();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      clearTimeout(timer);
      setNow(Date.now());
      const remaining = data.expiresAt - Date.now();
      if (remaining <= 0) {
        setTranslated(false);
        cache.setQueryData(options.queryKey, null);
        clearRenderedTranslation();
        // This read also deletes expired rows; the sync worker cleans closed messages.
        void cache.invalidateQueries({ queryKey: options.queryKey });
      } else {
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      }
    };
    expire();
    window.addEventListener('focus', expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', expire);
    };
  }, [data, cache, threadId, messageId]);

  const onTranslated = async (value: MailTranslation) => {
    await cache.cancelQueries({ queryKey: options.queryKey });
    cache.setQueryData(options.queryKey, value);
    setNow(Date.now());
    setTranslated(true);
  };

  return (
    <>
      {showAi && (
        <MailAiPanel threadId={threadId} messageId={messageId} onTranslated={onTranslated} />
      )}
      <section
        className={available ? 'mx-4 mb-3 overflow-hidden rounded-lg border' : undefined}
        aria-label={available ? m['mailAi.translationPanel']() : undefined}
      >
        {available && (
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h3 className="min-w-0 truncate text-sm font-medium">
              {translated ? data.subject : subject}
            </h3>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              aria-pressed={translated}
              aria-label={translated ? m['mailAi.showOriginal']() : m['mailAi.showTranslation']()}
              title={translated ? m['mailAi.showOriginal']() : m['mailAi.showTranslation']()}
              onClick={() => setTranslated((value) => !value)}
            >
              <Languages className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
        <MailContent
          imagePreferenceId={messageId}
          id={available && translated ? translatedId : messageId}
          html={available && translated ? data.html : html}
          senderEmail={senderEmail}
        />
      </section>
    </>
  );
}
