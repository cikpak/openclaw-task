import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { snapshot } from '../test/fixtures';
import { ConversationMessages } from './MessageBubble';

it('keeps a named tool at its canonical chronological position without duplicating or remounting its open popover', async () => {
  const tool = {
    id: 'run:call',
    name: 'write',
    status: 'completed' as const,
    parameters: '{"path":"documents/review.txt"}',
    output: 'Successfully wrote file.',
  };
  const common = { tools: [tool], aborting: false, onAbort: vi.fn() };
  const { rerender } = render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [],
        activeRun: { id: 'run', text: '', sequence: 1 },
      }}
    />,
  );
  const chip = screen.getByRole('button', {
    name: 'write · completed · Tool details',
  });
  const card = document.querySelector('[data-tool-id="run:call"]')!;
  await userEvent.click(chip);
  const popup = screen.getByRole('dialog', {
    name: 'write · completed · Tool details',
  });
  await waitFor(() =>
    expect(within(popup).getByText('Successfully wrote file.')).toBeVisible(),
  );
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        activeRun: null,
        messages: [
          {
            id: 'result',
            role: 'tool',
            text: 'Successfully wrote file.',
            createdAt: 1,
            runId: 'run',
            toolCallId: 'call',
            toolName: 'write',
          },
          {
            id: 'answer',
            role: 'assistant',
            text: 'Your document is ready.',
            createdAt: 2,
            runId: 'run',
          },
        ],
      }}
    />,
  );
  expect(
    screen.getAllByRole('button', { name: 'write · completed · Tool details' }),
  ).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'write · completed · Tool details' }),
  ).toBe(chip);
  expect(document.querySelector('[data-tool-id="run:call"]')).toBe(card);
  expect(card).toHaveAttribute('data-message-id', 'result');
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  expect(
    screen.getByRole('dialog', { name: 'write · completed · Tool details' }),
  ).toBe(popup);
  expect(screen.getAllByText('Successfully wrote file.')).toHaveLength(1);
  expect(
    card.compareDocumentPosition(screen.getByText('Your document is ready.')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
