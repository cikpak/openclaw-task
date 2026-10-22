// Structural diagnostics exist only in the acceptance provider.
export function recordProvider(
  diagnostics,
  response,
  payload,
  currentPrompt,
  callTool,
  toolCall,
) {
  const diagnostic = {
    users: payload.messages
      .filter((message) => message.role === 'user')
      .map((message) => {
        const text =
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
        return {
          image:
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === 'image_url'),
          attachments: text.includes('[messenger-attachments:'),
          privateWrite: text.includes('TOOL_WRITE_FIXTURE'),
          documentsWrite: text.includes('TOOL_WRITE_DOC_FIXTURE'),
        };
      }),
    toolResults: payload.messages
      .filter((message) => message.role === 'tool')
      .map((message) => ({
        denied: /EACCES|permission|denied/iu.test(
          JSON.stringify(message.content),
        ),
        wrote: /Successfully wrote/u.test(JSON.stringify(message.content)),
        artifact: JSON.stringify(message.content).includes(
          'artifact-fixture.txt',
        ),
        privateWorking: JSON.stringify(message.content).includes(
          'private-working-fixture.txt',
        ),
      })),
    selectedPrivateWrite: currentPrompt.includes('TOOL_WRITE_FIXTURE'),
    selectedDocumentsWrite: currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE'),
    callTool: Boolean(callTool),
    tool: callTool ? toolCall.function.name : null,
    documentsTarget:
      callTool &&
      toolCall.function.arguments.includes('documents/artifact-fixture.txt'),
  };
  diagnostic.completed = false;
  diagnostic.closed = false;
  response.once('finish', () => {
    diagnostic.completed = true;
  });
  response.once('close', () => {
    diagnostic.closed = true;
  });
  diagnostics.push(diagnostic);
  if (diagnostics.length > 1000) diagnostics.shift();
}
