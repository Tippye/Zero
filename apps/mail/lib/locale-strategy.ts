import { defineCustomClientStrategy, locales, type Locale } from '@/paraglide/runtime';

// Paraglide 2.1's preferredLanguage strategy lowercases browser tags before an
// exact comparison, so it cannot match region tags such as zh-CN and zh-TW.
function preferredLocale(languages: readonly string[]): Locale | undefined {
  for (const language of languages) {
    const tag = language.toLowerCase();
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;

    if (tag === 'zh' || tag.startsWith('zh-')) {
      const parts = tag.split('-');
      if (parts.includes('hant')) return 'zh-TW';
      if (parts.includes('hans')) return 'zh-CN';
      return parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN';
    }

    const base = locales.find((locale) => locale.toLowerCase() === tag.split('-')[0]);
    if (base) return base;
  }
}

defineCustomClientStrategy('custom-browserLanguage', {
  getLocale: () =>
    typeof navigator === 'undefined' ? undefined : preferredLocale(navigator.languages),
  // The cookie strategy persists the user's choice; browser preferences are read-only.
  setLocale: () => {},
});
