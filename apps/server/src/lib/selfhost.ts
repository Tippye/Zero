export function selfHostedOrigin(
  request: Request,
  config: { AUTH_ORIGINS?: string; VITE_PUBLIC_BACKEND_URL: string },
) {
  const allowed = (config.AUTH_ORIGINS || config.VITE_PUBLIC_BACKEND_URL)
    .split(',')
    .map((s) => s.trim());
  const protocol = request.headers.get('x-forwarded-proto');
  const host = request.headers.get('host') || new URL(request.url).host;
  const proposed = `${protocol === 'https' ? 'https' : 'http'}://${host}`;
  return allowed.includes(proposed) ? proposed : config.VITE_PUBLIC_BACKEND_URL;
}
