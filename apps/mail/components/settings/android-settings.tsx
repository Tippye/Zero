import { SettingsCard } from './settings-card';
import { Button } from '@/components/ui/button';
import { m } from '@/paraglide/messages';

export function AndroidSettings() {
  const bridge = typeof window === 'undefined' ? undefined
    : (window as Window & { ZeroAndroidSettings?: { postMessage(message: string): void } }).ZeroAndroidSettings;
  if (!bridge) return null;
  return <SettingsCard title={m['android.settings']()} description={m['android.description']()}>
    <Button type="button" variant="outline" onClick={() => bridge.postMessage('open')}>
      {m['android.open']()}
    </Button>
  </SettingsCard>;
}
