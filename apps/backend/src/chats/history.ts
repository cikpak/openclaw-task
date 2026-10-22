import type {
  Gateway,
  GatewayHistory,
  GatewayMapping,
} from '../gateway/types.js';
import { GatewayUnavailableError } from '../errors.js';
/** The pinned receipt query is limited to fifty IDs; recovery can retain more upstream inputs. */
export async function historyWithReceipts(
  gateway: Gateway,
  target: GatewayMapping,
  ids: string[],
): Promise<GatewayHistory> {
  if (!ids.length) return gateway.history(target);
  const receipts = new Map<string, GatewayHistory['receipts'][number]>();
  const journaled = new Set<string>();
  const cancelled = new Set<string>();
  const owners = new Map<string, string>();
  let session: string | undefined;
  let latest: GatewayHistory | undefined;
  for (let start = 0; start < ids.length; start += 50) {
    latest = await gateway.history(target, {
      inputRunIds: ids.slice(start, start + 50),
    });
    if (start === 0) session = latest.sessionId;
    else if (latest.sessionId !== session) throw new GatewayUnavailableError();
    for (const receipt of latest.receipts) receipts.set(receipt.runId, receipt);
    for (const id of latest.completedInputs ?? []) journaled.add(id);
    for (const id of latest.nativeCancelledInputs ?? []) cancelled.add(id);
    for (const owner of latest.nativeInputOwners ?? [])
      owners.set(owner.inputId, owner.runId);
  }
  if (!latest) throw new Error('Missing bounded history response');
  return {
    ...latest,
    receipts: [...receipts.values()],
    ...(journaled.size ? { completedInputs: [...journaled] } : {}),
    ...(cancelled.size ? { nativeCancelledInputs: [...cancelled] } : {}),
    ...(owners.size
      ? {
          nativeInputOwners: [...owners].map(([inputId, runId]) => ({
            inputId,
            runId,
          })),
        }
      : {}),
  };
}
