export function uint8ArrayToBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < value.length; index += chunkSize) {
    const chunk = value.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}
