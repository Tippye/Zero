import { redirect } from 'react-router';
import type { Route } from './+types/mailto-handler';
import { parseComposeLink } from '../../../native/desktop/src/links.mjs';

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  const raw = new URL(request.url).searchParams.get('mailto');
  try {
    const fields = parseComposeLink(raw || 'mailto:');
    throw redirect('/mail/compose?' + new URLSearchParams(fields));
  } catch (error) {
    if (error instanceof Response) throw error;
    throw redirect('/mail/compose');
  }
}
