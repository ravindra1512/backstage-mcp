import { parseEntityRef, DEFAULT_NAMESPACE } from "../entity-ref.js";
import type { BackstageClient } from "./backstage.js";
import { BackstageApiError } from "./backstage.js";

const TECHDOCS_MAX_CHARS = 80_000;
const TECHDOCS_MAX_IMAGES = 10;
const TECHDOCS_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const TECHDOCS_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const TECHDOCS_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export interface TechDocsImage {
  page: string;
  src: string;
  alt: string;
  mimeType: string;
  data: string; // base64
}

export interface TechDocsResult {
  entityRef: string;
  content: string;
  synced: boolean;
  truncated: boolean;
  source: "search_index" | "index.html";
  images: TechDocsImage[];
  skippedImages: string[];
  warning?: string;
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
  ): Promise<{
    content: string;
    source: "search_index" | "index.html";
    warning?: string;
    basePath: string;
    pages: string[];
  }> {
    const basePath = `/api/techdocs/static/docs/${namespace}/${kind}/${name}`;

    let warning: string | undefined;
    try {
      const indexed = await this.getDocsFromSearchIndex(basePath);
      if (indexed) {
        return {
          content: indexed.content,
          source: "search_index",
          basePath,
          pages: indexed.pages,
        };
      }
      warning = "search_index.json had no usable content";
    } catch (err) {
      warning = `search_index.json failed: ${
        err instanceof BackstageApiError
          ? `${err.status} ${err.statusText} ${err.body.slice(0, 200)}`
          : (err as Error).message
      }`;
    }
    console.error(`[techdocs] ${basePath}: ${warning}; falling back to index.html`);

    let html = await this.base.fetchText(`${basePath}/index.html`);
    let page = "";

    // MkDocs generates redirect stubs — detect and follow them
    const redirectMatch = html.match(
      /content="0;\s*url=([^"]+)"/i
    );
    if (redirectMatch) {
      const redirectTarget = redirectMatch[1].replace(/\/$/, "");
      const followed = await this.base
        .fetchText(`${basePath}/${redirectTarget}/index.html`)
        .catch(() => null); // fall back to original if redirect fails
      if (followed !== null) {
        html = followed;
        page = `${redirectTarget}/`;
      }
    }

    return {
      content: this.stripHtml(html),
      source: "index.html",
      warning,
      basePath,
      pages: [page],
    };
  }

  /**
   * Download raster images referenced by the given docs pages as base64.
   * Only images served from the same TechDocs docs path are fetched.
   */
  private async fetchImages(
    basePath: string,
    pages: string[]
  ): Promise<{ images: TechDocsImage[]; skipped: string[] }> {
    const images: TechDocsImage[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const origin = "http://techdocs.local";

    for (const page of pages) {
      if (images.length >= TECHDOCS_MAX_IMAGES) break;
      const pagePath =
        page === "" || page.endsWith("/") ? `${page}index.html` : page;
      const pageUrl = new URL(`${basePath}/${pagePath}`, origin);

      let html: string;
      try {
        html = await this.base.fetchText(`${pageUrl.pathname}`);
      } catch {
        continue;
      }

      const article = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html;
      const body = article
        .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ");

      for (const tag of body.match(/<img\b[^>]*>/gi) ?? []) {
        if (images.length >= TECHDOCS_MAX_IMAGES) break;
        const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!src) continue;
        const alt = decodeHtmlAttr(
          tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? ""
        );

        let data: Buffer;
        let mimeType: string;
        let key: string;
        try {
          if (src.startsWith("data:")) {
            const m = src.match(/^data:([^;,]+);base64,(.+)$/s);
            if (!m) continue;
            mimeType = m[1].toLowerCase();
            data = Buffer.from(m[2], "base64");
            key = src.slice(0, 120);
          } else {
            const resolved = new URL(decodeHtmlAttr(src), pageUrl);
            if (
              resolved.origin !== origin ||
              !resolved.pathname.startsWith(`${basePath}/`)
            ) {
              continue; // external or outside this entity's docs
            }
            key = resolved.pathname;
            if (seen.has(key)) continue;
            const res = await this.base.fetch(
              `${resolved.pathname}${resolved.search}`
            );
            mimeType = (res.headers.get("content-type") ?? "")
              .split(";")[0]
              .trim()
              .toLowerCase();
            data = Buffer.from(await res.arrayBuffer());
          }
        } catch (err) {
          skipped.push(`${src} (fetch failed: ${(err as Error).message})`);
          continue;
        }

        if (seen.has(key)) continue;
        seen.add(key);

        if (!TECHDOCS_IMAGE_TYPES.has(mimeType)) {
          skipped.push(`${src} (unsupported type ${mimeType || "unknown"})`);
          continue;
        }
        if (
          data.length > TECHDOCS_MAX_IMAGE_BYTES ||
          totalBytes + data.length > TECHDOCS_MAX_TOTAL_IMAGE_BYTES
        ) {
          skipped.push(`${src} (too large: ${data.length} bytes)`);
          continue;
        }
        totalBytes += data.length;
        images.push({
          page: page || "index",
          src,
          alt,
          mimeType,
          data: data.toString("base64"),
        });
      }
    }
    return { images, skipped };
  }

  /**
   * Fetch all pages via MkDocs search/search_index.json.
   * Returns null if the index is missing or empty so callers can fall back.
   */
  private async getDocsFromSearchIndex(
    basePath: string
  ): Promise<{ content: string; pages: string[] } | null> {
    const raw = await this.base.fetchText(`${basePath}/search/search_index.json`);
    const index = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      docs?: Array<{ location?: string; title?: string; text?: string }>;
    };
    const docs = index.docs ?? [];

    // Group entries by page (location without #anchor), preserving order.
    const pages = new Map<string, string[]>();
    for (const doc of docs) {
      const page = (doc.location ?? "").split("#")[0];
      const parts = pages.get(page) ?? [];
      const title = doc.title?.trim();
      const text = this.stripHtml(doc.text ?? "");
      if (title) parts.push(`## ${title}`);
      if (text) parts.push(text);
      pages.set(page, parts);
    }

    const sections: string[] = [];
    for (const [page, parts] of pages) {
      if (parts.length === 0) continue;
      sections.push(`# Page: ${page || "index"}\n${parts.join("\n")}`);
    }
    const content = sections.join("\n\n");
    return content.length > 0
      ? { content, pages: [...pages.keys()] }
      : null;
  }

  async getTechDocs(
    entityRef: string,
    forceSync: boolean,
    includeImages = true
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

    const { content, source, warning, basePath, pages } = await this.getDocs(
      kind,
      namespace,
      name
    );
    const truncated = content.length >= TECHDOCS_MAX_CHARS;

    let images: TechDocsImage[] = [];
    let skippedImages: string[] = [];
    if (includeImages) {
      try {
        ({ images, skipped: skippedImages } = await this.fetchImages(
          basePath,
          pages
        ));
      } catch (err) {
        skippedImages = [`image fetching failed: ${(err as Error).message}`];
      }
    }

    return {
      entityRef,
      content: truncated
        ? content.slice(0, TECHDOCS_MAX_CHARS) +
          "\n\n[...content truncated at 80,000 chars]"
        : content,
      synced,
      truncated,
      source,
      images,
      skippedImages,
      ...(warning ? { warning } : {}),
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
