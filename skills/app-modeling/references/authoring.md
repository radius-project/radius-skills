# Authoring a Radius app.bicep

This file is the detailed policy for a generated Radius model. Write only
`.radius/app.bicep`, `.radius/bicepconfig.json`, and artifacts required by
[custom-resource-types.md](custom-resource-types.md). Do not change a parent
configuration or any other repository file.

The compiler checks Bicep syntax and resource shape. `check.mjs` checks the
compiled model. Source evidence and the rules here establish that the selected
application can actually run.

## Repository exploration and profile choice

Repository exploration establishes one complete path from input to observable
result and determines what the application needs. Type and Recipe resolution
then tests whether Radius can provide it.

1. **Acceptance criteria.** The request, scenario, and target-repository
   requirements define an acceptable result. They may specify types, resource
   names or parameters, workload roles and counts, native configuration keys,
   secret bindings, provider profiles, protocol values, and connection names.
   These are requirements, not proof that the source supports them. If the
   pinned revision cannot meet one, report the conflict instead of choosing an
   easier default or inventing compatibility.
2. **Deployment entry points.** The search starts with the relevant Dockerfile
   and the production manifests, Compose or Helm files, deployment scripts, and
   startup files at the pinned revision. These establish the build context,
   deployment units, processes, commands, ports, and configuration files worth
   tracing. In a monorepo, stay within that deployment path unless a runtime
   reference crosses into another service.
3. **One candidate profile.** Among profiles that meet the acceptance criteria,
   prefer production deployment assets, then a matching quickstart, then a
   complete repository example, and use defaults last. When sources disagree,
   the files used by the selected build and startup path take precedence. Never
   combine settings or services from different profiles or source revisions.
   The chosen profile must perform the application's primary operation without
   manual setup. Reject a health or metrics-only process, a login or setup
   screen as the terminal result, placeholder configuration, empty pipeline,
   idle process, or any path that still needs feature-critical configuration
   after deployment. Normal authentication before the primary operation is not
   itself an incomplete profile. Every service used by the chosen profile is
   required, while an installed package, optional extra, test, adapter, or
   unselected example does not add a dependency.
   Before concluding that no complete profile exists, assess every candidate
   already surfaced by the entry-point search and give its specific
   disqualifier. Do not infer a repository-wide absence from a sample of
   examples, and do not widen the search once the surfaced candidates are
   resolved.
4. **Runtime trace.** Follow each startup command into the configuration reads
   and client initialization it uses. Follow one request or primary protocol
   operation from its listener through middleware to the backing client, and
   treat a secret, flag, or option with an absent or false default as required
   when that path otherwise fails. For every selected workload, extract the
   image and build context, command and arguments, listeners and ports,
   environment and config parsing, secrets, writable and persistent paths,
   dependencies, protocol, TLS, authentication, bootstrap, backend choice, and
   feature flags. Inspect structured configuration and command-line flags as
   well as environment variables. Follow migrations, seed data, identities,
   and protocol surfaces when the primary operation depends on them.
5. **Completeness proof.** Keep a private note that follows one trigger or input
   through every role and required backing resource to an observable result.
   Link each acceptance criterion and planned property reference to its source
   evidence, the workload setting that consumes it, and, during type
   resolution, the exact schema or Recipe field. Do not print this note or add
   it to Bicep. Model only workloads and services supported by this evidence,
   and make every declared resource serve a workload in the trace.
6. **Stopping condition.** Exploration ends when the trace is complete and the
   pinned source supports every acceptance criterion. Unrelated files and
   unselected profiles need no further investigation. If no complete profile
   exists, report that boundary instead of returning a partial model. When
   several complete profiles remain, choose the best documented one with exact
   type and Recipe support, state the choice in the summary, and do not ask a
   modeling question the evidence can answer.

A gap in an essential role, dependency, target, bootstrap path, listener,
persistence path, build path, schema, or Recipe is terminal. Do not emit a
partial `app.bicep` and describe the missing piece as a limitation. Report the
gap instead, even when a partial model would compile or pass `check.mjs`.

When source supports both an external service and a compatible service
represented by an exact predefined Radius type, prefer the Radius-backed
profile. A developer-supplied external-service credential is not a shortcut
around an available type and Recipe. Keep the external profile only when the
acceptance criteria select it or no compatible Radius-backed source profile
exists, and cite the exact source or Recipe incompatibility that prevents the
Radius-backed profile.

A complete profile must also meet the applicable behavior:

| Behavior | What makes the profile complete |
|---|---|
| Proxy, gateway, or router | A configured, reachable upstream with the required authentication. A metadata store alone is insufficient. |
| Management client or explorer | A configured target service, including backend choice, subresource, TLS, and authentication. An internal metadata store is not that target. |
| Pipeline, worker, or event processor | A real input, the processing path, and a real output. Diagnostics or stdout alone do not qualify unless the source defines them as production behavior. |
| File or content service | The primary protocol listens, a noninteractive protocol user or bootstrap exists, and writable persistent storage preserves both primary content and durable service identity material. |
| Stateful web service or API | Its required stores, migration or bootstrap, credentials, and feature-enabling settings are configured. |

Exact service choice, provider profile, deployment names, and secret names or
keys are sometimes unknowable from source alone. The explicit request and
target contracts decide those cases.

## Type and Recipe resolution

Use the exact predefined Radius type when it fits. Do not substitute a similar
type or invent properties. The predefined types this skill may emit are:

| Need | Type |
|---|---|
| Application grouping | `Radius.Core/applications@2025-08-01-preview` |
| Container image and workload | `Radius.Compute/containerImages`, `Radius.Compute/containers` |
| MySQL, PostgreSQL, Neo4j, MongoDB, Redis, SQL Server | `Radius.Data/mySqlDatabases`, `Radius.Data/postgreSqlDatabases`, `Radius.Data/neo4jDatabases`, `Radius.Data/mongoDatabases`, `Radius.Data/redisCaches`, `Radius.Data/sqlServerDatabases` |
| Kafka or RabbitMQ | `Radius.Messaging/kafka`, `Radius.Messaging/rabbitMQ` |
| AI model endpoint or search | `Radius.AI/models`, `Radius.AI/search` |
| Object or persistent storage | `Radius.Storage/objectStorage`, `Radius.Compute/persistentVolumes` |
| Requested public ingress or application secrets | `Radius.Compute/routes`, `Radius.Security/secrets` |

This table only identifies candidate types. For every emitted type, resolve
four separate contracts:

1. **Compile-time type.** `.radius/bicepconfig.json` selects the Bicep
   extension. `bicep build` checks the model against that extension, but a clean
   compile proves only that the local extension accepts the shape.
2. **Registered schema.** When the target Radius control plane is available,
   run `rad resource-type show '<type>' --output json` and read
   `APIVersions.<version>.Schema`. This is the target's property shape,
   required fields, sensitivity markers, read-only properties, and API
   versions. `Radius.Core/applications` comes from Radius itself, not
   `resource-types-contrib`, and the command resolves it the same way.
3. **Registered Recipe.** Use the target Environment and resource group:

   ```sh
   rad recipe list --environment '<environment>' --group '<group>' --output json
   rad recipe show '<recipe-name>' --resource-type '<type>' \
     --environment '<environment>' --group '<group>' --output json
   ```

   These commands prove Recipe availability and show its template source and
   parameters.
4. **Recipe output mapping.** Read the Recipe Pack Bicep from the Environment
   setup or deployment source that created the registration. For a generated
   custom type, this is `.radius/custom-recipe-pack.bicep`. The `outputs` block
   maps module outputs to resource properties and managed-secret keys. When a
   wrapped Recipe omits that mapping, inspect the Recipe module's
   `result.values` and `result.secrets`. `rad recipe show` does not expose this
   mapping.

Choose one deployment contract before using provider-sensitive values. When a
target Environment is available, its registered schemas, Recipes, and Recipe
Pack source are authoritative. Otherwise use the fallback Azure AKS Recipe Pack
from `radius-project/resource-types-contrib` commit
`323e3fac5622fa3dad4f4c83b105b00f177496d9`; this is also the boundary used by
`check.mjs`. Derive the schema path from the type:
`Radius.Data/mySqlDatabases` becomes
`Data/mySqlDatabases/mySqlDatabases.yaml`. The Recipe Pack is
`recipe-packs/azure/aks-recipepack.bicep`. Do not combine a schema from one
revision or provider with a Recipe Pack from another. Apply this same boundary
to effective versions, endpoints, protocol, TLS, authentication, outputs, and
runtime evidence. If the exact target registration or fallback source is
unavailable, report that gap rather than guessing. The fallback commit is
declared here so model design never requires reading checker implementation.

Read each Recipe parameter mapping as well as its outputs. Compare every
authored resource property with the effective provider value after literal
defaults, conditionals, and supported-version mappings. If the Recipe changes a
requested version, protocol, authentication mode, or other compatibility
property, use an exact supported value or report the substitution and its risk.
Schema acceptance alone does not prove that the provider receives the authored
value. For a Recipe that directly invokes a provider module, an authored
property absent from every Recipe parameter mapping is ignored, even when the
resource schema accepts it; remove it only when the selected trace does not need
the behavior, otherwise report a terminal Recipe gap. A supported-value
substitution is valid when the source's protocol,
TLS, authentication, and feature requirements remain compatible. Record the
effective version and any compatibility risk in the response; `check.mjs`
doesn't make this source-dependent decision.

The target schema and Recipe are the deployment contract. They outrank mutable
extension metadata such as `radius:latest`, a branch, or a stale local artifact.
Every emitted type and property must resolve there. Read a Recipe-generated
property only when that Recipe maps it. A property explicitly set in the model
may be read back, but a provider-fixed literal needs proof from the concrete
provider contract. Never set a read-only property. If the needed mapping,
secret, omitted input, or Recipe is absent, report the gap instead of guessing,
wrapping, deleting required wiring, or generating a partial application
definition.

For a source version the type does not offer, select the highest supported
version that does not exceed it. When all supported versions are newer, use the
lowest one only with proof that protocol, TLS, and authentication stay
compatible. Otherwise generate a custom type or report the component as
unsupported. State any version substitution in the response and flag the
newer-server case as a compatibility risk. This choice must be deterministic.

When no predefined type fits and Azure can provision the essential service,
generate a `Radius.Resources/*` custom type as
[custom-resource-types.md](custom-resource-types.md) specifies. That reference
owns the custom schema, extension, Recipe, and Recipe-pack flow. If Azure cannot
provision it, report the unsupported essential component.

Match a compatible service by wire protocol rather than package name only when
the client's protocol version, TLS, and authentication match the Recipe
endpoint. Derive database, topic, queue, bucket, and other subresource values
from source configuration. Never use a provider-reserved database admin name:
Azure rejects `root`, `admin`, `administrator`, `guest`, `public`, and
`azure_superuser`; PostgreSQL also rejects `postgres`, `azuresu`,
`azure_pg_admin`, and names beginning `pg_`; SQL Server rejects `sa` and other
fixed logins. `check.mjs` applies those rules only when the Recipe's normalized
source exactly matches the corresponding Azure AVM database module. Use a
provider-safe name such as `myadmin`, and pass the same resource property or
literal to the application so the two values cannot drift.

## File shape and naming

Create or update `.radius/bicepconfig.json` before emitting the model. It must
enable extensibility and resolve `radius`, plus the local custom-types extension
when one is generated, including its locally generated tgz. Preserve unrelated
settings in an existing file and change only entries that conflict with
`app.bicep`. If a parent
`bicepconfig.json` would apply before the local file exists, copy compatible
settings into the new local file and adjust them there. The parent is input
only. When there is no usable input, use:

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

Use `radius:latest` only when no exact target contract is available. Otherwise
use a verified compatible immutable reference, and fail closed when the target
contract and extension disagree. An already-correct local configuration should
not change.

Always declare `extension radius`. Add a local custom-types extension only when
the application uses a generated custom type. Declare resources in this order:
extensions, `param environment string` and secure parameters for each
developer-supplied secret, one application, backing
resources, secret resources, container images, containers, then requested
routes. The application resource is exactly one
`Radius.Core/applications@2025-08-01-preview`.
Do not declare per-namespace or per-type extensions.

Use one `Radius.Compute/containers` resource per deployment unit. Put
co-scheduled roles in its `containers` map and use separate resources for
independently deployed roles. Declare backing resources before the workloads
that consume them. A generated image is consumed through
`<image>.properties.imageReference`, not a copied image value, and needs no
connection of its own.

Symbolic names are camelCase. Runtime-facing resource names and
`properties.containers` keys are lowercase RFC 1123 labels: lowercase letters,
digits, and hyphens, beginning and ending with an alphanumeric character. Keep
a container key at most 63 characters and leave room for a prefixed resource
name. Preserve a name, parameter, relationship, or native setting that an
explicit runtime, deployment, or Recipe contract requires verbatim.

The default symbols are `<shortName>App`, `<serviceName>Container`, and
`<serviceName>Image`; backing-resource symbols use a camelCase engine and role.
Use lowercase engine-and-role connection keys, such as `mysqldb`, and `web` for
the main HTTP port key. Resource names use the app name and role, such as
`<app-name>-<engine>` and `<app-name>-<role>`. For every selected Recipe,
inspect how its template uses `context.resource.name` and check the underlying
provider's name scope, length, and character rules. If the Recipe passes the
Radius name to a globally scoped provider name or DNS subdomain, append a
deterministic suffix derived from `environment` with `uniqueString`, within the
actual provider limits. Do not use randomness, deployment-time availability
probes, or a changing seed because repeat deployment must produce the same
name. Secrets follow the application-scoped form. Use a source-derived
subdirectory and a 40-character checkout SHA in a container-image
`build.source`.

Keep provider modules, SKUs, regions, firewall and network policy, and Recipe
output mapping out of `app.bicep`. It contains application intent and runtime
wiring. Generated Bicep has no explanatory comments or `@description`
decorators. The one exception is the functional `#disable-next-line` described
under [runtime configuration](#runtime-configuration-and-lifecycle).

## Images and build paths

Prove each application image has a complete build path from a clean checkout
through its exact Recipe. Inspect the build context, Dockerfile path,
`.dockerignore`, build arguments, every local `COPY` and `ADD`, generated
artifacts, target platforms, required Git metadata, and files generated outside
the Docker build. Reconcile the Dockerfile's effective user, entrypoint,
command, working directory, architecture, and declared volumes with every
mount and process setting in the final model. A copied source must exist in the
clean context, and a generated artifact must come from an earlier Dockerfile
stage rather than an unmodeled host build. Report a terminal packaging gap only
when the source evidence proves the build path is incomplete or unusable.

Never use Docker to build, pull, or run an image. Image execution is outside
the modeling workflow; static source inspection establishes the build path,
while Bicep compilation and `check.mjs` validate the generated model.

For the immutable release-image exception, resolve the exact digest from the
publisher's registry without pulling the image. Provenance and source tracing
waive only the source build; runtime compatibility still comes from the normal
source trace and is not established by modeling.

Pin `build.source` to `?ref=<40-character-commit-sha>` and set `tag` to that
same SHA. Use `//<subdirectory>` when the Dockerfile is below the repository
root, set `build.dockerfile` for a nonstandard Dockerfile name, and set
`build.args.BUILDKIT_CONTEXT_KEEP_GIT_DIR: '1'` when the build needs Git
metadata. Do not use mutable build refs or tags. If a Dockerfile runs
target-architecture binaries without a `BUILDPLATFORM` and `TARGETARCH`
strategy, set the one proven `build.platforms` value rather than relying on
multi-platform defaults or emulation. Set an explicit `build.platforms` value
unless the Dockerfile proves its cross-build behavior.

A Dockerfile that only packages an externally built artifact is not a source
build. A publisher image may replace it when a source-owned release workflow,
release manifest, or documentation proves that a published tag was built from
the selected revision. Resolve that tag through the publisher's registry and
author the resulting `image@sha256:<digest>`; the digest need not already
appear in source. If the registry cannot resolve the tag, report the packaging
gap rather than guessing. Published images are appropriate for genuine
third-party or backing containers and must be immutable. Digest provenance
does not prove runtime or backing-service compatibility, which still needs the
normal source trace. Do not make a required source build pass by quietly
substituting an unproven release image.

## Runtime configuration and lifecycle

Keep the image entrypoint and CMD unless the selected profile requires an
override: `command` replaces ENTRYPOINT and `args` replaces CMD, so setting one
can discard the other. A `containerPort` exposes a port but does not make the
process listen. Set the source-supported listener address and port, and make
them agree.

Use the exact configuration key, casing, syntax, and parser-safe value that the
pinned source reads. In particular, omit a value rather than setting `'false'`
when the parser treats every nonempty string as true. Supply every
feature-enabling or backend-selection setting, bootstrap setting, subresource,
protocol, TLS mode, authentication method, identity, endpoint transformation,
and final client syntax that the selected trace needs.

Match the lifecycle to the role. Run-to-completion work uses `OnFailure` or
`Never` for `restartPolicy`, stateful work has writable ownership and persistent storage, and the
selected profile has the migration, readiness, bootstrap, or identity path it
needs before its primary operation is available.

Before emitting a networked workload, resolve the effective listener from the
Dockerfile `ENV`, entrypoint, command, configuration, and application defaults.
A `containerPort` does not repair a loopback-only listener. Trace a normal
request through middleware and client construction, including required session,
cookie, CSRF, transport, and authentication settings whose omitted defaults
break that request. Before mounting a persistent volume, compare the image's
effective `USER` with the ownership and write behavior of a fresh mount; report
an ownership gap when neither the image nor the target container contract can
initialize it. A directory created or chowned in an image is not evidence for a
fresh external volume mounted over that directory: the mount hides the image's
ownership. Require an entrypoint that fixes ownership after mounting, a
provider-supported pod ownership setting, or an immutable root init-container
that initializes only the required paths; otherwise stop.

Treat provider-required TLS as an application-client requirement. Prove that
the exact client constructor or connection parser receives its TLS option,
certificate mode, or TLS-enabled URL. A secure provider endpoint, port, or an
environment variable the source never reads does not enable client TLS.

When an unmodified image needs a config file, put complete noncredential
content in `Radius.Security/secrets.data`, mount it with `volumeMounts` and a
`volumes` entry whose `secretName` uses that secret name, and point the process at the mount. The
process uses `args` for that mounted config path. The
only permitted generated-Bicep suppression is:

```bicep
#disable-next-line use-secure-value-for-secure-inputs
'app.yaml': { value: '<complete noncredential config file content>' }
```

The compile must otherwise be warning-free. Put credentials in a secure
parameter or `secretKeyRef`, and reference them from the file only when its
format supports that safely. Generate a file at startup only when the image has
the required shell and tools and the destination is writable.

## Connections and secrets

Declare a connection for every backing resource a workload consumes. A direct
reference orders deployment but does not create the application graph
relationship. The connection does not replace the application's native
configuration.

By default a connection injects nonsecret
`CONNECTION_<NAME>_<PROPERTY>` values. `disableDefaultEnvVars` suppresses that
only when the exact container schema supports it, and connection-driven cloud
RBAC applies only to supported IAM relationship kinds. Sensitive values are not
injected. Bind them with `valueFrom.secretKeyRef`, using the exact nested
`<resource>.properties.secrets.name` and key declared by the Recipe. A resource
with a secret usually needs both the connection and that explicit binding.
Never hand-author a `CONNECTION_*` value for an unconnected resource.

Pass a developer-supplied credential from the same `@secure()` parameter
directly to the resource property and, when the workload consumes it, to
`env.value`. Do not wrap it in an authored secret or send it through
`secretKeyRef`. Author `Radius.Security/secrets` only for a genuine application
secret, a noncredential config file, or a schema-required `secretName`.
When the schema uses `username` and `password`, set them on the resource. When
it uses `secretName`, create and reference the required secret. Supply neither
when the schema takes no credentials.

Never author a secret that copies a Recipe output. Do not read a managed-secret
key as a convenience property, use a placeholder for it, or compose it into a
larger template-time value, which would put the combined secret in deployment
state. Bind a compatible published connection string or
URL as the exact managed-secret key when the source accepts one. Otherwise bind
parts separately and let the application compose them at runtime only when the
application provides the required encoding.

For every selected Recipe, determine from its template whether provider
authentication is enabled and which published values form a working
connection. Endpoint fields alone do not satisfy an authenticated provider;
bind a compatible managed URL or connection string when the application accepts
one, or bind every required part separately.

Kubernetes expands `$(VAR)` only from variables emitted earlier in the final
container env list, but the Recipe Pack's container entry currently points to a
mutable Recipe artifact, so its exact ordering isn't a stable contract. Don't
compose authored plain env values from other plain or connection-derived env
values. Binding a complete value with `secretKeyRef` avoids this ordering
dependency. URL-encode credentials before placing them in URL userinfo;
Kubernetes and shell substitution don't encode them. If the source accepts
neither a complete managed URL nor separate
fields and the image has no safe runtime encoder, report the composition gap.
Expanding a secret into `command` or `args` exposes it in the process list.

## Routes and provider boundary

Do not declare a `Radius.Compute/routes` resource unless the request explicitly
asks for public exposure. A container port is reachable inside the cluster and
can be port-forwarded locally; a browser interface alone does not imply public
ingress. Provider implementation choices stay outside the application model as
described in [file shape and naming](#file-shape-and-naming).

## Worked example

This model shows how the rules fit together for a web workload that requires
Redis. The repository URL, commit SHA, port, and `REDIS_URL` key must come from
the source being modeled; they are concrete here only to make the relationships
clear. This is an example of the shape, not a source of defaults.

```bicep
extension radius

param environment string

resource exampleApp 'Radius.Core/applications@2025-08-01-preview' = {
  name: 'example-app'
  properties: {
    environment: environment
  }
}

resource cache 'Radius.Data/redisCaches@2025-08-01-preview' = {
  name: 'example-app-redis'
  properties: {
    environment: environment
    application: exampleApp.id
    size: 'S'
  }
}

resource webImage 'Radius.Compute/containerImages@2025-08-01-preview' = {
  name: 'example-app-web-image'
  properties: {
    environment: environment
    application: exampleApp.id
    tag: '0123456789abcdef0123456789abcdef01234567'
    build: {
      source: 'git::https://github.com/example/example-app.git?ref=0123456789abcdef0123456789abcdef01234567'
      platforms: [
        'linux/amd64'
      ]
    }
  }
}

resource webContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'example-app-web'
  properties: {
    environment: environment
    application: exampleApp.id
    containers: {
      web: {
        image: webImage.properties.imageReference
        ports: {
          web: {
            containerPort: 3000
          }
        }
        env: {
          REDIS_URL: {
            valueFrom: {
              secretKeyRef: {
                secretName: cache.properties.secrets.name
                key: 'url'
              }
            }
          }
        }
      }
    }
    connections: {
      rediscache: {
        source: cache.id
        disableDefaultEnvVars: true
      }
    }
  }
}
```

The image comes from an immutable checkout and is consumed through
`imageReference`. The workload uses the Recipe-managed `url` secret, while the
connection records the application graph edge; default connection variables
are disabled because this profile uses its native `REDIS_URL` setting. There is
no route because the example does not request public exposure.

## Verification

Follow [Compile and check](../SKILL.md#compile-and-check). Fix every checker
finding and stop on a repeated signature. The generated model must compile
without warnings, return `ALLOW`, and preserve every required backend
activation, native value, secret binding, and dependency edge.

Close the private trace by checking that its input reaches the chosen workload,
all required services, and the stated result with source-supported
configuration in the final generated files, independently of what the checker
tests. A runtime probe supports only the exact bytes and provider boundary it
ran; a changed TLS mode, image, command, environment value, or backing Recipe
must be disclosed and cannot validate the final model. Compile success, checker
acceptance, and a starting process are each incomplete on their own. Report a
schema, Recipe, target Environment, source-build, or unsupported-component gap
rather than a partial model with an unresolved runtime caveat. Describe only
the checks that actually ran; don't call the result deployable, working,
complete, or broadly validated when an essential caveat remains or deployment,
build, or runtime execution did not establish those claims.
