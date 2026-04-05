import type { CandidatePage, ReferenceState, Snapshot, SnapshotItemType, SnapshotSourceType, WhiteboardInfo } from "./types";

type PulledRef = {
  "db/id"?: number;
};

type PulledPageContext = {
  "db/id"?: number;
  "block/uuid"?: string;
  "block/name"?: string;
  "block/title"?: string;
  "block/original-name"?: string;
};

type PulledEntity = {
  "db/id"?: number;
  "block/uuid"?: string;
  "block/title"?: string;
  "block/content"?: string;
  "block/name"?: string;
  "block/original-name"?: string;
  "block/link"?: unknown;
  "block/type"?: string;
  "logseq.property/built-in?"?: boolean;
  "block/refs"?: PulledRef[];
  "block/page"?: PulledPageContext;
};

type GenericEntity = Record<string, unknown>;
type PageLookupRef = string | number | { uuid: string };
type NativeScope = Record<string, unknown>;

type NativeSearchBlockResult = {
  "block/uuid"?: string;
};

type FallbackBlockSearchItem = {
  blockUuid: string;
  pageName: string | null;
  content: string;
};

type CandidateNormalizationStats = {
  totalRows: number;
  normalized: number;
  invalidRows: number;
  missingId: number;
  missingUuid: number;
  missingTitle: number;
};

let fallbackBlockSearchCacheGraph = "";
let fallbackBlockSearchCache: FallbackBlockSearchItem[] = [];

function createCandidateNormalizationStats(): CandidateNormalizationStats {
  return {
    totalRows: 0,
    normalized: 0,
    invalidRows: 0,
    missingId: 0,
    missingUuid: 0,
    missingTitle: 0,
  };
}

function appendCandidateNormalizationDiagnostics(
  diagnostics: string[],
  stats: CandidateNormalizationStats,
): void {
  const dropped = stats.totalRows - stats.normalized;
  diagnostics.push(`candidate normalization: total=${stats.totalRows} kept=${stats.normalized} dropped=${dropped}`);

  if (stats.missingUuid > 0) {
    diagnostics.push(
      `dropped candidates without stable uuid: ${stats.missingUuid} (some block/page results may be omitted)`,
    );
  }

  if (stats.missingId > 0) {
    diagnostics.push(`dropped candidates without db/id: ${stats.missingId}`);
  }

  if (stats.missingTitle > 0) {
    diagnostics.push(`dropped candidates without title/content: ${stats.missingTitle}`);
  }

  if (stats.invalidRows > 0) {
    diagnostics.push(`dropped malformed candidate rows: ${stats.invalidRows}`);
  }
}

function chunkValues<T>(values: T[], size: number): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function includesIgnoreCase(value: string, needle: string): boolean {
  return value.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function trimPreview(text: string, maxLength = 280): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}

function isDeferredTimeoutError(error: unknown): boolean {
  return getErrorMessage(error).includes("[deferred timeout]");
}

function serializeEdnScalar(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot serialize a non-finite number for Datascript.");
    }

    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value == null) {
    return "nil";
  }

  throw new Error(`Unsupported Datascript scalar input: ${typeof value}`);
}

function serializeEdnVector(values: unknown[]): string {
  return `[${values.map((value) => serializeEdnInput(value)).join(" ")}]`;
}

function serializeEdnMap(record: Record<string, unknown>): string {
  const pairs = Object.entries(record).map(([key, value]) => {
    const ednKey = key.startsWith(":") ? key : `:${key}`;
    return `${ednKey} ${serializeEdnInput(value)}`;
  });

  return `{${pairs.join(" ")}}`;
}

function serializeEdnInput(value: unknown): string {
  if (Array.isArray(value)) {
    return serializeEdnVector(value);
  }

  if (value && typeof value === "object") {
    return serializeEdnMap(value as Record<string, unknown>);
  }

  return serializeEdnScalar(value);
}

function normalizeDatascriptInput(value: unknown): unknown {
  if (typeof value === "function") {
    return value;
  }

  if (Array.isArray(value)) {
    return serializeEdnVector(value);
  }

  return value;
}

async function withDeferredTimeoutMessage<T>(message: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (isDeferredTimeoutError(error)) {
      throw new Error(message);
    }

    throw error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

function scoreSearchCandidate(label: string, query: string): number {
  const normalizedLabel = normalizeSearchText(label);
  if (!normalizedLabel || !query) {
    return 0;
  }

  if (normalizedLabel === query) {
    return 400;
  }

  if (normalizedLabel.startsWith(query)) {
    return 300;
  }

  const position = normalizedLabel.indexOf(query);
  if (position >= 0) {
    return 200 - position;
  }

  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeRowShape(row: unknown): string {
  if (Array.isArray(row)) {
    return `array(len=${row.length})`;
  }

  if (!row || typeof row !== "object") {
    return typeof row;
  }

  const keys = Object.keys(row as Record<string, unknown>).slice(0, 8);
  return `object(keys=${keys.join(",") || "none"})`;
}

function hasLinkedReference(rawContent: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return false;
  }

  const escaped = escapeRegExp(normalizedQuery);
  const wikiPattern = new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, "i");
  const tagPattern = new RegExp(`(^|\\s)#${escaped}(?=$|\\s|[.,;:!?])`, "i");
  return wikiPattern.test(rawContent) || tagPattern.test(rawContent);
}

function getStringField(record: GenericEntity, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function getNumberField(record: GenericEntity, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function getProperties(record: GenericEntity): GenericEntity | null {
  const properties = record.properties;
  if (!properties || typeof properties !== "object") {
    return null;
  }

  return properties as GenericEntity;
}

function isWhiteboardEntity(entity: unknown): entity is GenericEntity {
  if (!entity || typeof entity !== "object") {
    return false;
  }

  const record = entity as GenericEntity;
  const directType = getStringField(record, ["type", "block/type", "blockType"]);
  if (directType?.toLocaleLowerCase() === "whiteboard") {
    return true;
  }

  const properties = getProperties(record);
  if (!properties) {
    return false;
  }

  const lsType = getStringField(properties, ["ls-type", "lsType", "logseq.property/ls-type"]);
  if (lsType?.toLocaleLowerCase().includes("whiteboard")) {
    return true;
  }

  return Object.keys(properties).some((key) => key.toLocaleLowerCase().includes("tldraw.page"));
}

function buildWhiteboardInfo(entity: GenericEntity): WhiteboardInfo | null {
  const id = getStringField(entity, ["uuid", "block/uuid"]);
  if (!id) {
    return null;
  }

  const name =
    getStringField(entity, ["originalName", "title", "name", "block/title", "block/name"]) ??
    "Untitled whiteboard";

  return { id, name };
}

function buildWhiteboardInfoWithFallback(
  entity: GenericEntity,
  fallback: Partial<WhiteboardInfo> = {},
): WhiteboardInfo | null {
  const whiteboard = buildWhiteboardInfo(entity);
  if (whiteboard) {
    return whiteboard;
  }

  if (!fallback.id || !fallback.name) {
    return null;
  }

  return {
    id: fallback.id,
    name: fallback.name,
  };
}

function isWhiteboardDomVisible(): boolean {
  try {
    const hostDocument = window.top?.document ?? document;
    return Boolean(hostDocument.querySelector(".logseq-tldraw, .tl-container, .tl-canvas"));
  } catch (_error) {
    return false;
  }
}

function getPageLookupRef(value: unknown): PageLookupRef | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as GenericEntity;
  const uuid = getStringField(record, ["uuid", "block/uuid"]);
  if (uuid) {
    return { uuid };
  }

  const id = record.id ?? record["db/id"];
  if (typeof id === "number") {
    return id;
  }

  return null;
}

function getCurrentLocationPath(): string | null {
  try {
    const location = window.top?.location ?? window.location;
    if (location.hash && location.hash !== "#") {
      return location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    }

    const path = `${location.pathname}${location.search}`;
    return path || null;
  } catch (_error) {
    return null;
  }
}

async function getGraphCacheKey(): Promise<string> {
  const currentGraph = await logseq.App.getCurrentGraph();
  if (!currentGraph || typeof currentGraph !== "object") {
    return "default";
  }

  const graphRecord = currentGraph as Record<string, unknown>;
  const identifier =
    graphRecord.path ??
    graphRecord.url ??
    graphRecord.name ??
    graphRecord.id ??
    "default";

  return String(identifier);
}

function extractWhiteboardNameFromRoutePath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  if (!path.startsWith("/whiteboard/")) {
    return null;
  }

  const encodedName = path.slice("/whiteboard/".length).split("?")[0];
  if (!encodedName) {
    return null;
  }

  try {
    return decodeURIComponent(encodedName);
  } catch (_error) {
    return encodedName;
  }
}

async function resolveWhiteboardByName(name: string): Promise<WhiteboardInfo | null> {
  const lookupName = name.trim();
  if (!lookupName) {
    return null;
  }

  const page = await logseq.Editor.getPage(lookupName);
  if (!page) {
    return null;
  }

  return buildWhiteboardInfoWithFallback(page as GenericEntity, {
    id: lookupName,
    name: lookupName,
  });
}

function isBuiltInTitle(candidate: Pick<CandidatePage, "title" | "name">): boolean {
  return Boolean(candidate.name?.startsWith("$$$")) || candidate.title.startsWith("logseq/");
}

function normalizePageContext(value: PulledPageContext | undefined) {
  return normalizeNativePageContext(value);
}

function normalizeCandidate(row: unknown): CandidatePage | null {
  return normalizeCandidateWithStats(row);
}

function normalizeCandidateWithStats(
  row: unknown,
  stats?: CandidateNormalizationStats,
): CandidatePage | null {
  const pulled = (Array.isArray(row) ? row[0] : row) as PulledEntity | undefined;
  if (!pulled) {
    if (stats) {
      stats.totalRows += 1;
      stats.invalidRows += 1;
    }
    return null;
  }

  return normalizeNativeCandidate(pulled, normalizePageContext(pulled["block/page"]), stats);
}

function getHostScope(): NativeScope | null {
  try {
    const hostScope = logseq.Experiments.ensureHostScope();
    return hostScope && typeof hostScope === "object" ? (hostScope as NativeScope) : null;
  } catch (_error) {
    return null;
  }
}

function getNativeScopes(): NativeScope[] {
  const scopes = [
    getHostScope(),
    window.top as unknown,
    window as unknown,
  ].flatMap((scope) => {
    if (!scope || typeof scope !== "object") {
      return [];
    }

    const record = scope as NativeScope;
    const appRoot = record.$APP;
    return appRoot && typeof appRoot === "object" ? [record, appRoot as NativeScope] : [record];
  });

  return scopes.filter((scope, index) => scopes.indexOf(scope) === index);
}

function getNativeValue<T>(key: string): T | undefined {
  for (const scope of getNativeScopes()) {
    if (key in scope) {
      return scope[key] as T;
    }
  }

  return undefined;
}

function getNativeFunction(key: string): ((...args: unknown[]) => unknown) | null {
  const nativeValue = getNativeValue<unknown>(key);
  return typeof nativeValue === "function" ? (nativeValue as (...args: unknown[]) => unknown) : null;
}

function getHostDatascriptQuery():
  | ((query: string, ...inputs: unknown[]) => unknown)
  | null {
  const hostScope = getHostScope();
  const hostLogseq = hostScope?.logseq;
  if (!hostLogseq || typeof hostLogseq !== "object" || !("api" in hostLogseq)) {
    return null;
  }

  const hostApi = hostLogseq.api;
  if (!hostApi || typeof hostApi !== "object" || !("datascript_query" in hostApi)) {
    return null;
  }

  return typeof hostApi.datascript_query === "function"
    ? (hostApi.datascript_query as (query: string, ...inputs: unknown[]) => unknown)
    : null;
}

async function runDatascriptQuery<T>(query: string, ...inputs: unknown[]): Promise<T> {
  try {
    const normalizedInputs = inputs.map((value) => normalizeDatascriptInput(value));
    const hostDatascriptQuery = getHostDatascriptQuery();
    if (hostDatascriptQuery) {
      const hostResult = await resolveNativeData<T>(hostDatascriptQuery(query, ...normalizedInputs));
      if (hostResult != null) {
        return hostResult;
      }
    }

    return logseq.DB.datascriptQuery<T>(query, ...normalizedInputs, undefined);
  } catch (error) {
    throw error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

async function resolveNativeData<T>(value: unknown): Promise<T | null> {
  if (value == null) {
    return null;
  }

  const awaited =
    typeof (value as PromiseLike<unknown>)?.then === "function"
      ? await (value as PromiseLike<unknown>)
      : value;

  if (awaited == null) {
    return null;
  }

  if (typeof awaited === "object") {
    try {
      const hostScope = getHostScope();
      const hostToJs = hostScope?.logseq &&
        typeof hostScope.logseq === "object" &&
        "sdk" in hostScope.logseq &&
        hostScope.logseq.sdk &&
        typeof hostScope.logseq.sdk === "object" &&
        "utils" in hostScope.logseq.sdk &&
        hostScope.logseq.sdk.utils &&
        typeof hostScope.logseq.sdk.utils === "object" &&
        "toJs" in hostScope.logseq.sdk.utils &&
        typeof hostScope.logseq.sdk.utils.toJs === "function"
          ? (hostScope.logseq.sdk.utils.toJs as (input: unknown) => unknown)
          : null;

      if (hostToJs) {
        return hostToJs(awaited) as T;
      }

      const pluginWithUtils = logseq as typeof logseq & {
        Utils?: {
          toJs: <R = unknown>(obj: {}) => Promise<R>;
        };
      };

      if (pluginWithUtils.Utils?.toJs) {
        return await pluginWithUtils.Utils.toJs(awaited as {});
      }

      return awaited as T;
    } catch (_error) {
      return awaited as T;
    }
  }

  return awaited as T;
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();

  return values.filter((value) => {
    const normalized = value.trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function matchesSearchTerms(value: string | undefined, searchTerms: string[]): boolean {
  if (!value) {
    return false;
  }

  return searchTerms.some((term) => includesIgnoreCase(value, term));
}

function getAliasTerms(entity: GenericEntity): string[] {
  const properties = getProperties(entity);
  if (!properties) {
    return [];
  }

  const aliases = properties.alias ?? properties.aliases;
  if (typeof aliases === "string") {
    return aliases
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (Array.isArray(aliases)) {
    return aliases.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  }

  return [];
}

function getSearchTermsFromEntity(entity: GenericEntity, fallback: string): string[] {
  return uniqueTerms([
    fallback,
    getStringField(entity, ["originalName", "title", "name", "block/title", "block/name"]) ?? "",
    ...getAliasTerms(entity),
  ]);
}

function normalizeNativePageContext(value: unknown): CandidatePage["page"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as GenericEntity;
  const id = getNumberField(record, ["db/id", "id"]);
  const uuid = getStringField(record, ["block/uuid", "uuid"]);
  const title = getStringField(record, ["block/original-name", "originalName", "block/title", "title", "name"]);
  if (typeof id !== "number" || !uuid || !title) {
    return undefined;
  }

  return {
    id,
    uuid,
    title,
    name: getStringField(record, ["block/name", "name"]),
  };
}

function normalizeNativeCandidate(
  value: unknown,
  fallbackPage?: CandidatePage["page"],
  stats?: CandidateNormalizationStats,
): CandidatePage | null {
  if (stats) {
    stats.totalRows += 1;
  }

  if (!value || typeof value !== "object") {
    if (stats) {
      stats.invalidRows += 1;
    }
    return null;
  }

  const record = value as GenericEntity;
  const id = getNumberField(record, ["db/id", "id"]);
  const uuid = getStringField(record, ["block/uuid", "uuid"]);
  const rawTitle = getStringField(record, ["block/title", "title"]);
  const content = getStringField(record, ["block/content", "content"]);
  const name = getStringField(record, ["block/name", "name"]);
  const originalName = getStringField(record, ["block/original-name", "originalName"]);
  const title = rawTitle ?? content ?? originalName ?? name;
  if (typeof id !== "number") {
    if (stats) {
      stats.missingId += 1;
    }
    return null;
  }

  if (!uuid) {
    if (stats) {
      stats.missingUuid += 1;
    }
    return null;
  }

  if (!title) {
    if (stats) {
      stats.missingTitle += 1;
    }
    return null;
  }

  const refsValue = record["block/refs"] ?? record.refs;
  const refs = Array.isArray(refsValue) ? refsValue : [];
  const page =
    normalizeNativePageContext(record["block/page"] ?? record.page) ??
    fallbackPage;

  if (stats) {
    stats.normalized += 1;
  }

  return {
    id,
    uuid,
    type: name ? "page" : "block",
    title,
    originalName,
    rawTitle,
    content,
    name,
    page,
    refIds: refs
      .map((ref) => {
        if (!ref || typeof ref !== "object") {
          return undefined;
        }

        return getNumberField(ref as GenericEntity, ["db/id", "id"]);
      })
      .filter((refId): refId is number => typeof refId === "number"),
    link: Boolean(record["block/link"] ?? record.link),
    builtIn: record["logseq.property/built-in?"] === true || record.builtIn === true,
    blockType: getStringField(record, ["block/type", "type"]),
  };
}

async function queryNativePageCandidates(
  pageName: string,
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[] | null> {
  try {
    const nativeFn = getNativeFunction("$frontend$db$model$get_page_unlinked_references$$");
    if (!nativeFn) {
      return null;
    }

    const result = await resolveNativeData<unknown[]>(nativeFn(pageName));
    if (!Array.isArray(result)) {
      return null;
    }

    const candidates: CandidatePage[] = [];

    for (const group of result) {
      if (!Array.isArray(group) || group.length < 2) {
        continue;
      }

      const page = normalizeNativePageContext(group[0]);
      const blocks = Array.isArray(group[1]) ? group[1] : [];
      for (const block of blocks) {
        const candidate = normalizeNativeCandidate(block, page, normalizationStats);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  } catch (_error) {
    return null;
  }
}

function getCurrentRepoFromNative(): string | null {
  const getRepo = getNativeFunction("$frontend$state$get_current_repo$$");
  if (!getRepo) {
    return null;
  }

  const repo = getRepo();
  return typeof repo === "string" && repo.trim() ? repo : null;
}

function buildNativeLimitOptions(limit: number): unknown {
  const appRoot = getNativeValue<NativeScope>("$APP");
  const mapConstructor = appRoot?.["$cljs$core$PersistentArrayMap$$"];
  const limitKeyword = appRoot?.["$cljs$cst$keyword$limit$$"];

  if (typeof mapConstructor !== "function" || limitKeyword == null) {
    return undefined;
  }

  return new (mapConstructor as new (...args: unknown[]) => unknown)(null, 1, [limitKeyword, limit], null);
}

async function queryPagesByOriginalNames(
  originalNames: string[],
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const uniqueNames = uniqueTerms(originalNames);
  if (uniqueNames.length === 0) {
    return [];
  }

  const nameSet = new Set(uniqueNames);
  const rows = await runDatascriptQuery<unknown[]>(
    `[:find (pull ?b
              [:db/id
               :block/uuid
               :block/title
               :block/content
               :block/name
               :block/original-name
               :block/link
               :block/type
               :logseq.property/built-in?
               {:block/refs [:db/id]}
               {:block/page [:db/id :block/uuid :block/name :block/title :block/original-name]}])
      :in $ ?matches
      :where
      [?b :block/original-name ?name]
      [(?matches ?name)]]`,
    (value: unknown) => typeof value === "string" && nameSet.has(value),
  );

  return rows
    .map((row) => normalizeCandidateWithStats(row, normalizationStats))
    .filter((candidate): candidate is CandidatePage => candidate !== null);
}

async function loadFallbackBlockSearchIndex(whiteboard: WhiteboardInfo): Promise<FallbackBlockSearchItem[]> {
  const graphKey = await getGraphCacheKey();
  if (fallbackBlockSearchCacheGraph === graphKey && fallbackBlockSearchCache.length > 0) {
    return fallbackBlockSearchCache;
  }

  const rows =
    (await runDatascriptQuery<Array<[string, string, string | null]>>(
      `[:find ?uuid ?content ?page-name
        :where
        [?b :block/uuid ?uuid]
        [?b :block/content ?content]
        [?b :block/page ?p]
        [?p :block/original-name ?page-name]]`,
    )) ?? [];

  fallbackBlockSearchCache = rows
    .map(([blockUuid, content, pageName]) => ({
      blockUuid,
      pageName,
      content: trimPreview(
        String(content ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.includes(":: "))
          .join(" "),
        280,
      ),
    }))
    .filter((item) => item.content.length > 0)
    .filter((item) => item.pageName !== whiteboard.name);

  fallbackBlockSearchCacheGraph = graphKey;
  return fallbackBlockSearchCache;
}

async function hasWarmFallbackBlockSearchIndex(): Promise<boolean> {
  const graphKey = await getGraphCacheKey();
  return fallbackBlockSearchCacheGraph === graphKey && fallbackBlockSearchCache.length > 0;
}

async function queryCandidatesByUuids(
  uuids: string[],
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const uniqueUuids = uniqueTerms(uuids);
  if (uniqueUuids.length === 0) {
    return [];
  }

  const uuidSet = new Set(uniqueUuids);
  const rows = await runDatascriptQuery<unknown[]>(
    `[:find (pull ?b
              [:db/id
               :block/uuid
               :block/title
               :block/content
               :block/name
               :block/original-name
               :block/link
               :block/type
               :logseq.property/built-in?
               {:block/refs [:db/id]}
               {:block/page [:db/id :block/uuid :block/name :block/title :block/original-name]}])
      :in $ ?matches
      :where
      [?b :block/uuid ?uuid]
      [(?matches ?uuid)]]`,
    (value: unknown) => typeof value === "string" && uuidSet.has(value),
  );

  return rows
    .map((row) => normalizeCandidateWithStats(row, normalizationStats))
    .filter((candidate): candidate is CandidatePage => candidate !== null);
}

function dedupeCandidates(candidates: CandidatePage[]): CandidatePage[] {
  const seen = new Set<string>();
  const deduped: CandidatePage[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.uuid)) {
      continue;
    }

    seen.add(candidate.uuid);
    deduped.push(candidate);
  }

  return deduped;
}

async function queryNativeKeywordCandidatesForTerms(
  searchTerms: string[],
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const merged: CandidatePage[] = [];

  for (const term of uniqueTerms(searchTerms)) {
    const candidates = await queryNativeKeywordCandidates(term, normalizationStats);
    if (candidates) {
      merged.push(...candidates);
    }
  }

  return dedupeCandidates(merged);
}

async function queryNativeKeywordCandidates(
  keyword: string,
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[] | null> {
  const repo = getCurrentRepoFromNative();
  const blockSearch = getNativeFunction("$frontend$search$block_search$$");
  const pageSearch = getNativeFunction("$frontend$search$page_search$cljs$0core$0IFn$0_invoke$0arity$02$$");
  if (!repo || (!blockSearch && !pageSearch)) {
    return null;
  }

  try {
    const limitOptions = buildNativeLimitOptions(500);
    const [pageNames, blockResults] = await Promise.all([
      pageSearch ? resolveNativeData<unknown[]>(pageSearch(keyword)) : Promise.resolve(null),
      blockSearch ? resolveNativeData<unknown[]>(blockSearch(repo, keyword, limitOptions)) : Promise.resolve(null),
    ]);

    const normalizedPageNames = Array.isArray(pageNames)
      ? pageNames.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];

    const blockUuids = Array.isArray(blockResults)
      ? blockResults
          .map((value) => {
            if (!value || typeof value !== "object") {
              return undefined;
            }

            return (value as NativeSearchBlockResult)["block/uuid"];
          })
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];

    const [pageCandidates, blockCandidates] = await Promise.all([
      queryPagesByOriginalNames(normalizedPageNames, normalizationStats),
      queryCandidatesByUuids(blockUuids, normalizationStats),
    ]);

    return dedupeCandidates([...pageCandidates, ...blockCandidates]);
  } catch (_error) {
    return null;
  }
}

async function queryFallbackKeywordCandidates(
  whiteboard: WhiteboardInfo,
  keyword: string,
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const normalizedQuery = normalizeSearchText(keyword);
  if (!normalizedQuery) {
    return [];
  }

  const index = await loadFallbackBlockSearchIndex(whiteboard);
  const blockUuids = index
    .map((item) => {
      const haystack = `${item.pageName ?? ""} ${item.content}`;
      const score = scoreSearchCandidate(haystack, normalizedQuery);
      if (score <= 0) {
        return null;
      }

      return { blockUuid: item.blockUuid, score };
    })
    .filter((item): item is { blockUuid: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 500)
    .map((item) => item.blockUuid);

  return queryCandidatesByUuids(blockUuids, normalizationStats);
}

async function queryFallbackPageCandidates(
  whiteboard: WhiteboardInfo,
  sourcePage: GenericEntity,
  sourceTitle: string,
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const searchTerms = getSearchTermsFromEntity(sourcePage, sourceTitle).map(normalizeSearchText).filter(Boolean);
  if (searchTerms.length === 0) {
    return [];
  }

  const index = await loadFallbackBlockSearchIndex(whiteboard);
  const blockUuids = index
    .map((item) => {
      const haystack = `${item.pageName ?? ""} ${item.content}`;
      const bestScore = searchTerms.reduce((maxScore, term) => {
        const nextScore = scoreSearchCandidate(haystack, term);
        return nextScore > maxScore ? nextScore : maxScore;
      }, 0);

      if (bestScore <= 0) {
        return null;
      }

      return { blockUuid: item.blockUuid, score: bestScore };
    })
    .filter((item): item is { blockUuid: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 500)
    .map((item) => item.blockUuid);

  return queryCandidatesByUuids(blockUuids, normalizationStats);
}

async function queryCandidateIds(searchTerms: string[]): Promise<number[]> {
  const normalizedTerms = uniqueTerms(searchTerms.map(normalizeSearchText));
  if (normalizedTerms.length === 0) {
    return [];
  }

  const matchesValue = (value: unknown): boolean => {
    if (typeof value !== "string") {
      return false;
    }

    return normalizedTerms.some((term) => includesIgnoreCase(value, term));
  };

  const [contentIds, titleIds] = await Promise.all([
    runDatascriptQuery<number[]>(
      `[:find [?b ...]
        :in $ ?matches
        :where
        [?b :block/content ?content]
        [(?matches ?content)]]`,
      matchesValue,
    ),
    runDatascriptQuery<number[]>(
      `[:find [?b ...]
        :in $ ?matches
        :where
        [?b :block/title ?title]
        [(?matches ?title)]]`,
      matchesValue,
    ),
  ]);

  return Array.from(
    new Set(
      [...(contentIds ?? []), ...(titleIds ?? [])].filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      ),
    ),
  );
}

async function queryCandidatesBySearchTerms(
  searchTerms: string[],
  diagnostics?: string[],
  normalizationStats?: CandidateNormalizationStats,
): Promise<CandidatePage[]> {
  const normalizedTerms = uniqueTerms(searchTerms.map(normalizeSearchText));
  if (normalizedTerms.length === 0) {
    return [];
  }

  const matchesValue = (value: unknown): boolean => {
    if (typeof value !== "string") {
      return false;
    }

    return normalizedTerms.some((term) => includesIgnoreCase(value, term));
  };

  const pullPattern = `[:db/id
                       :block/uuid
                       :block/title
                       :block/content
                       :block/name
                       :block/original-name
                       :block/link
                       :block/type
                       :logseq.property/built-in?
                       {:block/refs [:db/id]}
                       {:block/page [:db/id :block/uuid :block/name :block/title :block/original-name]}]`;

  const [contentRows, titleRows] = await Promise.all([
    runDatascriptQuery<unknown[]>(
      `[:find (pull ?b ${pullPattern})
        :in $ ?matches
        :where
        [?b :block/content ?content]
        [(?matches ?content)]]`,
      matchesValue,
    ),
    runDatascriptQuery<unknown[]>(
      `[:find (pull ?b ${pullPattern})
        :in $ ?matches
        :where
        [?b :block/title ?title]
        [(?matches ?title)]]`,
      matchesValue,
    ),
  ]);

  const mergedRows = [...(contentRows ?? []), ...(titleRows ?? [])];
  diagnostics?.push(`datascript pull rows: content=${contentRows?.length ?? 0} title=${titleRows?.length ?? 0} merged=${mergedRows.length}`);
  if (mergedRows.length > 0) {
    diagnostics?.push(`datascript sample row shape: ${describeRowShape(mergedRows[0])}`);
  }

  const normalizedCandidates = mergedRows
    .map((row) => normalizeCandidateWithStats(row, normalizationStats))
    .filter((candidate): candidate is CandidatePage => candidate !== null);

  diagnostics?.push(`datascript normalized candidates before dedupe: ${normalizedCandidates.length}`);
  if (normalizedCandidates.length > 0) {
    const sample = normalizedCandidates[0];
    diagnostics?.push(
      `datascript normalized sample: type=${sample.type} uuid=${sample.uuid ? "yes" : "no"} title=${sample.title ? "yes" : "no"}`,
    );
  }

  return dedupeCandidates(normalizedCandidates);
}

async function queryCandidatesByIds(ids: number[]): Promise<CandidatePage[]> {
  if (ids.length === 0) {
    return [];
  }

  const idSet = new Set(ids.filter((value) => Number.isFinite(value)));
  const rows = await runDatascriptQuery<unknown[]>(
    `[:find (pull ?b
              [:db/id
               :block/uuid
               :block/title
               :block/content
               :block/name
               :block/original-name
               :block/link
               :block/type
               :logseq.property/built-in?
               {:block/refs [:db/id]}
               {:block/page [:db/id :block/uuid :block/name :block/title :block/original-name]}])
      :in $ ?matches
      :where
      [?b :block/uuid _]
      [(?matches ?b)]]`,
    (value: unknown) => typeof value === "number" && idSet.has(value),
  );

  return rows
    .map((row) => normalizeCandidate(row))
    .filter((candidate): candidate is CandidatePage => candidate !== null);
}

function getItemLabel(candidate: CandidatePage): string {
  const compactText = candidate.title.replace(/\s+/g, " ").trim();
  if (compactText) {
    if (candidate.type === "block" && compactText.length > 180) {
      return `${compactText.slice(0, 177)}...`;
    }

    return compactText;
  }

  return candidate.type === "page" ? "Untitled page" : "Untitled block";
}

function getItemPageName(candidate: CandidatePage): string | undefined {
  if (candidate.type === "page") {
    return candidate.name;
  }

  return candidate.page?.name;
}

function getItemPageTitle(candidate: CandidatePage): string | undefined {
  if (candidate.type === "page") {
    return candidate.title;
  }

  return candidate.page?.title;
}

function compareCandidates(left: CandidatePage, right: CandidatePage): number {
  const pageTitleCompare = (getItemPageTitle(left) ?? left.title).localeCompare(
    getItemPageTitle(right) ?? right.title,
    undefined,
    { sensitivity: "base" },
  );
  if (pageTitleCompare !== 0) {
    return pageTitleCompare;
  }

  const typeCompare = Number(left.type === "block") - Number(right.type === "block");
  if (typeCompare !== 0) {
    return typeCompare;
  }

  return getItemLabel(left).localeCompare(getItemLabel(right), undefined, { sensitivity: "base" });
}

function getReferenceState(candidate: CandidatePage, searchTerms: string[], sourcePageId?: number): ReferenceState {
  if (typeof sourcePageId === "number") {
    if (candidate.id === sourcePageId || candidate.refIds.includes(sourcePageId)) {
      return "linked";
    }
  }

  const haystacks = [
    candidate.content,
    candidate.rawTitle,
    candidate.title,
    candidate.page?.title,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));

  const hasLinkedTerm = searchTerms.some((term) =>
    haystacks.some((value) => hasLinkedReference(value, normalizeSearchText(term))),
  );

  if (hasLinkedTerm || candidate.link) {
    return "linked";
  }

  return "unlinked";
}

async function buildSnapshot(params: {
  whiteboard: WhiteboardInfo;
  sourceType: SnapshotSourceType;
  sourceValue: string;
  keyword: string;
  searchTerms: string[];
  sourcePageId?: number;
  prefetchedCandidates?: CandidatePage[] | null;
  allowQueryFallback?: boolean;
  diagnostics?: string[];
  normalizationStats?: CandidateNormalizationStats;
}): Promise<Snapshot> {
  const keyword = params.keyword.trim();
  if (!keyword) {
    throw new Error("Source keyword is empty.");
  }

  const diagnostics = [...(params.diagnostics ?? [])];
  const searchTerms = uniqueTerms(params.searchTerms.length > 0 ? params.searchTerms : [keyword]);
  let candidates = params.prefetchedCandidates ?? [];
  diagnostics.push(`prefetched candidates: ${candidates.length}`);

  if (candidates.length === 0 && params.allowQueryFallback !== false) {
    const candidateIds = await queryCandidateIds(searchTerms);
    diagnostics.push(`datascript fallback ids: ${candidateIds.length}`);
    candidates = await queryCandidatesBySearchTerms(searchTerms, diagnostics, params.normalizationStats);
    diagnostics.push(`datascript fallback candidates: ${candidates.length}`);
  }

  if (params.normalizationStats) {
    appendCandidateNormalizationDiagnostics(diagnostics, params.normalizationStats);
  }

  diagnostics.push(`candidates before filtering: ${candidates.length}`);

  const withoutBuiltIn = candidates.filter((candidate) => !candidate.builtIn && !isBuiltInTitle(candidate));
  diagnostics.push(`after built-in filter: ${withoutBuiltIn.length}`);

  const textMatched = withoutBuiltIn.filter((candidate) =>
    matchesSearchTerms(candidate.content ?? candidate.rawTitle ?? candidate.title, searchTerms),
  );
  diagnostics.push(`after text-match filter: ${textMatched.length}`);

  const withoutWhiteboards = textMatched.filter((candidate) => candidate.blockType !== "whiteboard");
  diagnostics.push(`after whiteboard-type filter: ${withoutWhiteboards.length}`);

  const withoutCurrentWhiteboard = withoutWhiteboards.filter((candidate) => candidate.uuid !== params.whiteboard.id);
  diagnostics.push(`after current-whiteboard filter: ${withoutCurrentWhiteboard.length}`);

  const filtered = withoutCurrentWhiteboard
    .filter((candidate) => {
      if (typeof params.sourcePageId !== "number") {
        return true;
      }

      if (candidate.id === params.sourcePageId) {
        return false;
      }

      if (candidate.page?.id === params.sourcePageId) {
        return false;
      }

      return true;
    })
    .sort(compareCandidates);
  diagnostics.push(`after source-page filter: ${filtered.length}`);

  return {
    id: crypto.randomUUID(),
    whiteboardId: params.whiteboard.id,
    whiteboardName: params.whiteboard.name,
    sourceType: params.sourceType,
    sourceValue: params.sourceValue,
    keyword,
    createdAt: Date.now(),
    items: filtered.map((candidate, index) => {
      const itemType: SnapshotItemType = candidate.type;
      const pageName = getItemPageName(candidate);

      return {
        id: candidate.uuid,
        type: itemType,
        label: getItemLabel(candidate),
        referenceState: getReferenceState(candidate, searchTerms, params.sourcePageId),
        pageName,
        pageTitle: getItemPageTitle(candidate),
        blockUuid: itemType === "block" ? candidate.uuid : undefined,
        blockEntityId: itemType === "block" ? candidate.id : undefined,
        matchedTitle: candidate.rawTitle ?? candidate.title,
        order: index,
        status: "unseen",
      };
    }),
    diagnostics: {
      lines: diagnostics,
    },
  };
}

export async function getCurrentWhiteboard(): Promise<WhiteboardInfo | null> {
  const routeWhiteboardName = extractWhiteboardNameFromRoutePath(getCurrentLocationPath());
  if (routeWhiteboardName) {
    const whiteboardFromRoute = await resolveWhiteboardByName(routeWhiteboardName);
    if (whiteboardFromRoute) {
      return whiteboardFromRoute;
    }
  }

  const currentPage = await logseq.Editor.getCurrentPage();
  if (!currentPage) {
    return null;
  }

  if (isWhiteboardEntity(currentPage)) {
    return buildWhiteboardInfo(currentPage);
  }

  const currentRecord = currentPage as GenericEntity;
  const pageRef = getPageLookupRef(currentRecord.page);
  if (pageRef != null) {
    const pageFromBlock = await logseq.Editor.getPage(pageRef);
    if (isWhiteboardEntity(pageFromBlock)) {
      return buildWhiteboardInfo(pageFromBlock);
    }
  }

  const currentUuid = getStringField(currentRecord, ["uuid", "block/uuid"]);
  if (currentUuid) {
    const pageByUuid = await logseq.Editor.getPage({ uuid: currentUuid });
    if (isWhiteboardEntity(pageByUuid)) {
      return buildWhiteboardInfo(pageByUuid);
    }
  }

  const lookupNames = Array.from(
    new Set(
      ["originalName", "title", "name", "block/title", "block/name"]
        .map((key) => getStringField(currentRecord, [key]))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  for (const name of lookupNames) {
    const page = await logseq.Editor.getPage(name);
    if (isWhiteboardEntity(page)) {
      return buildWhiteboardInfo(page);
    }
  }

  if (isWhiteboardDomVisible()) {
    return buildWhiteboardInfoWithFallback(currentRecord, {
      id: currentUuid ?? routeWhiteboardName ?? "active-whiteboard",
      name:
        getStringField(currentRecord, ["originalName", "title", "name", "block/title", "block/name"]) ??
        routeWhiteboardName ??
        "Active whiteboard",
    });
  }

  return null;
}

export async function createSnapshotFromKeyword(
  whiteboard: WhiteboardInfo,
  keyword: string,
): Promise<Snapshot> {
  const trimmedKeyword = keyword.trim();
  const diagnostics = [`mode: keyword`, `source: ${trimmedKeyword}`];
  const normalizationStats = createCandidateNormalizationStats();
  const nativeCandidates = await queryNativeKeywordCandidates(trimmedKeyword, normalizationStats);
  diagnostics.push(
    `native keyword candidates: ${nativeCandidates ? nativeCandidates.length : "unavailable"}`,
  );
  const candidates =
    nativeCandidates && nativeCandidates.length > 0
      ? nativeCandidates
      : await withDeferredTimeoutMessage(
          "Keyword search timed out while loading the local fallback index.",
          () => queryFallbackKeywordCandidates(whiteboard, trimmedKeyword, normalizationStats),
        );
  if (!nativeCandidates || nativeCandidates.length === 0) {
    diagnostics.push(`local keyword fallback candidates: ${candidates.length}`);
  }

  return withDeferredTimeoutMessage(
    "Keyword search timed out while building the snapshot.",
    () =>
      buildSnapshot({
        whiteboard,
        sourceType: "keyword",
        sourceValue: trimmedKeyword,
        keyword,
        searchTerms: [trimmedKeyword],
        prefetchedCandidates: candidates,
        allowQueryFallback: candidates.length === 0,
        diagnostics,
        normalizationStats,
      }),
  );
}

export async function createSnapshotFromPage(
  whiteboard: WhiteboardInfo,
  pageName: string,
): Promise<Snapshot> {
  const diagnostics = [`mode: page`, `source: ${pageName.trim()}`];
  const normalizationStats = createCandidateNormalizationStats();
  const sourcePage = await withDeferredTimeoutMessage(
    "Page search timed out while loading the source page.",
    () => logseq.Editor.getPage(pageName.trim()),
  );
  if (!sourcePage) {
    throw new Error(`Page not found: ${pageName}`);
  }

  const sourceId = Number((sourcePage as { id?: number }).id);
  const sourceTitle =
    ((sourcePage as { originalName?: string }).originalName ??
      (sourcePage as { title?: string }).title ??
      (sourcePage as { name?: string }).name ??
      pageName).trim();

  if (!sourceTitle) {
    throw new Error("The source page has no title.");
  }

  const searchTerms = getSearchTermsFromEntity(sourcePage as GenericEntity, sourceTitle);
  diagnostics.push(`search terms: ${searchTerms.join(" | ")}`);
  const nativePageCandidates = await queryNativePageCandidates(
    ((sourcePage as { name?: string }).name ?? pageName).trim(),
    normalizationStats,
  );
  diagnostics.push(`native page candidates: ${nativePageCandidates ? nativePageCandidates.length : "unavailable"}`);

  const nativeKeywordCandidates = await queryNativeKeywordCandidatesForTerms(searchTerms, normalizationStats);
  diagnostics.push(`native keyword companion candidates: ${nativeKeywordCandidates.length}`);

  let prefetchedCandidates = dedupeCandidates([...(nativePageCandidates ?? []), ...nativeKeywordCandidates]);
  diagnostics.push(`combined prefetched candidates: ${prefetchedCandidates.length}`);

  const warmFallbackIndex = await hasWarmFallbackBlockSearchIndex();
  diagnostics.push(`warm local fallback index: ${warmFallbackIndex ? "yes" : "no"}`);

  if (prefetchedCandidates.length === 0 && warmFallbackIndex) {
    prefetchedCandidates = await withDeferredTimeoutMessage(
      "Page search timed out while loading the local fallback index.",
      () => queryFallbackPageCandidates(whiteboard, sourcePage as GenericEntity, sourceTitle, normalizationStats),
    );
    diagnostics.push(`local page fallback candidates: ${prefetchedCandidates.length}`);
  }

  return withDeferredTimeoutMessage(
    "Page search timed out while building the snapshot.",
    () =>
      buildSnapshot({
        whiteboard,
        sourceType: "page",
        sourceValue: pageName.trim(),
        keyword: sourceTitle,
        searchTerms,
        sourcePageId: Number.isFinite(sourceId) ? sourceId : undefined,
        prefetchedCandidates,
        allowQueryFallback: prefetchedCandidates.length === 0,
        diagnostics,
        normalizationStats,
      }),
  );
}

export async function createSnapshotFromInput(
  whiteboard: WhiteboardInfo,
  input: string,
): Promise<Snapshot> {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    throw new Error("Enter a page name or keyword.");
  }

  const sourcePage = await logseq.Editor.getPage(trimmedInput);
  if (sourcePage) {
    return createSnapshotFromPage(whiteboard, trimmedInput);
  }

  return createSnapshotFromKeyword(whiteboard, trimmedInput);
}
