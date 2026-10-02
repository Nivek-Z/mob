export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 1024 * 1024): Promise<T> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
  try {
    const bytes = await readBytes(request, maxBytes);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_INPUT', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function requireString(value: unknown, name: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new ApiError(400, 'INVALID_INPUT', name + ' must be a non-empty string of at most ' + maxLength + ' characters.');
  return value;
}
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function requireId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new ApiError(400, 'INVALID_MEDIA_ID', 'Invalid media ID.');
}
