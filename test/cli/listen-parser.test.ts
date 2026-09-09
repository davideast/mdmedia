import { describe, expect, it } from 'bun:test';
import { parseListenCommand } from '../../src/cli/listen-parser.js';

describe('parseListenCommand', () => {
  it('returns null for non-/listen commands', () => {
    expect(parseListenCommand('hello world')).toBeNull();
    expect(parseListenCommand('/help')).toBeNull();
  });

  it('parses one-shot /listen', () => {
    const cmd = parseListenCommand('/listen');
    expect(cmd).not.toBeNull();
    expect(cmd?.mode).toBe('once');
  });

  it('parses /listen auto with voice and style', () => {
    const cmd = parseListenCommand('/listen auto --voice Puck --style "energetic"');
    expect(cmd?.mode).toBe('auto');
    expect(cmd?.voice).toBe('Puck');
    expect(cmd?.style).toBe('energetic');
  });

  it('parses /listen off and /listen stop', () => {
    expect(parseListenCommand('/listen off')?.mode).toBe('off');
    expect(parseListenCommand('/listen stop')?.mode).toBe('off');
  });

  it('parses /listen generate for conversation turns and specific file targets', () => {
    const turnCmd = parseListenCommand('/listen generate');
    expect(turnCmd?.mode).toBe('generate');
    expect(turnCmd?.targetPath).toBeUndefined();

    const fileCmd = parseListenCommand('/listen generate docs/architecture.md');
    expect(fileCmd?.mode).toBe('generate');
    expect(fileCmd?.targetPath).toBe('docs/architecture.md');
  });
});
