import { expect, it } from 'vitest';
import { SleepDiagnostics } from './sleep-diagnostics.js';

it.each([
  ['Invalid recovery reference', 'invalid-reference'],
  ['Recovery reference mismatch', 'reference-mismatch'],
  ['Invalid recovery object', 'invalid-object'],
  ['Private recovery signing unavailable', 'signing-unavailable'],
  ['Recovery object missing or incomplete', 'object-missing'],
  ['Recovery object metadata changed', 'object-metadata-mismatch'],
  ['Stale private operation result', 'stale-operation'],
  ['Helper operation identity reused', 'operation-identity'],
  ['Recovery readback verification mismatch', 'verification-mismatch'],
  ['Private engine helper unavailable', 'helper-unavailable'],
])(
  'categorizes fixed Manager failure %s without emitting its message',
  (message, reason) => {
    const lines: string[] = [];
    const diagnostics = new SleepDiagnostics((line) => lines.push(line));
    diagnostics.failure('capturing', new Error(message));
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'engine-sleep',
      observation: 'failure',
      phase: 'capturing',
      reason,
    });
    expect(lines[0]).not.toContain(message);
    diagnostics.failure(
      'capturing',
      new Error(message + ': SECRET /recovery/path'),
    );
    expect(JSON.parse(lines[1]!)).toMatchObject({ reason: 'other' });
    expect(lines.join('')).not.toContain('SECRET');
  },
);
