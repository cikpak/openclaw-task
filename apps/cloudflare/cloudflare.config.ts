import { defineConfig } from 'cf/config';
import { backend, facade, manager } from './config/workers.ts';

export default defineConfig(({ mode }) => ({
  accountId: '65cabd080cdf7a36f76d0e884752c249',
  worker:
    mode === 'backend-bootstrap'
      ? { ...backend, env: { ...backend.env, MANAGER: undefined } }
      : mode === 'backend'
        ? backend
        : mode === 'manager'
          ? manager
          : facade,
}));
