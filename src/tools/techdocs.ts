import type { BackstageTechDocsClient } from "../clients/techdocs.js";
import { toolSuccess, withToolError, type ToolResult } from "./helpers.js";

export class TechDocsTools {
  constructor(private readonly techDocs: BackstageTechDocsClient) {}

  async getTechDocs(input: {
    entityRef: string;
    forceSync?: boolean;
    includeImages?: boolean;
  }): Promise<ToolResult> {
    return withToolError(async () => {
      const result = await this.techDocs.getTechDocs(
        input.entityRef,
        input.forceSync ?? false,
        input.includeImages ?? true
      );
      const text = toolSuccess({
        entityRef: result.entityRef,
        synced: result.synced,
        truncated: result.truncated,
        source: result.source,
        warning: result.warning,
        // Image blocks follow this text block in the same order.
        images: result.images.map((img, i) => ({
          index: i + 1,
          page: img.page,
          src: img.src,
          alt: img.alt,
          mimeType: img.mimeType,
        })),
        skippedImages: result.skippedImages.length
          ? result.skippedImages
          : undefined,
        content: result.content,
      });
      return {
        content: [
          ...text.content,
          ...result.images.map((img) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
        ],
      };
    }, `get_techdocs(${input.entityRef})`);
  }
}
