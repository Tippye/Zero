import { createSingleFlight } from '../single-flight';
import { imapBridge, type ImapAccount } from '../imap-bridge';
import { getZeroDB } from '../server-utils';
import { TRPCError } from '@trpc/server';
import { env } from '../../env';
export type MailboxAccount = {
  id: string;
  email: string;
  name: string;
  providerId: string;
  connected: boolean;
  warning?: string;
  picture?: string | null;
  createdAt?: string | Date;
};
const imapMetadata = new Map<string, ImapAccount[]>();
const accountReads = createSingleFlight<MailboxAccount[]>();
export function mailboxAccounts(owner: string): Promise<MailboxAccount[]> {
  return accountReads(owner, () => loadMailboxAccounts(owner));
}
async function loadMailboxAccounts(owner: string): Promise<MailboxAccount[]> {
  const db = await getZeroDB(owner);
  let imapUnavailable = false;
  const [oauth, imap] = await Promise.all([
    db.findManyConnections(),
    (env as typeof env & { IMAP_BRIDGE_URL?: string }).IMAP_BRIDGE_URL
      ? imapBridge<ImapAccount[]>(owner, 'accounts.list')
          .then((accounts) => {
            if (imapMetadata.size >= 200 && !imapMetadata.has(owner))
              imapMetadata.delete(imapMetadata.keys().next().value!);
            imapMetadata.set(owner, accounts);
            return accounts;
          })
          .catch(() => {
            imapUnavailable = true;
            return imapMetadata.get(owner) || [];
          })
      : Promise.resolve([]),
  ]);
  const accounts: MailboxAccount[] = [
    ...oauth.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name || a.email,
      providerId: a.providerId,
      connected: !!a.accessToken && !!a.refreshToken,
    })),
    ...imap.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name || a.email,
      providerId: 'imap',
      connected: true,
    })),
  ];
  if (imapUnavailable) {
    const first = accounts.find((a) => a.providerId === 'imap') || accounts[0];
    if (first) first.warning = 'IMAP service is unavailable. Refresh to retry.';
    else
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'IMAP service is unavailable. Refresh to retry.',
      });
  }
  return accounts;
}

export async function ownedMailbox(owner: string, id?: string) {
  const accounts = await mailboxAccounts(owner);
  const account = id ? accounts.find((a) => a.id === id) : accounts.find((a) => a.connected);
  if (!account)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Mailbox not found. Add a mailbox in Settings → Connections.',
    });
  if (!account.connected)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reconnect this mailbox in Settings → Connections.',
    });
  return account;
}
