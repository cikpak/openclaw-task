import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { registerApplicationDispatcher } from '../lib/manager';
import { fixtureApplication } from './applicationDispatcher';
beforeEach(() => {
  registerApplicationDispatcher(fixtureApplication);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  value: function (this: HTMLDialogElement) {
    this.open = true;
  },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  value: function (this: HTMLDialogElement) {
    this.open = false;
  },
});
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  value: () => undefined,
});

if (!Blob.prototype.arrayBuffer)
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    value: function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () =>
          reject(reader.error ?? new Error('File could not be read.'));
        reader.readAsArrayBuffer(this);
      });
    },
  });
