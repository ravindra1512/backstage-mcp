import { BackstageApiError } from "../clients/backstage.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

export function toolSuccess(data: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function toolError(message: string, details?: unknown): ToolResult {
  const payload: Record<string, unknown> = { error: message };
  if (details !== undefined) payload.details = details;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

// withToolError wraps a fn that already returns ToolResult — catches Backstage errors
export async function withToolError(
  fn: () => Promise<ToolResult>,
  context: string
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackstageApiError) {
      switch (err.status) {
        case 404:
          return toolError(`Not found: ${context}`);
        case 401:
        case 403:
          return toolError(
            `Authentication failed for ${context}. Check that BACKSTAGE_TOKEN is valid and has the required permissions.`
          );
        case 408:
          return toolError(
            `Request timed out for ${context}. Backstage may be slow or unreachable.`
          );
        case 503:
          return toolError(
            `Backstage service unavailable for ${context}. The server may be starting up.`
          );
        default:
          return toolError(
            `Backstage API error ${err.status} for ${context}`,
            err.body ? err.body.slice(0, 500) : undefined
          );
      }
    }
    return toolError(`Unexpected error in ${context}`, String(err));
  }
}
