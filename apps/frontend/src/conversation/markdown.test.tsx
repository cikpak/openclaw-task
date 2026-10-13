import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type * as ReactMarkdownModule from 'react-markdown';
// eslint-disable-next-line no-restricted-imports -- Test-only authored CSS fixture.
import { readFileSync } from 'node:fs';
import { AgentMessageContent } from './AgentMessageContent';
import { ConversationMessages } from './MessageBubble';
import { snapshot } from '../test/fixtures';
import styles from './Conversation.module.css';

const { markdownRender } = vi.hoisted(() => ({ markdownRender: vi.fn() }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      markdownRender();
      return actual.default(props);
    },
  };
});
const css = readFileSync('src/conversation/Conversation.module.css', 'utf8');
const scopedCss = css.replace(
  /\.([a-zA-Z][\w-]*)/gu,
  (_match, name: string) => `.${styles[name] ?? name}`,
);
const example = `- **Chisinau Politechnical College:** Computer Science, June 2018.
- **Step IT Academy:** Computer Science, December 2019.

### Skills and tools

Covers JavaScript/TypeScript, React, Vue, Next.js, HTML/CSS, Node.js, Python, SQL, MongoDB, APIs, microservices, and CI/CD. Also lists Git, AWS, Docker, deployment tools, design systems, UI/UX, OpenAI API, and agentic development.

The header includes a phone number, email address, and LinkedIn reference.

**Overall:** It presents an engineer who combines product development and frontend leadership with substantial experience teaching others.`;
const common = { tools: [], aborting: false, onAbort: vi.fn() };

it('formats the exact education, skills and Overall example with compact semantic Markdown', () => {
  const { container } = render(
    <>
      <style>{scopedCss}</style>
      <AgentMessageContent text={example} />
    </>,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Chisinau Politechnical College:').tagName).toBe(
    'STRONG',
  );
  expect(screen.getByText('Step IT Academy:').tagName).toBe('STRONG');
  expect(
    screen.getByRole('heading', { level: 3, name: 'Skills and tools' }),
  ).toBeVisible();
  expect(getComputedStyle(screen.getByRole('heading')).fontSize).toBe('16px');
  expect(screen.getByText('Overall:').tagName).toBe('STRONG');
  expect(container.querySelectorAll('[data-message-content] > p')).toHaveLength(
    3,
  );
  expect(container.querySelector('p ul')).toBeNull();
  expect(
    container.querySelector('[data-message-content]')!.textContent,
  ).not.toContain('**');
});

it('keeps user messages literal while rendering canonical, live and settled assistant text through the same pipeline', () => {
  const value = {
    ...snapshot,
    messages: [
      {
        id: 'user',
        role: 'user' as const,
        text: '**Literal request**',
        createdAt: 1,
      },
      {
        id: 'assistant',
        role: 'assistant' as const,
        text: '**Canonical**',
        createdAt: 2,
      },
    ],
    activeRun: { id: 'run', text: '**Live**', sequence: 1 },
  };
  const { rerender } = render(
    <ConversationMessages {...common} snapshot={value} />,
  );
  const user = screen.getByText('**Literal request**');
  expect(user.tagName).toBe('P');
  expect(user.querySelector('strong')).toBeNull();
  expect(screen.getByText('Canonical').tagName).toBe('STRONG');
  expect(screen.getByText('Live').tagName).toBe('STRONG');
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...value,
        activeRun: null,
        settledRun: {
          id: 'run',
          text: '**Live**',
          sequence: 1,
          state: 'final',
        },
      }}
    />,
  );
  expect(screen.getByText('Live').tagName).toBe('STRONG');
});

it('handles partial formatting without inventing text and retains the animated wrapper through final handoff', () => {
  const update = (text: string) => (
    <ConversationMessages
      {...common}
      snapshot={{ ...snapshot, activeRun: { id: 'run', text, sequence: 1 } }}
    />
  );
  const { rerender } = render(update('A **partial'));
  const content = screen
    .getByText('A **partial')
    .closest('[data-message-content]');
  expect(content).toHaveClass(styles.replyText!);
  expect(content).toHaveAttribute(
    'data-message-source-size',
    String('A **partial'.length),
  );
  rerender(update('A **partial response**'));
  expect(screen.getByText('partial response').tagName).toBe('STRONG');
  expect(
    screen.getByText('partial response').closest('[data-message-content]'),
  ).toBe(content);
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'canonical',
            role: 'assistant',
            text: 'A **partial response**',
            createdAt: 1,
            runId: 'run',
          },
        ],
      }}
    />,
  );
  expect(
    screen.getByText('partial response').closest('[data-message-content]'),
  ).toBe(content);
});

it('drops raw HTML and unsafe protocols while preserving sanitized manual links', () => {
  const text = `<script>window.pwned = true</script>

<iframe src="https://unsafe.example"></iframe>

[JS](javascript:alert(1)) [Data](data:text/html;base64,PHNjcmlwdD4=) [VB](vbscript:msgbox(1)) [Safe](https://example.com/path) [Email](mailto:owner@example.com)

<img src="https://unsafe.example/pixel" onerror="alert(1)">`;
  const { container } = render(<AgentMessageContent text={text} />);
  expect(container.querySelector('script,iframe,img')).toBeNull();
  for (const label of ['JS', 'Data', 'VB'])
    expect(screen.getByText(label).closest('a')).toBeNull();
  expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute(
    'href',
    'https://example.com/path',
  );
  expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute(
    'href',
    'mailto:owner@example.com',
  );
});

it('never mounts image elements or preloads remote image URLs', () => {
  const { container } = render(
    <AgentMessageContent
      text={
        '![Remote diagram](https://images.example/pixel.png)\n\n![Unsafe](data:image/svg+xml;base64,PHN2Zz4=)'
      }
    />,
  );
  expect(container.querySelector('img,link[rel="preload"]')).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Image: Remote diagram' }),
  ).toHaveAttribute('href', 'https://images.example/pixel.png');
  expect(screen.getByText('Image: Unsafe').closest('a')).toBeNull();
});

it('renders fenced/inline code, quotes, GFM tables and tasks with bounded scrolling styles', () => {
  const { container } = render(
    <>
      <style>{scopedCss}</style>
      <AgentMessageContent
        text={
          'Use `pnpm test`.\n\n```ts\nconst text = "<safe>";\n```\n\n> Keep the reader in control.\n\n| Tool | Status |\n| --- | --- |\n| React | Ready |\n\n- [x] Verified\n- [ ] Pending'
        }
      />
    </>,
  );
  expect(container.querySelector('pre code')).toHaveTextContent(
    'const text = "<safe>";',
  );
  expect(container.querySelector('blockquote')).toHaveTextContent(
    'Keep the reader in control.',
  );
  const table = screen.getByRole('table');
  expect(
    within(table).getByRole('columnheader', { name: 'Tool' }),
  ).toBeVisible();
  expect(getComputedStyle(table.parentElement!).overflowX).toBe('auto');
  expect(getComputedStyle(container.querySelector('pre')!).overflowX).toBe(
    'auto',
  );
  for (const checkbox of screen.getAllByRole('checkbox'))
    expect(checkbox).toBeDisabled();
});

it('does not reparse unchanged historical text during unrelated parent updates', () => {
  const { rerender } = render(
    <AgentMessageContent text="**Keep this response**" />,
  );
  const calls = markdownRender.mock.calls.length;
  rerender(<AgentMessageContent text="**Keep this response**" />);
  expect(markdownRender).toHaveBeenCalledTimes(calls);
  rerender(<AgentMessageContent text="**Changed response**" />);
  expect(markdownRender).toHaveBeenCalledTimes(calls + 1);
});
