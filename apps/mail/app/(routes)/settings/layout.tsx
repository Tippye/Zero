import { SettingsLayoutContent } from '@/components/ui/settings-content';
import { Link, Outlet, redirect, useRevalidator } from 'react-router';
import { authClient } from '@/lib/auth-client';
import { ensureWorkspaceSession } from '@/lib/workspace-session';
import { m } from '@/paraglide/messages';
import type { Route } from './+types/layout';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const signal = AbortSignal.any([request.signal, controller.signal]);
    if (import.meta.env.VITE_PUBLIC_SELF_HOSTED === 'true') {
      await ensureWorkspaceSession(signal);
      return null;
    }
    const result = await authClient.getSession({
      fetchOptions: {
        signal,
        retry: 0,
      },
    });
    if (result.error) throw new Error('Session check failed');
    if (!result.data) return redirect('/login');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function ErrorBoundary() {
  const revalidator = useRevalidator();
  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="max-w-md space-y-4" role="alert">
        <h1 className="text-xl font-semibold">{m['pages.settings.loadFailed']()}</h1>
        <p>{m['pages.settings.connectionHelp']()}</p>
        <div className="flex gap-4">
          <button
            className="rounded-md border px-4 py-2 disabled:opacity-50"
            disabled={revalidator.state !== 'idle'}
            onClick={() => void revalidator.revalidate()}
          >
            {m['pages.settings.retry']()}
          </button>
          <Link className="rounded-md border px-4 py-2" to="/mail/inbox">
            {m['common.actions.back']()}
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function SettingsLayout() {
  return (
    <SettingsLayoutContent>
      <Outlet />
    </SettingsLayoutContent>
  );
}
