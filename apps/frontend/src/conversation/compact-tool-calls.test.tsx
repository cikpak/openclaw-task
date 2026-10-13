import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ToolActivity } from '@messenger/contracts';
import { expect, it, vi } from 'vitest';
import { snapshot } from '../test/fixtures';
import { ConversationMessages } from './MessageBubble';
import { ToolActivityCard, ToolResult } from './ToolResult';

const tool: ToolActivity = {
  id: 'run:call',
  name: 'write',
  status: 'running',
  parameters: JSON.stringify({
    path: 'report.txt',
    content: 'Document contents',
  }),
  output: '',
};

it('renders only a compact specific icon, name and status cue before opening', () => {
  render(<ToolActivityCard tool={tool} />);
  const chip = screen.getByRole('button', { name: /write · running/u });
  expect(chip).toHaveTextContent('Write');
  expect(chip).not.toHaveTextContent('running');
  expect(chip.querySelector('svg')).toHaveAttribute('width', '16');
  expect(chip.querySelector('[data-tool-status]')).toHaveAttribute(
    'data-tool-status',
    'running',
  );
  expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
  expect(screen.queryByText('report.txt')).not.toBeInTheDocument();
});

it('opens after 200ms hovering and portals details outside the transcript', async () => {
  const { container } = render(<ToolActivityCard tool={tool} />);
  const started = Date.now();
  await userEvent.hover(screen.getByRole('button'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const popup = await screen.findByRole('dialog');
  expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  expect(container).not.toContainElement(popup);
  await waitFor(() => expect(screen.getByText('report.txt')).toBeVisible());
});

it('opens immediately by keyboard focus, supports Enter and closes with Escape', async () => {
  render(<ToolActivityCard tool={tool} />);
  const chip = screen.getByRole('button');
  await userEvent.tab();
  expect(chip).toHaveFocus();
  expect(screen.getByRole('dialog')).toBeVisible();
  await userEvent.keyboard('{Enter}');
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  await userEvent.keyboard('{Escape}');
  expect(chip).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(chip).toHaveFocus();
});

it('opens by click and closes on an outside click', async () => {
  render(
    <>
      <ToolActivityCard tool={tool} />
      <button type="button">Outside</button>
    </>,
  );
  const chip = screen.getByRole('button', { name: /Tool details/u });
  await userEvent.click(chip);
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Outside' }));
  expect(chip).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
});

it('retains the same trigger and open popover across live completion and canonical handoff', async () => {
  const props = { aborting: false, onAbort: () => undefined };
  const { rerender } = render(
    <ConversationMessages {...props} snapshot={snapshot} tools={[tool]} />,
  );
  const card = document.querySelector('[data-tool-id="run:call"]')!;
  const chip = screen.getByRole('button', { name: /Tool details/u });
  await userEvent.click(chip);
  const popup = screen.getByRole('dialog');
  rerender(
    <ConversationMessages
      {...props}
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'canonical',
            role: 'tool',
            toolName: 'write',
            toolCallId: 'call',
            runId: 'run',
            text: 'Saved report.',
            createdAt: 2,
          },
        ],
      }}
      tools={[{ ...tool, status: 'completed', output: 'Saved report.' }]}
    />,
  );
  expect(document.querySelector('[data-tool-id="run:call"]')).toBe(card);
  expect(card).toHaveAttribute('data-message-id', 'canonical');
  expect(screen.getByRole('button', { name: /write · completed/u })).toBe(chip);
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('dialog')).toBe(popup);
  await waitFor(() => expect(screen.getByText('Saved report.')).toBeVisible());
});

it('keeps canonical output off the chat and preserves artifact downloads in details', async () => {
  render(
    <ToolResult
      chatId={snapshot.chat.id}
      message={{
        id: 'read',
        role: 'tool',
        toolName: 'read',
        text: 'File contents.',
        createdAt: 2,
        artifacts: [
          {
            id: 'artifact-a',
            name: 'report.txt',
            mimeType: 'text/plain',
            sizeBytes: 42,
          },
        ],
      }}
    />,
  );
  expect(screen.queryByText('File contents.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button').querySelector('[data-tool-status]'),
  ).toHaveAttribute('data-tool-status', 'recorded');
  await userEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByText('File contents.')).toBeVisible());
  const download = screen.getByRole('link', { name: /report.txt/u });
  expect(download).toHaveAttribute('download', 'report.txt');
  expect(download).toHaveAttribute(
    'href',
    '/api/chats/chat-a/artifacts/artifact-a',
  );
  await userEvent.tab();
  expect(download).toHaveFocus();
  expect(screen.getByRole('dialog')).toBeVisible();
});

it('keeps document previews nested and literal instead of rendering tool HTML', async () => {
  render(
    <ToolActivityCard
      tool={{
        ...tool,
        parameters: JSON.stringify({ content: '<script>alert(1)</script>' }),
      }}
    />,
  );
  await userEvent.click(screen.getByRole('button'));
  expect(
    screen.getByText('Document content').closest('details'),
  ).not.toHaveAttribute('open');
  await userEvent.click(screen.getByText('Document content'));
  expect(screen.getByText('<script>alert(1)</script>')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
});

it('uses distinct icons and a safe fallback even for inherited object names', () => {
  const { rerender } = render(<ToolActivityCard tool={tool} />);
  const write = screen.getByRole('button').querySelector('svg')!.innerHTML;
  rerender(<ToolActivityCard tool={{ ...tool, name: 'read' }} />);
  expect(screen.getByRole('button').querySelector('svg')!.innerHTML).not.toBe(
    write,
  );
  for (const name of [
    'unknown-provider-tool',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    rerender(<ToolActivityCard tool={{ ...tool, name }} />);
    expect(screen.getByRole('button')).toHaveTextContent(name);
    expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute(
      'fill',
      'none',
    );
  }
});

it('keeps the portal inside its owning native dialog', async () => {
  const { container } = render(
    <dialog open>
      <ToolActivityCard tool={tool} />
    </dialog>,
  );
  await userEvent.click(screen.getByRole('button'));
  expect(container.querySelector('dialog')).toContainElement(
    screen.getByRole('dialog', { name: /Tool details/u }),
  );
});

it('updates details without resetting the open popover', async () => {
  const { rerender } = render(<ToolActivityCard tool={tool} />);
  await userEvent.click(screen.getByRole('button'));
  rerender(
    <ToolActivityCard
      tool={{ ...tool, parameters: '{"path":"updated.txt"}' }}
    />,
  );
  expect(screen.getByRole('button', { name: /Tool details/u })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await waitFor(() => expect(screen.getByText('updated.txt')).toBeVisible());
});

it('does not mount at 199ms and mounts at the 200ms hover deadline', () => {
  vi.useFakeTimers();
  const view = render(<ToolActivityCard tool={tool} />);
  try {
    fireEvent.mouseEnter(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it('clears pending hover timers when a tool unmounts before the deadline', () => {
  vi.useFakeTimers();
  const view = render(<ToolActivityCard tool={tool} />);
  try {
    fireEvent.mouseEnter(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it('keeps a hover-open popup mounted when the pointer enters its interactive details', async () => {
  render(<ToolActivityCard tool={tool} />);
  const chip = screen.getByRole('button');
  await userEvent.hover(chip);
  const popup = await screen.findByRole('dialog');
  fireEvent.mouseLeave(chip, { clientX: 10, clientY: 10 });
  fireEvent.mouseEnter(popup, { clientX: 10, clientY: 18 });
  await waitFor(() => expect(screen.getByText('report.txt')).toBeVisible());
  expect(chip).toHaveAttribute('aria-expanded', 'true');
});
