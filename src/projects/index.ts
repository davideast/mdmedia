/** The agent and CLI use the same authenticated operations as Studio. No provider calls. */
export interface ProjectImport {
  version: 1;
  id: string;
  title: string;
  productionNotes: string;
  reviewNotes: string[];
  parts: {
    id: string;
    continuity: 'continuous' | 'planned';
    script: {
      title: string;
      sourceTranscript: string;
      sourceDescription: string;
      shots: {
        id: string; title: string; seconds: number;
        source: 'generated' | 'presenter' | 'screencast';
        connection: 'cut' | 'continue';
        dialogue: string; visual: string; audio: string; pauseSeconds?: number;
      }[];
    };
  }[];
}
export interface ProjectImportResult { id: string; href: string; created: boolean; generationStarted: false }
export class StudioProjectsClient {
  private readonly origin: string;
  constructor(origin: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS or a localhost Studio URL.');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a Studio origin without credentials, path or query.');
    if (!token.trim()) throw new Error('A Studio ID token is required.');
    this.origin = url.origin;
  }
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.transport(`${this.origin}/api/studio-projects${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token.trim()}` },
    });
    const data = await response.json() as {message?: string};
    if (!response.ok) throw new Error(data.message ?? `Studio request failed (${response.status}).`);
    return data;
  }
  async importProject(manifest: ProjectImport): Promise<ProjectImportResult> {
    return await this.request('', {method: 'POST', body: JSON.stringify(manifest)}) as ProjectImportResult;
  }
  async getProject(id: string): Promise<unknown> { return this.request(`/${encodeURIComponent(id)}`); }
  async listProjects(): Promise<unknown> { return this.request(''); }
}
