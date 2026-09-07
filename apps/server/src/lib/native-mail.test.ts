import type { IGetThreadResponse } from './driver/types';
import { nativeMail, nativeThread } from './native-mail';
import { describe, expect, it, vi } from 'vitest';

const fixture: IGetThreadResponse = {
  messages: [
    {
      id: 'message',
      sender: { email: 'sender@example.test' },
      to: [],
      cc: [],
      bcc: [],
      title: 'Test',
      subject: 'Test',
      receivedOn: '',
      body: '',
      decodedBody: '<p>Hello &amp; welcome</p><script>secret()</script>',
      processedHtml: '',
      blobUrl: '',
      tls: true,
      tags: [],
      unread: true,
      attachments: [
        {
          attachmentId: 'file',
          filename: 'file.txt',
          mimeType: 'text/plain',
          size: 2,
          body: 'aGk=',
          headers: [],
        },
      ],
    },
  ],
  hasUnread: true,
  totalReplies: 1,
  labels: [{ id: 'STARRED', name: 'STARRED' }],
};
type Caller = Parameters<typeof nativeMail>[0];
const outgoing = {
  accountId: 'account',
  to: [{ email: 'recipient@example.test' }],
  subject: 'Test',
  message: 'Hello',
  operationId: '00000000-0000-4000-8000-000000000001',
};
describe('native mail boundary', () => {
  it('refuses to edit a draft when the provider omits an attachment', async () => {
    const caller = {
      drafts: {
        get: vi
          .fn()
          .mockResolvedValue({
            id: 'mbx.account.draft',
            rawMessage: {
              id: 'message',
              payload: { parts: [{ filename: 'inline.png', body: { attachmentId: 'missing' } }] },
            },
          }),
      },
      mail: { getMessageAttachments: vi.fn().mockResolvedValue([]) },
    } as unknown as Caller;
    await expect(nativeMail(caller, 'draft', { id: 'mbx.account.draft' })).rejects.toThrow(
      'Draft attachments are incomplete',
    );
  });
  it('maps native trash to the shared cache folder name', async () => {
    const listThreads = vi.fn().mockResolvedValue({ threads: [], nextPageToken: null });
    await nativeMail({ mail: { listThreads } } as unknown as Caller, 'threads', {
      folder: 'trash',
    });
    expect(listThreads.mock.calls[0]?.[0].folder).toBe('bin');
  });
  it('omits attachment bodies in thread reads and creates safe text', () => {
    const thread = nativeThread('thread', fixture);
    expect(thread.starred).toBe(true);
    expect(thread.messages[0]?.text).toBe('Hello & welcome');
    expect(thread.messages[0]?.attachments[0]).not.toHaveProperty('body');
  });
  it('uses owned router methods without accepting caller-supplied owner IDs', async () => {
    const read = vi.fn().mockResolvedValue({ success: true });
    const caller = { mail: { markAsRead: read } } as unknown as Caller;
    await nativeMail(caller, 'action', {
      ids: ['mbx.account.mail'],
      action: 'read',
      userId: 'attacker',
    });
    expect(read).toHaveBeenCalledWith({ ids: ['mbx.account.mail'] });
  });
  it('rejects missing recipients, corrupted attachments and unknown operations before invoking the provider', async () => {
    const send = vi.fn();
    const caller = { mail: { send } } as unknown as Caller;
    await expect(nativeMail(caller, 'send', { ...outgoing, to: [] })).rejects.toThrow();
    await expect(
      nativeMail(caller, 'send', {
        ...outgoing,
        attachments: [
          { name: 'file', type: 'text/plain', size: 5, lastModified: 0, base64: 'aGk=' },
        ],
      }),
    ).rejects.toThrow();
    await expect(nativeMail(caller, 'arbitrary-admin-action', {})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves send operation IDs and attachment bytes', async () => {
    const send = vi.fn().mockResolvedValue({ success: true });
    const file = { name: 'file', type: 'text/plain', size: 2, lastModified: 0, base64: 'aGk=' };
    await nativeMail({ mail: { send } } as unknown as Caller, 'send', {
      ...outgoing,
      attachments: [file],
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      operationId: outgoing.operationId,
      attachments: [file],
    });
  });
  it('resolves Gmail draft attachment requests using the owned message ID', async () => {
    const getMessageAttachments = vi.fn().mockResolvedValue(fixture.messages[0]!.attachments);
    const caller = {
      drafts: {
        get: vi.fn().mockResolvedValue({
          id: 'mbx.account.draft-id',
          content: '<b>Draft</b>',
          rawMessage: { id: 'gmail-message' },
        }),
      },
      mail: { getMessageAttachments },
    } as unknown as Caller;
    const draft = await nativeMail(caller, 'draft', { id: 'mbx.account.draft-id' });
    expect(getMessageAttachments).toHaveBeenCalledWith({ messageId: 'mbx.account.gmail-message' });
    expect(draft).toMatchObject({ text: 'Draft', attachments: fixture.messages[0]!.attachments });
  });
  it('keeps pagination and partial mailbox warnings', async () => {
    const caller = {
      mail: {
        listThreads: vi.fn().mockResolvedValue({
          threads: [
            {
              id: 'one',
              accountId: 'account',
              accountEmail: 'me@example.test',
              $raw: { preview: fixture },
            },
          ],
          nextPageToken: 'opaque',
          warnings: [{ accountId: 'other', email: 'other@example.test', message: 'Unavailable' }],
        }),
      },
    } as unknown as Caller;
    expect(await nativeMail(caller, 'threads', {})).toMatchObject({
      cursor: 'opaque',
      threads: [{ subject: 'Test', unread: true, starred: true }],
      warnings: [{ accountId: 'other' }],
    });
  });
});
