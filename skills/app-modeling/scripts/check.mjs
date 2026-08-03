#!/usr/bin/env node
// Prefer false negatives: DENY only proven defects, never merely suspicious models.
/**
 * Validate compiled Radius models against the skill contract.
 *
 * Rules read compiled ARM and the current Azure Recipe-pack contract. They
 * report deploy or runtime defects and ARM-checkable policy violations.
 * Decisions that need source, image, profile, or intent stay in authoring.md.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";

const HEX = new Set("0123456789abcdef");
export const DENY = "DENY";
export const ALLOW = "ALLOW";

export const APP_KIND = "Radius.Core/applications";
export const CONTAINER_KIND = "Radius.Compute/containers";
export const IMAGE_KIND = "Radius.Compute/containerImages";
export const SECRET_KIND = "Radius.Security/secrets";
export const RECIPE_PACK_KIND = "Radius.Core/recipePacks";

export const RESOURCE_TYPES_CONTRIB_COMMIT =
  "323e3fac5622fa3dad4f4c83b105b00f177496d9";
export const AZURE_RECIPE_PACK_URL =
  "https://raw.githubusercontent.com/radius-project/" +
  `resource-types-contrib/${RESOURCE_TYPES_CONTRIB_COMMIT}/` +
  "recipe-packs/azure/aks-recipepack.bicep";
export const RECIPE_FETCH_TIMEOUT = 30_000;
export const RECIPE_COMPILE_TIMEOUT = 120_000;
export const MAX_RECIPE_PACK_BYTES = 2 * 1024 * 1024;

const WORKLOAD_KINDS = new Set([
  APP_KIND,
  CONTAINER_KIND,
  "Radius.Compute/routes",
]);
const CONNECTION_BACKING_PREFIXES = [
  "Radius.Data/",
  "Radius.Messaging/",
  "Radius.AI/",
  "Radius.Storage/",
];
const CONNECTION_BACKING_KINDS = new Set([
  "Radius.Compute/persistentVolumes",
]);
const SECURE_TYPES = new Set(["securestring", "secureobject"]);

const AZURE_RECIPE_CONSTRAINTS = {
  "avm/res/db-for-my-sql/flexible-server": {
    reserved: {
      username: [
        "azure_superuser",
        "admin",
        "administrator",
        "root",
        "guest",
        "public",
      ],
    },
  },
  "avm/res/db-for-postgre-sql/flexible-server": {
    reserved: {
      username: [
        "azure_superuser",
        "azure_pg_admin",
        "azuresu",
        "postgres",
        "admin",
        "administrator",
        "root",
        "guest",
        "public",
      ],
    },
    reservedPrefixes: { username: ["pg_"] },
  },
  "avm/res/sql/server": {
    reserved: {
      username: [
        "sa",
        "admin",
        "administrator",
        "root",
        "guest",
        "public",
        "dbmanager",
        "loginmanager",
        "dbo",
      ],
    },
  },
};

export const AZURE_GLOBAL_NAME_SOURCES = new Set([
  "avm/res/cache/redis-enterprise",
  "avm/res/cognitive-services/account",
  "avm/res/db-for-my-sql/flexible-server",
  "avm/res/db-for-postgre-sql/flexible-server",
  "avm/res/document-db/database-account",
  "avm/res/event-hub/namespace",
  "avm/res/search/search-service",
  "avm/res/service-bus/namespace",
  "avm/res/sql/server",
  "avm/res/storage/storage-account",
]);

const AZURE_CONNECTION_SECRET_REQUIREMENTS = {
  "avm/res/cache/redis-enterprise": "url",
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mapping(value) {
  return isObject(value) ? value : {};
}

function sortedEntries(value) {
  return Object.entries(mapping(value)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function sortedKeys(value) {
  return Object.keys(mapping(value)).sort();
}

function typeName(value) {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (isObject(value)) return "dict";
  return typeof value;
}

function repr(value) {
  if (typeof value === "string") {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (isObject(value)) {
    return `{${Object.entries(value)
      .map(([key, nested]) => `${repr(key)}: ${repr(nested)}`)
      .join(", ")}}`;
  }
  return String(value);
}

function stringValue(value) {
  return typeof value === "string" ? value : repr(value);
}

export function* calls(text, name) {
  const marker = `${name}('`;
  let index = 0;
  while (true) {
    index = text.indexOf(marker, index);
    if (index < 0) return;
    const start = index + marker.length;
    const end = text.indexOf("'", start);
    if (end < 0) return;
    yield [text.slice(start, end), end + 2];
    index = end;
  }
}

export function identifier(text, index) {
  let end = index;
  while (end < text.length && /[A-Za-z0-9_]/u.test(text[end])) end += 1;
  return [text.slice(index, end), end];
}

export function* propertyReads(text) {
  for (const [symbol, initialTail] of calls(text, "reference")) {
    let tail = initialTail;
    while (text.startsWith(".properties.", tail)) {
      const [name, nextTail] = identifier(
        text,
        tail + ".properties.".length,
      );
      if (!name) break;
      yield [symbol, name];
      tail = nextTail;
    }
  }
}

export function* strings(node, currentPath = "") {
  if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      yield* strings(value, `${currentPath}.${key}`);
    }
  } else if (Array.isArray(node)) {
    for (const [index, value] of node.entries()) {
      yield* strings(value, `${currentPath}[${index}]`);
    }
  } else if (typeof node === "string") {
    yield [currentPath, node];
  }
}

export function expand(text, variables, limit = null) {
  const marker = "variables('";
  const attempts = limit === null ? Object.keys(variables).length + 1 : limit;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!text.includes(marker)) break;
    const output = [];
    let position = 0;
    let substituted = false;
    while (true) {
      const start = text.indexOf(marker, position);
      if (start < 0) {
        output.push(text.slice(position));
        break;
      }
      const end = text.indexOf("')", start + marker.length);
      if (end < 0) {
        output.push(text.slice(position));
        break;
      }
      output.push(text.slice(position, start));
      const name = text.slice(start + marker.length, end);
      if (Object.hasOwn(variables, name)) {
        output.push(stringValue(variables[name]));
        substituted = true;
      } else {
        output.push(text.slice(start, end + 2));
      }
      position = end + 2;
    }
    text = output.join("");
    if (!substituted) break;
  }
  return text;
}

export function commitSha(ref) {
  return (
    typeof ref === "string" &&
    ref.length === 40 &&
    [...ref.toLowerCase()].every((character) => HEX.has(character))
  );
}

export function immutable(ref) {
  return commitSha(ref);
}

export function unwrapExpression(text) {
  if (typeof text !== "string") return "";
  while (text.startsWith("[") && text.endsWith("]") && text.length >= 2) {
    text = text.slice(1, -1);
  }
  return text;
}

export function expressionBody(text, variables) {
  if (typeof text !== "string") return "";
  return unwrapExpression(expand(unwrapExpression(text), variables));
}

export function resolve(text, variables) {
  if (typeof text !== "string") return null;
  if (!(text.startsWith("[") && text.endsWith("]"))) return text;
  const body = unwrapExpression(expand(text.slice(1, -1), variables));
  if (body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1);
  return body.includes("(") ? null : body;
}

const ENVELOPE = ".properties.properties";

export function normalized(resourcePath) {
  for (const prefix of [ENVELOPE, ".properties"]) {
    if (!resourcePath.startsWith(prefix)) continue;
    const rest = resourcePath.slice(prefix.length);
    if (rest === "" || ".[".includes(rest[0])) return rest;
  }
  return resourcePath;
}

export function propertiesOf(body) {
  if (!isObject(body)) return {};
  const outer = body.properties;
  if (!isObject(outer)) return {};
  return isObject(outer.properties) ? outer.properties : {};
}

export class RecipeContractError extends Error {
  constructor(source, reason) {
    super(reason);
    this.name = "RecipeContractError";
    this.source = source;
  }
}

export function recipeSourceKey(source) {
  if (typeof source !== "string") return "";
  if (source.startsWith("br:")) source = source.slice(3);
  source = source.split("@", 1)[0];
  const slash = source.lastIndexOf("/");
  const head = slash >= 0 ? source.slice(0, slash) : "";
  const separator = slash >= 0 ? "/" : "";
  let tail = slash >= 0 ? source.slice(slash + 1) : source;
  if (tail.includes(":")) {
    tail = tail.split(":", 1)[0];
    source = `${head}${separator}${tail}`;
  }
  const bicep = source.indexOf("/bicep/");
  if (bicep >= 0) return source.slice(bicep + "/bicep/".length);
  return source.startsWith("bicep/") ? source.slice("bicep/".length) : source;
}

export function constrainedContract(source, outputs) {
  const contract = { source, outputs };
  const constraints =
    AZURE_RECIPE_CONSTRAINTS[recipeSourceKey(source)] ?? {};
  for (const [field, values] of Object.entries(constraints)) {
    contract[field] = Object.fromEntries(
      Object.entries(values).map(([name, entries]) => [name, [...entries]]),
    );
  }
  return contract;
}

export function recipeContractFromPackArm(arm) {
  if (!isObject(arm)) {
    throw new Error("compiled Recipe-pack ARM is not an object");
  }
  const resources = arm.resources;
  let bodies;
  if (isObject(resources)) bodies = Object.values(resources);
  else if (Array.isArray(resources)) bodies = resources;
  else throw new Error("compiled Recipe-pack ARM has no resources collection");

  const packs = bodies.filter((body) => {
    if (!isObject(body) || typeof body.type !== "string") return false;
    return body.type.split("@", 1)[0] === RECIPE_PACK_KIND;
  });
  if (packs.length === 0) {
    throw new Error("compiled ARM has no Radius.Core/recipePacks resource");
  }

  const contracts = {};
  const recipeTypes = new Map();
  const normalizedTypes = new Map();
  for (const pack of packs) {
    const recipes = propertiesOf(pack).recipes;
    if (!isObject(recipes)) {
      throw new Error("Recipe-pack properties.recipes is not an object");
    }
    for (const [kind, recipe] of Object.entries(recipes)) {
      if (!kind) throw new Error("Recipe-pack contains an invalid Recipe type");
      if (!isObject(recipe)) {
        throw new Error(`${kind} Recipe definition is not an object`);
      }
      const normalizedKind = kind.toLowerCase();
      const priorKind = recipeTypes.get(normalizedKind);
      if (priorKind && priorKind !== kind) {
        throw new Error(
          `conflicting Recipe definitions for ${priorKind} and ${kind}: ` +
            "type names differ only by case",
        );
      }
      recipeTypes.set(normalizedKind, kind);
      const source = recipe.source;
      if (typeof source !== "string" || !source) {
        throw new Error(`${kind}.source is not a non-empty string`);
      }
      const outputs = recipe.outputs;
      if (
        outputs === null ||
        outputs === undefined ||
        (isObject(outputs) && Object.keys(outputs).length === 0)
      ) {
        continue;
      }
      if (!isObject(outputs)) {
        throw new Error(`${kind}.outputs is not an object`);
      }
      const contract = constrainedContract(source, outputs);
      const prior = normalizedTypes.get(normalizedKind);
      if (prior) {
        const [priorKind, priorContract] = prior;
        if (!isDeepStrictEqual(priorContract, contract)) {
          throw new Error(
            `conflicting Recipe definitions for ${priorKind} and ${kind}`,
          );
        }
        continue;
      }
      normalizedTypes.set(normalizedKind, [kind, contract]);
      contracts[kind] = contract;
    }
  }
  return {
    types: contracts,
    recipeTypes: [...recipeTypes.values()].sort(),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchRecipePack(
  url = AZURE_RECIPE_PACK_URL,
  timeout = RECIPE_FETCH_TIMEOUT,
  maxBytes = MAX_RECIPE_PACK_BYTES,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "radius-app-modeling-checker" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RecipeContractError(
        url,
        `the Azure Recipe Pack exceeds the ${maxBytes}-byte download limit`,
      );
    }

    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          throw new RecipeContractError(
            url,
            `the Azure Recipe Pack exceeds the ${maxBytes}-byte download limit`,
          );
        }
        chunks.push(bytes);
      }
    }

    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch (error) {
      throw new RecipeContractError(
        url,
        "the Azure Recipe Pack is not valid UTF-8",
      );
    }
    if (!source.trim()) {
      throw new RecipeContractError(
        url,
        "the Azure Recipe Pack download is empty",
      );
    }
    return source;
  } catch (error) {
    if (error instanceof RecipeContractError) throw error;
    throw new RecipeContractError(
      url,
      `the Azure Recipe Pack could not be downloaded: ${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findBicepConfig(cwd = process.cwd()) {
  for (const candidate of [
    path.join(cwd, ".radius", "bicepconfig.json"),
    path.join(cwd, "bicepconfig.json"),
  ]) {
    if (isFile(candidate)) return path.resolve(candidate);
  }
  throw new RecipeContractError(
    ".radius/bicepconfig.json",
    "no bicepconfig.json was found, so extension radius cannot be resolved",
  );
}

function executableOnPath(command) {
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function bicepBinary() {
  if (process.env.BICEP_BINARY) return process.env.BICEP_BINARY;
  const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
  return (
    executableOnPath("bicep") ??
    path.join(os.homedir(), ".rad", "bin", executable)
  );
}

export function compileRecipePack(source, configPath = null) {
  const config = configPath
    ? path.resolve(configPath)
    : findBicepConfig();
  if (!isFile(config)) {
    throw new RecipeContractError(
      config,
      "the Bicep configuration needed for Recipe compilation is missing",
    );
  }

  let temporary = null;
  let result;
  try {
    temporary = fs.mkdtempSync(
      path.join(path.dirname(config), ".recipe-contract-"),
    );
    const pack = path.join(temporary, "recipe-pack.bicep");
    fs.writeFileSync(pack, source, "utf8");
    result = spawnSync(bicepBinary(), ["build", pack, "--stdout"], {
      cwd: temporary,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: RECIPE_COMPILE_TIMEOUT,
    });
  } catch (error) {
    throw new RecipeContractError(
      AZURE_RECIPE_PACK_URL,
      `the Azure Recipe Pack could not be compiled: ${errorMessage(error)}`,
    );
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }

  if (result.error) {
    const timedOut =
      result.error.code === "ETIMEDOUT" || result.error.code === "SIGTERM";
    throw new RecipeContractError(
      AZURE_RECIPE_PACK_URL,
      timedOut
        ? "Bicep timed out while compiling the Azure Recipe Pack"
        : `the Azure Recipe Pack could not be compiled: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr || result.stdout || "").trim().slice(0, 1000) ||
      `bicep exited with status ${result.status}`;
    throw new RecipeContractError(
      AZURE_RECIPE_PACK_URL,
      `the Azure Recipe Pack did not compile: ${detail}`,
    );
  }
  try {
    return recipeContractFromPackArm(JSON.parse(result.stdout));
  } catch (error) {
    throw new RecipeContractError(
      AZURE_RECIPE_PACK_URL,
      `the compiled Azure Recipe Pack is unusable: ${errorMessage(error)}`,
    );
  }
}

export function containersOf(properties) {
  if (!isObject(properties) || !isObject(properties.containers)) return {};
  return Object.fromEntries(
    Object.entries(properties.containers).filter(([, body]) => isObject(body)),
  );
}

export function sourceLine(result) {
  const line =
    result?.locations?.[0]?.physicalLocation?.region?.startLine;
  return line ?? null;
}

export function* diagnostics(output) {
  let runs = null;
  try {
    runs = JSON.parse(output).runs;
  } catch {
    runs = null;
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    if (output.trim()) {
      yield ["unparseable-diagnostics", output.trim().split(/\r?\n/u)[0]];
    }
    return;
  }
  for (const run of runs) {
    const results = isObject(run) ? (run.results ?? []) : null;
    if (!Array.isArray(results)) {
      yield ["unparseable-diagnostics", stringValue(run).slice(0, 120)];
      continue;
    }
    for (const result of results) {
      if (!isObject(result)) {
        yield ["unparseable-diagnostics", stringValue(result).slice(0, 120)];
        continue;
      }
      const rule = stringValue(
        Object.hasOwn(result, "ruleId") ? result.ruleId : "",
      );
      const message = result.message;
      const text =
        isObject(message) && Object.hasOwn(message, "text")
          ? message.text
          : "";
      const line = sourceLine(result);
      yield [rule, `${line ? `line ${line}: ` : ""}${stringValue(text)}`];
    }
  }
}

export class Model {
  constructor(arm, recipes, compilerOutput = "") {
    arm = mapping(arm);
    recipes = mapping(recipes);
    this.compilerOutput = compilerOutput;
    this.contracts = mapping(recipes.types);
    this.recipeTypes = new Set(
      Array.isArray(recipes.recipeTypes)
        ? recipes.recipeTypes.filter((kind) => typeof kind === "string")
        : Object.keys(this.contracts),
    );
    this.variables = mapping(arm.variables);

    const declared = Object.hasOwn(arm, "resources") ? arm.resources : {};
    this.resolved = isObject(declared);
    this.resources = this.resolved ? declared : {};

    this.kinds = Object.fromEntries(
      Object.entries(this.resources).map(([symbol, body]) => [
        symbol,
        isObject(body)
          ? stringValue(Object.hasOwn(body, "type") ? body.type : "").split(
              "@",
              1,
            )[0]
          : "",
      ]),
    );
    this.secure = new Set(
      Object.entries(mapping(arm.parameters))
        .filter(
          ([, spec]) =>
            isObject(spec) &&
            SECURE_TYPES.has(String(spec.type ?? "").toLowerCase()),
        )
        .map(([name]) => name),
    );
    this.authored = new Map(
      Object.keys(this.resources).map((symbol) => [
        symbol,
        new Set(Object.keys(this.properties(symbol))),
      ]),
    );
    this.published = new Map();
    for (const [symbol, kind] of Object.entries(this.kinds)) {
      if (kind === SECRET_KIND) {
        const data = this.properties(symbol).data;
        if (isObject(data)) this.published.set(symbol, new Set(Object.keys(data)));
      } else if (Object.keys(mapping(this.contracts[kind])).length > 0) {
        const outputs = mapping(mapping(this.contracts[kind]).outputs);
        this.published.set(
          symbol,
          new Set(Object.keys(mapping(outputs.secrets))),
        );
      }
    }
    this.referenced = new Set();
    for (const [, text] of strings(arm.resources ?? {})) {
      for (const [target] of calls(text, "reference")) {
        this.referenced.add(target);
      }
    }
  }

  kind(symbol) {
    return this.kinds[symbol] ?? "";
  }

  properties(symbol) {
    return propertiesOf(this.resources[symbol]);
  }

  contract(symbol) {
    const contract = mapping(this.contracts[this.kind(symbol)]);
    return Object.keys(contract).length > 0 ? contract : null;
  }

  recipeAvailable(symbol) {
    const kind = this.kind(symbol);
    return this.recipeTypes.has(kind) || Object.hasOwn(this.contracts, kind);
  }

  requiresConnection(symbol) {
    const kind = this.kind(symbol);
    if (!this.recipeAvailable(symbol)) return false;
    return (
      CONNECTION_BACKING_KINDS.has(kind) ||
      CONNECTION_BACKING_PREFIXES.some((prefix) => kind.startsWith(prefix)) ||
      kind.startsWith("Radius.Resources/")
    );
  }

  *ofKind(kind) {
    for (const symbol of Object.keys(this.resources).sort()) {
      if (this.kind(symbol) === kind) {
        yield [symbol, this.properties(symbol)];
      }
    }
  }

  *texts(symbol) {
    for (const [resourcePath, text] of strings(this.resources[symbol])) {
      yield [`${symbol}${normalized(resourcePath)}`, text];
    }
  }

  *containers() {
    for (const [symbol, properties] of this.ofKind(CONTAINER_KIND)) {
      for (const [name, container] of Object.entries(containersOf(properties))) {
        yield [`${symbol}.containers.${name}`, container];
      }
    }
  }
}

export function composes(text) {
  return text.includes("format(") || text.includes("concat(");
}

export function envOf(container) {
  return isObject(container.env) ? container.env : {};
}

export function runtimeReferences(text) {
  if (typeof text !== "string") return [];
  const references = [];
  const pattern = /\$\(([A-Za-z_][A-Za-z0-9_]*)\)/gu;
  for (const match of text.matchAll(pattern)) {
    if (match.index > 0 && text[match.index - 1] === "$") continue;
    references.push(match[1]);
  }
  return [...new Set(references)];
}

export function secretBinding(entry) {
  if (!isObject(entry)) return null;
  const source = entry.valueFrom;
  const bound = isObject(source) ? source.secretKeyRef : null;
  if (!isObject(bound)) return null;
  const holder = bound.secretName;
  const wanted = bound.key;
  return typeof holder === "string" && typeof wanted === "string"
    ? [holder, wanted]
    : null;
}

export function connectionsOf(properties) {
  const connected = {};
  for (const [connectionPath, text] of strings(properties.connections || {})) {
    for (const [target] of calls(text, "reference")) {
      connected[target] = connectionPath.replace(/^\.+/u, "").split(".", 1)[0];
    }
  }
  return connected;
}

export function* iterSecretBindings(model) {
  for (const [where, container] of model.containers()) {
    for (const [key, entry] of Object.entries(envOf(container))) {
      const bound = secretBinding(entry);
      if (!bound) continue;
      const [holder, wanted] = bound;
      const expression = expressionBody(holder, model.variables);
      const at = `${where}.env.${key}`;
      for (const [target] of calls(expression, "reference")) {
        yield [at, target, wanted, expression];
      }
    }
  }
}

export function hasManagedSecrets(model, symbol) {
  const contract = model.contract(symbol);
  if (!contract) return false;
  return isObject(mapping(contract.outputs).secrets);
}

export function referenceReads(text, symbol) {
  const properties = new Set();
  let bareName = false;
  let unknown = false;
  for (const [target, tail] of calls(text, "reference")) {
    if (target !== symbol) continue;
    if (text.startsWith(".properties.", tail)) {
      const [name] = identifier(text, tail + ".properties.".length);
      if (name) properties.add(name);
      else unknown = true;
    } else if (text.startsWith(".name", tail)) {
      const after = tail + ".name".length;
      if (
        after < text.length &&
        /[A-Za-z0-9_]/u.test(text[after])
      ) {
        unknown = true;
      } else {
        bareName = true;
      }
    } else {
      unknown = true;
    }
  }
  return [properties, bareName, unknown];
}

export function checkCompilerDiagnostics(model, report) {
  for (const [rule, detail] of diagnostics(model.compilerOutput)) {
    report(
      "compiler-diagnostic",
      rule,
      `the compiler reported ${rule}: ${detail}`,
    );
  }
}

export function checkExtensionResolved(model, report) {
  if (!model.resolved) {
    report(
      "unresolved-extension",
      "resources",
      "the compiled template has no symbolic resources, so the Radius " +
        "types never resolved; declare `extension radius`.",
    );
  }
}

export function checkApplicationCount(model, report) {
  if (!model.resolved) return;
  const applications = Object.keys(model.resources)
    .sort()
    .filter((symbol) => model.kind(symbol) === APP_KIND);
  for (const symbol of applications) {
    const body = model.resources[symbol];
    const modifier = ["copy", "condition"].find(
      (key) => isObject(body) && Object.hasOwn(body, key),
    );
    if (modifier) {
      report(
        "application-count",
        symbol,
        `the ${APP_KIND} resource carries \`${modifier}\`, so the number ` +
          "deployed is not the one resource every other resource scopes " +
          "to; declare exactly one application unconditionally.",
      );
      return;
    }
  }
  if (applications.length !== 1) {
    report(
      "application-count",
      "resources",
      `the model declares ${applications.length} ${APP_KIND} resources ` +
        `(${applications.length ? repr(applications) : "none"}); declare exactly one.`,
    );
  }
}

export function checkResourceShapes(model, report) {
  if (!model.resolved) return;
  for (const symbol of Object.keys(model.resources).sort()) {
    const body = model.resources[symbol];
    if (!isObject(body)) {
      report(
        "malformed-resource",
        symbol,
        `the resource is ${typeName(body)}, not an object, so no ` +
          "check can read it; declare it as a resource.",
      );
      continue;
    }
    const outer = body.properties;
    const inner = isObject(outer) ? outer.properties : null;
    if (!isObject(inner)) {
      report(
        "malformed-resource",
        `${symbol}.properties`,
        "the resource declares no readable properties object, so every " +
          "check below it would pass without testing anything; give it a " +
          "`properties` body.",
      );
      continue;
    }
    const containers = inner.containers;
    if (containers !== null && containers !== undefined && !isObject(containers)) {
      report(
        "malformed-resource",
        `${symbol}.containers`,
        `\`containers\` is ${typeName(containers)}, not an object, ` +
          "so the container checks cannot read it; declare containers as " +
          "a named map.",
      );
      continue;
    }
    for (const [name, container] of sortedEntries(containers)) {
      if (!isObject(container)) {
        report(
          "malformed-resource",
          `${symbol}.containers.${name}`,
          `the container is ${typeName(container)}, not an object, so its ` +
            "image and environment go unchecked.",
        );
      }
    }
  }
}

export function checkContainerNames(model, report) {
  const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
  for (const [symbol, properties] of model.ofKind(CONTAINER_KIND)) {
    for (const name of Object.keys(containersOf(properties))) {
      if (
        name.startsWith("[") ||
        (name.length <= 63 && kubernetesName.test(name))
      ) {
        continue;
      }
      report(
        "invalid-container-name",
        `${symbol}.containers.${name}`,
        `${repr(name)} is not a valid Kubernetes container name; use a ` +
          "lowercase RFC 1123 label of at most 63 characters.",
      );
    }
  }
}

export function checkRecipeOutputs(model, report) {
  for (const symbol of Object.keys(model.resources).sort()) {
    for (const [resourcePath, text] of model.texts(symbol)) {
      for (const [target, name] of propertyReads(text)) {
        const contract = model.contract(target);
        if (!contract) continue;
        const outputs = mapping(contract.outputs);
        const allowed = new Set([
          ...Object.keys(outputs),
          ...(model.authored.get(target) ?? new Set()),
          "secrets",
        ]);
        if (!allowed.has(name)) {
          const returned = sortedKeys(outputs);
          report(
            "unmapped-recipe-output",
            resourcePath,
            `reads ${target}.properties.${name}, which the template ` +
              "does not set and the pinned Recipe does not return " +
              `(it returns ${returned.length ? repr(returned) : "nothing"}), so the ` +
              "value is null at deploy time.",
          );
        }
      }
    }
  }
}

export function checkReservedValues(model, report) {
  for (const symbol of Object.keys(model.resources).sort()) {
    const contract = model.contract(symbol);
    if (!contract) continue;
    const properties = model.properties(symbol);
    const reserved = mapping(contract.reserved);
    const prefixes = mapping(contract.reservedPrefixes);
    const fields = [...new Set([...Object.keys(reserved), ...Object.keys(prefixes)])]
      .sort();
    for (const name of fields) {
      const value = resolve(properties[name], model.variables);
      if (typeof value !== "string") continue;
      const banned = Array.isArray(reserved[name]) ? reserved[name] : [];
      const bannedPrefixes = Array.isArray(prefixes[name]) ? prefixes[name] : [];
      const folded = value.toLowerCase();
      const exact = banned.find(
        (item) =>
          typeof item === "string" &&
          item &&
          folded === item.toLowerCase(),
      );
      const prefix = bannedPrefixes.find(
        (item) =>
          typeof item === "string" &&
          item &&
          folded.startsWith(item.toLowerCase()),
      );
      if (exact === undefined && prefix === undefined) continue;
      const restriction =
        exact !== undefined
          ? "is reserved by the provider"
          : `starts with provider-reserved prefix ${repr(prefix)}`;
      report(
        "reserved-property-value",
        `${symbol}.${name}`,
        `${name} ${repr(value)} ${restriction}, so the deployment is ` +
          "rejected; use a neutral value instead.",
      );
    }
  }
}

export function environmentUniqueAzureName(value, variables = {}) {
  const expression = expressionBody(value, variables);
  const pattern = new RegExp(
    "^format\\('([a-z][a-z0-9]{0,10})\\{0\\}', " +
      "uniqueString\\(parameters\\('environment'\\)\\)\\)$",
    "u",
  );
  return pattern.test(expression);
}

export function checkCloudGlobalNames(model, report) {
  for (const symbol of Object.keys(model.resources).sort()) {
    const contract = model.contract(symbol);
    if (
      !contract ||
      !AZURE_GLOBAL_NAME_SOURCES.has(recipeSourceKey(contract.source))
    ) {
      continue;
    }
    const outer = mapping(mapping(model.resources[symbol]).properties);
    if (environmentUniqueAzureName(outer.name, model.variables)) continue;
    report(
      "nonunique-cloud-name",
      `${symbol}.name`,
      "the pinned Azure Recipe passes this name to a globally scoped " +
        "resource; use a lowercase alphanumeric prefix of at most 11 " +
        "characters followed by `${uniqueString(environment)}` so the " +
        "result is deterministic and fits every supported provider limit.",
    );
  }
}

export function secureParameters(model, text) {
  return [...new Set(
    [...calls(text, "parameters")]
      .map(([parameter]) => parameter)
      .filter((parameter) => model.secure.has(parameter)),
  )].sort();
}

export function names(items) {
  return [...items].map(repr).join(", ");
}

export function checkAuthoredSecrets(model, report) {
  for (const [symbol, properties] of model.ofKind(SECRET_KIND)) {
    for (const [dataPath, text] of strings(properties.data || {})) {
      if (!calls(text, "reference").next().done) {
        report(
          "authored-secret-copies-output",
          `${symbol}.data${dataPath}`,
          "authored secret copies a resource output; bind the managed " +
            "secret with secretKeyRef instead.",
        );
      }
      const expanded = expand(text, model.variables);
      const exposed = secureParameters(model, expanded);
      if (composes(expanded) && exposed.length > 0) {
        report(
          "secret-composed-in-template",
          `${symbol}.data${dataPath}`,
          `secure parameter ${names(exposed)} is interpolated into this ` +
            "authored secret value, materializing it in deployment state; " +
            "bind the parts separately and compose at runtime.",
        );
      }
    }
  }
}

function queryParameter(source, name) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) {
    try {
      return new URL(source).searchParams.get(name) ?? "";
    } catch {
      return null;
    }
  }
  const question = source.indexOf("?");
  if (question < 0) return "";
  const query = source.slice(question + 1).split("#", 1)[0];
  return new URLSearchParams(query).get(name) ?? "";
}

export function checkBuildSource(model, report) {
  for (const [symbol, properties] of model.ofKind(IMAGE_KIND)) {
    const build = properties.build;
    if (!isObject(build)) continue;
    const source = resolve(build.source, model.variables);
    if (typeof source !== "string") continue;
    const ref = queryParameter(source, "ref");
    if (ref === null) continue;
    if (!immutable(ref)) {
      report(
        "mutable-build-source",
        `${symbol}.build.source`,
        `build ref ${ref || "(absent)"} is mutable, so the code that ` +
          "gets built is not the code that was read; pin a 40-character " +
          "commit sha.",
      );
    }
  }
}

export function checkConnections(model, report) {
  for (const [symbol, properties] of model.ofKind(CONTAINER_KIND)) {
    const connected = connectionsOf(properties);
    const consumed = new Map();
    for (const [resourcePath, text] of model.texts(symbol)) {
      if (resourcePath.startsWith(`${symbol}.connections`)) continue;
      for (const [target] of calls(text, "reference")) {
        if (model.requiresConnection(target) && !consumed.has(target)) {
          consumed.set(target, resourcePath);
        }
      }
    }

    for (const [target, resourcePath] of [...consumed.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (Object.hasOwn(connected, target)) continue;
      report(
        "missing-connection",
        resourcePath,
        `consumes ${target} but declares no connection to it; local ` +
          "authoring requires a connection for the application-graph " +
          `relationship (add connections.<name>.source = ${target}.id). ` +
          "A direct reference only orders deployment; it does not create " +
          "that relationship. Default CONNECTION_* injection is " +
          "connection-driven and may be suppressed with " +
          "disableDefaultEnvVars.",
      );
    }
  }
}

function connectionRuntimeVariables(model, properties, disabled) {
  const variables = new Set();
  const connections = connectionsOf(properties);
  for (const [target, name] of Object.entries(connections)) {
    const definition = mapping(mapping(properties.connections)[name]);
    if ((definition.disableDefaultEnvVars === true) !== disabled) continue;
    const prefix = `CONNECTION_${name.toUpperCase()}_`;
    const contract = model.contract(target);
    for (const property of Object.keys(mapping(contract?.outputs))) {
      if (property !== "secrets") {
        variables.add(`${prefix}${property.toUpperCase()}`);
      }
    }
    for (const property of model.authored.get(target) ?? []) {
      if (!["application", "environment", "recipe"].includes(property)) {
        variables.add(`${prefix}${property.toUpperCase()}`);
      }
    }
  }
  return variables;
}

function connectionSecretVariables(model, properties) {
  const variables = new Set();
  for (const [target, name] of Object.entries(connectionsOf(properties))) {
    const prefix = `CONNECTION_${name.toUpperCase()}_`;
    const secrets = mapping(mapping(model.contract(target)?.outputs).secrets);
    for (const key of Object.keys(secrets)) {
      variables.add(`${prefix}${key.toUpperCase()}`);
    }
  }
  return variables;
}

export function checkRuntimeInterpolation(model, report) {
  for (const [symbol, properties] of model.ofKind(CONTAINER_KIND)) {
    const disabledVariables = connectionRuntimeVariables(
      model,
      properties,
      true,
    );
    const secretVariables = connectionSecretVariables(model, properties);
    for (const [name, container] of Object.entries(containersOf(properties))) {
      const env = envOf(container);
      const authored = new Set(Object.keys(env));
      const plain = Object.entries(env)
        .filter(([, entry]) => isObject(entry) && typeof entry.value === "string")
        .map(([key]) => key);

      for (const key of plain) {
        const value = expressionBody(env[key].value, model.variables);
        for (const referenced of runtimeReferences(value)) {
          if (authored.has(referenced)) continue;
          if (secretVariables.has(referenced)) {
            report(
              "unresolvable-runtime-interpolation",
              `${symbol}.containers.${name}.env.${key}`,
              `${key} references managed secret ${referenced}, but Radius ` +
                "connections do not inject secret outputs as environment " +
                "variables; bind the published key with secretKeyRef.",
            );
            continue;
          }
          if (disabledVariables.has(referenced)) {
            report(
              "unresolvable-runtime-interpolation",
              `${symbol}.containers.${name}.env.${key}`,
              `${key} references ${referenced}, but its connection disables ` +
                "default environment-variable injection.",
            );
          }
        }
      }
    }
  }
}

export function checkConnectionVariables(model, report) {
  for (const [symbol, properties] of model.ofKind(CONTAINER_KIND)) {
    const declared = new Set(
      Object.values(connectionsOf(properties)).map((name) => name.toUpperCase()),
    );
    for (const [name, container] of Object.entries(containersOf(properties))) {
      for (const key of Object.keys(envOf(container))) {
        const parts = key.split("_");
        if (parts.length < 3 || parts[0] !== "CONNECTION") continue;
        let belongs = false;
        for (let index = 2; index < parts.length; index += 1) {
          if (declared.has(parts.slice(1, index).join("_"))) {
            belongs = true;
            break;
          }
        }
        if (belongs) continue;
        report(
          "orphaned-connection-variable",
          `${symbol}.containers.${name}.env.${key}`,
          `${key} is written by hand but no connection named ` +
            `${repr(parts[1].toLowerCase())} is declared, so the rest of the set ` +
            "the application reads is never injected; declare the " +
            "connection instead of forging its variables.",
        );
      }
    }
  }
}

export function checkProcessArguments(model, report) {
  for (const [where, container] of model.containers()) {
    for (const field of ["command", "args"]) {
      const arguments_ = container[field];
      if (!Array.isArray(arguments_)) continue;
      for (const [index, rawArgument] of arguments_.entries()) {
        if (typeof rawArgument !== "string") continue;
        const at = `${where}.${field}[${index}]`;
        const argument = expand(rawArgument, model.variables);
        const exposed = secureParameters(model, argument);
        if (exposed.length > 0) {
          report(
            "secret-in-process-args",
            at,
            `secure parameter ${names(exposed)} is passed on the ` +
              "command line, exposing it in the pod spec and process " +
              "list; deliver it through env instead.",
          );
        }
        const holders = [...new Set(
          [...propertyReads(argument)]
            .filter(([, read]) => read === "secrets")
            .map(([target]) => target),
        )].sort();
        if (holders.length > 0) {
          report(
            "secret-in-process-args",
            at,
            `managed secret from ${names(holders)} is passed on the ` +
              "command line; deliver it through env with secretKeyRef " +
              "instead.",
          );
        }
      }
    }
  }
}

export function checkSecretBindings(model, report) {
  for (const [at, target, wanted, expression] of iterSecretBindings(model)) {
    const [properties, bareName, unknown] = referenceReads(expression, target);
    let wrong = null;
    if (hasManagedSecrets(model, target)) {
      if (!properties.has("secrets") && (properties.size > 0 || bareName)) {
        const read = [...properties]
          .sort()
          .map((property) => `.properties.${property}`);
        if (bareName) read.push(".name");
        wrong =
          `secretName reads ${names(read)} from ${target}, not the ` +
          "managed secret name it publishes at " +
          `reference('${target}').properties.secrets.name.`;
      }
    } else if (model.kind(target) === SECRET_KIND) {
      if (properties.size > 0 && !bareName) {
        wrong =
          `secretName reads properties of authored secret ${target}; ` +
          "its Kubernetes secret is named by " +
          `reference('${target}').name.`;
      }
    }
    if (wrong && !unknown) report("wrong-secret-name-path", at, wrong);

    const published = model.published.get(target);
    if (published !== undefined && !published.has(wanted)) {
      const values = [...published].sort();
      report(
        "unknown-secret-key",
        at,
        `binds key ${repr(wanted)} from ${target}, which publishes ` +
          `${values.length ? repr(values) : "no secrets"}.`,
      );
    }
  }
}

export function checkRequiredConnectionSecrets(model, report) {
  for (const [symbol, properties] of model.ofKind(CONTAINER_KIND)) {
    for (const [target, connectionName] of Object.entries(
      connectionsOf(properties),
    )) {
      const contract = model.contract(target);
      const required =
        AZURE_CONNECTION_SECRET_REQUIREMENTS[
          recipeSourceKey(contract?.source)
        ];
      if (!required) continue;
      let found = false;
      for (const container of Object.values(containersOf(properties))) {
        for (const entry of Object.values(envOf(container))) {
          const bound = secretBinding(entry);
          if (!bound || bound[1] !== required) continue;
          const expression = expressionBody(bound[0], model.variables);
          if (
            [...calls(expression, "reference")]
              .some(([name]) => name === target)
          ) {
            found = true;
          }
        }
      }
      if (found) continue;
      report(
        "missing-required-secret-binding",
        `${symbol}.connections.${connectionName}`,
        `${target} uses an Azure Recipe that requires authentication; bind ` +
          `its published ${repr(required)} secret with secretKeyRef instead ` +
          "of wiring only its public host and port.",
      );
    }
  }
}

export function checkComposedSecrets(model, report) {
  for (const [where, container] of model.containers()) {
    for (const [key, entry] of Object.entries(envOf(container))) {
      const value = isObject(entry) ? entry.value : null;
      if (typeof value !== "string") continue;
      const composed = expand(value, model.variables);
      const exposed = secureParameters(model, composed);
      if (composes(composed) && exposed.length > 0) {
        report(
          "secret-composed-in-template",
          `${where}.env.${key}`,
          `secure parameter ${names(exposed)} is interpolated into a ` +
            "larger value, materializing it in deployment state; bind " +
            "the parts separately and let the application compose them " +
            "at runtime.",
        );
      }
    }
  }
}

export function checkUnconsumedResources(model, report) {
  for (const symbol of Object.keys(model.resources).sort()) {
    const kind = model.kind(symbol);
    if (WORKLOAD_KINDS.has(kind) || model.referenced.has(symbol)) continue;
    report(
      "unconsumed-resource",
      symbol,
      `${kind} is declared but no workload consumes it; wire it or remove it.`,
    );
  }
}

const RULES = [
  checkCompilerDiagnostics,
  checkExtensionResolved,
  checkResourceShapes,
  checkContainerNames,
  checkApplicationCount,
  checkRecipeOutputs,
  checkReservedValues,
  checkCloudGlobalNames,
  checkAuthoredSecrets,
  checkBuildSource,
  checkConnections,
  checkConnectionVariables,
  checkRuntimeInterpolation,
  checkProcessArguments,
  checkSecretBindings,
  checkRequiredConnectionSecrets,
  checkComposedSecrets,
  checkUnconsumedResources,
];

export function check(arm, recipes, compilerOutput = "") {
  const findings = [];
  const seen = new Set();
  const report = (code, findingPath, message) => {
    const key = JSON.stringify([code, findingPath, message]);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, path: findingPath, message });
  };
  const model = new Model(arm, recipes, compilerOutput);
  for (const rule of RULES) rule(model, report);
  return findings;
}

export function signatureOf(findings) {
  const keys = findings
    .map((finding) => `${finding.code}:${finding.path}`)
    .sort();
  return crypto
    .createHash("sha256")
    .update(keys.join("\n"))
    .digest("hex")
    .slice(0, 12);
}

export function makeResult(findings) {
  return {
    verdict: findings.length > 0 ? DENY : ALLOW,
    signature: signatureOf(findings),
    findings,
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function readUtf8(file) {
  return UTF8.decode(fs.readFileSync(file));
}

export function load(file) {
  try {
    const parsed = JSON.parse(readUtf8(file));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readRecipeContract() {
  return compileRecipePack(await fetchRecipePack());
}

export function contractFaults(recipes) {
  const types = recipes.types;
  if (!isObject(types) || Object.keys(types).length === 0) {
    return ["`types` is missing, empty, or not an object"];
  }
  const faults = [];
  const recipeTypes = recipes.recipeTypes;
  if (
    !Array.isArray(recipeTypes) ||
    recipeTypes.length === 0 ||
    !recipeTypes.every((kind) => typeof kind === "string" && kind)
  ) {
    faults.push(
      "`recipeTypes` is missing, empty, or not a list of non-empty strings",
    );
  } else if (
    new Set(recipeTypes.map((kind) => kind.toLowerCase())).size !==
    recipeTypes.length
  ) {
    faults.push("`recipeTypes` contains duplicate case-insensitive type names");
  }
  for (const [kind, contract] of sortedEntries(types)) {
    if (!isObject(contract)) {
      faults.push(`${kind} is not an object`);
      continue;
    }
    const outputs = contract.outputs;
    if (!isObject(outputs) || Object.keys(outputs).length === 0) {
      faults.push(`${kind}.outputs is missing, empty, or not an object`);
      continue;
    }
    for (const [name, value] of sortedEntries(outputs)) {
      if (isObject(value)) {
        for (const [key, nested] of sortedEntries(value)) {
          if (typeof nested !== "string" || !nested) {
            faults.push(
              `${kind}.outputs.${name}.${key} is not a non-empty string`,
            );
          }
        }
      } else if (typeof value !== "string" || !value) {
        faults.push(`${kind}.outputs.${name} is not a non-empty string`);
      }
    }
    for (const field of ["reserved", "reservedPrefixes"]) {
      const constraints = contract[field];
      if (constraints === null || constraints === undefined) continue;
      if (!isObject(constraints)) {
        faults.push(`${kind}.${field} is not an object`);
        continue;
      }
      for (const [name, banned] of sortedEntries(constraints)) {
        if (
          !Array.isArray(banned) ||
          banned.length === 0 ||
          !banned.every((entry) => typeof entry === "string" && entry)
        ) {
          faults.push(
            `${kind}.${field}.${name} is not a non-empty list of non-empty strings`,
          );
        }
      }
    }
  }
  return faults;
}

export function unusable(findingPath, reason) {
  return [{ code: "checker-unusable", path: String(findingPath), message: reason }];
}

export async function findingsFor(armPath, diagnosticsPath) {
  let compilerOutput;
  try {
    compilerOutput = readUtf8(diagnosticsPath);
  } catch {
    return unusable(
      diagnosticsPath,
      "the compiler diagnostics could not be read, so a warning-free " +
        "build cannot be established; re-run bicep build with " +
        "--diagnostics-format sarif and pass the file it writes.",
    );
  }

  const arm = load(armPath);
  if (arm === null) {
    const findings = [
      {
        code: "compile-failed",
        path: String(armPath),
        message:
          "the compiled ARM JSON is missing or unparseable, so " +
          "the build failed; fix the compiler errors below and rebuild.",
      },
    ];
    for (const [rule, detail] of diagnostics(compilerOutput)) {
      findings.push({
        code: "compiler-diagnostic",
        path: rule,
        message: `the compiler reported ${rule}: ${detail}`,
      });
    }
    return findings;
  }

  let recipes;
  try {
    recipes = await readRecipeContract();
  } catch (error) {
    if (!(error instanceof RecipeContractError)) throw error;
    return unusable(
      error.source,
      `${error.message}, so the model's Recipe contract cannot be checked`,
    );
  }
  const faults = contractFaults(recipes);
  if (faults.length > 0) {
    return unusable(
      AZURE_RECIPE_PACK_URL,
      "the Recipe output contract is malformed, so the checks that read " +
        `it would pass without testing anything (${faults.slice(0, 5).join("; ")})`,
    );
  }
  return check(arm, recipes, compilerOutput);
}

function usage() {
  return "usage: check.mjs [-h] --diagnostics DIAGNOSTICS arm\n";
}

function parseArgs(argv) {
  let arm = null;
  let diagnosticsPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      return { help: true };
    }
    if (argument === "--diagnostics") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("argument --diagnostics: expected one argument");
      }
      diagnosticsPath = argv[index];
      continue;
    }
    if (argument.startsWith("--diagnostics=")) {
      diagnosticsPath = argument.slice("--diagnostics=".length);
      if (!diagnosticsPath) {
        throw new Error("argument --diagnostics: expected one argument");
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unrecognized arguments: ${argument}`);
    }
    if (arm !== null) {
      throw new Error(`unrecognized arguments: ${argument}`);
    }
    arm = argument;
  }
  if (arm === null) throw new Error("the following arguments are required: arm");
  if (diagnosticsPath === null) {
    throw new Error("the following arguments are required: --diagnostics");
  }
  return { help: false, arm, diagnosticsPath };
}

export async function main(
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(usage());
    stderr.write(`check.mjs: error: ${errorMessage(error)}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(usage());
    stdout.write(
      "\nValidate compiled Radius models against the current Azure Recipe Pack.\n",
    );
    return 0;
  }

  const result = makeResult(
    await findingsFor(args.arm, args.diagnosticsPath),
  );
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.verdict === DENY ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
