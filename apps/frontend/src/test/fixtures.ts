import type { ChatSnapshot, ModelCapability } from '@messenger/contracts';
export const models: ModelCapability[] = [
  {
    id: 'model-a',
    name: 'Reasoner',
    provider: 'Provider',
    available: true,
    thinkingLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
    thinkingDefault: 'low',
    supportsFastMode: true,
    input: ['text', 'image'],
  },
  {
    id: 'model-b',
    name: 'Writer',
    provider: 'Provider',
    available: true,
    thinkingLevels: [{ id: 'off', label: 'Off' }],
    thinkingDefault: 'off',
    supportsFastMode: false,
    input: ['text'],
  },
];
export const snapshot: ChatSnapshot = {
  chat: {
    id: 'chat-a',
    name: 'Research',
    status: 'idle',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: { model: 'model-a', thinkingLevel: 'high', fastMode: true },
  },
  messages: [],
  pending: [],
  activeRun: null,
  pendingSettings: null,
  hasOlderHistory: false,
  historyCursor: null,
};
