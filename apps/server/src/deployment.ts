export function parsePublicOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('INVALID_PUBLIC_ORIGIN');
    return origin;
  } catch {
    throw new Error('INVALID_PUBLIC_ORIGIN');
  }
}
export function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535)
    throw new Error('INVALID_PORT');
  return Number(value);
}
