export function responsePlan(body, response, capacity) {
  const payload = JSON.parse(body);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const prompt = JSON.stringify(messages);
  const markers = [
    'TEXT_FIXTURE_TOKEN',
    'MARKDOWN_FIXTURE_TOKEN',
    'PDF_FIXTURE_TOKEN',
    'PDF_FIRST_BOUNDARY_TOKEN',
    'PDF_SECOND_BOUNDARY_TOKEN',
  ].filter((marker) => prompt.includes(marker));
  if (
    messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'image_url'),
    )
  )
    markers.push('IMAGE_FIXTURE_RECEIVED', 'IMAGE_FIXTURE_TOKEN');
  const latestUser = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      !(
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'image_url') &&
        !message.content.some(
          (part) =>
            part.type === 'text' &&
            part.text?.includes('[messenger-attachments:'),
        )
      ),
  );
  const currentPrompt = JSON.stringify(messages[latestUser]?.content ?? '');
  const capacityMarker = currentPrompt.match(/CAPACITY_CHAT_\d+/u)?.[0];
  if (capacityMarker) markers.push(capacityMarker);
  const reply = currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE')
    ? 'Generated document ready. [Download generated document](documents/artifact-fixture.txt)'
    : currentPrompt.includes('MARKDOWN_STYLE_FIXTURE')
      ? '- **Chisinau Politechnical College:** Computer Science, June 2018.\n- **Step IT Academy:** Computer Science, December 2019.\n\n### Skills and tools\n\nCovers JavaScript/TypeScript, React, Vue, Next.js, HTML/CSS, Node.js, Python, SQL, MongoDB, APIs, microservices, and CI/CD. Also lists Git, AWS, Docker, deployment tools, design systems, UI/UX, OpenAI API, and agentic development.\n\nThe header includes a phone number, email address, and LinkedIn reference.\n\n**Overall:** It presents an engineer who combines product development and frontend leadership with substantial experience teaching others.'
      : `Real Gateway integration response.${markers.length ? ' ' + markers.join(' ') : ''}`;
  if (currentPrompt.includes('CAPACITY_RESPONSE_FIXTURE')) {
    capacity.active++;
    capacity.calls++;
    capacity.peak = Math.max(capacity.peak, capacity.active);
    response.once('close', () => {
      capacity.active--;
    });
  }
  const userContent = messages[latestUser]?.content;
  const userText =
    typeof userContent === 'string'
      ? userContent
      : Array.isArray(userContent)
        ? userContent.map((part) => part.text ?? '').join('\n')
        : '';
  const attachmentLines = userText
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"path"'));
  const inputs = attachmentLines
    .map((line) => JSON.parse(line))
    .filter(
      (file) =>
        typeof file.path === 'string' && file.path.startsWith('/recovery/'),
    );
  const results = messages
    .slice(latestUser + 1)
    .filter((message) => message.role === 'tool');
  const nextInput = inputs[results.length];
  const toolName =
    nextInput || currentPrompt.includes('TOOL_READ_IMAGE_FIXTURE')
      ? 'read'
      : 'write';
  const tool = Array.isArray(payload.tools)
    ? payload.tools.find((entry) => entry.function?.name === toolName)
    : null;
  const callTool = nextInput
    ? Boolean(tool)
    : (currentPrompt.includes('TOOL_WRITE_FIXTURE') ||
        currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE') ||
        currentPrompt.includes('TOOL_READ_IMAGE_FIXTURE')) &&
      tool &&
      !messages
        .slice(latestUser + 1)
        .some((message) => message.role === 'tool');
  const pathKey = tool?.function?.parameters?.properties?.path
    ? 'path'
    : 'file_path';
  const toolCall = {
    id: `call-fixture-${toolName}-${results.length}`,
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify({
        [pathKey]:
          nextInput?.path ??
          (toolName === 'read'
            ? 'documents/artifact-fixture.png'
            : currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE')
              ? 'documents/artifact-fixture.txt'
              : 'private-working-fixture.txt'),
        ...(toolName === 'write' ? { content: 'TOOL_FILE_TOKEN' } : {}),
      }),
    },
  };

  return { payload, currentPrompt, reply, callTool, toolCall };
}
