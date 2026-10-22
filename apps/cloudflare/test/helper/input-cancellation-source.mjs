import vm from 'node:vm';
import { upstreamSources } from './native-owner-fixture.mjs';
import { inputCancellationPatches } from '../../container/native-owner/input-cancellation-patches.mjs';
import { transform } from '../../container/native-owner/install.mjs';
const originals = upstreamSources(['chat-abort-BYJgcIuQ.mjs']);
export const sources = new Map(
  inputCancellationPatches.map((patch) => [
    patch.file,
    transform(originals[patch.file], patch),
  ]),
);
export const abortSource = originals['chat-abort-BYJgcIuQ.mjs'];
export const slice = (source, start, end) =>
  source.slice(
    source.indexOf(start),
    source.indexOf(end, source.indexOf(start)),
  );
export const evaluate = (source, globals) =>
  vm.runInNewContext(`(${source})`, globals);
export const noop = () => {};
