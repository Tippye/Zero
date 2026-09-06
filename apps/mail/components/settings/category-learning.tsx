import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { useSettings } from '@/hooks/use-settings';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

export function CategoryLearning() {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const { data, isPending } = useSettings();
  const save = useMutation(
    trpc.settings.save.mutationOptions({
      onSuccess: () => cache.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
      onError: () => toast.error(m['mailCategories.learningSaveFailed']()),
    }),
  );
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor="ai-category-learning">{m['mailCategories.learning']()}</Label>
        <p id="ai-category-learning-description" className="text-muted-foreground text-sm">
          {m['mailCategories.learningDescription']()}
        </p>
      </div>
      <Switch
        id="ai-category-learning"
        aria-describedby="ai-category-learning-description"
        checked={data?.settings.aiCategoryLearning ?? false}
        disabled={isPending || !data || save.isPending}
        onCheckedChange={(aiCategoryLearning) => save.mutate({ aiCategoryLearning })}
      />
    </div>
  );
}
