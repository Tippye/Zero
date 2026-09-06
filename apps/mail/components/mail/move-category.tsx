import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { categoryName, useCategorySettings } from '@/hooks/use-categories';
import { useTRPC } from '@/providers/query-provider';
import { Check, FolderInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

export function MoveCategory({ threadId }: { threadId: string }) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const categories = useCategorySettings();
  const { data } = useQuery(
    trpc.mailboxes.category.queryOptions({ id: threadId }, { meta: { persist: false } }),
  );
  const move = useMutation(
    trpc.mailboxes.moveCategory.mutationOptions({
      onSuccess: async () => {
        toast.success(m['mailCategories.moved']());
        await Promise.all([
          cache.invalidateQueries({ queryKey: trpc.mailboxes.category.queryKey() }),
          cache.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() }),
          cache.invalidateQueries({ queryKey: trpc.mailboxes.syncStatus.queryKey() }),
        ]);
      },
      onError: () => toast.error(m['mailCategories.moveFailed']()),
    }),
  );
  if (!data?.enabled) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1.5"
          disabled={move.isPending}
          aria-label={m['mailCategories.moveTo']()}
          title={m['mailCategories.moveTo']()}
        >
          <FolderInput className="h-4 w-4" />
          <span className="hidden lg:inline">{m['mailCategories.moveTo']()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {categories.map((category) => {
          const destination = category.builtin;
          if (!destination || destination === 'all') return null;
          return (
            <DropdownMenuItem
              key={category.id}
              disabled={move.isPending || data.category === destination}
              onSelect={() => move.mutate({ id: threadId, category: destination })}
            >
              <span className="flex-1">{categoryName(category)}</span>
              {data.category === destination && <Check className="ml-2 h-4 w-4" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
