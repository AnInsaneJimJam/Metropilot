export class LanguageError extends Error {
  readonly code: string;
  readonly nodeId: string | undefined;
  readonly fieldPath: string;
  constructor(code: string, message: string, nodeId?: string, fieldPath = '') {
    super(message); this.name = 'LanguageError'; this.code = code; this.nodeId = nodeId; this.fieldPath = fieldPath;
  }
}
