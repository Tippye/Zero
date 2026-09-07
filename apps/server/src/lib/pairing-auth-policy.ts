const sessionRoutes = new Set([
  'sign-out',
  'list-sessions',
  'revoke-session',
  'revoke-sessions',
  'revoke-other-sessions',
  'update-user',
  'list-accounts',
  'unlink-account',
  'get-access-token',
  'refresh-token',
  'link-social',
  'delete-user',
  'delete-user/callback',
]);

export function allowPairedAuthRoute(path: string, signedIn: boolean) {
  let route: string;
  try {
    route = decodeURIComponent(path)
      .replace(/^\/api\/auth\//, '')
      .replace(/\/$/, '');
  } catch {
    return false;
  }
  if (route === 'get-session') return true;
  if (!signedIn) return false;
  return sessionRoutes.has(route) || /^callback\/(google|microsoft)$/.test(route);
}
