import { authClient } from '@/lib/auth-client';
import { m } from '@/paraglide/messages';
import { redirect } from 'react-router';

let creatingWorkspace: Promise<unknown> | undefined;

export async function ensureWorkspaceSession(signal?: AbortSignal) {
  const result = await authClient.getSession({ fetchOptions: { signal, retry: 0 } });
  if (result.error) throw new Error(m['imap.connectionError']());
  if (result.data) return;
  if (import.meta.env.VITE_PUBLIC_SELF_HOSTED_AUTH === 'required') {
    const next = window.location.pathname + window.location.search;
    throw redirect('/login?next=' + encodeURIComponent(next));
  }
  creatingWorkspace ??= authClient.signIn.anonymous({ fetchOptions: { signal, retry: 0 } })
    .then((session) => {
      if (session.error) throw new Error(m['imap.workspaceError']());
    })
    .finally(() => { creatingWorkspace = undefined; });
  await creatingWorkspace;
}
