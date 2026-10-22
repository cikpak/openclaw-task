export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function base64(bytes: ArrayBuffer): string {
  return btoa(
    Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(
      '',
    ),
  );
}
