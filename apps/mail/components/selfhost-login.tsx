import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SelfHostLogin() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.email({
        email: String(form.get('email')),
        password: String(form.get('password')),
      });
      if (result.error) {
        setError('登录失败，请检查账号和密码。 / Sign-in failed.');
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      window.location.assign(
        next?.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
          ? next
          : '/mail/inbox',
      );
    } catch {
      setError('无法连接服务器 / Server unavailable');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-white">
      <label className="block">
        账号 / Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="mt-1 block w-full rounded border bg-transparent p-2"
        />
      </label>
      <label className="block">
        密码 / Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 block w-full rounded border bg-transparent p-2"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>
        {busy ? '登录中…' : '登录 / Sign in'}
      </Button>
    </form>
  );
}
