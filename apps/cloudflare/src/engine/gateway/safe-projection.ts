import type {
  GatewayEvent,
  GatewayHistory,
} from '../../../../backend/src/gateway/types.js';
import {
  BrowserProjection,
  SafeTextStream,
  type ProjectionPolicy,
} from '../../../../backend/src/presentation/safe.js';
/** This boundary runs before service history, stream and tool caches. */
export class SafeGatewayProjection {
  private readonly streams = new Map<
    string,
    { stream: SafeTextStream; sequence: number }
  >();
  constructor(
    private readonly policy: (sessionKey?: string) => ProjectionPolicy,
  ) {}
  history(history: GatewayHistory, sessionKey?: string): GatewayHistory {
    const projection = new BrowserProjection(this.policy(sessionKey));
    return {
      ...history,
      messages: history.messages
        .filter(
          (message) => message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({
          ...message,
          text: projection.text(message.text),
        })),
      activeRun: history.activeRun
        ? {
            ...history.activeRun,
            text: projection.text(history.activeRun.text),
          }
        : null,
      tools: [],
    };
  }
  event(event: GatewayEvent): GatewayEvent | null {
    if (event.type === 'connection') {
      if (!event.ready) this.streams.clear();
      return event;
    }
    // Native raw tool arguments/results are never admitted to legacy tool caches.
    // Classified summaries can be added only when an authoritative publication exists.
    if (event.type === 'tool') return null;
    const key = `${event.sessionKey}\0${event.runId}`;
    let entry = this.streams.get(key);
    if (entry && event.sequence <= entry.sequence) return null;
    if (!entry || event.replace) {
      entry = {
        stream: new SafeTextStream(
          new BrowserProjection(this.policy(event.sessionKey)),
        ),
        sequence: event.sequence,
      };
      this.streams.set(key, entry);
    }
    entry.sequence = event.sequence;
    // Keep unfinished tokens private while newly verified files become visible mid-run.
    entry.stream.refresh(new BrowserProjection(this.policy(event.sessionKey)));
    let text = entry.stream.push(event.text);
    if (['final', 'aborted', 'error'].includes(event.state)) {
      text += entry.stream.finish();
      this.streams.delete(key);
    }
    // Replace events clear any older preview even while the final token is held.
    return { ...event, text };
  }
}
