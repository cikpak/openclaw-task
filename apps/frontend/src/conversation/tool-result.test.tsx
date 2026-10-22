import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { snapshot } from '../test/fixtures';
import { ConversationMessages } from './MessageBubble';
import { toolResultText, ToolActivityCard } from './ToolResult';
it('hides tool-call-only assistant turns while keeping real text and file-only deliveries', () => {
  render(
    <ConversationMessages
      snapshot={{
        ...snapshot,
        messages: [
          { id: 'empty', role: 'assistant', text: '', createdAt: 1 },
          { id: 'whitespace', role: 'assistant', text: ' \n', createdAt: 2 },
          {
            id: 'real',
            role: 'assistant',
            text: 'Jonathan it is.',
            createdAt: 3,
          },
          {
            id: 'file',
            role: 'assistant',
            text: '',
            createdAt: 4,
            artifacts: [
              {
                id: 'a',
                name: 'answer.txt',
                mimeType: 'text/plain',
                sizeBytes: 1,
              },
            ],
          },
        ],
      }}
      tools={[]}
      aborting={false}
      onAbort={vi.fn()}
    />,
  );
  expect(
    document.querySelector('[data-message-id="empty"]'),
  ).not.toBeInTheDocument();
  expect(
    document.querySelector('[data-message-id="whitespace"]'),
  ).not.toBeInTheDocument();
  expect(screen.getByText('Jonathan it is.')).toBeVisible();
  expect(screen.getByRole('button', { name: /answer.txt/u })).toBeVisible();
});
it('shows named tool activity without duplicate generic output messages', async () => {
  render(
    <ConversationMessages
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'tool',
            role: 'tool',
            text: JSON.stringify([
              {
                type: 'input_text',
                text: 'Script completed\nWall time 0.0 seconds\nOutput:\n',
              },
              { type: 'input_text', text: '<script>not executable</script>' },
            ]),
            createdAt: 1,
          },
        ],
      }}
      tools={[
        {
          id: 'call',
          name: 'write',
          status: 'completed',
          parameters: JSON.stringify({
            path: 'documents/review.txt',
            content: 'First line\nSecond line',
          }),
          output: JSON.stringify({
            content: [{ type: 'text', text: 'Successfully wrote file.' }],
          }),
        },
      ]}
      aborting={false}
      onAbort={vi.fn()}
    />,
  );
  const chip = screen.getByRole('button', {
    name: 'write · completed · Tool details',
  });
  expect(chip).toHaveTextContent('Write');
  expect(chip).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('Tool output')).not.toBeInTheDocument();
  expect(screen.queryByText(/Script completed/u)).not.toBeInTheDocument();
  await userEvent.click(chip);
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  const details = screen.getByRole('dialog', {
    name: 'write · completed · Tool details',
  });
  await waitFor(() =>
    expect(within(details).getByText('documents/review.txt')).toBeVisible(),
  );
  expect(screen.getByText('Successfully wrote file.')).toBeVisible();
  const disclosure = within(details).getByText('Document content');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  await userEvent.click(disclosure);
  expect(
    screen.getByText('Document content').querySelector('svg'),
  ).toHaveAttribute('width', '16');
  expect(disclosure.querySelector('svg')).toHaveAttribute(
    'viewBox',
    '0 0 24 24',
  );
  expect(screen.getByText(/First line/u).textContent).toBe(
    'First line\nSecond line',
  );
  expect(details.querySelector('script')).toBeNull();
});
it('preserves unknown and mixed structured output and bounds the visible preview', async () => {
  const unknown = '[{"type":"image","url":"private"}]';
  expect(toolResultText(unknown)).toBe(unknown);
  expect(toolResultText('Plain result')).toBe('Plain result');
  expect(toolResultText('[invalid')).toBe('[invalid');
  const mixed = '[{"type":"text","text":"one"},{"type":"image"}]';
  expect(toolResultText(mixed)).toBe(mixed);
  render(
    <ToolActivityCard
      tool={{
        id: 'large',
        name: 'read',
        status: 'completed',
        parameters: '',
        output: 'x'.repeat(70000),
      }}
    />,
  );
  expect(document.querySelector('pre')).toBeNull();
  await userEvent.click(
    screen.getByRole('button', { name: 'read · completed · Tool details' }),
  );
  const details = screen.getByRole('dialog');
  await waitFor(() => expect(details.querySelector('pre')).toBeVisible());
  expect(details.querySelector('pre')?.textContent).toHaveLength(16384);
  expect(screen.getByText(/Preview limited/u)).toBeInTheDocument();
});
it('decodes the object text envelope from native live tool results without executing HTML', async () => {
  expect(
    toolResultText(
      JSON.stringify({
        content: [{ type: 'text', text: 'Success\nNext line' }],
      }),
    ),
  ).toBe('Success\nNext line');
  const { container } = render(
    <ToolActivityCard
      tool={{
        id: 'a',
        name: 'read',
        status: 'failed',
        parameters: '{}',
        output: JSON.stringify({
          content: [{ type: 'text', text: '<script>no execution</script>' }],
        }),
      }}
    />,
  );
  expect(
    screen.queryByText('<script>no execution</script>'),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'read · failed · Tool details' }),
  );
  const details = screen.getByRole('dialog');
  await waitFor(() =>
    expect(
      within(details).getByText('<script>no execution</script>'),
    ).toBeVisible(),
  );
  expect(container.querySelector('script')).toBeNull();
  expect(details.querySelector('script')).toBeNull();
});
it('keeps truncated write parameters readable without inventing missing content', async () => {
  render(
    <ToolActivityCard
      tool={{
        id: 'a',
        name: 'write',
        status: 'completed',
        parameters:
          '{"path":"documents/review.txt","content":"First line\\nSecond line',
        output: '',
      }}
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'write · completed · Tool details' }),
  );
  await waitFor(() =>
    expect(screen.getByText('documents/review.txt')).toBeVisible(),
  );
  await userEvent.click(screen.getByText('Document content'));
  expect(screen.getByText(/First line/u).textContent).toBe(
    'First line\nSecond line',
  );
  expect(screen.getByText(/Parameters preview is truncated/u)).toBeVisible();
});
it('retains file delivery even when canonical tool output text is hidden', async () => {
  render(
    <ConversationMessages
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'delivery',
            role: 'tool',
            text: 'Hidden tool JSON',
            createdAt: 1,
            artifacts: [
              {
                id: 'a',
                name: 'review.txt',
                mimeType: 'text/plain',
                sizeBytes: 50,
              },
            ],
          },
        ],
      }}
      tools={[]}
      aborting={false}
      onAbort={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole('link', { name: /review.txt/u }),
  ).not.toBeInTheDocument();
  const chip = screen.getByRole('button', {
    name: 'Tool files · recorded · Tool details',
  });
  expect(chip).toHaveTextContent('Tool files');
  await userEvent.click(chip);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /review.txt/u })).toBeVisible(),
  );
  expect(screen.getByRole('button', { name: /review.txt/u })).toBeEnabled();

  expect(screen.queryByText('Hidden tool JSON')).not.toBeInTheDocument();
});
