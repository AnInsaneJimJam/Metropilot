import type { GeneratedContractMap } from "@monad-hack/contracts";
export type SavedAgent = GeneratedContractMap["controlAgent"];
export type SaveRequest = GeneratedContractMap["controlSave"];
export class ApiError extends Error {
  readonly status: number;
  readonly nodeId: string | undefined;
  readonly fieldPath: string | undefined;
  constructor(message: string, body: unknown, status: number) {
    super(message);
    this.status = status;
    const b = body as { nodeId?: string; fieldPath?: string } | undefined;
    this.nodeId = b?.nodeId;
    this.fieldPath = b?.fieldPath;
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error(
      "Cannot reach the control API. Your unsaved draft is still here.",
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String(body.message)
        : "Cannot reach the control API. Start it with pnpm api:dev.";
    throw new ApiError(message, body, response.status);
  }
  return body as T;
}
