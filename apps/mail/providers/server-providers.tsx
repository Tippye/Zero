import { QueryProvider } from './query-provider';
import { AutumnProvider } from 'autumn-js/react';
import type { PropsWithChildren } from 'react';

export function ServerProviders({
  children,
  connectionId,
}: PropsWithChildren<{ connectionId: string | null }>) {
  if (import.meta.env.VITE_PUBLIC_SELF_HOSTED === 'true') {
    return <QueryProvider connectionId={connectionId}>{children}</QueryProvider>;
  }
  return (
    <AutumnProvider backendUrl={import.meta.env.VITE_PUBLIC_BACKEND_URL}>
      <QueryProvider connectionId={connectionId}>{children}</QueryProvider>
    </AutumnProvider>
  );
}
