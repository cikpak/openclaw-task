/** Public file metadata has no path, object key, storage URL, or native ID. */
export interface BrowserFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: 'input' | 'deliverable';
  updatedAt: number;
}
export interface BrowserToolSummary {
  id: string;
  operation: 'read' | 'write' | 'edit' | 'fetch';
  status: 'running' | 'completed' | 'failed';
  text: string;
  fileId?: string | undefined;
}
