import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const eslint = new ESLint({
  overrideConfig: [tseslint.configs.disableTypeChecked],
});
async function restrictions(
  source,
  filePath = 'apps/frontend/src/boundary.ts',
) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter(
    (message) =>
      message.ruleId === 'no-restricted-imports' ||
      message.ruleId === 'import-boundary/no-server-dynamic-import',
  );
}

describe('browser/server import boundaries', () => {
  it('permits browser-only type imports from shared contracts', async () => {
    expect(
      await restrictions(
        'import type { ChatSnapshot } from "@messenger/contracts"; export type Snapshot = ChatSnapshot;',
      ),
    ).toEqual([]);
  });
  it.each([
    'import { ChatService } from "../../backend/src/chats/service.js"; console.info(ChatService);',
    'import client from "@openclaw/gateway-client"; console.info(client);',
    'import protocol from "@openclaw/protocol"; console.info(protocol);',
    'import fs from "node:fs"; console.info(fs);',
    'import fs from "fs"; console.info(fs);',
    'import backend from "@messenger/backend"; console.info(backend);',
    'export const client = import("@openclaw/gateway-client");',
    'export const server = import("../../backend/src/config.js");',
    'export const contracts = import("@messenger/contracts");',
    'import { ChatSnapshot } from "@messenger/contracts"; console.info(ChatSnapshot);',
    'export { ChatSnapshot } from "@messenger/contracts";',
  ])(
    'rejects browser runtime imports crossing the boundary',
    async (source) => {
      expect(await restrictions(source)).toHaveLength(1);
    },
  );
  it('keeps the shared contract package independent of app implementations', async () => {
    expect(
      await restrictions(
        'import { Store } from "../../../apps/backend/src/database.js"; console.info(Store);',
        'packages/contracts/src/boundary.ts',
      ),
    ).toHaveLength(1);
  });
  it('permits backend runtime access to its Gateway SDK', async () => {
    expect(
      await restrictions(
        'import client from "@openclaw/gateway-client"; console.info(client);',
        'apps/backend/src/gateway/boundary.ts',
      ),
    ).toEqual([]);
  });
});
