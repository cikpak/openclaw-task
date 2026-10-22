/** Transport fragments never shorten canonical complete message content. */
export function sendFrame(socket: WebSocket, value: unknown): void {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength <= 64 * 1024) {
    socket.send(text);
    return;
  }
  const width = 16 * 1024;
  const count = Math.ceil(text.length / width);
  const id = crypto.randomUUID();
  for (let index = 0; index < count; index += 1)
    socket.send(
      JSON.stringify({
        type: 'manager.chunk',
        id,
        index,
        count,
        text: text.slice(index * width, (index + 1) * width),
      }),
    );
}
