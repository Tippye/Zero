// IDs retain mailbox ownership across aggregate views, navigation, and browser tabs.
export function mailboxId(accountId: string, id: string): string {
  return `mbx.${encodeURIComponent(accountId)}.${encodeURIComponent(id).replace(/\./g, '%2E')}`;
}
export function splitMailboxId(value: string): { accountId: string; id: string } | null {
  if (!value.startsWith('mbx.')) return null;
  const end = value.indexOf('.', 4);
  if (end < 5) throw new Error('Invalid mailbox message ID');
  const accountId = decodeURIComponent(value.slice(4, end));
  const id = decodeURIComponent(value.slice(end + 1));
  if (!accountId || !id) throw new Error('Invalid mailbox message ID');
  return { accountId, id };
}
