import { describe, expect, it } from 'bun:test';
import { apiOrigin } from '../../studio/src/lib/api-origin';

describe('API links behind the Studio reverse proxy', () => {
  const publicOrigin = 'https://studio.tail1234.ts.net:3443';
  const internal = new Request('http://localhost:3001/api/v1/device', {
    headers: { 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'https' },
  });

  it('uses the configured public origin rather than Next internal or forwarded hostnames', () => {
    expect(apiOrigin(internal, publicOrigin)).toBe(publicOrigin);
    expect(new URL('/connect', apiOrigin(internal, publicOrigin)).href).toBe(`${publicOrigin}/connect`);
  });

  it('supports direct local development without a public origin', () => {
    expect(apiOrigin(internal, '')).toBe('http://localhost:3001');
  });

  it('rejects values that are not plain HTTP origins', () => {
    for (const value of ['file:///tmp/site', 'https://user:secret@studio.example',
      'https://studio.example/api', 'https://studio.example?q=1', 'https://studio.example#x']) {
      expect(() => apiOrigin(internal, value)).toThrow('MDMEDIA_PUBLIC_ORIGIN');
    }
  });
});
