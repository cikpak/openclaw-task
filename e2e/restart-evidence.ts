import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type {
  ManagerChunk,
  ManagerCommand,
  ManagerFrame,
  ChatSnapshot,
} from '@messenger/contracts';

import type { JournalProof } from './runtime-control.js';
type Marker = 'active-input' | 'queued-followup';
type SnapshotState = {
  status: string;
  activeRun: boolean;
  canonical: Record<Marker, number>;
  pending: Array<{ marker: Marker; state: string }>;
  assistantRunMatches: Record<Marker, boolean>;
};
const markers: Record<Marker, string> = {
  'active-input': 'RESTART_RESPONSE_FIXTURE active before Gateway restart',
  'queued-followup': 'Accepted queue while Gateway restarts',
};
function marker(text: string): Marker | undefined {
  return (Object.keys(markers) as Marker[]).find((key) =>
    text.includes(markers[key]),
  );
}
/** Observe public frames without routing, changing delivery, or retaining raw payloads. */
export function observeRestart(page: Page) {
  const records: Array<Record<string, unknown>> = [];
  const commands = new Map<string, Marker>();
  const chunks = new Map<string, string[]>();
  const seen = new Set<string>();
  const submissions = new Map<Marker, Set<string>>();
  let originalRequest: { chatId: string; commandId: string } | undefined;
  let latest: SnapshotState | undefined;
  let oracleKey = '';
  function remember(known: Marker, id: string) {
    const ids = submissions.get(known) ?? new Set<string>();
    ids.add(id);
    submissions.set(known, ids);
  }
  function snapshot(value: ChatSnapshot) {
    if (value.chat.name !== 'Restart space') return;
    for (const item of value.pending) {
      const known = marker(item.text);
      if (known) remember(known, item.submissionId);
    }
    latest = {
      status: value.chat.status,
      activeRun: Boolean(value.activeRun),
      canonical: Object.fromEntries(
        (Object.keys(markers) as Marker[]).map((key) => [
          key,
          value.messages.filter(
            (message) =>
              message.role === 'user' && message.text.includes(markers[key]),
          ).length,
        ]),
      ) as Record<Marker, number>,
      pending: value.pending.flatMap((item) => {
        const known = marker(item.text);
        return known ? [{ marker: known, state: item.state }] : [];
      }),
      assistantRunMatches: Object.fromEntries(
        (Object.keys(markers) as Marker[]).map((key) => [
          key,
          value.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.requestFailed !== true &&
              message.text.includes('Real Gateway integration response.') &&
              Boolean(
                message.runId && submissions.get(key)?.has(message.runId),
              ),
          ),
        ]),
      ) as Record<Marker, boolean>,
    };
    records.push({
      at: Date.now(),
      kind: 'snapshot',
      ...latest,
      terminalState: value.settledRun?.state ?? null,
    });
  }
  function received(frame: ManagerFrame | ManagerChunk) {
    if (frame.type === 'manager.chunk') {
      const parts = chunks.get(frame.id) ?? new Array<string>(frame.count);
      parts[frame.index] = frame.text;
      chunks.set(frame.id, parts);
      if (parts.filter((part) => part !== undefined).length === frame.count) {
        chunks.delete(frame.id);
        received(JSON.parse(parts.join('')) as ManagerFrame);
      }
      return;
    }
    if (frame.type === 'command.result') {
      const known = commands.get(frame.commandId);
      if (known && frame.ok && frame.data.receipt?.submissionId)
        remember(known, frame.data.receipt.submissionId);
      if (known)
        records.push({
          at: Date.now(),
          kind: 'command-result',
          marker: known,
          ok: frame.ok,
          receipt: frame.ok ? (frame.data.receipt?.state ?? null) : null,
          errorCode: frame.ok ? null : frame.error.code,
        });
      if (frame.ok && frame.data.snapshot) snapshot(frame.data.snapshot);
      return;
    }
    const identity = `${frame.generation}:${frame.sequence}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    if (frame.type === 'conversation.snapshot') snapshot(frame.snapshot);
    if (
      frame.type === 'conversation.updated' &&
      frame.chat.name === 'Restart space'
    )
      records.push({
        at: Date.now(),
        kind: 'conversation-updated',
        status: frame.chat.status,
        sequence: frame.sequence,
      });
  }
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        const command = JSON.parse(String(payload)) as ManagerCommand;
        if (command.type !== 'conversation.message.send') return;
        const known = marker(command.text);
        if (known) {
          commands.set(command.commandId, known);
          remember(known, command.commandId);
          if (known === 'active-input')
            originalRequest = {
              chatId: command.chatId,
              commandId: command.commandId,
            };
          records.push({ at: Date.now(), kind: 'command-sent', marker: known });
        }
      } catch {
        /* Diagnostics never affect application delivery. */
      }
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        received(JSON.parse(String(payload)) as ManagerFrame | ManagerChunk);
      } catch {
        /* Never persist malformed or raw frames. */
      }
    });
  });
  return {
    mark(
      boundary:
        | 'before-manager-restart'
        | 'after-manager-restart'
        | 'before-gateway-stop'
        | 'after-gateway-start',
    ) {
      if (boundary === 'before-gateway-stop') latest = undefined;
      records.push({ at: Date.now(), kind: 'boundary', boundary });
    },
    request() {
      return originalRequest;
    },
    state() {
      return latest;
    },
    oracle(proof: JournalProof) {
      const key = JSON.stringify(proof);
      if (key === oracleKey) return;
      oracleKey = key;
      records.push({ at: Date.now(), kind: 'journal-oracle', ...proof });
    },
    async save(path: string) {
      await writeFile(path, JSON.stringify({ records }, null, 2));
    },
  };
}
export let restartEvidence: ReturnType<typeof observeRestart> | undefined;
export function beginRestartEvidence(page: Page) {
  restartEvidence = observeRestart(page);
}
