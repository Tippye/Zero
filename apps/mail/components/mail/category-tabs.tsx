import { useCategorySettings, categoryName, type CategorySetting } from '@/hooks/use-categories';
import { useMailboxScope } from '@/hooks/use-mailboxes';
import useSearchLabels from '@/hooks/use-labels-search';
import { useTRPC } from '@/providers/query-provider';
import { Inbox, Receipt, Bell, Tags, Mails, Tag } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';
import { Link, useParams } from 'react-router';
import { useQueryStates, parseAsString } from 'nuqs';
import { m } from '@/paraglide/messages';
import { cn } from '@/lib/utils';
import { classificationErrorMessage } from '@/components/settings/classification-controls';

const icons = { primary: Inbox, transactions: Receipt, updates: Bell, promotions: Tags, all: Mails };
export function MailCategoryTabs() {
  const { folder } = useParams();
  const categories = useCategorySettings();
  const { labels } = useSearchLabels();
  const [, setQuery] = useQueryStates({ labels: parseAsString, threadId: parseAsString });
  const trpc = useTRPC(), accountId = useMailboxScope();
  const { data: provider } = useQuery(trpc.llm.list.queryOptions(undefined, { enabled: folder === 'inbox', staleTime: 30000, meta: { persist: false } }));
  const { data: sync } = useQuery(trpc.mailboxes.syncStatus.queryOptions({ accountId }, { enabled: folder === 'inbox', staleTime: 5000, meta: { persist: false, noGlobalError: true } }));
  const choose = (category: CategorySetting) => void setQuery({ labels: category.searchValue || null, threadId: null });
  const active = categories.find(c => {
    const filter = c.searchValue.split(',').map(s => s.trim()).filter(Boolean);
    return filter.length === labels.length && filter.every(label => labels.includes(label));
  });
  useHotkeys(['1','2','3','4','5','6','7','8','9','0'], e => {
    const category = categories[(Number(e.key) + 9) % 10];
    if (category) choose(category);
  }, { scopes: ['mail-list'], enabled: folder === 'inbox', preventDefault: true, enableOnFormTags: false }, [categories]);
  if (folder !== 'inbox') return null;
  const total = sync?.accounts.reduce((n, a) => n + (a.classificationTotal || 0), 0) || 0;
  const completed = sync?.accounts.reduce((n, a) => n + (a.classifiedCount || 0), 0) || 0;
  const failed = sync?.accounts.some(a => a.classificationError);
  const paused = !!sync?.accounts.length && sync.accounts.every(a => a.classificationPaused);
  const error = sync?.accounts.find(a => a.classificationError && !a.classificationPaused);
  return (
    <div className="shrink-0 border-b px-2 pt-2" data-mail-categories>
      <div role="tablist" aria-label={m['mailCategories.title']()} className="flex gap-1 overflow-x-auto pb-2">
        {categories.map((category, index) => {
          const Icon = category.builtin ? icons[category.builtin] : Tag;
          const selected = active?.id === category.id;
          return <button key={category.id} role="tab" type="button" aria-selected={selected}
            tabIndex={selected || (!active && index === 0) ? 0 : -1}
            onClick={() => choose(category)}
            onKeyDown={e => {
              if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
              e.preventDefault();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? categories.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
              choose(categories[next]!);
              (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }}
            className={cn('flex min-w-fit flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary', selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{categoryName(category)}
          </button>;
        })}
      </div>
      {provider && !provider.ready ? <p className="text-muted-foreground pb-2 text-xs">{m['mailCategories.configureHint']()} <Link className="text-primary whitespace-nowrap underline" to="/settings/llm">{m['mailCategories.configure']()}</Link></p>
        : sync && !sync.enabled ? <p className="text-muted-foreground pb-2 text-xs">{m['mailCategories.requiresSync']()}</p>
        : paused ? <p className="text-muted-foreground pb-2 text-xs" role="status">{m['classification.paused']()} <Link className="underline" to="/settings/llm">{m['classification.management']()}</Link></p>
        : sync && !sync.workerOnline ? <p className="text-muted-foreground pb-2 text-xs" role="status">{m['sync.offline']()}</p>
        : failed && error ? <p className="text-muted-foreground pb-2 text-xs" role="status">{classificationErrorMessage(error.classificationError!)}{' '}{error.classificationRetryAt && m['classification.retry']({ time: new Date(error.classificationRetryAt).toLocaleTimeString() })} <Link className="text-primary whitespace-nowrap underline" to="/settings/llm">{m['classification.management']()}</Link></p>
        : completed < total ? <p className="text-muted-foreground pb-2 text-xs" role="status">{m['mailCategories.progress']({ completed, total })}</p> : null}
    </div>
  );
}
