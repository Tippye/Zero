import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MailAiPanel } from '../../../apps/mail/components/mail/mail-ai-panel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mutate, ensure } = vi.hoisted(() => ({ mutate: vi.fn(), ensure: vi.fn() }));
vi.mock('@/providers/query-provider', () => ({
  useTRPCClient: () => ({ ai: { read: { mutate } } }),
}));
vi.mock('@/hooks/use-llm', () => ({ useEnsureLlm: () => ensure }));
vi.mock('@/paraglide/runtime', () => ({ getLocale: () => 'en' }));
vi.mock('@/paraglide/messages', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: any) => <button {...props} />,
}));
vi.mock('@/components/ui/textarea', () => ({ Textarea: (props: any) => <textarea {...props} /> }));

beforeEach(() => {
  vi.resetAllMocks();
  ensure.mockResolvedValue(true);
  mutate.mockResolvedValue({ text: 'Generated result' });
});
afterEach(cleanup);
const mount = () =>
  render(<MailAiPanel threadId="thread-1" messageId="message-1" onTranslated={vi.fn()} />);

describe('mail reading AI', () => {
  it('only generates a summary when requested and reuses it when reopened', async () => {
    mount();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.summary' }));
    await screen.findByText('Generated result');
    expect(mutate.mock.calls[0][0]).toMatchObject({
      threadId: 'thread-1',
      messageId: 'message-1',
      action: 'summary',
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.summary' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('uses the selected translation language', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.translate' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'mailAi.translate' })[1]);
    await screen.findByText('Generated result');
    expect(mutate.mock.calls[0][0]).toMatchObject({
      action: 'translate',
      language: 'zh-CN',
      history: [],
    });
  });

  it('sends previous answers with follow-up questions and preserves failed input', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.ask' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'How much?' } });
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.send' }));
    await screen.findByText('Generated result');
    mutate.mockRejectedValueOnce(new Error('Provider failed'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'When?' } });
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.send' }));
    await screen.findByRole('alert');
    expect(mutate.mock.calls[1][0]).toMatchObject({
      question: 'When?',
    });
    expect(mutate.mock.calls[1][0].history).toEqual([
      { question: 'How much?', answer: 'Generated result' },
    ]);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('When?');
  });

  it('does not generate when no LLM is configured', async () => {
    ensure.mockResolvedValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.summary' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('ignores responses from a previous email after unmount', async () => {
    let finish!: (value: { text: string }) => void;
    mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = mount();
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.summary' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(mutate.mock.calls[0][1].signal.aborted).toBe(true);
    render(<MailAiPanel threadId="thread-2" messageId="message-2" onTranslated={vi.fn()} />);
    finish({ text: 'Old email result' });
    fireEvent.click(screen.getByRole('button', { name: 'mailAi.ask' }));
    expect(screen.queryByText('Old email result')).toBeNull();
  });
});
