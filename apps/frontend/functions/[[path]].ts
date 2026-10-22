import { routeDynamic } from '../../cloudflare/src/facade.js';
import type { FacadeBindings } from '../../cloudflare/src/facade.js';

export const onRequest = (context: { request: Request; env: FacadeBindings }) =>
  routeDynamic(context.request, context.env);
