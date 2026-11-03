import { parseEntityRef, DEFAULT_NAMESPACE } from "../entity-ref.js";
import type { BackstageClient } from "./backstage.js";
import { BackstageApiError } from "./backstage.js";

const TECHDOCS_MAX_CHARS = 80_000;

export interface TechDocsResult {
  entityRef: string;
  content: string;
  synced: boolean;
  truncated: boolean;
}

export class BackstageTechDocsClient {
  constructor(private readonly base: BackstageClient) {}

  /**
   * Trigger a TechDocs sync/build for an entity.
   * Path: GET /api/techdocs/sync/{namespace}/{kind}/{name}
   * Returns SSE stream — 200 with `{"updated": false}` or `{"updated": true}`.
   */
  async syncDocs(
    kind: string,
    namespace: string,
    name: string
  ): Promise<{ alreadyCurrent: boolean }> {
    const text = await this.base.fetchText(
      `/api/techdocs/sync/${namespace}/${kind}/${name}`
    );
    // SSE format: "event: finish\ndata: {\"updated\":false}\n"
    const updated = text.includes('"updated":true');
    return { alreadyCurrent: !updated };
  }

  /**
   * Fetch rendered TechDocs HTML.
   * Path: GET /api/techdocs/static/docs/{namespace}/{kind}/{name}/index.html
   * If the page is a redirect stub (MkDocs default), follow the redirect.
   */
  async getDocs(
    kind: string,
    namespace: string,
    name: string
  ): Promise<string> {
    const basePath = `/api/techdocs/static/docs/${namespace}/${kind}/${name}`;
    let html = await this.base.fetchText(`${basePath}/index.html`);

    // MkDocs generates redirect stubs — detect and follow them
    const redirectMatch = html.match(
      /content="0;\s*url=([^"]+)"/i
    );
    if (redirectMatch) {
      const redirectTarget = redirectMatch[1].replace(/\/$/, "");
      html = await this.base
        .fetchText(`${basePath}/${redirectTarget}/index.html`)
        .catch(() => html); // fall back to original if redirect fails
    }

    return this.stripHtml(html);
  }

  async getTechDocs(
    entityRef: string,
    forceSync: boolean
  ): Promise<TechDocsResult> {
    const parsed = parseEntityRef(entityRef);
    const kind = parsed.kind.toLowerCase();
    const namespace = parsed.namespace ?? DEFAULT_NAMESPACE;
    const name = parsed.name;

    let synced = false;
    try {
      const syncResult = await this.syncDocs(kind, namespace, name);
      synced = !syncResult.alreadyCurrent;
    } catch (err) {
      if (err instanceof BackstageApiError && err.status === 404) {
        throw new BackstageApiError(
          404,
          "Not Found",
          `TechDocs not found for ${entityRef}. Ensure the entity has a 'backstage.io/techdocs-ref' annotation.`,
          `/api/techdocs/sync/${namespace}/${kind}/${name}`
        );
      }
      if (!forceSync) {
        // Non-fatal — still try to fetch cached docs
      } else {
        throw err;
      }
    }

    const content = await this.getDocs(kind, namespace, name);
    const truncated = content.length >= TECHDOCS_MAX_CHARS;

    return {
      entityRef,
      content: truncated
        ? content.slice(0, TECHDOCS_MAX_CHARS) +
          "\n\n[...content truncated at 8,000 chars]"
        : content,
      synced,
      truncated,
    };
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#x2F;/g, "/")
      .replace(/\s+/g, " ")
      .trim();
  }
}
