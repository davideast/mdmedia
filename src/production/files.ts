import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readMp4Duration } from '../video/mp4-duration.js';
import type { AssetInspection, ProductionPlan } from './types.js';

export async function hashProductionFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inspectProductionAssets(plan: ProductionPlan, root: string): Promise<AssetInspection[]> {
  return Promise.all(plan.assets.map(async asset => {
    try {
      const path = resolve(root, asset.path);
      if (asset.kind === 'video') {
        const bytes = await readFile(path);
        const durationSeconds = readMp4Duration(bytes);
        return { id: asset.id, sha256: createHash('sha256').update(bytes).digest('hex'), durationSeconds, ...(!durationSeconds ? { error: 'Cannot read MP4/MOV duration; provide a supported review/export file.' } : {}) };
      }
      return { id: asset.id, sha256: await hashProductionFile(path) };
    }
    catch (error) { return { id: asset.id, error: error instanceof Error ? error.message : String(error) }; }
  }));
}
