import { McpServer } from "./mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { BackstageClient } from "./clients/backstage.js";
import { TtlCache } from "./clients/cache.js";
import { BackstageCatalogClient } from "./clients/catalog.js";
import { BackstageScaffolderClient } from "./clients/scaffolder.js";
import { BackstageTechDocsClient } from "./clients/techdocs.js";
import { CatalogTools } from "./tools/catalog.js";
import { ScaffolderTools } from "./tools/scaffolder.js";
import { TechDocsTools } from "./tools/techdocs.js";
import { toolSuccess, toolError } from "./tools/helpers.js";

export function createServer(config: Config): McpServer {
  const cache = new TtlCache(config.cacheTtlSeconds * 1000);
  const baseClient = new BackstageClient(config);

  const catalogClient = new BackstageCatalogClient(baseClient, config, cache);
  const scaffolderClient = new BackstageScaffolderClient(baseClient, cache);
  const techDocsClient = new BackstageTechDocsClient(baseClient);

  const catalogTools = new CatalogTools(catalogClient);
  const scaffolderTools = new ScaffolderTools(scaffolderClient);
  const techDocsTools = new TechDocsTools(techDocsClient);

  // __MCP_VERSION__ is injected from package.json at bundle time (see the
  // `bundle` script). Under `tsx` dev mode it is undefined, so fall back.
  const version =
    typeof __MCP_VERSION__ !== "undefined" ? __MCP_VERSION__ : "dev";
  const server = new McpServer("backstage-mcp", version);

  // ─── Diagnostic tool ────────────────────────────────────────────────────────

  server.tool(
    "check_connection",
    "Verify connectivity to Backstage and validate the configured token. Returns server info, token identity (if available), and a summary of accessible resources. Run this first to confirm your setup is working.",
    {},
    async () => {
      try {
        // Probe 1: fetch 1 catalog entity to verify auth + connectivity
        const catalogProbe = await baseClient
          .fetchJson<{ items: unknown[]; totalItems?: number }>(
            "/api/catalog/entities/by-query?limit=1"
          )
          .catch(async () => {
            // Fallback for older Backstage
            const items = await baseClient.fetchJson<unknown[]>(
              "/api/catalog/entities?limit=1"
            );
            return { items, totalItems: undefined };
          });

        // Probe 2: try to get token identity from the Backstage identity API
        const identity = await baseClient
          .fetchJson<{ token?: string; identity?: { userEntityRef?: string; ownershipEntityRefs?: string[] } }>(
            "/api/auth/v1/userinfo"
          )
          .catch(() => null);

        return toolSuccess({
          status: "ok",
          backstageUrl: config.backstageBaseUrl,
          catalogAccessible: true,
          entitiesFound: Array.isArray(catalogProbe.items),
          tokenIdentity: identity?.identity?.userEntityRef ?? "unknown (token may be a static service token)",
          ownershipRefs: identity?.identity?.ownershipEntityRefs,
          cacheEnabled: config.cacheTtlSeconds > 0,
          cacheTtlSeconds: config.cacheTtlSeconds,
          transport: config.transport,
        });
      } catch (err) {
        const isAuthError =
          err instanceof Error &&
          (err.message.includes("401") || err.message.includes("403"));

        return toolError(
          isAuthError
            ? "Authentication failed. Your BACKSTAGE_TOKEN is invalid or expired."
            : `Cannot reach Backstage at ${config.backstageBaseUrl}. Check BACKSTAGE_BASE_URL and network connectivity.`,
          String(err)
        );
      }
    }
  );

  // ─── Catalog tools ───────────────────────────────────────────────────────────

  server.tool(
    "search_catalog",
    "Search the Backstage software catalog for components, APIs, systems, groups, users, and other entities. Returns a paginated list with entityRefs for follow-up calls. Use get_entity for full details on a specific result.",
    {
      query: z
        .string()
        .optional()
        .describe("Full-text search query (name, description, tags)"),
      kind: z
        .enum([
          "Component",
          "API",
          "System",
          "Domain",
          "Group",
          "User",
          "Resource",
          "Template",
          "Location",
        ])
        .optional()
        .describe("Filter by entity kind"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by metadata tags (AND logic)"),
      owner: z
        .string()
        .optional()
        .describe(
          "Filter by owner entity ref, e.g. 'team-payments' or 'group:default/team-payments'"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of results to return"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response's nextCursor"),
    },
    (input) => catalogTools.searchCatalog(input)
  );

  server.tool(
    "get_entity",
    "Get full details for a Backstage entity including metadata, spec, annotations, and resolved relations (APIs consumed/provided, dependencies, system membership, ownership). Use search_catalog first to find the entityRef.",
    {
      entityRef: z
        .string()
        .describe(
          "Entity reference in 'kind:namespace/name' format, e.g. 'component:default/payment-service' or 'api:default/payment-api'"
        ),
      includeRelations: z
        .boolean()
        .default(true)
        .describe(
          "Resolve and include related entities (APIs, dependencies, owners). Set false for a faster, lighter response."
        ),
    },
    (input) => catalogTools.getEntity(input)
  );

  server.tool(
    "list_api_specs",
    "List API entities in the Backstage catalog, optimized for integration discovery. Returns name, type (openapi/asyncapi/graphql/grpc), owner, and description. Use get_api_spec to retrieve the full specification.",
    {
      type: z
        .enum(["openapi", "asyncapi", "graphql", "grpc"])
        .optional()
        .describe("Filter by API specification type"),
      owner: z
        .string()
        .optional()
        .describe("Filter by owning team or group"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of results"),
    },
    (input) => catalogTools.listApiSpecs(input)
  );

  server.tool(
    "get_api_spec",
    "Retrieve the raw API specification (OpenAPI YAML/JSON, AsyncAPI, GraphQL schema, etc.) for a specific API entity. The spec content can be used to understand available endpoints, schemas, and authentication requirements for writing integration code.",
    {
      entityRef: z
        .string()
        .describe(
          "API entity reference, e.g. 'api:default/payment-api'. Use list_api_specs to find available APIs."
        ),
    },
    (input) => catalogTools.getApiSpec(input)
  );

  // ─── Scaffolder tools ────────────────────────────────────────────────────────

  server.tool(
    "list_templates",
    "List available Backstage scaffolder templates for creating new services, libraries, repositories, or other resources. Returns names, descriptions, and tags. Use get_template to see the full parameter schema for a specific template.",
    {
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter templates by tags, e.g. ['react', 'frontend']"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum number of results"),
    },
    (input) => scaffolderTools.listTemplates(input)
  );

  server.tool(
    "get_template",
    "Get the full specification for a Backstage scaffolder template, including the parameters JSON Schema and lookupHints. The lookupHints array tells you which tools to call (in parallel) to fetch selectable options (groups, APIs, components) BEFORE asking the user for input. Always present fetched options as numbered lists so the user can pick rather than type. Use this BEFORE run_template.",
    {
      entityRef: z
        .string()
        .describe(
          "Template entity reference, e.g. 'template:default/create-react-app'. Use list_templates to find available templates."
        ),
    },
    (input) => scaffolderTools.getTemplate(input)
  );

  server.tool(
    "run_template",
    "Execute a Backstage scaffolder template with the provided parameter values. Validates inputs against the template schema before submitting. Returns a taskId for tracking progress with get_task_status. Always call get_template first to understand required parameters.",
    {
      templateRef: z
        .string()
        .describe(
          "Template entity reference, e.g. 'template:default/create-react-app'"
        ),
      values: z
        .record(z.string(), z.unknown())
        .describe(
          "Template parameter values as key-value pairs. Must match the schema returned by get_template."
        ),
      createdBy: z
        .string()
        .optional()
        .describe(
          "User entity ref to attribute the task to, e.g. 'user:default/john-doe'. If omitted, the task owner will show as 'Unknown' in Backstage."
        ),
    },
    (input) => scaffolderTools.runTemplate(input)
  );

  server.tool(
    "list_tasks",
    "List scaffolder tasks (template executions). Returns task IDs, status, template used, and who created them. Optionally filter by the user who triggered the task.",
    {
      createdBy: z
        .string()
        .optional()
        .describe(
          "Filter by the user who created the task, e.g. 'user:default/ankit-singh16'. Omit to list all tasks."
        ),
    },
    (input) => scaffolderTools.listTasks(input)
  );

  server.tool(
    "get_task_status",
    "Get the execution status and progress of a Backstage scaffolder task. Poll this after run_template to monitor progress. Status will be 'processing', 'completed', 'failed', or 'cancelled'.",
    {
      taskId: z
        .string()
        .describe("Task ID returned by run_template"),
      includeLogs: z
        .boolean()
        .default(false)
        .describe(
          "Include filtered execution logs (errors, status changes, outputs). Useful for debugging failed tasks."
        ),
    },
    (input) => scaffolderTools.getTaskStatus(input)
  );

  // ─── TechDocs tool ───────────────────────────────────────────────────────────

  server.tool(
    "get_techdocs",
    "Retrieve the TechDocs documentation for a Backstage entity. Triggers a render sync if needed, then returns the documentation as plain text. The entity must have a 'backstage.io/techdocs-ref' annotation configured.",
    {
      entityRef: z
        .string()
        .describe(
          "Entity reference, e.g. 'component:default/payment-service'. Use get_entity first to confirm the entity has techdocs configured (check for 'backstage.io/techdocs-ref' annotation)."
        ),
      forceSync: z
        .boolean()
        .default(false)
        .describe(
          "Force a TechDocs re-render before fetching. Use when docs may be stale."
        ),
      includeImages: z
        .boolean()
        .default(true)
        .describe(
          "Also return the documentation's PNG/JPEG/GIF/WebP images (e.g. workflow diagrams) as base64 image content blocks after the text. Set false for text only."
        ),
    },
    (input) => techDocsTools.getTechDocs(input)
  );

  return server;
}
