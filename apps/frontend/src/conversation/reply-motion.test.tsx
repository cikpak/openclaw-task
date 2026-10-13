import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- Test-only authored CSS fixture.
import { readFileSync } from 'node:fs';
import type { PendingMessage } from '@messenger/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { useChatProjection, useDrafts } from '../state/stores';
import { snapshot } from '../test/fixtures';
import { installTestSocket } from '../test/socket';
import { ConnectionProvider } from './ConnectionProvider';
import { ConversationMessages } from './MessageBubble';
import { QueuedCard } from './QueuedCard';
import styles from './Conversation.module.css';

const css = readFileSync('src/conversation/Conversation.module.css', 'utf8');
const scopedCss = css.replace(
  /\.([a-zA-Z][\w-]*)/gu,
  (_match, name: string) => `.${styles[name] ?? name}`,
);
const message: PendingMessage = {
  id: 'submitted',
  chatId: 'chat-a',
  position: 2,
  text: 'A real submitted request',
  attachments: [],
  revision: 1,
  state: 'submitted',
  submissionId: 'receipt',
  createdAt: 1,
};
const common = { tools: [], aborting: false, onAbort: vi.fn() };
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  installTestSocket();
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ authenticated: true }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
});

function queued(value = message) {
  return render(
    <>
      <style>{scopedCss}</style>
      <AuthProvider>
        <ConnectionProvider>
          <QueuedCard message={value} canSteer />
        </ConnectionProvider>
      </AuthProvider>
    </>,
  );
}

it('presents a submitted input as the same normal user bubble without receipt actions or a submitted-card heading', async () => {
  const view = queued();
  await waitFor(() =>
    expect(useChatProjection.getState().connection).toBe('ready'),
  );
  const submitted = screen.getByText(message.text).closest('article')!;
  expect(submitted).toHaveClass(styles.message!, styles.userMessage!);
  expect(submitted).not.toHaveClass(styles.queued!);
  expect(submitted.querySelector('header')).toHaveTextContent('You');
  expect(submitted.querySelector('time')).toHaveAttribute(
    'dateTime',
    new Date(message.createdAt).toISOString(),
  );
  expect(submitted).toHaveAttribute('data-message-state', 'submitted');
  expect(screen.queryByText('Submitted to agent')).not.toBeInTheDocument();
  expect(submitted.querySelector('button')).toBeNull();
  // The durable receipt identity is retained; no client-side canonical promotion occurs.
  expect(submitted).toHaveAccessibleName('Queued message 2');
  view.rerender(
    <>
      <style>{scopedCss}</style>
      <AuthProvider>
        <ConnectionProvider>
          <QueuedCard message={message} canSteer />
          <ConversationMessages
            {...common}
            snapshot={{
              ...snapshot,
              messages: [
                {
                  id: 'canonical',
                  role: 'user',
                  text: 'A canonical request',
                  createdAt: 1,
                },
              ],
            }}
          />
        </ConnectionProvider>
      </AuthProvider>
    </>,
  );
  const canonical = screen.getByText('A canonical request').closest('article')!;
  for (const property of [
    'maxWidth',
    'padding',
    'backgroundColor',
    'marginLeft',
    'borderRadius',
  ] as const)
    expect(getComputedStyle(submitted)[property]).toBe(
      getComputedStyle(canonical)[property],
    );
  expect(getComputedStyle(submitted).maxWidth).toBe('85%');
  expect(getComputedStyle(submitted).marginLeft).toBe('auto');
});

it.each([
  ['pending', 'Queued · 2', ['Edit', 'Cancel', 'Steer instead']],
  ['submitting', 'Submitting…', []],
  ['unknown', 'Delivery unconfirmed', ['Retry with receipt check', 'Discard']],
] as const)(
  'retains truthful %s status and allowed queue actions',
  async (state, label, actions) => {
    queued({ ...message, state });
    await waitFor(() =>
      expect(useChatProjection.getState().connection).toBe('ready'),
    );
    expect(screen.getByText(label)).toBeVisible();
    const row = screen.getByRole('article', { name: 'Queued message 2' });
    expect(row).toHaveClass(styles.queued!);
    expect(row.querySelectorAll('button')).toHaveLength(actions.length);
    for (const name of actions)
      expect(screen.getByRole('button', { name })).toBeVisible();
  },
);

it('enters once at the first actual response text, retaining the node/class through later deltas and canonical handoff', () => {
  const { rerender } = render(
    <>
      <style>{scopedCss}</style>
      <ConversationMessages
        {...common}
        snapshot={{
          ...snapshot,
          activeRun: { id: 'run', text: '', sequence: 0 },
        }}
      />
    </>,
  );
  expect(document.querySelector(`.${styles.replyText}`)).toBeNull();
  const update = (text: string, sequence: number) =>
    rerender(
      <>
        <style>{scopedCss}</style>
        <ConversationMessages
          {...common}
          snapshot={{ ...snapshot, activeRun: { id: 'run', text, sequence } }}
        />
      </>,
    );
  update('Actual', 1);
  const textNode = screen.getByText('Actual');
  const content = textNode.closest('[data-message-content]');
  const bubble = textNode.closest('article');
  expect(content).toHaveClass(styles.replyText!);
  for (const [index, text] of [
    'Actual incremental',
    'Actual incremental response',
  ].entries()) {
    update(text, index + 2);
    expect(screen.getByText(text)).toBe(textNode);
    expect(textNode.closest('[data-message-content]')).toBe(content);
    expect(content).toHaveClass(styles.replyText!);
  }
  rerender(
    <>
      <style>{scopedCss}</style>
      <ConversationMessages
        {...common}
        snapshot={{
          ...snapshot,
          messages: [
            {
              id: 'final',
              role: 'assistant',
              text: 'Actual incremental response',
              createdAt: 1,
              runId: 'run',
            },
          ],
        }}
      />
    </>,
  );
  expect(screen.getByText('Actual incremental response')).toBe(textNode);
  expect(textNode.closest('[data-message-content]')).toBe(content);
  expect(textNode.closest('article')).toBe(bubble);
});

it('animates newly received assistant text, not user messages, and provides a real reduced-motion override', () => {
  const { container } = render(
    <>
      <style>{scopedCss}</style>
      <ConversationMessages
        {...common}
        snapshot={{
          ...snapshot,
          messages: [
            { id: 'user', role: 'user', text: 'Request', createdAt: 1 },
            {
              id: 'assistant',
              role: 'assistant',
              text: 'Received response',
              createdAt: 2,
            },
          ],
        }}
      />
    </>,
  );
  expect(screen.getByText('Request')).not.toHaveClass(styles.replyText!);
  const content = screen
    .getByText('Received response')
    .closest('[data-message-content]')!;
  expect(content).toHaveClass(styles.replyText!);
  const sheet = container.querySelector('style')!.sheet!;
  const reduce = Array.from(sheet.cssRules).find(
    (rule) =>
      rule instanceof CSSMediaRule &&
      rule.conditionText === '(prefers-reduced-motion: reduce)',
  ) as CSSMediaRule;
  const override = Array.from(reduce.cssRules).find(
    (rule) =>
      rule instanceof CSSStyleRule &&
      rule.selectorText === `.${styles.replyText}`,
  ) as CSSStyleRule;
  expect(override.style.getPropertyValue('animation')).toBe('none');
  // Apply the authored media rule directly; jsdom does not evaluate media queries.
  const style = document.createElement('style');
  style.textContent = override.cssText;
  container.appendChild(style);
  expect(getComputedStyle(content).animation).toBe('none');
});

it('widens the transcript 20% while matching composer desktop gutters and keeping a responsive width', () => {
  const { container } = render(
    <>
      <style>{scopedCss}</style>
      <div className={styles.chatBody}>
        <div className={styles.history}>
          <div className={styles.historyInner} />
        </div>
        <div className={styles.composerViewport}>
          <div className={styles.composerWrap} />
        </div>
      </div>
    </>,
  );
  const owner = getComputedStyle(
    container.querySelector(`.${styles.chatBody}`)!,
  );
  const history = getComputedStyle(
    container.querySelector(`.${styles.historyInner}`)!,
  );
  const composer = getComputedStyle(
    container.querySelector(`.${styles.composerWrap}`)!,
  );
  expect(owner.getPropertyValue('--chat-column-width')).toBe('960px');
  expect(parseFloat(owner.getPropertyValue('--chat-column-width'))).toBe(
    800 * 1.2,
  );
  expect(owner.getPropertyValue('--chat-inline-gutter')).toBe('32px');
  // Assert the shared authored token contract. jsdom does not resolve CSS
  // variables/calc into rendered geometry; chat-column-layout covers column math.
  expect(history.maxWidth).toBe('var(--chat-column-width)');
  expect(composer.maxWidth).toBe(
    'calc(var(--chat-column-width) + 2 * var(--chat-inline-gutter))',
  );
  expect(composer.getPropertyValue('padding')).toBe(
    '8px var(--chat-inline-gutter) 12px',
  );
  expect(
    getComputedStyle(
      container.querySelector(`.${styles.history}`)!,
    ).getPropertyValue('padding'),
  ).toBe('24px var(--chat-inline-gutter)');
  const sheet = container.querySelector('style')!.sheet!;
  const mobile = Array.from(sheet.cssRules).find(
    (rule) =>
      rule instanceof CSSMediaRule &&
      rule.conditionText === '(max-width: 700px)',
  ) as CSSMediaRule;
  const mobileOwner = Array.from(mobile.cssRules).find(
    (rule) =>
      rule instanceof CSSStyleRule &&
      rule.selectorText === `.${styles.chatBody}`,
  ) as CSSStyleRule;
  expect(mobileOwner.style.getPropertyValue('--chat-inline-gutter')).toBe(
    '14px',
  );
  expect(composer.width).toBe('100%');
});
