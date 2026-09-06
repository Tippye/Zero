import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HelpCircle,
  LogOut,
  MoonIcon,
  CopyCheckIcon,
  BanknoteIcon,
  RefreshCcw,
  Trash2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveConnection } from '@/hooks/use-connections';
import { useDoState } from '@/components/mail/use-do-state';
import { useCallback, useEffect, useState } from 'react';
import { signOut, useSession } from '@/lib/auth-client';
import { useTRPC } from '@/providers/query-provider';
import { useBilling } from '@/hooks/use-billing';
import { SunIcon } from '../icons/animated/sun';
import { clear as idbClear } from 'idb-keyval';
import { ThreeDots } from '../icons/icons';
import { m } from '@/paraglide/messages';
import { useTheme } from 'next-themes';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const bytesToMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

interface SyncingStatusIndicatorProps {
  isSyncing: boolean;
  storageSize: number;
  syncingFolders: string[];
}

function SyncingStatusIndicator({
  isSyncing,
  storageSize,
  syncingFolders,
}: SyncingStatusIndicatorProps) {
  const statusContent = (
    <div className="flex items-center gap-2">
      <div className="flex h-4 w-4 items-center justify-center">
        <div
          className={cn(
            'h-2 w-2 rounded-full',
            isSyncing || storageSize === 0 ? 'animate-pulse bg-orange-500' : 'bg-green-500',
          )}
        />
      </div>
      <p className="text-[13px] opacity-60">
        {isSyncing || storageSize === 0
          ? 'Syncing emails...'
          : `Synced${storageSize ? ` • ${bytesToMB(storageSize)} MB` : ''}`}
      </p>
    </div>
  );

  if (isSyncing && syncingFolders.length > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem className="cursor-default">{statusContent}</DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} avoidCollisions={false}>
          <p className="text-xs">Syncing: {syncingFolders.join(', ')}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <DropdownMenuItem className="cursor-default">{statusContent}</DropdownMenuItem>;
}

export function NavUser() {
  const { data: session } = useSession();
  const [isRendered, setIsRendered] = useState(false);
  const { theme, setTheme } = useTheme();
  const trpc = useTRPC();
  const { mutateAsync: handleForceSync } = useMutation(trpc.mail.forceSync.mutationOptions());
  const { openBillingPortal, customer: billingCustomer } = useBilling();
  const queryClient = useQueryClient();
  const { data: activeConnection } = useActiveConnection();
  const [{ isSyncing, syncingFolders, storageSize, shards }] = useDoState();

  const handleClearCache = useCallback(async () => {
    queryClient.clear();
    await idbClear();
    toast.success('Cache cleared successfully');
  }, [queryClient]);

  const handleCopyConnectionId = useCallback(async () => {
    await navigator.clipboard.writeText(activeConnection?.id || '');
    toast.success('Connection ID copied to clipboard');
  }, [activeConnection]);

  const { data: activeAccount } = useActiveConnection();

  useEffect(() => setIsRendered(true), []);

  const handleLogout = async () => {
    toast.promise(signOut(), {
      loading: 'Signing out...',
      success: () => 'Signed out successfully!',
      error: 'Error signing out',
      async finally() {
        // await handleClearCache();
        window.location.href = '/login';
      },
    });
  };

  const handleThemeToggle = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  if (!isRendered || !session) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 group-data-[collapsible=icon]:w-6"
          aria-label={m['common.threadDisplay.moreOptions']()}
        >
          <ThreeDots className="fill-iconLight dark:fill-iconDark" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="ml-3 min-w-56 bg-white font-medium dark:bg-[#131313]"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-1">
          {billingCustomer?.stripe_id ? (
            <DropdownMenuItem onClick={() => openBillingPortal()}>
              <div className="flex items-center gap-2">
                <BanknoteIcon size={16} className="opacity-60" />
                <p className="text-[13px] opacity-60">Billing</p>
              </div>
            </DropdownMenuItem>
          ) : null}
        </div>
        <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">Debug</p>
        <DropdownMenuItem onClick={handleCopyConnectionId}>
          <div className="flex items-center gap-2">
            <CopyCheckIcon size={16} className="opacity-60" />
            <p className="text-[13px] opacity-60">Copy Connection ID</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleClearCache}>
          <div className="flex items-center gap-2">
            <Trash2 size={16} className="opacity-60" />
            <p className="text-[13px] opacity-60">Clear Local Cache</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={activeAccount?.providerId !== 'google'}
          onClick={() => handleForceSync()}
        >
          <div className="flex items-center gap-2">
            <RefreshCcw size={16} className="opacity-60" />
            <p className="text-[13px] opacity-60">Force re-sync</p>
          </div>
        </DropdownMenuItem>
        <SyncingStatusIndicator
          isSyncing={isSyncing}
          storageSize={storageSize}
          syncingFolders={syncingFolders}
        />
        <DropdownMenuItem>
          <div className="flex items-center gap-2">
            <p className="text-[13px] opacity-60">Shards: {shards}</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mt-1" />
        <DropdownMenuItem onClick={handleThemeToggle} className="cursor-pointer">
          <div className="flex w-full items-center gap-2">
            {theme === 'dark' ? (
              <MoonIcon className="size-4 opacity-60" />
            ) : (
              <SunIcon className="size-4 opacity-60" />
            )}
            <p className="text-[13px] opacity-60">{m['common.navUser.appTheme']()}</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <a href="https://discord.gg/mail0" target="_blank" rel="noreferrer" className="w-full">
            <div className="flex items-center gap-2">
              <HelpCircle size={16} className="opacity-60" />
              <p className="text-[13px] opacity-60">{m['common.navUser.customerSupport']()}</p>
            </div>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onClick={handleLogout}>
          <div className="flex items-center gap-2">
            <LogOut size={16} className="opacity-60" />
            <p className="text-[13px] opacity-60">{m['common.actions.logout']()}</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mt-1" />
        <div className="text-muted-foreground/60 flex items-center justify-center gap-1 px-2 pb-2 pt-1 text-[10px]">
          <a href="/privacy" className="hover:underline">
            Privacy
          </a>
          <span>·</span>
          <a href="/terms" className="hover:underline">
            Terms
          </a>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
