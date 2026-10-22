import type { z } from 'zod';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { historySchema, upstreamMessageSchema } from './protocol-schemas.js';
import { GatewayUnavailableError } from '../errors.js';
type Page = z.infer<typeof historySchema>;
type Receipt = NonNullable<Page['inputReceipts']>[number];
type Binding = { owner: string; sequence: number; explicit: boolean };

/** Native consumption proves ingestion. Exact later successful output proves
 * completion; all associations remain private and bound to this native scope. */
export async function completedInputs(
  context: GatewayContext,
  mapping: GatewayMapping,
  first: Page,
  requested: string[],
  generation: number,
): Promise<{
  inputs: string[];
  cancelled: string[];
  receipts: Receipt[];
  owners?: { inputId: string; runId: string }[];
}> {
  const sessionId = first.sessionId ?? first.sessionInfo?.sessionId;
  if (!requested.length || !sessionId)
    return { inputs: [], cancelled: [], receipts: [] };
  const wanted = new Set(requested);
  const receipts = new Map<string, Receipt>();
  const bindings = new Map<string, Binding>();
  const done = new Set<string>(),
    cancelled = new Set<string>();
  const check = (page: Page) => {
    if (
      context.capabilityGeneration !== generation ||
      context.transport.stopped ||
      !context.transport.ready ||
      (page.sessionId ?? page.sessionInfo?.sessionId) !== sessionId ||
      (page.sessionInfo?.sessionId !== undefined &&
        page.sessionInfo.sessionId !== sessionId) ||
      (page.sessionKey !== undefined &&
        page.sessionKey !== mapping.sessionKey) ||
      (first.totalMessages !== undefined &&
        page.totalMessages !== first.totalMessages)
    )
      throw new GatewayUnavailableError();
    for (const receipt of page.inputReceipts ?? []) {
      if (!wanted.has(receipt.runId)) continue;
      const prior = receipts.get(receipt.runId);
      if (
        prior?.cancelled ||
        (prior?.state === 'pending' && !receipt.cancelled)
      )
        continue;
      receipts.set(receipt.runId, receipt);
    }
  };
  const records = (page: Page) =>
    page.messages.flatMap((value) => {
      const parsed = upstreamMessageSchema.safeParse(value);
      const meta = parsed.success ? parsed.data.__openclaw : undefined;
      return parsed.success &&
        meta?.id?.trim() &&
        !meta.id.startsWith('pending:') &&
        Number.isSafeInteger(meta.seq) &&
        (meta.seq ?? 0) > 0
        ? [{ message: parsed.data, meta }]
        : [];
    });
  // Two bounded-page passes retain only metadata for requested inputs, never an
  // accumulated transcript. An owner can first become known on an older page.
  const scan = async (visit: (page: Page) => boolean) => {
    let page = first,
      previousOffset = 0;
    for (;;) {
      check(page);
      if (visit(page) || !page.hasMore) return;
      const offset = page.nextOffset;
      if (!Number.isSafeInteger(offset) || offset! <= previousOffset)
        throw new GatewayUnavailableError();
      previousOffset = offset!;
      page = historySchema.parse(
        await context.request('chat.history', {
          agentId: mapping.agentId,
          sessionKey: mapping.sessionKey,
          offset,
          limit: 1000,
          maxBytes: 262144,
          inputRunIds: requested,
        }),
      );
    }
  };
  await scan((page) => {
    for (const { message, meta } of records(page)) {
      if (message.role !== 'user') continue;
      const key = meta.idempotencyKey ?? message.idempotencyKey;
      const base = key?.endsWith(':user') ? key.slice(0, -5) : key;
      const processing = meta.messengerProcessing;
      if (
        processing &&
        meta.steerTargetRunId &&
        processing.runId !== meta.steerTargetRunId
      )
        throw new GatewayUnavailableError();
      for (const input of wanted) {
        const receipt = receipts.get(input);
        if (
          base !== input &&
          !processing?.keys.some(
            (source) => source === input || source === `${input}:user`,
          ) &&
          !(
            receipt?.state === 'consumed' &&
            receipt.consumedByEventId === meta.id
          )
        )
          continue;
        const owner =
          processing?.runId || meta.steerTargetRunId?.trim() || base;
        if (owner) {
          const prior = bindings.get(input);
          const explicit = processing !== undefined;
          if (prior) {
            if (prior.explicit && (!explicit || prior.sequence > meta.seq!))
              continue;
            if (
              !explicit &&
              !prior.explicit &&
              (prior.owner !== owner || prior.sequence !== meta.seq)
            )
              throw new GatewayUnavailableError();
            if (prior.sequence === meta.seq && prior.owner !== owner)
              throw new GatewayUnavailableError();
          }
          bindings.set(input, { owner, sequence: meta.seq!, explicit });
        }
      }
    }
    return [...wanted].every(
      (input) =>
        bindings.has(input) || receipts.get(input)?.state === 'pending',
    );
  });
  if (bindings.size)
    await scan((page) => {
      for (const { message, meta } of records(page)) {
        if (
          message.role !== 'assistant' ||
          !meta.runId ||
          (message.channel !== undefined && message.channel !== 'final') ||
          message.error ||
          message.errorMessage ||
          message.isError === true ||
          message.requestFailed === true ||
          (Array.isArray(message.content) &&
            message.content.some((part) =>
              ['toolCall', 'tool_use', 'functionCall'].includes(part.type),
            ))
        )
          continue;
        for (const [input, binding] of bindings) {
          if (
            receipts.get(input)?.state === 'pending' ||
            binding.owner !== meta.runId ||
            meta.seq! <= binding.sequence ||
            first.inFlightRun?.runId === binding.owner
          )
            continue;
          if (message.stopReason === 'stop') done.add(input);
          else if (message.stopReason === 'aborted') cancelled.add(input);
        }
      }
      return [...bindings.keys()].every(
        (input) =>
          done.has(input) ||
          cancelled.has(input) ||
          first.inFlightRun?.runId === bindings.get(input)?.owner,
      );
    });
  check(first);
  const pending = [...receipts.values()].filter(
    (receipt) => receipt.state === 'pending' && !receipt.cancelled,
  );
  for (const [input, binding] of bindings)
    if (
      first.inFlightRun?.runId === binding.owner &&
      !receipts.get(input)?.cancelled &&
      !pending.some((receipt) => receipt.runId === input)
    )
      pending.push({ runId: input, state: 'pending' });
  for (const receipt of receipts.values())
    if (receipt.cancelled) cancelled.add(receipt.runId);
  for (const input of wanted)
    if (receipts.get(input)?.state === 'pending') done.delete(input);
  return {
    inputs: [...done],
    cancelled: [...cancelled],
    receipts: pending,
    ...(bindings.size
      ? {
          owners: [...bindings].map(([inputId, binding]) => ({
            inputId,
            runId: binding.owner,
          })),
        }
      : {}),
  };
}
