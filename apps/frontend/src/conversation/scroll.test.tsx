import { testConnectionTicket } from '../test/socket';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- Test-only authored CSS fixture, not browser application code.
import { readFileSync } from 'node:fs';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { useChatProjection, useDrafts, usePreferences } from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket } from '../test/socket';
import styles from './Conversation.module.css';
const conversationCss = readFileSync(
  'src/conversation/Conversation.module.css',
  'utf8',
);
const scopedCss = conversationCss.replace(
  /\.([a-zA-Z][\w-]*)/gu,
  (_match, name: string) => `.${styles[name] ?? name}`,
);

let height = 1000;
let sequence = 0;
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  usePreferences.getState().clear();
  installTestSocket();
  height = 1000;
  sequence = 0;
  const positions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
    () => height,
  );
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: Element,
  ) {
    return positions.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    positions.set(this, Math.max(0, Math.min(value, height - 400)));
  });
  // Simulate the browser's existing scrollIntoView behavior within this viewport.
  Object.defineProperty(HTMLDivElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLDivElement) {
      const viewport = this.closest(`.${styles.history}`);
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === '/api/connection-tickets'
              ? testConnectionTicket()
              : url === '/api/session'
                ? { authenticated: true }
                : url === '/api/chats'
                  ? {
                      chats: [
                        snapshot.chat,
                        { ...snapshot.chat, id: 'chat-b', name: 'Writing' },
                      ],
                    }
                  : url.startsWith('/api/models')
                    ? { models }
                    : {
                        version: 1,
                        defaults: snapshot.chat.settings,
                        busySendBehavior: 'queue',
                      },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  );
});
afterEach(() => {
  Reflect.deleteProperty(HTMLDivElement.prototype, 'scrollIntoView');
});
async function conversation() {
  // Flush the mocked session, ticket and initial snapshot microtasks before
  // querying the full conversation DOM. Polling that DOM can otherwise starve
  // the initial promise chain when workspace test suites run concurrently.
  await act(async () => {
    render(
      <>
        <style>{scopedCss}</style>
        <MemoryRouter initialEntries={['/chat/chat-a']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </>,
    );
    await Promise.resolve();
  });
  expect(
    screen.getByRole('textbox', { name: 'Message Research' }),
  ).toBeVisible();
  expect(useChatProjection.getState().generation).toBe('test');
  const viewport = document.querySelector<HTMLElement>(`.${styles.history}`);
  if (!viewport) throw new Error('Missing conversation viewport');
  return viewport;
}
async function stream(text: string) {
  act(() =>
    currentSocket().receive({
      type: 'conversation.run.text',
      generation: 'test',
      sequence: ++sequence,
      chatId: 'chat-a',
      runId: 'run',
      text,
      replace: true,
      runSequence: sequence,
    }),
  );
  expect(
    await screen.findByText(text, { normalizer: (value) => value }),
  ).toBeVisible();
}
it('follows pending/tool growth only while the reader stays near the bottom', async () => {
  const viewport = await conversation();
  const active = { id: 'run', text: '', sequence: 0 };
  act(() =>
    useChatProjection
      .getState()
      .applySnapshot({ ...snapshot, activeRun: active }),
  );
  height = 1200;
  const pending = [
    {
      id: 'submitted',
      chatId: 'chat-a',
      position: 1,
      revision: 1,
      text: 'Submitted input',
      attachments: [],
      state: 'submitted' as const,
      createdAt: 2,
      submissionId: 'submission',
    },
  ];
  act(() =>
    useChatProjection
      .getState()
      .applySnapshot({ ...snapshot, activeRun: active, pending }),
  );
  expect(viewport.scrollTop).toBe(800);
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  height = 1400;
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      activeRun: active,
      pending,
      tools: [
        {
          id: 'tool',
          name: 'read',
          status: 'completed',
          parameters: '{}',
          output: 'Result',
        },
      ],
    }),
  );
  expect(viewport.scrollTop).toBe(100);
  await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
  expect(viewport.scrollTop).toBe(1000);
});
it('does not jump to streaming or new messages after the reader scrolls up', async () => {
  const viewport = await conversation();
  await stream('First chunk');
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  height = 1100;
  await stream('A later streaming chunk');
  expect(viewport.scrollTop).toBe(100);
  act(() =>
    currentSocket().receive({
      type: 'conversation.snapshot',
      generation: 'test',
      sequence: ++sequence,
      snapshot: {
        ...snapshot,
        messages: [
          {
            id: 'canonical',
            role: 'assistant',
            text: 'Finished response',
            createdAt: 1,
          },
        ],
      },
    }),
  );
  expect(viewport.scrollTop).toBe(100);
});
it('follows streaming while near the bottom and resumes after an intentional return to the bottom', async () => {
  const viewport = await conversation();
  await stream('First chunk');
  viewport.scrollTop = 560;
  fireEvent.scroll(viewport);
  height = 1120;
  await stream('A longer next chunk');
  expect(viewport.scrollTop).toBe(720);
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await stream('Another even longer chunk');
  viewport.scrollTop = 720;
  fireEvent.scroll(viewport);
  height = 1200;
  await stream('The latest streaming chunk is followed again');
  expect(viewport.scrollTop).toBe(800);
});
it('follows an equal-length replacement when new line wrapping increases the response height', async () => {
  const viewport = await conversation();
  await stream('One two');
  expect(viewport.scrollTop).toBe(600);
  fireEvent.scroll(viewport);
  height = 1120;
  await stream('One\ntwo');
  expect(viewport.scrollTop).toBe(720);
});
it('anchors the visible context when earlier history is prepended, preserves it during streaming, and starts another chat at its bottom', async () => {
  const viewport = await conversation();
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      hasOlderHistory: true,
      historyCursor: 'older',
      activeRun: { id: 'run', text: 'Working', sequence: 1 },
    }),
  );
  sequence = 1;
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await userEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  const request = currentSocket().commands.find(
    (command) => command.type === 'conversation.history.request',
  );
  if (!request) throw new Error('Missing history request');
  height = 1300;
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() =>
    document.body.textContent?.includes('Earlier context') ? 1300 : 1000,
  );
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: request.commandId,
      ok: true,
      data: {
        messages: [
          { id: 'older', role: 'user', text: 'Earlier context', createdAt: 1 },
        ],
        historyCursor: null,
        hasOlderHistory: false,
      },
    }),
  );
  await screen.findByText('Earlier context');
  await stream('A streaming chunk while reviewing history');
  // The prepend adds 300px above the reader; the same content stays in view.
  expect(viewport.scrollTop).toBe(400);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
    () => height,
  );
  await userEvent.click(screen.getByRole('link', { name: /Writing/ }));
  await screen.findByRole('textbox', { name: 'Message Writing' });
  const next = document.querySelector<HTMLElement>(`.${styles.history}`);
  await waitFor(() => expect(next?.scrollTop).toBe(900));
});
it('offers a jump to latest without changing the reader position until requested', async () => {
  const viewport = await conversation();
  await stream('First chunk');
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  height = 1200;
  await stream('New content below');
  const jump = await screen.findByRole('button', { name: 'Jump to latest' });
  expect(viewport.scrollTop).toBe(100);
  await userEvent.click(jump);
  expect(viewport.scrollTop).toBe(800);
  expect(
    screen.queryByRole('button', { name: 'Jump to latest' }),
  ).not.toBeInTheDocument();
  height = 1300;
  await stream('Following the latest again');
  expect(viewport.scrollTop).toBe(900);
});
it('anchors the current reader position rather than counting stream growth while an older-page request is pending', async () => {
  const viewport = await conversation();
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      hasOlderHistory: true,
      historyCursor: 'older',
      activeRun: { id: 'run', text: 'Working', sequence: 0 },
    }),
  );
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await userEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  const request = currentSocket().commands.find(
    (command) => command.type === 'conversation.history.request',
  );
  if (!request) throw new Error('Missing history request');
  height = 1100;
  await stream('Extra streaming content below while history is loading');
  viewport.scrollTop = 150;
  fireEvent.scroll(viewport);
  height = 1400;
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() =>
    document.body.textContent?.includes('Prepended page') ? 1400 : 1100,
  );
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: request.commandId,
      ok: true,
      data: {
        messages: [
          { id: 'older', role: 'user', text: 'Prepended page', createdAt: 1 },
        ],
        historyCursor: null,
        hasOlderHistory: false,
      },
    }),
  );
  await screen.findByText('Prepended page');
  expect(viewport.scrollTop).toBe(450);
});
it('renders delivery recovery guidance at readable body size', async () => {
  await conversation();
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      pending: [
        {
          id: 'uncertain',
          chatId: 'chat-a',
          position: 1,
          text: 'Retained message',
          attachments: [],
          revision: 1,
          state: 'unknown',
          submissionId: 'submission',
          createdAt: 1,
        },
      ],
    }),
  );
  const guidance = screen.getByText(
    /The connection ended before delivery was confirmed/,
  );
  expect(getComputedStyle(guidance).fontSize).toBe('16px');
});
