import type { EngineContext, ManagerEngine } from './types.js';

/** Wired to the private native Gateway/lifecycle adapter in phase three. */
export function createManagerEngine(
  _context: EngineContext,
): ManagerEngine | undefined {
  void _context;
  return undefined;
}
