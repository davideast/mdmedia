import { existsSync } from 'node:fs';

if (existsSync('.next-hosted/BUILD_ID')) {
  throw new Error('A live hosted build already exists. Use build:hosted and release:hosted to update it.');
}
