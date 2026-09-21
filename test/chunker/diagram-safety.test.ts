import { describe, expect, it } from 'bun:test';
import {
  isDiagramBlock,
  parseMarkdownToSpeakableParagraphs,
} from '../../src/chunker/markdown-ast-parser.js';

describe('Diagram Safety Net in Chunker (Seam 1)', () => {
  const rawMermaidFlowchart = `flowchart TD
  subgraph PROBES["1. Independent Facet Probes (Parallel Fact Gathering)"]
    direction LR
    F_AUTH["<b>auth</b><br/>Loop & Canvas tokens"]
    F_REPO["<b>repo</b><br/>git remote & GitHub App"]
    F_WS["<b>workspace</b><br/>.stitch.json & candidates"]
  end
  ENV["<b>stitch status --json</b>"]
  subgraph REDUCERS["2. Pluggable Flow Reducers"]
    direction LR
    R_PROTO["<b>--flow=prototype</b>"]
  end
  PROBES --> ENV
  ENV --> REDUCERS`;

  const indentedFlowchartMarkdown = `
The domain language updates provide a foundation for precise problem definition.

    flowchart TD
    subgraph PROBES["1. Independent Facet Probes"]
      direction LR
      F_AUTH["auth"]
    end
    ENV["stitch status"]
    PROBES --> ENV

Next paragraph explains the architecture.
`;

  const fencedMermaidMarkdown = `
Here is the system architecture:

\`\`\`mermaid
graph TD
  A[Client] --> B[Server]
  B --> C[Database]
\`\`\`

Conclusion of the document.
`;

  const fencedSequenceMarkdown = `
\`\`\`
sequenceDiagram
  Alice->>Bob: Hello
  Bob-->>Alice: Hi
\`\`\`
`;

  const standardCodeMarkdown = `
\`\`\`ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`
`;

  describe('isDiagramBlock (Unit)', () => {
    it('detects mermaid diagrams with explicit lang tag', () => {
      expect(isDiagramBlock('graph TD\nA --> B', 'mermaid')).toBe(true);
    });

    it('detects diagrams without lang tag from first statement keyword', () => {
      expect(isDiagramBlock(rawMermaidFlowchart)).toBe(true);
      expect(isDiagramBlock('flowchart LR\nA --> B')).toBe(true);
      expect(isDiagramBlock('graph TD\nA --> B')).toBe(true);
      expect(isDiagramBlock('sequenceDiagram\nAlice->>Bob: Hi')).toBe(true);
      expect(isDiagramBlock('stateDiagram-v2\n[*] --> Still')).toBe(true);
      expect(isDiagramBlock('classDiagram\nClass01 <|-- Avery')).toBe(true);
      expect(isDiagramBlock('erDiagram\nCUSTOMER ||--o{ ORDER : places')).toBe(true);
    });

    it('rejects standard programming code snippets', () => {
      expect(isDiagramBlock('export function add(a: number, b: number): number {\n  return a + b;\n}', 'ts')).toBe(false);
      expect(isDiagramBlock('const x = 1;\nconsole.log(x);')).toBe(false);
      expect(isDiagramBlock('import { foo } from "./foo";\nfoo();')).toBe(false);
    });
  });

  describe('parseMarkdownToSpeakableParagraphs (Integration)', () => {
    it('does NOT emit "Code snippet: flowchart TD..." for 4-space indented mermaid diagrams', () => {
      const paragraphs = parseMarkdownToSpeakableParagraphs(indentedFlowchartMarkdown);

      expect(paragraphs.length).toBeGreaterThan(0);
      for (const p of paragraphs) {
        expect(p).not.toContain('Code snippet: flowchart');
        expect(p).not.toContain('subgraph PROBES');
        expect(p).not.toContain('direction LR');
      }
      expect(paragraphs).toContain('The domain language updates provide a foundation for precise problem definition.');
      expect(paragraphs).toContain('Next paragraph explains the architecture.');
    });

    it('does NOT emit raw code snippet text for fenced mermaid diagram', () => {
      const paragraphs = parseMarkdownToSpeakableParagraphs(fencedMermaidMarkdown);

      for (const p of paragraphs) {
        expect(p).not.toContain('Code snippet: graph TD');
        expect(p).not.toContain('A[Client] --> B[Server]');
      }
      expect(paragraphs).toContain('Here is the system architecture:');
      expect(paragraphs).toContain('Conclusion of the document.');
    });

    it('does NOT emit raw code snippet text for untagged sequenceDiagram block', () => {
      const paragraphs = parseMarkdownToSpeakableParagraphs(fencedSequenceMarkdown);

      for (const p of paragraphs) {
        expect(p).not.toContain('Code snippet: sequenceDiagram');
        expect(p).not.toContain('Alice->>Bob');
      }
    });

    it('still emits standard code snippets when not verbalized', () => {
      const paragraphs = parseMarkdownToSpeakableParagraphs(standardCodeMarkdown);
      const codeSnippet = paragraphs.find((p) => p.startsWith('Code snippet:'));
      expect(codeSnippet).toBeDefined();
    });
  });
});
