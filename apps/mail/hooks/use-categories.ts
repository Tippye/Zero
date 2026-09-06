import { useSettings } from '@/hooks/use-settings';
import { normalizeMailCategories, type MailCategory } from '@zero/server/schemas';
import { m } from '@/paraglide/messages';
import { useMemo } from 'react';

export type CategorySetting = MailCategory;
export function categoryName(category: CategorySetting) {
  switch (category.builtin) {
    case 'primary': return m['mailCategories.primary']();
    case 'transactions': return m['mailCategories.transactions']();
    case 'updates': return m['mailCategories.updates']();
    case 'promotions': return m['mailCategories.promotions']();
    case 'all': return m['mailCategories.all']();
    default: return category.name;
  }
}
export function useCategorySettings(): CategorySetting[] {
  const { data } = useSettings();
  return useMemo(() => normalizeMailCategories(data?.settings.categories), [data?.settings.categories]);
}
export function useDefaultCategoryId(): string {
  const categories = useCategorySettings();
  return (categories.find(c => c.isDefault) ?? categories[0])?.id ?? 'zero-all';
}
