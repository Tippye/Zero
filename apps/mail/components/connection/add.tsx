import { useState } from 'react';
import { Mail, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { ImapConnectionForm, imapPresets, imapProviderName, type ImapPreset } from './imap-form';
import { useTRPC } from '@/providers/query-provider';
import { useBilling } from '@/hooks/use-billing';
import { emailProviders } from '@/lib/constants';
import { authClient } from '@/lib/auth-client';
import { m } from '@/paraglide/messages';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function AddConnectionDialog({ children, className, onOpenChange }: {
  children?: React.ReactNode;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const { connections, attach } = useBilling();
  const selfHosted = import.meta.env.VITE_PUBLIC_SELF_HOSTED === 'true';
  const canCreateConnection = selfHosted || !!connections?.unlimited || (connections?.remaining ?? 0) > 0;
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<ImapPreset | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const navigate = useNavigate();

  function changeOpen(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) setPreset(null);
    onOpenChange?.(next);
  }

  function connected() {
    setOpen(false);
    setPreset(null);
    onOpenChange?.(false);
    void queryClient.invalidateQueries({ queryKey: trpc.imap.accounts.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.mailboxes.accounts.queryKey() });
    toast.success(m['imap.accountAdded']());
    navigate('/settings/connections');
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        {children || <Button size="dropdownItem" variant="dropdownItem" className={cn('w-full justify-start gap-2', className)}>
          <UserPlus size={16} strokeWidth={2} aria-hidden="true" />
          {m['pages.settings.connections.addEmail']()}
        </Button>}
      </DialogTrigger>
      <DialogContent showOverlay className="max-h-[90dvh] overflow-y-auto sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{preset
            ? m['connectionsUi.configureProvider']({ provider: imapProviderName(preset) })
            : m['pages.settings.connections.connectEmail']()}</DialogTitle>
          <DialogDescription>{m['connectionsUi.addDescription']()}</DialogDescription>
        </DialogHeader>
        {preset ? <ImapConnectionForm key={preset} preset={preset} onConnected={connected} onBack={() => setPreset(null)} onBusyChange={setBusy} /> : <>
          {!canCreateConnection && <div className="space-y-2 rounded-lg border p-3 text-sm">
            <p>{m['connectionsUi.connectionLimit']()}</p>
            <Button variant="outline" onClick={() => {
              if (attach) void attach({ productId: 'pro-example', successUrl: `${window.location.origin}/settings/connections` });
            }}>{m['connectionsUi.managePlan']()}</Button>
          </div>}
          <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
            {emailProviders.map(provider => {
              const Icon = provider.icon;
              return <Button key={provider.providerId} disabled={!canCreateConnection || busy} variant="outline" className="h-24 flex-col gap-2" onClick={async () => {
                setBusy(true);
                try {
                  const result = await authClient.linkSocial({ provider: provider.providerId, callbackURL: `${window.location.origin}/settings/connections` });
                  if (result.error) throw new Error('OAuth connection failed');
                } catch {
                  toast.error(m['connectionsUi.oauthFailed']());
                } finally { setBusy(false); }
              }}><Icon className="size-6!" /><span>{provider.name}</span></Button>;
            })}
            {imapPresets.map(provider => <Button key={provider} disabled={busy} variant="outline" className="h-24 flex-col gap-1" onClick={() => setPreset(provider)}>
              <Mail className="text-muted-foreground size-6" />
              <span>{imapProviderName(provider)}</span>
              <span className="text-muted-foreground text-[10px]">IMAP / SMTP</span>
            </Button>)}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  );
}
