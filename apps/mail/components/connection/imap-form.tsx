import { useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTRPCClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { m } from '@/paraglide/messages';

export const imapPresets = ['qq', '163', '126', 'icloud', 'custom'] as const;
export type ImapPreset = (typeof imapPresets)[number];
export const imapProviderName = (preset: string) =>
  ({ qq: 'QQ', '163': '163', '126': '126', icloud: 'iCloud' } as Record<string, string>)[preset] || m['connectionsUi.otherProvider']();

export function ImapConnectionForm({ preset, onConnected, onBack, onBusyChange }: {
  preset: ImapPreset;
  onConnected: () => void;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const client = useTRPCClient();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [separateSmtp, setSeparateSmtp] = useState(false);
  const custom = preset === 'custom';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const value = (key: string) => String(fields.get(key) || '');
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      // Call directly: authorization codes must never enter a persisted mutation cache.
      await client.imap.addAccount.mutate({
        preset, email: value('email').trim(), name: value('name').trim(),
        password: value('password'), username: value('username').trim() || undefined,
        ...(custom ? {
          imapHost: value('imapHost').trim(), imapPort: 993 as const,
          smtpHost: value('smtpHost').trim(), smtpPort: Number(value('smtpPort')) as 465 | 587,
        } : {}),
        ...(separateSmtp ? {
          smtpUsername: value('smtpUsername').trim() || undefined,
          smtpPassword: value('smtpPassword') || undefined,
        } : {}),
        saveSent: fields.get('saveSent') === 'on',
      });
      form.reset();
      onConnected();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(message.includes('DUPLICATE_ACCOUNT') ? m['connectionsUi.duplicate']()
        : message.includes('HOST_NOT_ALLOWED') ? m['connectionsUi.hostNotAllowed']()
        : message.includes('BUSY') || message.includes('RATE_LIMIT') ? m['connectionsUi.busy']()
        : m['connectionsUi.verificationFailed']());
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">
        {preset === 'icloud' ? m['connectionsUi.icloudHelp']() : m['connectionsUi.authorizationHelp']()}
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span>{m['imap.email']()}</span>
          <Input name="email" type="email" autoComplete="email" required maxLength={320} placeholder={preset === 'qq' ? 'name@qq.com' : 'name@example.com'} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{m['imap.senderName']()}</span>
          <Input name="name" autoComplete="name" maxLength={128} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{m['imap.appPassword']()}</span>
          <Input name="password" type="password" autoComplete="new-password" required maxLength={2048} />
        </label>
        {custom && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span>{m['imap.imapHost']()}</span>
              <Input name="imapHost" required maxLength={253} placeholder="imap.example.com" />
              <span className="text-muted-foreground text-xs">993 · TLS</span>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{m['imap.smtpHost']()}</span>
              <Input name="smtpHost" required maxLength={253} placeholder="smtp.example.com" />
            </label>
            <label className="block space-y-1 text-sm sm:col-span-2">
              <span>{m['imap.smtpPort']()}</span>
              <select name="smtpPort" className="bg-background h-9 w-full rounded-md border px-3 text-sm">
                <option value="465">465 · TLS</option>
                <option value="587">587 · STARTTLS</option>
              </select>
            </label>
          </div>
        )}
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{m['connectionsUi.advanced']()}</summary>
          <div className="mt-3 space-y-3">
            <label className="block space-y-1">
              <span>{m['connectionsUi.username']()}</span>
              <Input name="username" maxLength={320} autoComplete="username" placeholder={m['connectionsUi.sameAsEmail']()} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={separateSmtp} onChange={event => setSeparateSmtp(event.target.checked)} />
              {m['connectionsUi.separateSmtp']()}
            </label>
            {separateSmtp && <>
              <label className="block space-y-1"><span>{m['connectionsUi.smtpUsername']()}</span><Input name="smtpUsername" maxLength={320} /></label>
              <label className="block space-y-1"><span>{m['connectionsUi.smtpPassword']()}</span><Input name="smtpPassword" type="password" autoComplete="new-password" required maxLength={2048} /></label>
            </>}
            <label className="flex items-start gap-2"><input name="saveSent" type="checkbox" className="mt-1" />{m['imap.saveSentCopy']()}</label>
          </div>
        </details>
      </fieldset>
      {error && <p role="alert" className="text-destructive rounded-md border p-3 text-sm">{error}</p>}
      {busy && <p role="status" className="text-muted-foreground text-sm">{m['connectionsUi.verifyingHelp']()}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onBack}>{m['common.actions.back']()}</Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? m['imap.verifying']() : m['imap.verifyAndAdd']()}
        </Button>
      </div>
    </form>
  );
}
