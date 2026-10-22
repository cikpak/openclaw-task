import type { BrowserFile, BrowserToolSummary } from '@messenger/contracts';

export interface FilePublication {
  nativePath: string;
  /** Classification is authoritative; location alone never grants publication. */
  classification: 'deliverable' | 'private' | 'unclassified';
  file: BrowserFile;
}
export interface ProjectionPolicy {
  documentsRoots: readonly string[];
  publications: readonly FilePublication[];
  secrets?: readonly string[] | undefined;
}
const PRIVATE_REFERENCE = '[private reference]';
const hasControl = (text: string): boolean =>
  Array.from(text).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const INTERNAL_NAME =
  /(?:^|\/)(?:\.[^/]+|AGENTS\.md|SOUL\.md|IDENTITY\.md|MEMORY\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|BOOTSTRAP\.md|openclaw\.json)(?:\/|$)/i;
function eligible(entry: FilePublication, roots: readonly string[]): boolean {
  const path = entry.nativePath;
  return (
    entry.classification === 'deliverable' &&
    entry.file.category === 'deliverable' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(entry.file.id) &&
    entry.file.name.length > 0 &&
    entry.file.name.length <= 300 &&
    !/[/\\]/u.test(entry.file.name) &&
    !hasControl(entry.file.name) &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(entry.file.mimeType) &&
    Number.isSafeInteger(entry.file.sizeBytes) &&
    entry.file.sizeBytes >= 0 &&
    !path.includes('\\') &&
    !hasControl(path) &&
    !path.split('/').some((part) => part === '..' || part === '.') &&
    !INTERNAL_NAME.test(path) &&
    roots.some(
      (root) =>
        /\/documents\/?$/.test(root) &&
        path.startsWith(`${root.replace(/\/$/, '')}/`),
    )
  );
}

/** Only classified deliverables can be converted into browser file references. */
export class BrowserProjection {
  private readonly files: FilePublication[];
  private readonly secrets: readonly string[];
  constructor(policy: ProjectionPolicy) {
    this.files = policy.publications
      .filter((file) => eligible(file, policy.documentsRoots))
      .sort((a, b) => b.nativePath.length - a.nativePath.length);
    this.secrets = (policy.secrets ?? []).filter(Boolean);
    if (this.secrets.some((secret) => secret.length > 65536))
      throw new Error('Projection secret exceeds the safe bound.');
  }
  file(nativePath: string): BrowserFile | null {
    const found = this.files.find((entry) => entry.nativePath === nativePath);
    if (!found) return null;
    const { id, name, mimeType, sizeBytes, category, updatedAt } = found.file;
    // Explicit projection prevents accidental future fields from crossing the boundary.
    return { id, name, mimeType, sizeBytes, category, updatedAt };
  }
  token(input: string): string {
    let output = input;
    for (const secret of this.secrets)
      output = output.split(secret).join('[redacted]');
    for (const entry of this.files) {
      const escaped = entry.nativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(
        new RegExp(
          `(?:file:\\/\\/)?${escaped}(?=$|[\\s\\)\\]}>"'\u0060,;!?])`,
          'g',
        ),
        `file:${entry.file.id}`,
      );
    }
    // Preserve public https URLs, while masking native absolute, home and Windows paths.
    output = output.replace(
      /(^|[<([{"'=,:`])(?:file:\/\/)?(?:\/(?!\/)|~\/|[A-Za-z]:[\\/])[^\s<>"'`]+/g,
      '$1' + PRIVATE_REFERENCE,
    );
    output = output.replace(
      /(^|[<([{"'=,:`])(?:documents\/|\.openclaw\/|\.{1,2}\/)[^\s<>"'`]+/g,
      '$1' + PRIVATE_REFERENCE,
    );
    output = output.replace(
      /\b(?:AGENTS|SOUL|IDENTITY|MEMORY|USER|TOOLS|HEARTBEAT|BOOTSTRAP)\.md\b|\bopenclaw\.json\b/gi,
      PRIVATE_REFERENCE,
    );
    output = output.replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password|authorization)=[^\s&]+)/gi,
      '[redacted]',
    );
    return output;
  }
  text(input: string): string {
    const stream = new SafeTextStream(this, Infinity);
    return stream.push(input) + stream.finish();
  }
  continuesFile(input: string): boolean {
    const prefix = input.replace(/^[<([{"'=,:`]*(?:file:\/\/)?/, '');
    return this.files.some((entry) => entry.nativePath.startsWith(prefix));
  }
  redactor(): SecretRedactor {
    return new SecretRedactor(this.secrets);
  }
  tool(input: {
    id: string;
    operation: BrowserToolSummary['operation'];
    status: BrowserToolSummary['status'];
    nativePath?: string | undefined;
    verifiedLineCount?: number | undefined;
  }): BrowserToolSummary | null {
    // Tool arguments/results are deliberately absent from this interface.
    const file = input.nativePath ? this.file(input.nativePath) : null;
    if ((input.nativePath || input.operation !== 'fetch') && !file) return null;
    if (!/^[A-Za-z0-9_:.-]{1,256}$/.test(input.id)) return null;
    const verb = {
      read: 'Read',
      write: 'Wrote',
      edit: 'Edited',
      fetch: 'Fetched a page',
    }[input.operation];
    const count =
      input.status === 'completed' &&
      input.operation === 'write' &&
      Number.isSafeInteger(input.verifiedLineCount) &&
      (input.verifiedLineCount ?? -1) >= 0
        ? ` ${input.verifiedLineCount} lines to`
        : '';
    return {
      id: input.id,
      operation: input.operation,
      status: input.status,
      text: this.text(`${verb}${count}${file ? ` ${file.name}` : ''}`),
      ...(file ? { fileId: file.id } : {}),
    };
  }
}

/**
 * Keep unfinished lexical tokens private, so a path/secret split between native
 * stream frames can never leak its prefix. Oversized tokens are suppressed whole;
 * this bound limits scratch memory, never canonical completed-message retention.
 */
export class SafeTextStream {
  private token = '';
  private suppressed = false;
  private readonly redactor: SecretRedactor;
  constructor(
    private readonly projection: BrowserProjection,
    private readonly tokenLimit = 4096,
  ) {
    this.redactor = projection.redactor();
  }
  push(chunk: string): string {
    return this.scan(this.redactor.push(chunk));
  }
  private scan(chunk: string): string {
    const output: string[] = [];
    for (const character of chunk) {
      if (
        /\s/u.test(character) &&
        !this.projection.continuesFile(this.token + character)
      ) {
        output.push(this.flush(), character);
      } else if (!this.suppressed) {
        this.token += character;
        if (this.token.length > this.tokenLimit) {
          this.token = '';
          this.suppressed = true;
        }
      }
    }
    return output.join('');
  }
  finish(): string {
    return this.scan(this.redactor.finish()) + this.flush();
  }
  private flush(): string {
    const output = this.suppressed
      ? PRIVATE_REFERENCE
      : this.projection.token(this.token);
    this.token = '';
    this.suppressed = false;
    return output;
  }
}

/** Prefix holdback covers opaque credentials and multiline/space-containing keys. */
class SecretRedactor {
  private pending = '';
  constructor(private readonly secrets: readonly string[]) {}
  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }
  finish(): string {
    return this.drain(true);
  }
  private drain(final: boolean): string {
    if (!this.secrets.length) {
      const text = this.pending;
      this.pending = '';
      return text;
    }
    const result: string[] = [];
    while (this.pending) {
      const secret = this.secrets.find((value) =>
        this.pending.startsWith(value),
      );
      if (secret) {
        result.push('[redacted]');
        this.pending = this.pending.slice(secret.length);
      } else if (
        !final &&
        this.secrets.some((value) => value.startsWith(this.pending))
      )
        break;
      else {
        result.push(this.pending[0] ?? '');
        this.pending = this.pending.slice(1);
      }
    }
    return result.join('');
  }
}
