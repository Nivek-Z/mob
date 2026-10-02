import { describe, expect, it } from 'vitest';
import { readBytes, readJson } from '../src/http';
describe('bounded request decoding', () => {
  it('accepts a normal numeric Content-Length', async () => {
    const request = new Request('https://example.com', { method: 'POST', body: 'hello', headers: { 'Content-Length': '5' } });
    expect(new TextDecoder().decode(await readBytes(request, 5))).toBe('hello');
  });
  it('checks actual size even if Content-Length understates it', async () => {
    const request = new Request('https://example.com', { method: 'POST', body: 'too-long', headers: { 'Content-Length': '1' } });
    await expect(readBytes(request, 2)).rejects.toMatchObject({ status: 413 });
  });
  it('rejects wrong content types and malformed JSON', async () => {
    await expect(readJson(new Request('https://example.com', { method: 'POST', body: '{}' }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(new Request('https://example.com', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ status: 400 });
  });
});
