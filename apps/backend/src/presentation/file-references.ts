import type { FilePublication } from './safe.js';
type Reference = { path: string; id: string };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundary = /[\s<([{"'=,:`]/u;
/** Literal aliases of already eligible publications; never a filesystem resolver. */
export class FileReferences {
  private readonly references: Reference[];
  constructor(files: readonly FilePublication[], roots: readonly string[]) {
    const candidates: Reference[] = [];
    for (const entry of files) {
      candidates.push({ path: entry.nativePath, id: entry.file.id });
      if (
        entry.relativePath &&
        roots.some((root) => {
          const prefix = root.replace(/\/$/, '') + '/';
          return (
            entry.nativePath.startsWith(prefix) &&
            entry.relativePath ===
              'documents/' + entry.nativePath.slice(prefix.length)
          );
        })
      )
        for (const path of [entry.relativePath, './' + entry.relativePath])
          candidates.push({ path, id: entry.file.id });
    }
    // A policy mistake must not pick one of two same-name publications.
    const unique = new Map<string, Reference | null>();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.path);
      if (!unique.has(candidate.path)) unique.set(candidate.path, candidate);
      else if (previous?.id !== candidate.id) unique.set(candidate.path, null);
    }
    this.references = [...unique.values()]
      .filter((reference): reference is Reference => reference !== null)
      .sort((a, b) => b.path.length - a.path.length);
  }
  replace(input: string): string {
    return input
      .split(/(https?:\/\/[^\s<>"'`]+)/gu)
      .map((part, index) => {
        if (index % 2) return part;
        for (const reference of this.references)
          part = part.replace(
            new RegExp(
              `(^|[\\s<(\\[{"'=,:\\x60])(?:file:\\/\\/)?${escape(reference.path)}(?::[1-9]\\d*(?::[1-9]\\d*)?)?(?=$|[\\s)\\]}>"'\\x60,;!?])`,
              'gu',
            ),
            (_match, prefix: string) => `${prefix}file:${reference.id}`,
          );
        return part;
      })
      .join('');
  }
  continues(input: string): boolean {
    for (let index = 0; index < input.length; index++) {
      if (index && !boundary.test(input[index - 1]!)) continue;
      const prefix = input.slice(index).replace(/^file:\/\//u, '');
      if (
        prefix &&
        this.references.some((reference) => reference.path.startsWith(prefix))
      )
        return true;
    }
    return false;
  }
}
