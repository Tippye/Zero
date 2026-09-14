import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, Trash, Unplug, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsCard } from '@/components/settings/settings-card';
import { AddConnectionDialog } from '@/components/connection/add';
import { imapProviderName } from '@/components/connection/imap-form';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useConnections } from '@/hooks/use-connections';
import { useImapAccounts } from '@/hooks/use-imap-accounts';
import { useTRPC, useTRPCClient } from '@/providers/query-provider';
import { authClient } from '@/lib/auth-client';
import { emailProviders } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

type ConnectionCard = {
  id: string; email: string; name: string | null; picture?: string | null;
  protocol: 'oauth' | 'imap'; provider: string; disconnected: boolean;
};

function MailHostSettings() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const cache = useQueryClient();
  const settings = useQuery(trpc.imap.mailHostSettings.queryOptions(undefined, {
    retry: false,
    gcTime: 0,
    meta: { persist: false },
    trpc: { abortOnUnmount: true },
  }));
  const [enabled, setEnabled] = useState(false);
  const [hosts, setHosts] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setHosts(settings.data.hosts.join('\n'));
  }, [settings.data]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const normalized = [...new Set(hosts.split(/[\s,]+/).map(host => host.trim().toLowerCase()).filter(Boolean))];
    if (normalized.some(host => !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(host))) {
      toast.error(m['connectionsUi.mailHostsInvalid']());
      return;
    }
    setSaving(true);
    try {
      const saved = await client.imap.saveMailHostSettings.mutate({ enabled, hosts: normalized });
      cache.setQueryData(trpc.imap.mailHostSettings.queryKey(), saved);
      setEnabled(saved.enabled);
      setHosts(saved.hosts.join('\n'));
      toast.success(m['connectionsUi.mailHostsSaved']());
    } catch {
      toast.error(m['connectionsUi.mailHostsSaveFailed']());
    } finally {
      setSaving(false);
    }
  }

  return <SettingsCard title={m['connectionsUi.mailHostsTitle']()} description={m['connectionsUi.mailHostsDescription']()}>
    {settings.error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <p>{m['connectionsUi.mailHostsLoadFailed']()}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => void settings.refetch()}>{m['pages.settings.retry']()}</Button>
    </div> : <form className="space-y-4" onSubmit={save}>
      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">{m['connectionsUi.mailHostsEnabled']()}</p>
          <p className="text-muted-foreground text-sm">{m['connectionsUi.mailHostsEnabledHelp']()}</p>
        </div>
        <Switch aria-label={m['connectionsUi.mailHostsEnabled']()} checked={enabled} disabled={settings.isLoading || saving} onCheckedChange={setEnabled} />
      </div>
      <label className="block space-y-2 text-sm">
        <span className="font-medium">{m['connectionsUi.mailHostsList']()}</span>
        <Textarea value={hosts} disabled={settings.isLoading || saving} onChange={event => setHosts(event.target.value)}
          className="min-h-32 font-mono" placeholder={'imap.school.edu\nsmtp.school.edu'} />
        <span className="text-muted-foreground block text-xs">{m['connectionsUi.mailHostsListHelp']()}</span>
      </label>
      {enabled && !hosts.trim() && <p role="status" className="text-amber-700 text-sm dark:text-amber-400">{m['connectionsUi.mailHostsEmpty']()}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={settings.isLoading || saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {m['common.actions.saveChanges']()}
        </Button>
      </div>
    </form>}
  </SettingsCard>;
}

export default function ConnectionsPage() {
  const oauth = useConnections();
  const imap = useImapAccounts();
  const client = useTRPCClient();
  const trpc = useTRPC();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState<ConnectionCard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cards: ConnectionCard[] = [
    ...(oauth.data?.connections || []).map(account => ({
      ...account, protocol: 'oauth' as const, provider: account.providerId,
      disconnected: !!oauth.data?.disconnectedIds?.includes(account.id),
    })),
    ...(imap.data || []).map(account => ({
      ...account, protocol: 'imap' as const, provider: account.preset, disconnected: false,
    })),
  ];

  async function openMailbox(account: ConnectionCard) {
    await cache.invalidateQueries({ queryKey: trpc.mailboxes.accounts.queryKey() });
    navigate(`/mail/inbox?accountId=${encodeURIComponent(account.id)}`);
  }

  async function disconnect() {
    if (!removing || busy) return;
    const account = removing;
    setBusy(account.id);
    try {
      if (account.protocol === 'imap') {
        await client.imap.removeAccount.mutate({ accountId: account.id });
        cache.setQueryData(trpc.imap.accounts.queryKey(), (accounts) => accounts?.filter(item => item.id !== account.id));
        await imap.refetch();
      } else {
        await client.connections.delete.mutate({ connectionId: account.id });
        await oauth.refetch();
        await cache.invalidateQueries({ queryKey: trpc.connections.getDefault.queryKey() });
      }
      await cache.invalidateQueries({ queryKey: trpc.mailboxes.accounts.queryKey() });
      toast.success(m['pages.settings.connections.disconnectSuccess']());
      setRemoving(null);
    } catch {
      toast.error(m['pages.settings.connections.disconnectError']());
    } finally { setBusy(null); }
  }

  return (
    <div className="grid gap-6">
      <SettingsCard title={m['pages.settings.connections.title']()} description={m['connectionsUi.description']()}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AddConnectionDialog><Button variant="outline"><Plus className="size-4" />{m['pages.settings.connections.addEmail']()}</Button></AddConnectionDialog>
          <LanguageSwitcher />
        </div>
        {(oauth.error || imap.error) && <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
          <p>{oauth.error ? m['connectionsUi.oauthListFailed']() : m['connectionsUi.imapListFailed']()}</p>
          <Button size="sm" variant="outline" onClick={() => { void oauth.refetch(); void imap.refetch(); }}>{m['pages.settings.retry']()}</Button>
        </div>}
        {(oauth.isLoading || imap.isLoading) && <div className="grid gap-4 md:grid-cols-2" aria-label={m['common.actions.loading']()}><Skeleton className="h-36 rounded-lg" /><Skeleton className="h-36 rounded-lg" /></div>}
        {!oauth.isLoading && !imap.isLoading && !cards.length && <div className="rounded-lg border border-dashed p-8 text-center">
          <Mail className="text-muted-foreground mx-auto mb-3 size-8" />
          <h2 className="font-medium">{m['imap.emptyTitle']()}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{m['connectionsUi.emptyDescription']()}</p>
        </div>}
        <div className="grid gap-4 xl:grid-cols-2">
          {cards.map(account => {
            const Icon = account.protocol === 'oauth' ? emailProviders.find(provider => provider.providerId === account.provider)?.icon : undefined;
            const provider = account.protocol === 'imap' ? imapProviderName(account.provider) : account.provider === 'google' ? 'Gmail' : 'Outlook';
            const lastOAuth = account.protocol === 'oauth' && oauth.data?.connections.length === 1;
            return <div key={`${account.protocol}:${account.id}`} className="bg-popover space-y-4 rounded-lg border p-4" data-testid="connection-card">
              <div className="flex min-w-0 items-center gap-3">
                <div className="bg-primary/10 flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg">
                  {account.picture ? <img src={account.picture} alt="" className="size-12 object-cover" /> : Icon ? <Icon className="size-6" /> : <Mail className="size-6" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.name || account.email}</p>
                  <p className="text-muted-foreground truncate text-xs" title={account.email}>{account.email}</p>
                </div>
                <Badge variant="secondary">{provider}</Badge>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Badge variant={account.disconnected ? 'destructive' : 'outline'}>{account.disconnected ? m['pages.settings.connections.disconnected']() : account.protocol === 'imap' ? 'IMAP / SMTP' : 'OAuth'}</Badge>
                <div className="flex items-center gap-2">
                  {account.disconnected ? <Button size="sm" variant="outline" disabled={!!busy} onClick={async () => {
                    setBusy(account.id);
                    try {
                      const result = await authClient.linkSocial({ provider: account.provider, callbackURL: `${window.location.origin}/settings/connections` });
                      if (result.error) throw new Error('OAuth connection failed');
                    } catch { toast.error(m['connectionsUi.oauthFailed']()); }
                    finally { setBusy(null); }
                  }}><Unplug className="size-4" />{m['pages.settings.connections.reconnect']()}</Button>
                    : <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void openMailbox(account)}>
                      {busy === account.id && <Loader2 className="size-4 animate-spin" />}{m['connectionsUi.openMailbox']()}
                    </Button>}
                  <Button size="icon" variant="ghost" disabled={!!busy || lastOAuth} aria-label={`${m['pages.settings.connections.remove']()} ${account.email}`} title={lastOAuth ? m['connectionsUi.lastOAuth']() : undefined} onClick={() => setRemoving(account)}><Trash className="size-4" /></Button>
                </div>
              </div>
            </div>;
          })}
        </div>
      </SettingsCard>
      {import.meta.env.VITE_PUBLIC_SELF_HOSTED_AUTH === 'required' && <MailHostSettings />}
      <Dialog open={!!removing} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}>
        <DialogContent showOverlay>
          <DialogHeader>
            <DialogTitle>{m['pages.settings.connections.disconnectTitle']()}</DialogTitle>
            <DialogDescription>{m['connectionsUi.removeDescription']({ email: removing?.email || '' })}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={!!busy} onClick={() => setRemoving(null)}>{m['common.actions.cancel']()}</Button>
            <Button variant="destructive" disabled={!!busy} onClick={() => void disconnect()}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{m['pages.settings.connections.remove']()}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
