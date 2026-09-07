import { LoginClient } from './login-client';
import { useLoaderData, redirect } from 'react-router';
import { authClient } from '@/lib/auth-client';

export async function clientLoader() {
  const session = await authClient.getSession();
  if (session.data?.user && !session.data.user.isAnonymous) {
    const next = new URLSearchParams(window.location.search).get('next');
    return redirect(next?.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login') ? next : '/mail/inbox');
  }
  const isProd = !import.meta.env.DEV;

  const response = await fetch(import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/public/providers');
  const data = (await response.json()) as { allProviders: any[] };

  return {
    allProviders: data.allProviders,
    isProd,
  };
}

export default function LoginPage() {
  const { allProviders, isProd } = useLoaderData<typeof clientLoader>();

  return (
    <div className="flex min-h-screen w-full flex-col bg-white dark:bg-black">
      <LoginClient providers={allProviders} isProd={isProd} />
    </div>
  );
}
