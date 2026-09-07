export interface PairingRequest {
  requestId: string;
  deviceSecret: string;
  userCode: string;
  expiresAt: string;
  interval: number;
  verificationUri: string;
  verificationUriComplete: string;
}
export interface PairingPreview {
  requestId: string;
  origin: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}
const messages: Record<string, string> = {
  unauthorized: '请在已登录的设备上批准配对。 / Use a signed-in device.',
  invalid_code: '配对码格式不正确。 / Invalid code.',
  invalid_or_expired_code: '配对码已失效或已被处理。 / Code expired or already used.',
  expired_token: '配对已过期，请重新生成。 / Pairing expired. Generate a new code.',
  access_denied: '配对请求已被拒绝。 / Pairing was denied.',
  rate_limited: '操作过于频繁，请稍后再试。 / Too many attempts. Try again later.',
  invalid_origin: '服务器地址与请求来源不一致。 / Server origin mismatch.',
  wrong_workspace: '请使用此服务器工作区的已登录设备。 / Use this workspace’s device.',
};
export async function pairingCall<T>(
  action: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/pairing/' + action, {
    credentials: 'include',
    ...(body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      messages[result.error] || '暂时无法完成配对，请检查网络后重试。 / Pairing unavailable.',
    );
  return result;
}
export function loginDestination() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next?.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\') &&
    !Array.from(next).some((char) => char.charCodeAt(0) < 32) &&
    !next.startsWith('/login')
    ? next
    : '/mail/inbox';
}
