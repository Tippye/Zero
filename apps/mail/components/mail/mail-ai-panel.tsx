import { FileText, Languages, MessageCircle, Sparkles, X } from 'lucide-react';
import { useTRPCClient } from '@/providers/query-provider';
import { useEffect, useId, useRef, useState } from 'react';
import type { MailTranslation } from './mail-reader';
import { getLocale } from '@/paraglide/runtime';
import { useEnsureLlm } from '@/hooks/use-llm';
import { Textarea } from '../ui/textarea';
import { m } from '@/paraglide/messages';
import { Button } from '../ui/button';
import { locales } from '@/locales';

type Action = 'ask' | 'summary' | 'translate';
type Turn = { question: string; answer: string };

export function MailAiPanel({
  threadId,
  messageId,
  onTranslated,
}: {
  threadId: string;
  messageId: string;
  onTranslated: (translation: MailTranslation) => void | Promise<void>;
}) {
  const client = useTRPCClient();
  const ensureLlm = useEnsureLlm();
  const panelId = useId();
  const [action, setAction] = useState<Action | null>(null);
  const [language, setLanguage] = useState<string>(getLocale());
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  const labels = {
    ask: m['mailAi.ask'](),
    summary: m['mailAi.summary'](),
    translate: m['mailAi.translate'](),
  };
  const icons = { ask: MessageCircle, summary: FileText, translate: Languages };

  const run = async (next: Action) => {
    if (request.current || (next === 'ask' && !question.trim())) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      if (!(await ensureLlm()) || controller.signal.aborted) return;
      const result = await client.ai.read.mutate(
        {
          threadId,
          messageId,
          action: next,
          language,
          question: next === 'ask' ? question.trim() : '',
          history: next === 'ask' ? turns.slice(-6) : [],
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (next === 'translate' && result.translation) {
        await onTranslated(result.translation);
        setAction(null);
      } else if (next === 'ask') {
        setTurns((previous) => [...previous, { question: question.trim(), answer: result.text }]);
        setQuestion('');
      } else {
        setResults((previous) => ({ ...previous, [`${next}:${language}`]: result.text }));
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : '';
      setError(
        message.includes('MAIL_AI_EMPTY')
          ? m['mailAi.empty']()
          : message.includes('MAIL_AI_TOO_LONG') || message.includes('MAIL_AI_OUTPUT_TOO_LONG')
            ? m['mailAi.tooLong']()
            : m['mailAi.failed'](),
      );
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  const stop = () => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
  };

  return (
    <section
      className="mx-4 mb-3 rounded-lg border"
      aria-label={m['mailAi.title']()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1 p-2">
        <Sparkles className="text-muted-foreground mx-1 h-4 w-4" aria-hidden="true" />
        {(['ask', 'summary', 'translate'] as const).map((item) => {
          const Icon = icons[item];
          return (
            <Button
              key={item}
              type="button"
              size="xs"
              variant={action === item ? 'secondary' : 'ghost'}
              disabled={busy}
              aria-expanded={action === item}
              aria-controls={panelId}
              onClick={() => {
                setAction(item);
                setError('');
                if (item === 'summary' && !results[`summary:${language}`]) void run(item);
              }}
            >
              <Icon aria-hidden="true" />
              {labels[item]}
            </Button>
          );
        })}
        {action && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ms-auto"
            aria-label={m['common.actions.close']()}
            onClick={() => {
              stop();
              setAction(null);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {action && (
        <div id={panelId} className="space-y-3 border-t p-3">
          <p className="text-muted-foreground text-xs">{m['mailAi.scope']()}</p>
          <label className="flex items-center gap-2 text-xs">
            {m['mailAi.language']()}
            <select
              value={language}
              disabled={busy}
              className="bg-background rounded-md border px-2 py-1 text-sm"
              onChange={(event) => {
                setLanguage(event.target.value);
                setError('');
              }}
            >
              {Object.entries(locales).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div
            aria-live="polite"
            aria-busy={busy}
            className="max-h-80 space-y-3 overflow-y-auto text-sm"
          >
            {action === 'ask'
              ? turns.map((turn, index) => (
                  <div key={index} className="space-y-2">
                    <p className="bg-muted whitespace-pre-wrap break-words rounded-md p-2 font-medium">
                      {turn.question}
                    </p>
                    <p className="whitespace-pre-wrap break-words" dir="auto">
                      {turn.answer}
                    </p>
                  </div>
                ))
              : results[`${action}:${language}`] && (
                  <p className="whitespace-pre-wrap break-words" dir="auto">
                    {results[`${action}:${language}`]}
                  </p>
                )}
            {busy && (
              <p role="status" className="text-muted-foreground">
                {m['mailAi.working']()}
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {action === 'ask' ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run('ask');
              }}
            >
              <Textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                disabled={busy}
                maxLength={2000}
                rows={2}
                aria-label={m['mailAi.question']()}
                placeholder={m['mailAi.question']()}
              />
              <div className="flex gap-2">
                <Button type="submit" size="xs" disabled={busy || !question.trim()}>
                  {m['mailAi.send']()}
                </Button>
                {!!turns.length && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setTurns([]);
                      setError('');
                    }}
                  >
                    {m['mailAi.clear']()}
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <Button type="button" size="xs" disabled={busy} onClick={() => void run(action)}>
              {results[`${action}:${language}`] ? m['mailAi.regenerate']() : labels[action]}
            </Button>
          )}
          {busy && (
            <Button type="button" size="xs" variant="ghost" onClick={stop}>
              {m['mailAi.stop']()}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
