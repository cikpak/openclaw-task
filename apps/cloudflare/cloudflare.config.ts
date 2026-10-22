import { defineConfig } from 'cf/config';
import { backend, facade, manager, engineContainer } from './config/workers.ts';

import { localWorkers } from './config/local.ts';

export default defineConfig(({ mode }) => {
  if (mode === 'development' || mode === 'acceptance') {
    const local = localWorkers(mode);
    return { containers: [local.container], worker: local.facade };
  }
  if (
    !['backend-bootstrap', 'backend', 'manager', 'production'].includes(
      mode ?? '',
    )
  )
    throw new Error('Select an explicit supported build mode.');
  return {
    containers: mode === 'manager' ? [engineContainer] : [],
    accountId: '65cabd080cdf7a36f76d0e884752c249',
    worker:
      mode === 'backend-bootstrap'
        ? { ...backend, env: { ...backend.env, MANAGER: undefined } }
        : mode === 'backend'
          ? backend
          : mode === 'manager'
            ? manager
            : facade,
  };
});
