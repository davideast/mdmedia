import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_NARRATION_SYSTEM_INSTRUCTION,
  buildNarrationSystemInstruction,
} from '../../src/narration/system-instructions.js';

describe('Narration System Instructions (Seam 2)', () => {
  it('instructs model to verbalize all code blocks (both fenced and indented) into natural spoken English', () => {
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('Code Blocks & Snippets');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('triple backticks');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('indented');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('Translate all code blocks');
  });

  it('instructs model to describe Mermaid and visual diagrams conceptually without reading raw syntax', () => {
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('Mermaid & Architecture Diagrams');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('Never read or emit raw diagram syntax');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('flowchart');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('subgraph');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('arrows');
  });

  it('strictly forbids emitting code fences or raw indented blocks in adapted output', () => {
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('Never include triple backticks');
    expect(DEFAULT_NARRATION_SYSTEM_INSTRUCTION).toContain('pure narration prose');
  });

  it('builds combined instructions preserving default rules and appending custom prompts', () => {
    const combined = buildNarrationSystemInstruction('Custom test directive');
    expect(combined).toContain(DEFAULT_NARRATION_SYSTEM_INSTRUCTION);
    expect(combined).toContain('Custom Narration Instructions:');
    expect(combined).toContain('Custom test directive');
  });
});
