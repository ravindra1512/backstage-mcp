import type { BackstageTechDocsClient } from "../clients/techdocs.js";
import { toolSuccess, withToolError, type ToolResult } from "./helpers.js";

export class TechDocsTools {
  constructor(private readonly techDocs: BackstageTechDocsClient) {}

  async getTechDocs(input: {
    entityRef: string;
    forceSync?: boolean;
  }): Promise<ToolResult> {
    return withToolError(async () => {
      const result = await this.techDocs.getTechDocs(
        input.entityRef,
        input.forceSync ?? false
      );
      return toolSuccess({
        entityRef: result.entityRef,
        synced: result.synced,
        truncated: result.truncated,
        source: result.source,
        warning: result.warning,
        content: result.content,
      });
    }, `get_techdocs(${input.entityRef})`);
  }
}
