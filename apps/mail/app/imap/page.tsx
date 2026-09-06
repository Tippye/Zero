import { redirect } from 'react-router';
export function clientLoader({ request }: { request: Request }) {
  const id = new URL(request.url).searchParams.get('accountId');
  return redirect('/mail/inbox' + (id ? '?accountId=' + encodeURIComponent(id) : ''));
}
export default function LegacyImapRedirect() { return null; }
