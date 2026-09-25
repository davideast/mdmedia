import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

describe('Packaging, Subpath Export Maps & Container Hermeticity (Insights 4ffb88f5, 3f0ffec0, 59cd7e9f, c12fc3d4)', () => {
  const rootDir = path.resolve('.');

  it('Studio container and build configuration must be hermetic and standalone-enabled', () => {
    const studioDockerignoreExists = fs.existsSync(path.join(rootDir, 'studio', '.dockerignore'));
    const nextConfigContent = fs.readFileSync(path.join(rootDir, 'studio', 'next.config.ts'), 'utf8');
    const hasStandalone = nextConfigContent.includes('standalone');

    expect(studioDockerignoreExists).toBe(true);
    expect(hasStandalone).toBe(true);
  });
});
