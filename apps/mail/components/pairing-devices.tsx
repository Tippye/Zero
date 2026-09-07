import { pairingCall, type PairingPreview } from '@/lib/pairing-client';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { useEffect, useState } from 'react';

interface Device {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
export function PairingDevices() {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<PairingPreview | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<Device | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const result = await pairingCall<{ devices: Device[] }>('devices');
    setDevices(result.devices);
  }
  useEffect(() => {
    const readCode = () => {
      setCode(new URLSearchParams(window.location.hash.slice(1)).get('code') || '');
      setPreview(null);
    };
    readCode();
    window.addEventListener('hashchange', readCode);
    let active = true;
    void authClient
      .getSession()
      .then(async (session) => {
        if (!active) return;
        setSignedIn(!!session.data?.user);
        if (session.data?.user) await refresh();
      })
      .catch(() => {
        if (active) setError('无法检查登录状态，请刷新页面。 / Could not check session.');
      });
    return () => {
      active = false;
      window.removeEventListener('hashchange', readCode);
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败 / Request failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-semibold">设备配对与登录 / Paired devices</h1>
      {signedIn === null && <p>正在检查登录状态… / Checking session…</p>}
      {signedIn === false && (
        <div className="space-y-3">
          <p>请使用已登录设备扫描二维码，或在其「设置 → 安全」中输入配对码。</p>
          <p>
            Use a signed-in device to approve this request. For the first device, authorize from
            your server terminal.
          </p>
          <a
            className="underline"
            href={'/login?next=' + encodeURIComponent('/pair' + (code ? '#code=' + code : ''))}
          >
            登录此设备 / Sign in on this device
          </a>
        </div>
      )}
      {signedIn && (
        <>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () =>
                setPreview(await pairingCall<PairingPreview>('preview', { code })),
              );
            }}
          >
            <label className="block">
              新设备上的配对码 / Code shown on the new device
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPreview(null);
                }}
                maxLength={12}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                className="mt-1 w-full rounded border bg-transparent p-3 font-mono text-xl"
              />
            </label>
            <Button disabled={busy || !code.trim()}>查看配对请求 / Review request</Button>
          </form>
          {preview && (
            <section className="space-y-3 rounded-lg border p-4" aria-label="Review pairing">
              <h2 className="text-lg font-semibold">
                确认这是你正在登录的设备 / Confirm your device
              </h2>
              <p className="break-all">服务器 / Server: {preview.origin}</p>
              <p>设备名称 / Device: {preview.deviceName}</p>
              <p className="font-mono">{code.toUpperCase()}</p>
              <p>
                仅批准你本人发起的登录请求。设备名称由请求方提供。 / Only approve a sign-in you
                initiated; the requester supplies the device name.
              </p>
              <div className="flex flex-wrap gap-3">
                {(['approve', 'deny'] as const).map((action) => (
                  <Button
                    key={action}
                    disabled={busy}
                    variant={action === 'approve' ? 'default' : 'outline'}
                    onClick={() =>
                      void run(async () => {
                        await pairingCall(action, { code, requestId: preview.requestId });
                        setPreview(null);
                        setCode('');
                        window.history.replaceState(null, '', window.location.pathname);
                        setMessage(
                          action === 'approve'
                            ? '已批准，请返回新设备。 / Approved. Return to the new device.'
                            : '已拒绝配对。 / Pairing denied.',
                        );
                      })
                    }
                  >
                    {action === 'approve' ? '确认登录 / Approve' : '拒绝 / Deny'}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">已登录设备 / Signed-in devices</h2>
              <Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>
                刷新 / Refresh
              </Button>
            </div>
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div>
                  <p>
                    {device.name}
                    {device.current && ' · 本机 / This device'}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {new Date(device.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="outline" disabled={busy} onClick={() => setRevokeTarget(device)}>
                  退出设备 / Sign out
                </Button>
              </div>
            ))}
          </section>
        </>
      )}
      {revokeTarget && (
        <section
          role="dialog"
          aria-label="确认退出设备 / Confirm sign out"
          className="space-y-3 rounded-lg border p-4"
        >
          <p>退出设备「{revokeTarget.name}」？ / Sign out this device?</p>
          <div className="flex gap-3">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await pairingCall('revoke', { sessionId: revokeTarget.id });
                  if (revokeTarget.current) window.location.replace('/login');
                  else {
                    setRevokeTarget(null);
                    await refresh();
                  }
                })
              }
            >
              确认退出 / Confirm
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setRevokeTarget(null)}>
              取消 / Cancel
            </Button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <a className="inline-block underline" href="/mail/inbox">
        返回收件箱 / Inbox
      </a>
    </div>
  );
}
