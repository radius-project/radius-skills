---
name: app-modeling
description: >
  Analyze a source code repository and generate a Radius application
  definition (.radius/app.bicep) that models the app's compute and backing
  services as Radius resource types. Use for: creating, generating, or
  updating a Radius application definition or app.bicep; modeling or
  onboarding an app or repo to Radius; determining which Radius resource
  types an app needs; repairing or fixing an app.bicep that failed to
  deploy because of a modeling or schema error. Do not use for: authoring
  generic or Azure Bicep unrelated to Radius, or deploying or running an
  already-modeled app. Resolves the configured Radius schemas and the
  application's runtime contract to produce validated, deployable output.
---

# Radius Application Modeling

Use this skill to generate a Radius application definition (`app.bicep`) from a source code repository.

## Prerequisites

This skill currently supports only repositories that already contain a Dockerfile for building the application image. Before doing anything else, confirm the target repository includes a Dockerfile for the application (repo root or the relevant service subdirectory; match `Dockerfile`, `Dockerfile.*`, or `*.Dockerfile`, case-insensitively).

If no Dockerfile is present, stop immediately. Do not generate `.radius/app.bicep` or `.radius/bicepconfig.json`, do not create or write to a branch, and do not commit or push. Return only this error:

> This repository does not contain a Dockerfile. The Radius app modeling skill currently supports only repositories that already include a Dockerfile for building the application image. Add a Dockerfile for the application service and run the skill again.

## Response

When asked to model a repository, first apply the [Prerequisites](#prerequisites) check. Only if it passes:

1. If the requirement ledger cannot be closed against the exact source, schema, and target Environment recipe contracts, do not write, commit, or push a partial application definition. Report the mismatch and the compatible extension or recipe contract required.
2. Generate the application definition and write both `.radius/app.bicep` and `.radius/bicepconfig.json` (see [bicepconfig.json](#bicepconfigjson)) to the current working branch of the target repository. If that branch does not exist yet, create it before writing.
3. Commit both files to that branch, and push the branch when a remote is configured.
4. In your chat reply, give a one-line intro naming the app (e.g. "I'll create an application definition for `todo-list-app`."), then a short, natural summary of the resources you identified — a brief list such as "Container: `todo-list-app`", "MySQL database", "Secure DB credential binding". A sentence or two of reasoning is fine; don't dump raw source analysis or the full file contents.
5. Then ask whether to open a pull request against the default branch.

Don't open the pull request automatically — wait for the user to confirm. If they confirm, open a PR from the working branch against the default branch with title `Add Radius application definition` and body `Add .radius/app.bicep and .radius/bicepconfig.json for <app-name>.`

## Workflow

Before writing the Bicep, confirm the repository satisfies the [Prerequisites](#prerequisites) (it must contain a Dockerfile); if not, stop and return the prerequisite error without modeling, generating, or writing anything. Then:

1. Select one runnable deployment profile. Treat explicit user, scenario, and target-repository deployment requirements for Radius types, resource-name parameters, workload roles/count, native configuration keys, secret bindings, provider profile, protocol values, and connection names as acceptance criteria. Verify that the pinned source supports that profile; do not silently replace it with an easier default or optional backend.
2. Build an internal requirement ledger that maps every acceptance criterion and planned resource property reference to source evidence, an exact Radius schema/recipe field, and the workload setting that consumes it. Use it for reasoning and validation; do not print it or add it as Bicep comments. Follow [runtime-contract.md](references/runtime-contract.md).
3. Inventory every executable workload and backing service in the selected profile from manifests, Dockerfiles, compose/Helm files, entrypoints, source configuration reads, client initialization, and referenced config files. Treat web, worker, producer, consumer, migration, scheduler, and sidecar roles separately. Model a backing service only when source evidence proves it is mandatory for the selected startup/configuration path; a repo-wide optional dependency, extra, adapter, or example does not become a resource.
4. Extract each workload's runtime contract: image/build context and target platform, entrypoint and arguments, listener and ports, required environment/configuration including parser coercion and unset behavior, secrets, writable storage, dependencies, wire protocols, authentication/bootstrap setup, and feature-critical configuration. Inspect CLI flags and structured fields as well as environment variables.
5. Map every selected backing service to a Radius type with [component-catalog.md](references/component-catalog.md), using [architecture-patterns.md](references/architecture-patterns.md) only as context. Report unsupported essential components instead of substituting unrelated types.
6. First create or update `.radius/bicepconfig.json` (see [bicepconfig.json](#bicepconfigjson)), using any `bicepconfig.json` currently applicable to `.radius/app.bicep` as input. Resolve every emitted type and planned property read/write against the exact target Environment schema and Recipe contract, then reconcile that contract with the extension that `.radius/bicepconfig.json` declares. For every output, open the exact Environment recipe or matching immutable provider recipe-pack source and record the verbatim mapping; schema descriptions and property names are not recipe evidence. Also prove each managed-secret name/key, every omitted optional recipe input, and target Environment recipe availability for every emitted extensible type. The exact target schema and Recipe outrank stale mutable extension metadata such as `radius:latest`. Refresh or pin a verified compatible extension when possible; otherwise fail closed before generation rather than changing or deleting required wiring to fit the stale artifact.
7. Build the application's own workloads from the repository Dockerfile via `Radius.Compute/containerImages`; use a pinned published image only for a genuinely third-party or backing container. Require a complete, practical build context and pin `build.source` to the exact modeled checkout or an explicit immutable release tag. Resolve the exact `containerImages` Recipe: set a Docker-valid immutable `tag` when its omitted-tag path is not proven usable, select explicit target-compatible `build.platforms` when the Dockerfile cannot safely build every default platform, and preserve required Git metadata with schema-supported build arguments. If an application workload's Dockerfile or context is unusable, report the packaging gap instead of substituting a published image for the application's own code. Map every runtime value using [connection-conventions.md](references/connection-conventions.md), [secrets-handling.md](references/secrets-handling.md), and [bicep-structure-rules.md](references/bicep-structure-rules.md).
8. Generate the Bicep using [naming-conventions.md](references/naming-conventions.md), then run `node "<loaded-skill-base>/scripts/validate-bicep.mjs" .radius/app.bicep`. The checker uses only the extension-managed Bicep. Repair every compiler error and warning until the checker exits successfully and prints no warnings. Never make compilation pass by deleting a required backend activation, native configuration value, secret binding, or dependency edge.
9. Perform the [validation checklist](#validation-checklist) and close every item in the requirement ledger. Compilation or process startup alone is not success.

## Deployment Profile and Acceptance Contract

- **Explicit profile wins:** If the request names a supported Radius type, provider profile, workload role, native key, protocol value, secret binding, or relationship, model it exactly when the pinned source supports it. A source default or another valid deployment profile does not satisfy that request.
- **Source compatibility is still mandatory:** Resolve behavior from the requested commit/tag, not a different release or the current default branch. If an acceptance criterion conflicts with that source revision, stop and report the conflict instead of inventing compatibility.
- **No implicit omissions:** Each required typed resource must be emitted and wired to a consumer. Each required workload role must have a runnable process and complete config. Each required native key/value must appear in the exact source-supported location and format.
- **No decorative wiring:** Environment variables, connections, and resources must be consumed by the selected feature path. Merely declaring a dependency or starting a process does not prove the requested database, model, storage, or messaging path works.
- **Mandatory dependencies only:** Model only services required by the selected runnable path. Imports, package extras, adapters, examples, tests, or alternate configurations elsewhere in the repository do not prove that a backing service is required.
- **Infer only when unspecified:** Without an explicit profile, prefer a complete, documented manifest/configuration that exercises the application's primary feature. If multiple materially different profiles remain valid, ask the user rather than choosing an optional backend arbitrarily.
- **Fail closed on verified incompatibility:** Fully implement every clearly supported criterion. Stop after evidence proves the pinned source or exact schema/recipe cannot satisfy a requirement; do not return a partial definition as deployable, leave unresolved runtime caveats, or delete feature-critical wiring to obtain a clean compile.

### Repairing an existing app.bicep

When a deploy fails because of a modeling or schema error in an existing `.radius/app.bicep` (unknown type or API version, unknown or missing property, invalid reference between resources, wrong credential shape, or a Bicep parse or compile error), repair the file in place instead of regenerating it. This assumes the deploy error and any relevant logs have been provided; if they haven't, ask for them before attempting a fix.

1. Confirm whether the failure comes from the application model. If it is an infrastructure, recipe, Environment, or cluster failure (for example, recipe download/execution or provider provisioning), stop and report that editing `app.bicep` will not fix it. A pod that never becomes ready is not enough to classify the failure: inspect events and logs to distinguish infrastructure/connectivity failures from incorrect workload configuration, listeners, credentials, or dependency wiring in `app.bicep`.
2. Locate the implicated resource, property, or workload setting, then re-resolve the exact configured type schema and recipe output contract (see [Resource Type Resolution](#resource-type-resolution)) to confirm property names, required fields, credential shape, API version, and resource reference paths.
3. Apply the fix using the same runtime-contract, naming, structure, and secrets rules as authoring so the repaired resource stays consistent with the rest of the file. While you are in the file, also correct any other clear schema or rule violations you notice, and report each collateral fix you made. Never clear a compile error by deleting a required binding, native value, backend activation, or dependency edge; report version drift when the configured schema cannot represent the runnable profile.
4. Re-run the [validation checklist](#validation-checklist) against the whole file; a change in one resource can ripple to connections or references elsewhere.
5. Return the corrected file with a short note of what changed and why, then suggest redeploying to confirm the fix. If the same error recurs, treat the previous fix as insufficient and try a different fix rather than reapplying the one that just failed. If a couple of different fixes still do not resolve it, or no different fix can be found, stop and surface the problem to the user instead of looping.

## Deterministic Naming Rules

These rules eliminate ambiguity. Apply them exactly.

Explicit profile-required resource, relationship, parameter, and app-native configuration names take precedence over the default naming rules below. Never normalize a name the selected runtime contract requires verbatim. Preserve a resource-name parameter when deployment documentation, the target Environment Recipe, or verification couples it to a provider resource name.

### Symbolic names (left side of `=` in Bicep)

| Resource | Symbolic name |
|---|---|
| Application | `<shortName>App` where `<shortName>` is the app name without hyphens, camelCase (e.g., `todo-list-app` → `todoApp`) |
| Container | `<serviceName>Container` — service short name camelCase; single-container apps use `<shortName>Container` (e.g., `todoContainer`) |
| Container image | `<serviceName>Image` (e.g., `todoImage`) |
| Data store (database/cache/queue) | `<engine>` + role suffix, camelCase: `mysqlDb`, `postgresDb`, `neo4jDb`, `redisCache`. Multiple of the same engine: prefix with the source store name (e.g., `ordersPostgresDb`) |
| Data store secret | `<engine>Secret` when the type's schema requires `secretName`; app secrets use `appSecrets` |
| Route | `<serviceName>Route` (e.g., `todoRoute`) |

### Resource `name` properties (string values in Bicep)

| Resource | Name value |
|---|---|
| Application | Repository name in kebab-case (e.g., `'todo-list-app'`) |
| Container | Service name in kebab-case; single-container apps use the app name (e.g., `'todo-list-app'`) |
| Container image | `'<service-name>-image'` (e.g., `'todo-list-app-image'`) |
| Data store | Engine short name in kebab-case (`'mysql'`, `'postgres'`, `'neo4j'`, `'redis'`); multiple of the same engine use the source store name |
| Data store secret | `'<engine>-secret'` (when the schema requires `secretName`); app secrets `'app-secrets'` |

### Connection keys

| Connection | Key |
|---|---|
| Data store | Engine + role, lowercase: `mysqldb`, `postgresdb`, `neo4jdb`, `rediscache`. Multiple of the same engine: prefix with the source store name |

### Other fixed values

| Field | Value |
|---|---|
| Data store admin username | The administrator username you author for the provisioned database. Set it wherever the schema puts credentials — `username` on the resource, or `USERNAME` in the secret when the schema uses `secretName`. Use a simple admin name (e.g., `myadmin`); it is NOT derived from the source |
| Data store `database` name | Derived from source (e.g., `MYSQL_DATABASE`/`POSTGRES_DB`, or the database segment of a connection string) |
| Data store `version` | Derived from source (e.g., the image tag `mysql:8.0` → `'8.0'`) |
| Container key in `containers` map | Service short name camelCase (single-container: derived from app, e.g., `todo`) |
| Port key in `ports` map | `web` for the primary HTTP port; additional ports derive from protocol/use (`http`, `grpc`) |
| `build.source` for containerImages | Repo git URL pinned to the modeled checkout: `git::https://github.com/<org>/<repo>.git//<subdir>?ref=<checked-out-sha-or-explicit-immutable-tag>` (`//<subdir>` only when the Dockerfile isn't at the repo root) |

## Resource Type Resolution

### Built-in types (from `radius-project/radius`)

| Need | Resource Type | API Version |
|---|---|---|
| Application grouping | `Radius.Core/applications` | `2025-08-01-preview` |

`Radius.Core/applications` is built into the `radius` extension — there is no schema file for it in `resource-types-contrib`. Do NOT use `Applications.Core/applications` — the model has moved to `Radius.Core/applications`.

### Extensible types (from `radius-project/resource-types-contrib`)

First inspect the target repository's `bicepconfig.json`: the `radius` extension alias is the local compile-time contract. Resolve schemas from the `resource-types-contrib` revision that produced that artifact and from the target Environment's registered type definition and Recipe. A mutable artifact such as `radius:latest`, a recipe tagged `latest`, or a branch ref can drift. The exact target Environment schema and Recipe are authoritative for deployment; a clean compile against conflicting mutable metadata is not validation and must not override that contract.

Use the `radius-project/resource-types-contrib` repository for discovery. Do NOT hardcode a file path — derive it from the resource type name using the repo convention:

- Category = the segment after `Radius.` in the namespace (`Radius.Compute` → `Compute`, `Radius.Data` → `Data`, `Radius.Messaging` → `Messaging`, `Radius.AI` → `AI`, `Radius.Storage` → `Storage`, `Radius.Security` → `Security`)
- Schema path = `<Category>/<typeName>/<typeName>.yaml` (e.g., `Radius.Data/mySqlDatabases` → `Data/mySqlDatabases/mySqlDatabases.yaml`)

Read the matching schema file for property names, types, sensitivity, read-only outputs, and API versions. Open the exact Recipe to verify output mappings, managed-secret keys, omitted-input behavior, and registration in the target Environment. The configured extension and deployed contract must agree. Resolve a compatible immutable extension or stop and report the mismatch; never guess a path, remove required wiring, or substitute generic connection projection.

The following is the allow-list of predefined types this skill emits when one fits the need:

| Need | Resource Type |
|---|---|
| Container images (build from Dockerfile) | `Radius.Compute/containerImages` |
| Containers | `Radius.Compute/containers` |
| MySQL | `Radius.Data/mySqlDatabases` |
| PostgreSQL | `Radius.Data/postgreSqlDatabases` |
| Neo4j | `Radius.Data/neo4jDatabases` |
| MongoDB | `Radius.Data/mongoDatabases` |
| Redis (cache) | `Radius.Data/redisCaches` |
| SQL Server | `Radius.Data/sqlServerDatabases` |
| Kafka (event streaming) | `Radius.Messaging/kafka` |
| RabbitMQ (message queue) | `Radius.Messaging/rabbitMQ` |
| AI model endpoint | `Radius.AI/models` |
| AI search | `Radius.AI/search` |
| Object storage | `Radius.Storage/objectStorage` |
| Persistent storage | `Radius.Compute/persistentVolumes` |
| External ingress | `Radius.Compute/routes` |
| Secrets | `Radius.Security/secrets` |

Do NOT invent properties on these types, and do NOT substitute one predefined type for another. When a backing service the application genuinely needs has NO matching type above, do not stop and do not force an ill-fitting type: generate a custom resource type under the `Radius.Resources` namespace, following [custom-resource-types.md](references/custom-resource-types.md), which is authoritative for the schema, extension, recipe, and recipe-pack flow (Azure scope for now).

## Extension

Declare `extension radius`. It provides every predefined Radius type (`Radius.Core/*`, `Radius.Compute/*`, `Radius.Data/*`, `Radius.Messaging/*`, `Radius.AI/*`, `Radius.Storage/*`, `Radius.Security/*`). Do NOT declare per-namespace or per-type extensions (`radiusCompute`, `containers`, `kafka`, etc.). When the application uses a generated custom type (see [custom-resource-types.md](references/custom-resource-types.md)), also declare the local custom-types extension published into `.radius/` (for example `extension customTypes`). Every extension alias must resolve through `.radius/bicepconfig.json`, which the skill always creates or updates (see [bicepconfig.json](#bicepconfigjson)); only ever write that file, never a config outside `.radius/`.

## bicepconfig.json

`app.bicep` cannot compile or deploy unless a `bicepconfig.json` resolves the `radius` extension. Always create or update `.radius/bicepconfig.json` (co-located with `.radius/app.bicep`) so it fits the generated `app.bicep`; only ever write that file, never a `bicepconfig.json` outside `.radius/`. When the application uses a generated custom type, this file also aliases the local custom-types extension tgz alongside the `radius` extension (see [custom-resource-types.md](references/custom-resource-types.md)).

- If `.radius/bicepconfig.json` already exists, update it to fit `app.bicep`: add or correct what `app.bicep` needs (the `radius` extension reference and `extensibility`), preserve unrelated existing settings, and change or remove entries only where they conflict with what `app.bicep` needs. An already-correct file produces an empty diff.
- If it does not exist, create it. When a `bicepconfig.json` in a parent directory would otherwise be the config discovered for `.radius/app.bicep` (before you write `.radius/bicepconfig.json`), use it as input: seed the new file from its compatible settings and adjust so it fits `app.bicep` (add, correct, or drop entries as needed). Do not modify the parent file.
- When there is nothing to carry forward, create `.radius/bicepconfig.json` with:

```json
{
  "experimentalFeaturesEnabled": {
    "extensibility": true
  },
  "extensions": {
    "radius": "br:biceptypes.azurecr.io/radius:latest"
  }
}
```

Default to the `radius:latest` tag only when no exact target Environment contract is available. Pin a verified compatible immutable reference when one is provided by an existing `bicepconfig.json`, the user, or the target Environment. If `radius:latest` is proven to disagree with the target schema or Recipe, replace it with a verified compatible reference or fail closed; never weaken `app.bicep` to fit the mutable artifact.

## app.bicep Structure (mandatory order)

Declare resources in this order (do NOT output this as code — it is only for your reference):

1. Extensions: `extension radius` (always; covers all predefined Radius types) plus the local custom-types extension (for example `extension customTypes`) when the app uses a generated `Radius.Resources/*` custom type
2. Params: `environment`; add a `@secure() param` for each developer-supplied secret value
3. Application resource (`Radius.Core/applications@2025-08-01-preview`) — always exactly one
4. Data / infrastructure resources (databases, caches, message brokers, object storage, AI services)
5. Secret resources (app secrets, or schema-required credentials via `secretName`)
6. Container image resources (if building from Dockerfile)
7. Container resources (with image, configuration, secret, and dependency wiring)
8. Routes (only if external ingress needed)

Rules:
- One `Radius.Compute/containers` per deployment unit; its `containers` map must include every co-scheduled role required by that unit. Separate independently deployed services into separate resources. Create one typed resource per selected backing service.
- Building from a complete Dockerfile context: add a `Radius.Compute/containerImages` resource with `build.source` pinned to the exact modeled checkout. Verify the exact Recipe's omitted-tag and platform behavior, set a valid immutable tag when omission is broken, and select only platforms compatible with the Dockerfile and target runtime. The container references `<serviceName>Image.properties.imageReference` (no separate connection needed).
- Database credentials follow the type's schema: if it defines `username`/`password`, set them on the resource; if it defines `secretName`, create a `Radius.Security/secrets` and reference it; if it defines neither, the type takes no credentials. Always use a `@secure() param` for the password.
- Add `Radius.Compute/routes` only for external ingress.
- Keep provider modules, SKUs, regions, firewall/network policy, and recipe output mapping in Environment/provider Bicep. `app.bicep` contains only developer intent and app-facing runtime wiring.

## Connections

`connections` declares a generic Radius relationship. It does not translate resource properties into arbitrary application-specific variable or configuration names. Read [connection-conventions.md](references/connection-conventions.md).

Rules:
- Inspect the source to identify the exact names, casing, value format, defaults, and configuration mechanism it consumes.
- Generic projection can be a `CONNECTION_<NAME>_PROPERTIES` JSON value, individual `CONNECTION_<NAME>_<PROPERTY>` values, or another version-specific shape. Verify the configured extension/runtime contract; do not assume one format.
- Use a connection alone only when the application explicitly consumes that applicable generic contract. Otherwise map each required native input explicitly from a verified nonsecret resource output, a secret reference, a literal/default, or runtime composition.
- A direct resource property or secret reference creates dependency ordering. Do not add a connection merely for ordering; retain one only when the application/tooling consumes the relationship.
- An explicit request for Radius relationship metadata is a valid reason to retain a connection. Use the exact requested connection key and `source`; explicit native wiring may still be required for the workload.
- Explicit native variables may coexist with generic projection. Avoid conflicting values, and use `disableDefaultEnvVars` only when the exact container schema supports it and the generic variables would be harmful.

## Secrets

See [secrets-handling.md](references/secrets-handling.md). Secret contracts are version- and type-specific:

- **Inputs** (credentials you supply): follow the exact schema — set an `x-radius-sensitive` property (e.g. `password`) from a `@secure()` parameter; author a referenced `Radius.Security/secrets` only when the schema uses `secretName`; or none. When the app container also needs a supplied credential, assign the same `@secure()` parameter directly to its `env.value` — Radius encrypts and injects it, so do NOT wrap it in a `Radius.Security/secrets` or route it through `secretKeyRef`.
- **Outputs** (values a recipe generates): inspect the exact registered schema and recipe output mapping. When they declare managed-secret metadata, bind the workload directly with `secretName: <resource>.properties.secrets.name` and an exact key declared in that block. Those key declarations are not readable convenience properties. Never copy a recipe secret through an authored wrapper or guess `<resource>.properties.<key>`; if the managed-secret contract is absent, report the gap.
- An authored `Radius.Security/secrets.data.value` is not a runtime composition mechanism. Prefer source-native decomposed connection inputs. When an application requires one credential-bearing value, use an exact compatible managed-secret output or a verified runtime encoder/composer with correct ordering and escaping. URL-encode arbitrary valid credentials when the target syntax requires it; shell expansion alone is not encoding.

## Bicep Structure Rules

Read [bicep-structure-rules.md](references/bicep-structure-rules.md) for all structural rules.

## Validation Checklist

Before returning the Bicep, verify:
- [ ] The repository contains a Dockerfile; a repo without one was rejected with the prerequisite error and produced no files (see [Prerequisites](#prerequisites)).
- [ ] One deployment profile is selected. Every explicit type, resource-name parameter, workload role/count, native key, required value, secret binding, and connection name from the request is represented in a closed requirement ledger. Every modeled backing service is mandatory for that selected source path; optional repository-wide dependencies are omitted.
- [ ] Every planned resource property read/write has its verbatim path in the ledger and exists in the exact target schema/API version. Every recipe-generated output has a mapping copied from the exact target Environment Recipe or matching immutable provider recipe source; every managed-secret reference has the declared nested secret-name path and exact key; every omitted optional Recipe input is proven safe. An absent path blocks generation rather than being replaced by a guessed property, alias, wrapper, or stale mutable-extension shape.
- [ ] Exactly one `Radius.Core/applications@2025-08-01-preview`. `extension radius` is always declared; a local custom-types extension (for example `extension customTypes`) is also declared when the app uses a generated `Radius.Resources/*` custom type. No per-namespace or per-type extensions.
- [ ] `node "<loaded-skill-base>/scripts/validate-bicep.mjs" .radius/app.bicep` exits successfully and prints no errors or warnings. The file compiles with an extension compatible with the target Environment schema/Recipe contract; every `Radius.*` type is on the allow-list or is a generated `Radius.Resources/*` custom type, and matches that version's schema and API version. A conflicting mutable extension is version drift, not permission to alter required deployment wiring.
- [ ] The target Environment has a usable Recipe for every emitted extensible type, including support resources such as `Radius.Security/secrets` and `Radius.Compute/containerImages`.
- [ ] `param environment string` is declared; add a `@secure() param` for each developer-supplied secret.
- [ ] Every required executable role is modeled, including co-scheduled producer/consumer or proxy/backend roles. Its image/build, entrypoint/arguments, listener, exposed ports, config artifacts, writable storage/ownership, authentication/bootstrap path, and lifecycle are correct. `containerPort` matches the process; it does not configure the listener.
- [ ] Every required app-native input is supplied with the exact pinned-source name, casing, representation, parser coercion, unset behavior, URL/config syntax, and value. String values preserve source semantics; for example, a source that evaluates `Boolean(value)` must not receive non-empty `'false'` to mean false. Each generic connection is consumed by source or explicitly required as relationship metadata.
- [ ] The application's own workloads build from a complete practical repository Dockerfile/context through `Radius.Compute/containerImages`, with `build.source` pinned to the exact modeled checkout or an explicit immutable release tag. Published images are pinned and used only for genuinely third-party/backing containers. An omitted image tag is proven usable in the exact Recipe or a Docker-valid immutable tag is set. Selected platforms match the Dockerfile's proven cross-build behavior and target runtime. Required Git metadata is preserved with schema-supported build arguments. Generated builds are consumed through `.properties.imageReference`.
- [ ] Credentials match the type's schema: `username`+`password` on the resource, or `secretName`+secret, or none — whichever the schema defines. Password via `@secure() param`; `database`/`topic`/`queue`/etc. derived from source.
- [ ] A developer-supplied credential the app consumes reaches the exact native key from the same `@secure()` parameter through `env.value`, never through an authored wrapper secret or `secretKeyRef`. Recipe-generated values bind with `secretKeyRef` only from the exact nested managed-secret name and key. Authored `Radius.Security/secrets` are limited to genuine app secrets/config files or schema-required `secretName` inputs. No authored secret copies an output, guesses a convenience property, or interpolates an aggregate credential-bearing URL/config.
- [ ] Read-only properties are never **set**. A referenced nonsecret output exists in the exact schema and is explicitly mapped by the selected Recipe; a provider-fixed literal has proof from the concrete provider contract. A referenced secret path/key exists in the exact secret-output contract. Such direct references provide dependency ordering.
- [ ] Every dependency has a complete client tuple: subresource name, endpoint/FQDN transformation, port, protocol/version, TLS mode, auth mechanism/identity, secret source, and final client syntax. Provider modules, SKUs, regions, and firewall configuration remain outside `app.bicep`.
- [ ] Primary-feature readiness is proven: required model aliases, storage backends, database clients, messaging inputs/outputs, and noninteractive authentication/bootstrap settings are configured and reference the selected resources. A health endpoint, login screen without a usable bootstrap path, or idle/placeholder process is not sufficient.
- [ ] No ledger row was closed by deleting required wiring to obtain a clean compile. Any schema, Recipe, or Environment availability mismatch produced a fail-closed report instead of a partial application definition.
- [ ] Perform the static consistency pass in [runtime-contract.md](references/runtime-contract.md); no unresolved runtime caveat remains.
- [ ] The generated Bicep contains no explanatory comments. `.radius/bicepconfig.json` resolves the `radius` extension for `app.bicep`: created or updated in place (a parent `bicepconfig.json` is used only as input, never modified).

## Example

See [todo-list-app-example.md](references/todo-list-app-example.md) for source-derived modeling decisions when an application expects native database variables instead of Radius generic connection variables.
