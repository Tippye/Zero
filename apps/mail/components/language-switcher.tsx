import { locales as availableLocales } from '@/project.inlang/settings.json';
import { getLocale, setLocale, type Locale } from '@/paraglide/runtime';
import { locales as localeNames } from '@/locales';

export function LanguageSwitcher() {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span>语言 / Language</span>
      <select
        aria-label="语言 / Language"
        className="bg-background text-foreground rounded-md border px-2 py-2"
        value={getLocale()}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {availableLocales.map((locale) => (
          <option key={locale} value={locale}>
            {localeNames[locale as keyof typeof localeNames] || locale}
          </option>
        ))}
      </select>
    </label>
  );
}
