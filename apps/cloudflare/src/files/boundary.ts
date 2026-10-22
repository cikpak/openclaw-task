import {
  BrowserProjection,
  type ProjectionPolicy,
} from '../../../backend/src/presentation/safe.js';
const opaque = new Set([
  'id',
  'commandId',
  'chatId',
  'messageId',
  'runId',
  'generation',
  'historyCursor',
  'receiptCommandId',
  'uploadId',
  'submissionId',
  'toolCallId',
  'correlationId',
  'fileId',
]);
/** Apply one final boundary to canonical application inputs, errors and replay. */
export class BrowserBoundary {
  constructor(private readonly policy: () => ProjectionPolicy) {}
  project<T>(input: T): T {
    const projection = new BrowserProjection(this.policy());
    const visit = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string') {
        if (opaque.has(key)) return value;
        if (key === 'url' && /^\/downloads\/[a-f0-9]{64}$/.test(value))
          return value;
        return projection.text(value);
      }
      if (Array.isArray(value)) return value.map((item) => visit(item));
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            visit(item, name),
          ]),
        );
      return value;
    };
    return visit(input) as T;
  }
}
