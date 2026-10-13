import type {
  Gateway,
  GatewayHistory,
  GatewayMapping,
} from '../gateway/types.js';
/** The pinned receipt query is limited to fifty IDs; recovery can retain more upstream inputs. */
export async function historyWithReceipts(
  gateway: Gateway,
  target: GatewayMapping,
  ids: string[],
): Promise<GatewayHistory> {
  if (!ids.length) return gateway.history(target);
  const receipts = new Map<string, GatewayHistory['receipts'][number]>();
  let latest: GatewayHistory | undefined;
  for (let start = 0; start < ids.length; start += 50) {
    latest = await gateway.history(target, {
      inputRunIds: ids.slice(start, start + 50),
    });
    for (const receipt of latest.receipts) receipts.set(receipt.runId, receipt);
  }
  if (!latest) throw new Error('Missing bounded history response');
  return { ...latest, receipts: [...receipts.values()] };
}
