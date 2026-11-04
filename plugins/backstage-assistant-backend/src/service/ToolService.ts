import type {
  AuthService,
  BackstageCredentials,
  CacheService,
  DiscoveryService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { ToolDefinition, ToolResult } from '../types';
import { BackstageApiClient } from './BackstageApiClient';

// Converts rendered TechDocs HTML into markdown so the UI renders real
// structure (headings, lists, tables, code) instead of flattened text.
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndownService.use(gfm);
turndownService.remove(['script', 'style', 'nav', 'header', 'footer']);
// Pygments/codehilite wraps code in <table class="highlighttable"> (a line-number
// cell + a code cell). The gfm tables plugin can't convert that and leaves the
// raw <table> HTML, which then renders as literal tags. Intercept it and emit a
// fenced code block instead. addRule takes priority over the gfm table rule
// because turndown checks the most-recently-added rules first.
turndownService.addRule('pygmentsHighlightTable', {
  filter: node =>
    node.nodeName === 'TABLE' &&
    /(^|\s)highlighttable(\s|$)/.test(node.getAttribute('class') || ''),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const codeCell = el.querySelector('td.code') ?? el;
    const code = (codeCell.textContent ?? '').replace(/\n+$/, '');
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  },
});

const DEFAULT_NAMESPACE = 'default';
const TECHDOCS_MAX_CHARS = 200_000;
const INTERESTING_RELATIONS = new Set([
  'providesApi',
  'consumesApi',
  'dependsOn',
  'partOf',
  'ownedBy',
  'hasPart',
  'ownerOf',
]);

export interface ToolServiceDeps {
  auth: AuthService;
  discovery: DiscoveryService;
  cache: CacheService;
  logger: LoggerService;
}

export interface ToolCallContext {
  credentials: BackstageCredentials;
  userEntityRef: string;
  ownershipRefs: string[];
  vcsTokens?: {
    github?: string;
    gitlab?: string;
    azureDevops?: string;
    githubOwners?: string[];
    gitlabOwners?: string[];
    rejectedProviders?: string[];
  };
}

export class ToolService {
  constructor(private readonly deps: ToolServiceDeps) {}

  listTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const api = new BackstageApiClient(
      this.deps.auth,
      this.deps.discovery,
      context.credentials,
    );

    try {
      switch (name) {
        case 'check_connection':
          return await this.checkConnection(api);
        case 'search_catalog':
          return await this.searchCatalog(args, api, context);
        case 'get_entity':
          return await this.getEntity(args, api);
        case 'list_api_specs':
          return await this.listApiSpecs(args, api);
        case 'get_api_spec':
          return await this.getApiSpec(args, api);
        case 'list_templates':
          return await this.listTemplates(args, api);
        case 'get_template':
          return await this.getTemplate(args, api);
        case 'run_template':
          return await this.runTemplate(args, api, context);
        case 'get_vcs_groups':
          return await this.getVcsGroups(args, context);
        case 'list_tasks':
          return await this.listTasks(args, api);
        case 'get_task_status':
          return await this.getTaskStatus(args, api);
        case 'get_techdocs':
          return await this.getTechDocs(args, api);
        case 'search_techdocs':
          return await this.searchTechDocs(args, api);
        case 'get_catalog_facets':
          return await this.getCatalogFacets(args, api);
        default:
          return toolError(`Unknown tool: ${name}`);
      }
    } catch (err) {
      this.deps.logger.error(`Tool ${name} failed`, { error: String(err) });
      return toolError(
        `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async checkConnection(api: BackstageApiClient): Promise<ToolResult> {
    const catalogProbe = await api
      .fetchJson<{ items: unknown[]; totalItems?: number }>(
        'catalog',
        '/entities/by-query?limit=1',
      )
      .catch(async () => {
        const items = await api.fetchJson<unknown[]>(
          'catalog',
          '/entities?limit=1',
        );
        return { items, totalItems: undefined };
      });

    return toolSuccess({
      status: 'ok',
      catalogAccessible: true,
      entitiesFound: Array.isArray(catalogProbe.items),
    });
  }

  private async searchCatalog(
    args: Record<string, unknown>,
    api: BackstageApiClient,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const query = args.query as string | undefined;
    const kind = args.kind as string | undefined;
    const tags = args.tags as string[] | undefined;
    const owner = args.owner as string | undefined;
    const limit = (args.limit as number) ?? 20;
    const cursor = args.cursor as string | undefined;

    const cacheKey = `search:${JSON.stringify({
      principal: context.userEntityRef,
      ownershipRefs: [...context.ownershipRefs].sort(),
      query,
      kind,
      tags,
      owner,
      limit,
      cursor,
    })}`;
    const cached = await this.cacheGet<string>(cacheKey);
    if (cached) return { content: [{ type: 'text', text: cached }] };

    const filters: string[] = [];
    if (kind) filters.push(`kind=${kind}`);
    if (owner) filters.push(`spec.owner=${owner}`);
    if (tags?.length) {
      tags.forEach(t => filters.push(`metadata.tags=${t}`));
    }

    let result: { items: Entity[]; pageInfo?: { nextCursor?: string }; totalItems?: number };

    if (query) {
      const qs = new URLSearchParams({ fullTextFilter: query });
      if (filters.length) qs.set('filter', filters.join(','));
      qs.set('limit', String(limit));
      if (cursor) qs.set('after', cursor);

      result = await api
        .fetchJson<typeof result>('catalog', `/entities/by-query?${qs}`)
        .catch(async () => {
          const fallback = new URLSearchParams({ limit: '100' });
          if (filters.length) fallback.set('filter', filters.join(','));
          const items = await api.fetchJson<Entity[]>(
            'catalog',
            `/entities?${fallback}`,
          );
          const q = query.toLowerCase();
          const filtered = items.filter(
            e =>
              e.metadata.name.toLowerCase().includes(q) ||
              e.metadata.title?.toLowerCase().includes(q) ||
              e.metadata.description?.toLowerCase().includes(q) ||
              e.metadata.tags?.some(t => t.toLowerCase().includes(q)),
          );
          return {
            items: filtered.slice(0, limit),
            pageInfo: undefined,
            totalItems: filtered.length,
          };
        });
    } else {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (filters.length) qs.set('filter', filters.join(','));
      if (cursor) qs.set('after', cursor);

      result = await api
        .fetchJson<typeof result>('catalog', `/entities/by-query?${qs}`)
        .catch(async () => {
          const items = await api.fetchJson<Entity[]>(
            'catalog',
            `/entities?${qs}`,
          );
          return { items, pageInfo: undefined, totalItems: undefined };
        });
    }

    const response = {
      entities: result.items.map(toEntitySummary),
      nextCursor: result.pageInfo?.nextCursor,
      totalCount: result.totalItems,
    };

    const text = JSON.stringify(response, null, 2);
    await this.cacheSet(cacheKey, text);
    return toolSuccess(response);
  }

  private async getEntity(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const entityRef = args.entityRef as string;
    const includeRelations = (args.includeRelations as boolean) ?? true;

    const parsed = parseEntityRef(entityRef);
    const { kind, namespace, name } = parsed;

    const entity = await api
      .fetchJson<Entity>('catalog', `/entities/by-name/${kind}/${namespace}/${name}`)
      .catch(() => undefined);

    if (!entity) return toolError(`Entity not found: ${entityRef}`);

    const spec = entity.spec as Record<string, unknown> | undefined;
    const enriched: Record<string, unknown> = {
      ref: entityRef,
      kind: entity.kind,
      namespace: entity.metadata.namespace ?? DEFAULT_NAMESPACE,
      name: entity.metadata.name,
      title: entity.metadata.title,
      description: entity.metadata.description,
      owner: spec?.owner as string | undefined,
      tags: entity.metadata.tags,
      system: spec?.system as string | undefined,
      type: spec?.type as string | undefined,
      annotations: entity.metadata.annotations,
      labels: entity.metadata.labels,
      spec,
    };

    if (includeRelations && entity.relations?.length) {
      const interesting = entity.relations.filter(r =>
        INTERESTING_RELATIONS.has(r.type),
      );

      const resolved: Array<Record<string, unknown>> = [];
      const CONCURRENCY = 10;
      for (let i = 0; i < interesting.length; i += CONCURRENCY) {
        const batch = interesting.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async rel => {
            const targetParsed = parseEntityRef(rel.targetRef);
            const targetEntity = await api
              .fetchJson<Entity>(
                'catalog',
                `/entities/by-name/${targetParsed.kind}/${targetParsed.namespace}/${targetParsed.name}`,
              )
              .catch(() => undefined);
            return {
              type: rel.type,
              targetRef: rel.targetRef,
              targetName: targetParsed.name,
              targetKind: targetParsed.kind,
              targetDescription: targetEntity?.metadata.description,
            };
          }),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') resolved.push(r.value);
        }
      }
      enriched.relations = resolved;
    }

    return toolSuccess(enriched);
  }

  private async listApiSpecs(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const type = args.type as string | undefined;
    const owner = args.owner as string | undefined;
    const limit = (args.limit as number) ?? 20;

    const searchResult = await this.callSearchCatalog(api, {
      kind: 'API',
      owner,
      limit,
    });

    let entities = searchResult.entities;
    if (type) {
      entities = entities.filter(
        e => e.type?.toLowerCase() === type.toLowerCase(),
      );
    }

    return toolSuccess({
      apis: entities.map(e => ({
        ref: e.ref,
        name: e.name,
        title: e.title,
        description: e.description,
        type: e.type,
        owner: e.owner,
        tags: e.tags,
        system: e.system,
      })),
      totalCount: searchResult.totalCount,
      nextCursor: searchResult.nextCursor,
    });
  }

  private async getApiSpec(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const entityRef = args.entityRef as string;
    const parsed = parseEntityRef(entityRef);

    const entity = await api
      .fetchJson<Entity>(
        'catalog',
        `/entities/by-name/${parsed.kind}/${parsed.namespace}/${parsed.name}`,
      )
      .catch(() => undefined);

    if (!entity) {
      return toolError(
        `No API spec found for ${entityRef}. The entity may not exist or may not have a spec.definition field.`,
      );
    }

    const spec = entity.spec as Record<string, unknown> | undefined;
    const definition = spec?.definition;

    if (typeof definition === 'string') {
      if (definition.startsWith('$text:') || definition.startsWith('$yaml:')) {
        const ref = definition.replace(/^\$\w+:\s*/, '').trim();
        try {
          const content = await api.fetchText('catalog', ref);
          return toolSuccess({
            entityRef,
            spec: content.slice(0, 50_000),
          });
        } catch {
          return toolSuccess({
            entityRef,
            spec: `[Could not fetch external spec from: ${ref}]`,
          });
        }
      }
      return toolSuccess({ entityRef, spec: definition.slice(0, 50_000) });
    }

    return toolError(
      `No API spec found for ${entityRef}. The entity may not exist or may not have a spec.definition field.`,
    );
  }

  private async listTemplates(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const tags = args.tags as string[] | undefined;
    const limit = (args.limit as number) ?? 20;

    const qs = new URLSearchParams({ 'filter[kind]': 'Template' });
    qs.set('limit', String(limit));
    if (tags?.length) {
      tags.forEach(t => qs.append('filter[metadata.tags]', t));
    }

    const response = await api
      .fetchJson<{ items: RawTemplateEntity[] }>(
        'catalog',
        `/entities/by-query?${qs}`,
      )
      .catch(async () => {
        const items = await api.fetchJson<RawTemplateEntity[]>(
          'catalog',
          `/entities?filter=kind=Template&limit=${limit}`,
        );
        return { items };
      });

    const templates = response.items.map(toTemplateEntity);

    return toolSuccess({
      templates: templates.map(t => ({
        ref: t.ref,
        name: t.name,
        title: t.title,
        description: t.description,
        owner: t.owner,
        tags: t.tags,
        parameterCount: t.parameters.length,
      })),
    });
  }

  private async getTemplate(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const entityRef = args.entityRef as string;
    const parsed = parseEntityRef(entityRef, { defaultKind: 'Template' });

    const entity = await api
      .fetchJson<RawTemplateEntity>(
        'catalog',
        `/entities/by-name/${parsed.kind}/${parsed.namespace}/${parsed.name}`,
      )
      .catch(() => undefined);

    if (!entity) return toolError(`Template not found: ${entityRef}`);

    const template = toTemplateEntity(entity);
    const lookupHints = extractLookupHints(template.parameters);
    const parameters = sanitizeTemplateParameters(template.parameters);

    return toolSuccess({
      ref: template.ref,
      name: template.name,
      title: template.title,
      description: template.description,
      owner: template.owner,
      tags: template.tags,
      parameters,
      steps: template.steps,
      lookupHints,
      usage:
        'BEFORE asking the user for values, pre-fetch all options listed in lookupHints (in parallel) ' +
        'and present them as numbered lists so the user can pick. ' +
        'Then call run_template with templateRef and values matching the parameters schema above.',
    });
  }

  private async runTemplate(
    args: Record<string, unknown>,
    api: BackstageApiClient,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const templateRef = args.templateRef as string;
    const values = args.values as Record<string, unknown>;
    const createdBy = (args.createdBy as string) ?? context.userEntityRef;

    const parsed = parseEntityRef(templateRef, { defaultKind: 'Template' });
    const templateEntity = await api
      .fetchJson<RawTemplateEntity>(
        'catalog',
        `/entities/by-name/${parsed.kind}/${parsed.namespace}/${parsed.name}`,
      )
      .catch(() => undefined);

    if (!templateEntity) return toolError(`Template not found: ${templateRef}`);

    const template = toTemplateEntity(templateEntity);
    if (template.parameters.length > 0) {
      const validationErrors = validateRequiredFields(values, template.parameters);
      if (validationErrors.length > 0) {
        return toolError(
          'Template parameter validation failed. Fix the values and try again.',
          { validationErrors },
        );
      }
    }

    const repoUrlError = validateRepoUrlOwner(values, template.parameters, context);
    if (repoUrlError) {
      return toolError(repoUrlError);
    }

    const body: Record<string, unknown> = {
      templateRef,
      values,
      createdBy,
    };

    if (context.vcsTokens?.github) {
      body.secrets = { USER_OAUTH_TOKEN: context.vcsTokens.github };
    } else if (context.vcsTokens?.gitlab) {
      body.secrets = { USER_OAUTH_TOKEN: context.vcsTokens.gitlab };
    } else if (context.vcsTokens?.azureDevops) {
      body.secrets = { USER_OAUTH_TOKEN: context.vcsTokens.azureDevops };
    }

    const result = await api.fetchJson<{ id: string }>(
      'scaffolder',
      '/v2/tasks',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );

    return toolSuccess({
      taskId: result.id,
      message: `Template execution started. Use get_task_status with taskId "${result.id}" to track progress.`,
    });
  }

  private async getVcsGroups(
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const provider = (args.provider as string | undefined)?.toLowerCase();
    const rejectedProviders = context.vcsTokens?.rejectedProviders ?? [];

    let owners =
      provider === 'gitlab'
        ? context.vcsTokens?.gitlabOwners ?? []
        : provider === 'github'
          ? context.vcsTokens?.githubOwners ?? []
          : [
              ...(context.vcsTokens?.githubOwners ?? []),
              ...(context.vcsTokens?.gitlabOwners ?? []),
            ];

    if (owners.length === 0) {
      owners = await this.fetchVcsOwners(provider, context);
    }

    if (owners.length > 0) {
      return toolSuccess({
        provider: provider ?? 'any',
        owners,
        usage:
          'Use one of these exact owner/group names when constructing repoUrl for GitHub or GitLab templates. Do not use Azure DevOps allowedOrganizations for GitHub or GitLab.',
      });
    }

    if (
      rejectedProviders.includes(provider ?? 'github') ||
      rejectedProviders.includes('github') ||
      rejectedProviders.includes('gitlab')
    ) {
      return toolError(
        'OAuth authorization was rejected. Ask the user to provide the exact GitHub organization or GitLab group name manually before constructing repoUrl. Do not use Azure DevOps allowedOrganizations for GitHub or GitLab.',
      );
    }

    if (context.vcsTokens?.github || context.vcsTokens?.gitlab) {
      return toolError(
        'OAuth completed, but no GitHub organizations or GitLab groups were returned. Ask the user for the exact GitHub organization or GitLab group name manually before constructing repoUrl. Do not use Azure DevOps allowedOrganizations for GitHub or GitLab.',
      );
    }

    return toolError(
      'OAuth authorization is required to fetch GitHub organizations or GitLab groups. Ask the user to authorize VCS access. Do not use Azure DevOps allowedOrganizations for GitHub or GitLab.',
    );
  }

  private async fetchVcsOwners(
    provider: string | undefined,
    context: ToolCallContext,
  ): Promise<string[]> {
    if (provider === 'gitlab') {
      return context.vcsTokens?.gitlab
        ? this.fetchGitLabOwners(context.vcsTokens.gitlab)
        : [];
    }

    if (provider === 'github') {
      return context.vcsTokens?.github
        ? this.fetchGitHubOwners(context.vcsTokens.github)
        : [];
    }

    const [githubOwners, gitlabOwners] = await Promise.all([
      context.vcsTokens?.github
        ? this.fetchGitHubOwners(context.vcsTokens.github)
        : Promise.resolve([]),
      context.vcsTokens?.gitlab
        ? this.fetchGitLabOwners(context.vcsTokens.gitlab)
        : Promise.resolve([]),
    ]);
    return [...githubOwners, ...gitlabOwners];
  }

  private async fetchGitHubOwners(token: string): Promise<string[]> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };

    const [user, orgs] = await Promise.all([
      fetch('https://api.github.com/user', { headers })
        .then(response => (response.ok ? response.json() : undefined))
        .catch(() => undefined),
      fetch('https://api.github.com/user/orgs?per_page=100', { headers })
        .then(response => (response.ok ? response.json() : []))
        .catch(() => []),
    ]);

    const owners = new Set<string>();
    if (typeof user?.login === 'string') {
      owners.add(user.login);
    }
    if (Array.isArray(orgs)) {
      for (const org of orgs) {
        if (typeof org?.login === 'string') {
          owners.add(org.login);
        }
      }
    }
    return [...owners].sort((a, b) => a.localeCompare(b));
  }

  private async fetchGitLabOwners(token: string): Promise<string[]> {
    const response = await fetch(
      'https://gitlab.com/api/v4/groups?min_access_level=30&per_page=100',
      { headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => undefined);

    if (!response?.ok) {
      return [];
    }

    const groups = await response.json();
    if (!Array.isArray(groups)) {
      return [];
    }

    return groups
      .map(group => group?.full_path ?? group?.path)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  private async listTasks(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const createdBy = args.createdBy as string | undefined;
    const qs = new URLSearchParams();
    if (createdBy) qs.set('createdBy', createdBy);
    const query = qs.toString();
    const path = `/v2/tasks${query ? `?${query}` : ''}`;

    const response = await api.fetchJson<{ tasks: ScaffolderTask[] }>(
      'scaffolder',
      path,
    );

    return toolSuccess({
      tasks: response.tasks.map(t => ({
        taskId: t.id,
        status: t.status,
        createdAt: t.createdAt,
        createdBy: t.createdBy,
        templateRef: (t as any).spec?.templateInfo?.entityRef,
      })),
      totalCount: response.tasks.length,
    });
  }

  private async getTaskStatus(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const taskId = args.taskId as string;
    const includeLogs = (args.includeLogs as boolean) ?? false;

    const [task, logs] = await Promise.all([
      api.fetchJson<ScaffolderTask>('scaffolder', `/v2/tasks/${taskId}`),
      includeLogs
        ? api.fetchJson<ScaffolderTaskEvent[]>(
            'scaffolder',
            `/v2/tasks/${taskId}/events?after=0`,
          )
        : Promise.resolve(undefined),
    ]);

    const output: Record<string, unknown> = {
      taskId: task.id,
      status: task.status,
      createdAt: task.createdAt,
      lastHeartbeatAt: task.lastHeartbeatAt,
      createdBy: task.createdBy,
      steps: (task.spec?.steps ?? []).map(s => ({
        id: s.id,
        name: s.name,
        action: s.action,
      })),
    };

    if (logs) {
      output.logs = logs
        .filter(
          e =>
            e.type === 'completion' ||
            e.body.error ||
            (e.body.status && e.body.status !== 'processing'),
        )
        .slice(-20)
        .map(e => ({
          type: e.type,
          message: e.body.message,
          stepId: e.body.stepId,
          status: e.body.status,
          error: e.body.error,
          output: e.body.output,
        }));
    }

    return toolSuccess(output);
  }

  private async getTechDocs(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const entityRef = args.entityRef as string;
    const forceSync = (args.forceSync as boolean) ?? false;

    const parsed = parseEntityRef(entityRef);
    const kind = parsed.kind.toLowerCase();
    const namespace = parsed.namespace;
    const name = parsed.name;

    let synced = false;
    try {
      const syncText = await api.fetchText(
        'techdocs',
        `/sync/${namespace}/${kind}/${name}`,
      );
      synced = syncText.includes('"updated":true');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        return toolError(
          `TechDocs not found for ${entityRef}. Ensure the entity has a 'backstage.io/techdocs-ref' annotation.`,
        );
      }
      if (forceSync) throw err;
    }

    const basePath = `/static/docs/${namespace}/${kind}/${name}`;
    let html = await api.fetchText('techdocs', `${basePath}/index.html`);

    const redirectMatch = html.match(/content="0;\s*url=([^"]+)"/i);
    if (redirectMatch) {
      const redirectTarget = redirectMatch[1].replace(/\/$/, '');
      html = await api
        .fetchText('techdocs', `${basePath}/${redirectTarget}/index.html`)
        .catch(() => html);
    }

    const content = htmlToMarkdown(html);
    const truncated = content.length >= TECHDOCS_MAX_CHARS;

    return toolSuccess({
      entityRef,
      synced,
      truncated,
      content: truncated
        ? content.slice(0, TECHDOCS_MAX_CHARS) +
          '\n\n[...content truncated at 8,000 chars]'
        : content,
    });
  }

  private async searchTechDocs(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const query = args.query as string | undefined;
    if (!query) return toolError('query is required');
    const limit = (args.limit as number) ?? 10;

    const qs = new URLSearchParams({ term: query });
    qs.append('types[0]', 'techdocs');

    const data = await api.fetchJson<{
      results?: Array<{ document?: Record<string, unknown> }>;
    }>('search', `/query?${qs}`);

    const results = (data.results ?? []).slice(0, limit).map(r => {
      const doc = r.document ?? {};
      const text = typeof doc.text === 'string' ? doc.text : undefined;
      return {
        title: doc.title ?? doc.name ?? 'Untitled',
        text: text ? text.slice(0, 300) : undefined,
        location: doc.location,
      };
    });

    return toolSuccess({ results });
  }

  private async getCatalogFacets(
    args: Record<string, unknown>,
    api: BackstageApiClient,
  ): Promise<ToolResult> {
    const facets = args.facets as string[] | undefined;
    if (!facets?.length) {
      return toolError('facets is required, e.g. ["kind"] or ["spec.owner"]');
    }
    const filter = args.filter as string | undefined;

    const qs = new URLSearchParams();
    facets.forEach(f => qs.append('facet', f));
    if (filter) qs.append('filter', filter);

    const data = await api.fetchJson<{
      facets: Record<string, Array<{ value: string; count: number }>>;
    }>('catalog', `/entity-facets?${qs}`);

    return toolSuccess({ facets: data.facets ?? {} });
  }

  private async callSearchCatalog(
    api: BackstageApiClient,
    params: { kind?: string; owner?: string; limit?: number },
  ) {
    const filters: string[] = [];
    if (params.kind) filters.push(`kind=${params.kind}`);
    if (params.owner) filters.push(`spec.owner=${params.owner}`);

    const qs = new URLSearchParams({ limit: String(params.limit ?? 20) });
    if (filters.length) qs.set('filter', filters.join(','));

    const result = await api
      .fetchJson<{
        items: Entity[];
        pageInfo?: { nextCursor?: string };
        totalItems?: number;
      }>('catalog', `/entities/by-query?${qs}`)
      .catch(async () => {
        const items = await api.fetchJson<Entity[]>(
          'catalog',
          `/entities?${qs}`,
        );
        return { items, pageInfo: undefined, totalItems: undefined };
      });

    return {
      entities: result.items.map(toEntitySummary),
      nextCursor: result.pageInfo?.nextCursor,
      totalCount: result.totalItems,
    };
  }

  private async cacheGet<T>(key: string): Promise<T | undefined> {
    try {
      return (await this.deps.cache.get(key)) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private async cacheSet(key: string, value: unknown): Promise<void> {
    try {
      await this.deps.cache.set(key, value as any, { ttl: 30_000 });
    } catch {
      // cache failures are non-fatal
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Entity {
  kind: string;
  apiVersion: string;
  metadata: {
    name: string;
    namespace?: string;
    title?: string;
    description?: string;
    tags?: string[];
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  relations?: Array<{ type: string; targetRef: string }>;
}

interface EntitySummary {
  ref: string;
  kind: string;
  namespace: string;
  name: string;
  title?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  system?: string;
  type?: string;
}

interface RawTemplateEntity {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    title?: string;
    description?: string;
    tags?: string[];
  };
  spec?: {
    owner?: string;
    parameters?: TemplateParameterSchema | TemplateParameterSchema[];
    steps?: Array<{ id: string; name: string; action: string }>;
  };
}

interface TemplateEntity {
  ref: string;
  name: string;
  namespace: string;
  title?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  parameters: TemplateParameterSchema[];
  steps?: Array<{ id: string; name: string; action: string }>;
}

interface TemplateParameterSchema {
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ScaffolderTask {
  id: string;
  status: string;
  createdAt?: string;
  lastHeartbeatAt?: string;
  createdBy?: string;
  spec?: {
    steps?: Array<{ id: string; name: string; action: string }>;
    parameters?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
}

interface ScaffolderTaskEvent {
  id: number;
  taskId: string;
  body: {
    message?: string;
    stepId?: string;
    status?: string;
    output?: Record<string, unknown>;
    error?: { name?: string; message?: string };
  };
  type: string;
  createdAt: string;
}

interface LookupHint {
  field: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ValidationError {
  field: string;
  message: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseEntityRef(
  ref: string,
  defaults?: { defaultKind?: string },
): { kind: string; namespace: string; name: string } {
  const defaultKind = defaults?.defaultKind ?? 'Component';
  const colonIdx = ref.indexOf(':');
  const slashIdx = ref.indexOf('/');

  if (colonIdx !== -1 && slashIdx > colonIdx) {
    return {
      kind: ref.slice(0, colonIdx),
      namespace: ref.slice(colonIdx + 1, slashIdx),
      name: ref.slice(slashIdx + 1),
    };
  }
  if (colonIdx !== -1) {
    return {
      kind: ref.slice(0, colonIdx),
      namespace: DEFAULT_NAMESPACE,
      name: ref.slice(colonIdx + 1),
    };
  }
  return { kind: defaultKind, namespace: DEFAULT_NAMESPACE, name: ref };
}

function toEntitySummary(entity: Entity): EntitySummary {
  const spec = entity.spec as Record<string, unknown> | undefined;
  return {
    ref: `${entity.kind.toLowerCase()}:${entity.metadata.namespace ?? DEFAULT_NAMESPACE}/${entity.metadata.name}`,
    kind: entity.kind,
    namespace: entity.metadata.namespace ?? DEFAULT_NAMESPACE,
    name: entity.metadata.name,
    title: entity.metadata.title,
    description: entity.metadata.description,
    owner: spec?.owner as string | undefined,
    tags: entity.metadata.tags,
    system: spec?.system as string | undefined,
    type: spec?.type as string | undefined,
  };
}

function toTemplateEntity(raw: RawTemplateEntity): TemplateEntity {
  const rawParams = raw.spec?.parameters;
  const parameters: TemplateParameterSchema[] = rawParams
    ? Array.isArray(rawParams)
      ? rawParams
      : [rawParams]
    : [];

  return {
    ref: `template:${raw.metadata.namespace ?? DEFAULT_NAMESPACE}/${raw.metadata.name}`,
    name: raw.metadata.name,
    namespace: raw.metadata.namespace ?? DEFAULT_NAMESPACE,
    title: raw.metadata.title,
    description: raw.metadata.description,
    owner: raw.spec?.owner,
    tags: raw.metadata.tags,
    parameters,
    steps: raw.spec?.steps,
  };
}

function extractLookupHints(
  parameters: TemplateParameterSchema[],
): LookupHint[] {
  const hints: LookupHint[] = [];

  for (const step of parameters) {
    const props = step.properties ?? {};
    for (const [field, schema] of Object.entries(props)) {
      const s = schema as Record<string, unknown>;
      const uiField = s['ui:field'] as string | undefined;
      const uiOptions = s['ui:options'] as Record<string, unknown> | undefined;

      if (uiField === 'OwnerPicker') {
        const allowedKinds = (uiOptions?.allowedKinds as string[]) ?? ['Group'];
        hints.push({
          field,
          description: `Fetch available owners (${allowedKinds.join(', ')}) to present as options`,
          tool: 'search_catalog',
          args: { kind: allowedKinds[0], limit: 50 },
        });
      } else if (uiField === 'EntityPicker') {
        const catalogFilter = uiOptions?.catalogFilter as
          | Record<string, unknown>
          | undefined;
        const kind = (catalogFilter?.kind as string) ?? 'Component';
        if (kind === 'API') {
          hints.push({
            field,
            description: 'Fetch available APIs to present as options',
            tool: 'list_api_specs',
            args: { limit: 50 },
          });
        } else {
          hints.push({
            field,
            description: `Fetch available ${kind} entities to present as options`,
            tool: 'search_catalog',
            args: { kind, limit: 50 },
          });
        }
      } else if (uiField === 'RepoUrlPicker') {
        const allowedHosts = uiOptions?.allowedHosts as string[] | undefined;
        const provider = inferVcsProvider(allowedHosts);
        hints.push({
          field,
          description:
            provider === 'azureDevops'
              ? `Ask user for repo name and Azure DevOps project/org path. Allowed hosts: ${(allowedHosts ?? []).join(', ')}. Format: host?owner=<group>&repo=<name>`
              : `Fetch available ${provider ?? 'VCS'} owner/group names with OAuth before asking the user. Allowed hosts: ${(allowedHosts ?? []).join(', ')}. Format: host?owner=<group>&repo=<name>. Do not use Azure DevOps allowedOrganizations for this field.`,
          tool: provider === 'github' || provider === 'gitlab' ? 'get_vcs_groups' : 'none',
          args: { allowedHosts, provider },
        });
      }

      if (s.type === 'array') {
        const items = s.items as Record<string, unknown> | undefined;
        if (items?.['ui:field'] === 'EntityPicker') {
          const itemFilter = (
            items['ui:options'] as Record<string, unknown> | undefined
          )?.catalogFilter as Record<string, unknown> | undefined;
          const itemKind = (itemFilter?.kind as string) ?? 'Component';
          if (!hints.some(h => h.field === field)) {
            if (itemKind === 'API') {
              hints.push({
                field,
                description:
                  'Fetch available APIs to present as multi-select options',
                tool: 'list_api_specs',
                args: { limit: 50 },
              });
            } else {
              hints.push({
                field,
                description: `Fetch available ${itemKind} entities to present as multi-select options`,
                tool: 'search_catalog',
                args: { kind: itemKind, limit: 50 },
              });
            }
          }
        }
      }
    }
  }

  return hints;
}

function inferVcsProvider(
  allowedHosts: string[] | undefined,
): 'github' | 'gitlab' | 'azureDevops' | undefined {
  const host = (allowedHosts ?? []).join(' ').toLowerCase();
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (
    host.includes('dev.azure') ||
    host.includes('visualstudio') ||
    host.includes('azure')
  ) {
    return 'azureDevops';
  }
  return undefined;
}

function sanitizeTemplateParameters(
  parameters: TemplateParameterSchema[],
): TemplateParameterSchema[] {
  return parameters.map(step => {
    const props = step.properties;
    if (!props) return step;

    const sanitizedProps: Record<string, unknown> = {};
    let changed = false;

    for (const [field, schema] of Object.entries(props)) {
      const s = schema as Record<string, unknown>;
      const uiField = s['ui:field'] as string | undefined;
      const uiOptions = s['ui:options'] as Record<string, unknown> | undefined;
      const provider =
        uiField === 'RepoUrlPicker'
          ? inferVcsProvider(uiOptions?.allowedHosts as string[] | undefined)
          : undefined;

      if (
        uiField === 'RepoUrlPicker' &&
        (provider === 'github' || provider === 'gitlab') &&
        uiOptions &&
        'allowedOrganizations' in uiOptions
      ) {
        const { allowedOrganizations: _ignored, ...safeOptions } = uiOptions;
        sanitizedProps[field] = {
          ...s,
          'ui:options': {
            ...safeOptions,
            assistantUsage:
              'For GitHub/GitLab repoUrl owners, use get_vcs_groups or ask the user. Do not use Azure DevOps allowedOrganizations.',
          },
        };
        changed = true;
      } else {
        sanitizedProps[field] = schema;
      }
    }

    return changed
      ? {
          ...step,
          properties: sanitizedProps,
        }
      : step;
  });
}

function validateRequiredFields(
  values: Record<string, unknown>,
  parameters: TemplateParameterSchema[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const step of parameters) {
    const required = step.required as string[] | undefined;
    if (!required) continue;
    for (const field of required) {
      const value = values[field];
      if (value === undefined || value === null || value === '') {
        errors.push({
          field,
          message: `Required field '${field}' is missing or empty`,
        });
      }
    }
  }
  return errors;
}

function validateRepoUrlOwner(
  values: Record<string, unknown>,
  parameters: TemplateParameterSchema[],
  context: ToolCallContext,
): string | undefined {
  for (const step of parameters) {
    const props = step.properties ?? {};
    for (const [field, schema] of Object.entries(props)) {
      const s = schema as Record<string, unknown>;
      if (s['ui:field'] !== 'RepoUrlPicker') continue;

      const repoUrl = values[field];
      if (typeof repoUrl !== 'string') continue;

      const parsed = parseRepoUrl(repoUrl);
      if (!parsed || (parsed.provider !== 'github' && parsed.provider !== 'gitlab')) {
        continue;
      }

      const uiOptions = s['ui:options'] as Record<string, unknown> | undefined;
      const allowedOrganizations = toStringArray(uiOptions?.allowedOrganizations);
      if (allowedOrganizations.includes(parsed.owner)) {
        return (
          `Invalid ${parsed.provider} repoUrl owner "${parsed.owner}". ` +
          'That owner came from template allowedOrganizations and must not be used for GitHub/GitLab. ' +
          'Call get_vcs_groups or ask the user for the exact GitHub organization/GitLab group.'
        );
      }

      const knownOwners =
        parsed.provider === 'github'
          ? context.vcsTokens?.githubOwners ?? []
          : context.vcsTokens?.gitlabOwners ?? [];
      if (knownOwners.length > 0 && !knownOwners.includes(parsed.owner)) {
        return (
          `Invalid ${parsed.provider} repoUrl owner "${parsed.owner}". ` +
          `Use one of: ${knownOwners.join(', ')}.`
        );
      }
    }
  }

  return undefined;
}

function parseRepoUrl(
  repoUrl: string,
): { provider: 'github' | 'gitlab' | 'azureDevops' | undefined; owner: string } | undefined {
  const [hostPart, queryPart = ''] = repoUrl.split('?');
  const owner = new URLSearchParams(queryPart).get('owner') ?? '';
  if (!owner) return undefined;
  return {
    provider: inferVcsProvider([hostPart]),
    owner,
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Extract the main TechDocs article so nav/sidebar/header don't leak in. */
function extractMainHtml(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  return html;
}

function htmlToMarkdown(html: string): string {
  return turndownService.turndown(extractMainHtml(html)).trim();
}

function toolSuccess(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(message: string, extra?: unknown): ToolResult {
  const text = extra
    ? `${message}\n${JSON.stringify(extra, null, 2)}`
    : message;
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

// ─── Tool Definitions (JSON Schema, no Zod) ──────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'check_connection',
    description:
      'Verify connectivity to Backstage and validate the configured token. Returns server info and a summary of accessible resources. Run this first to confirm your setup is working.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_catalog',
    description:
      'Search the Backstage software catalog for components, APIs, systems, groups, users, and other entities. Returns a paginated list with entityRefs for follow-up calls. Use get_entity for full details on a specific result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full-text search query (name, description, tags)',
        },
        kind: {
          type: 'string',
          enum: [
            'Component',
            'API',
            'System',
            'Domain',
            'Group',
            'User',
            'Resource',
            'Template',
            'Location',
          ],
          description: 'Filter by entity kind',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by metadata tags (AND logic)',
        },
        owner: {
          type: 'string',
          description:
            "Filter by owner entity ref, e.g. 'team-payments' or 'group:default/team-payments'",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'Maximum number of results to return',
        },
        cursor: {
          type: 'string',
          description:
            "Pagination cursor from a previous response's nextCursor",
        },
      },
    },
  },
  {
    name: 'get_entity',
    description:
      'Get full details for a Backstage entity including metadata, spec, annotations, and resolved relations (APIs consumed/provided, dependencies, system membership, ownership). Use search_catalog first to find the entityRef.',
    inputSchema: {
      type: 'object',
      required: ['entityRef'],
      properties: {
        entityRef: {
          type: 'string',
          description:
            "Entity reference in 'kind:namespace/name' format, e.g. 'component:default/payment-service'",
        },
        includeRelations: {
          type: 'boolean',
          default: true,
          description:
            'Resolve and include related entities (APIs, dependencies, owners). Set false for a faster, lighter response.',
        },
      },
    },
  },
  {
    name: 'list_api_specs',
    description:
      'List API entities in the Backstage catalog, optimized for integration discovery. Returns name, type (openapi/asyncapi/graphql/grpc), owner, and description. Use get_api_spec to retrieve the full specification.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['openapi', 'asyncapi', 'graphql', 'grpc'],
          description: 'Filter by API specification type',
        },
        owner: {
          type: 'string',
          description: 'Filter by owning team or group',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'Maximum number of results',
        },
      },
    },
  },
  {
    name: 'get_api_spec',
    description:
      'Retrieve the raw API specification (OpenAPI YAML/JSON, AsyncAPI, GraphQL schema, etc.) for a specific API entity.',
    inputSchema: {
      type: 'object',
      required: ['entityRef'],
      properties: {
        entityRef: {
          type: 'string',
          description:
            "API entity reference, e.g. 'api:default/payment-api'. Use list_api_specs to find available APIs.",
        },
      },
    },
  },
  {
    name: 'list_templates',
    description:
      'List available Backstage scaffolder templates for creating new services, libraries, repositories, or other resources. Returns names, descriptions, and tags. Use get_template to see the full parameter schema.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: "Filter templates by tags, e.g. ['react', 'frontend']",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'Maximum number of results',
        },
      },
    },
  },
  {
    name: 'get_template',
    description:
      'Get the full specification for a Backstage scaffolder template, including the parameters JSON Schema and lookupHints. The lookupHints array tells you which tools to call (in parallel) to fetch selectable options BEFORE asking the user for input. Always present fetched options as numbered lists. Use this BEFORE run_template.',
    inputSchema: {
      type: 'object',
      required: ['entityRef'],
      properties: {
        entityRef: {
          type: 'string',
          description:
            "Template entity reference, e.g. 'template:default/create-react-app'. Use list_templates to find available templates.",
        },
      },
    },
  },
  {
    name: 'run_template',
    description:
      'Execute a Backstage scaffolder template with the provided parameter values. Validates inputs against the template schema before submitting. Returns a taskId for tracking progress with get_task_status. Always call get_template first to understand required parameters.',
    inputSchema: {
      type: 'object',
      required: ['templateRef', 'values'],
      properties: {
        templateRef: {
          type: 'string',
          description:
            "Template entity reference, e.g. 'template:default/create-react-app'",
        },
        values: {
          type: 'object',
          description:
            'Template parameter values as key-value pairs. Must match the schema returned by get_template.',
        },
        createdBy: {
          type: 'string',
          description:
            "User entity ref to attribute the task to, e.g. 'user:default/john-doe'. Auto-set from the current user if omitted.",
        },
      },
    },
  },
  {
    name: 'get_vcs_groups',
    description:
      'Return GitHub organizations or GitLab groups available from the user OAuth session for RepoUrlPicker fields. Use this before asking for template repoUrl owner/group values for GitHub or GitLab. If OAuth was rejected, ask the user to provide the owner/group manually.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['github', 'gitlab'],
          description:
            'VCS provider for the repository owner/group options. Infer from RepoUrlPicker allowedHosts.',
        },
      },
    },
  },
  {
    name: 'list_tasks',
    description:
      'List scaffolder tasks (template executions). Returns task IDs, status, template used, and who created them. Optionally filter by the user who triggered the task.',
    inputSchema: {
      type: 'object',
      properties: {
        createdBy: {
          type: 'string',
          description:
            "Filter by the user who created the task, e.g. 'user:default/ankit-singh16'. Omit to list all tasks.",
        },
      },
    },
  },
  {
    name: 'get_task_status',
    description:
      "Get the execution status and progress of a Backstage scaffolder task. Poll this after run_template to monitor progress. Status will be 'processing', 'completed', 'failed', or 'cancelled'.",
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID returned by run_template',
        },
        includeLogs: {
          type: 'boolean',
          default: false,
          description:
            'Include filtered execution logs (errors, status changes, outputs). Useful for debugging failed tasks.',
        },
      },
    },
  },
  {
    name: 'get_techdocs',
    description:
      "Retrieve the TechDocs documentation for a Backstage entity. Triggers a render sync if needed, then returns the documentation as plain text. The entity must have a 'backstage.io/techdocs-ref' annotation configured.",
    inputSchema: {
      type: 'object',
      required: ['entityRef'],
      properties: {
        entityRef: {
          type: 'string',
          description:
            "Entity reference, e.g. 'component:default/payment-service'. Use get_entity first to confirm the entity has techdocs configured.",
        },
        forceSync: {
          type: 'boolean',
          default: false,
          description:
            'Force a TechDocs re-render before fetching. Use when docs may be stale.',
        },
      },
    },
  },
  {
    name: 'search_techdocs',
    description:
      'Full-text search across TechDocs documentation CONTENT (the text inside docs), not just catalog metadata. Use when the user wants to find documentation/pages that mention a topic but does not know which entity owns it. Returns matching doc pages with titles, snippets, and links. (Distinct from search_catalog, which only matches entity names/metadata, and get_techdocs, which needs a known entity.)',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query to match against documentation content.',
        },
        limit: {
          type: 'number',
          default: 10,
          description: 'Maximum number of doc matches to return.',
        },
      },
    },
  },
  {
    name: 'get_catalog_facets',
    description:
      'Aggregate COUNTS of catalog entities grouped by one or more fields (e.g. kind, spec.type, spec.owner, spec.lifecycle). Use for summaries/metrics like "how many components per owner" or "count of APIs by type". Returns counts only, not entity lists. (Distinct from search_catalog, which lists entities and cannot aggregate.)',
    inputSchema: {
      type: 'object',
      required: ['facets'],
      properties: {
        facets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Fields to group by, e.g. ["kind"], ["spec.owner"], ["spec.type","spec.lifecycle"].',
        },
        filter: {
          type: 'string',
          description:
            "Optional catalog filter to scope the counts, e.g. 'kind=component'.",
        },
      },
    },
  },
];
