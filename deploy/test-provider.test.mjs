import { describe, expect, it } from 'vitest';
import { responsePlan } from '../test/acceptance/container/response.mjs';
const first = '/recovery/workspace/test/documents/.messenger-inputs/source.txt';
const second =
  '/recovery/workspace/test/documents/.messenger-inputs/source.pdf/.pdf-read-abc/extracted-text.txt';
const tools = [
  { function: { name: 'read', parameters: { properties: { path: {} } } } },
];
const userText = `[messenger-attachments:test]\n${JSON.stringify({ name: 'source.txt', path: first })}\n${JSON.stringify({ name: 'source.pdf', path: second })}`;
function plan(messages) {
  return responsePlan(JSON.stringify({ messages, tools }), {}, {});
}
describe('test-only provider follows actual native attachment references', () => {
  it('reads text even when native automatic image detection enriches the original user turn', () => {
    const result = plan([
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,fixture' },
          },
        ],
      },
    ]);
    expect(result.callTool).toBe(true);
    expect(JSON.parse(result.toolCall.function.arguments).path).toBe(first);
  });
  it('continues to the next input after a synthetic image-only user turn', () => {
    const result = plan([
      { role: 'user', content: userText },
      { role: 'tool', content: 'file read' },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,fixture' },
          },
        ],
      },
    ]);
    expect(result.callTool).toBe(true);
    expect(JSON.parse(result.toolCall.function.arguments).path).toBe(second);
  });
  it('does not emit a file-only marker before its actual tool result is present', () => {
    const result = plan([{ role: 'user', content: userText }]);
    expect(result.reply).not.toContain('PDF_FIXTURE_TOKEN');
  });
});
