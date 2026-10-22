import { readFile } from 'node:fs/promises';
import { AcceptanceClient } from './client.mjs';
export async function client() {
  const password = await readFile(
    process.env.ACCEPTANCE_PASSWORD_FILE ?? '.context/test-password.txt',
    'utf8',
  );
  return new AcceptanceClient(
    process.env.ACCEPTANCE_ORIGIN ?? 'http://localhost:18080',
    process.env.APP_USERNAME ?? 'admin',
    password,
  ).login();
}
export const settings = {
  model: 'mock/test-model',
  thinkingLevel: 'off',
  fastMode: false,
  customInstructions: '',
  responseStyle: 'default',
  personality: 'neutral',
};
