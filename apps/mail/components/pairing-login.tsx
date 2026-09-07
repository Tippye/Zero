import { pairingCall, loginDestination, type PairingRequest } from '@/lib/pairing-client';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

const storageKey = 'zero.pending-pairing.v1';
export function PairingLogin() {
  const [request, setRequest] = useState<PairingRequest | null>(null);
  const [name, setName] = useState('');
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [pollRetry, setPollRetry] = useState(0);
  const bridge =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { ZeroAndroidSettings?: { postMessage(message: string): void } })
          .ZeroAndroidSettings;
  useEffect(() => {
    const ua = navigator.userAgent;
    setName(
      /ZeroMailAndroid/.test(ua)
        ? 'Android'
        : /iPad/.test(ua)
          ? 'iPad'
          : /iPhone/.test(ua)
            ? 'iPhone'
            : /Macintosh/.test(ua)
              ? 'Mac'
              : /Windows/.test(ua)
                ? 'Windows'
                : 'Web browser',
    );
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (
        saved &&
        new Date(saved.expiresAt).getTime() > Date.now() &&
        new URL(saved.verificationUri).origin === window.location.origin
      )
        setRequest(saved);
      else sessionStorage.removeItem(storageKey);
    } catch {
      sessionStorage.removeItem(storageKey);
    }
  }, []);
  useEffect(() => {
    if (!request) {
      setQr('');
      return;
    }
    let active = true;
    void QRCode.toDataURL(request.verificationUriComplete, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQr(url);
      })
      .catch(() => {
        if (active) setQr('');
      });
    const tick = () =>
      setRemaining(
        Math.max(0, Math.ceil((new Date(request.expiresAt).getTime() - Date.now()) / 1000)),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [request]);
  useEffect(() => {
    if (!request) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || Date.now() >= new Date(request.expiresAt).getTime()) return;
      try {
        const result = await pairingCall<{ status: string }>(
          'exchange',
          { requestId: request.requestId, deviceSecret: request.deviceSecret },
          controller.signal,
        );
        if (stopped) return;
        if (result.status === 'authorized') {
          sessionStorage.removeItem(storageKey);
          window.location.replace(loginDestination());
          return;
        }
        timer = setTimeout(poll, 5000);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : '网络连接失败 / Connection failed');
      }
    };
    timer = setTimeout(poll, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [request, pollRetry]);
  async function start() {
    setBusy(true);
    setError('');
    try {
      const next = await pairingCall<PairingRequest>('start', { deviceName: name, mode: 'cookie' });
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* This tab can still pair without persistence. */
      }
      setRequest(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法生成配对码 / Pairing unavailable');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="w-full space-y-4 text-white">
      <p>
        使用已登录设备扫码或输入配对码，确认后即可登录。
        <br />
        <span className="text-sm text-white/70">
          Scan or approve the code from a signed-in device.
        </span>
      </p>
      <label className="block">
        本机名称 / Device name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!!request && remaining > 0}
          maxLength={80}
          className="mt-1 w-full rounded border border-white/30 bg-transparent p-2"
          autoComplete="off"
        />
      </label>
      {request && remaining > 0 && (
        <div className="space-y-3 text-center">
          {qr && (
            <img
              src={qr}
              alt="使用已登录设备扫描此配对二维码 / Pairing QR code"
              className="mx-auto rounded-lg"
              width={240}
              height={240}
            />
          )}
          <p className="font-mono text-3xl tracking-widest" data-testid="pairing-code">
            {request.userCode}
          </p>
          <p className="text-sm text-white/70" role="status">
            等待确认 · {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} /
            Waiting for approval
          </p>
          <p className="break-all text-sm">
            在已登录设备打开 / Open on a signed-in device:
            <br />
            {request.verificationUri}
          </p>
        </div>
      )}
      {request && remaining === 0 && (
        <p role="status">配对已过期，请重新生成。 / Pairing expired.</p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-red-300">
          <p>{error}</p>
          {request && remaining > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setError('');
                setPollRetry((n) => n + 1);
              }}
            >
              重新检查 / Retry
            </Button>
          )}
        </div>
      )}
      <Button
        onClick={() => void start()}
        disabled={busy || !name.trim() || (!!request && remaining > 0)}
        className="w-full"
      >
        {busy ? '生成中…' : '生成配对码 / Generate code'}
      </Button>
      <details className="text-sm text-white/70">
        <summary className="cursor-pointer">
          首次登录或所有设备均已退出 / First device or recovery
        </summary>
        <p className="mt-2">在服务器终端运行以下命令，核对设备信息后输入 yes：</p>
        <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-white/10 p-2">
          docker compose --env-file deploy/.env exec api node pairing.mjs approve{' '}
          {request?.userCode || '配对码'}
        </pre>
      </details>
      {bridge && (
        <Button variant="outline" onClick={() => bridge.postMessage('open')}>
          服务器设置 / Server settings
        </Button>
      )}
    </div>
  );
}
