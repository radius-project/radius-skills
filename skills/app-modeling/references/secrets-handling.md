# Secrets and Credentials

Secret behavior is part of the exact resource type, extension, recipe, and container contract. Do not copy a secret path or key from another type or version.

## Resolve the contract first

For every secret, inspect:

1. the exact registered resource schema for sensitive input properties, secret references, read-only outputs, and key names;
2. the configured recipe's parameters and output mapping;
3. the exact `Radius.Security/secrets` and `Radius.Compute/containers` schemas for authored-secret and `secretKeyRef` support; and
4. the application source for the final native variable/configuration name and required format.

Preserve the application's exact environment contract. On a compatible Kubernetes Container Recipe, connection projection uses `CONNECTION_<CONNECTION>_<SECRETKEY>`; the suffix follows the authored Secret data key or Recipe `result.secrets` key. Preserve explicit `env`, `secretKeyRef`, `envFrom`, or native-variable wiring when compatibility is unproven, the target is ACI, or the application requires a different name. Never automatically rewrite an existing working model.

Never hardcode passwords, tokens, keys, or credential-bearing URLs. Use a `@secure()` parameter for developer-supplied Bicep inputs, and place workload-consumed input credentials in a user-authored `Radius.Security/secrets` resource.

## Developer-supplied secret inputs

Follow the exact resource schema:

- If it defines an `x-radius-sensitive` property such as `password`, set that property from a `@secure()` parameter.
- If it accepts a Secret resource or the workload consumes a proven-compatible Secret connection, author or reuse `Radius.Security/secrets` and use that resource's `.id`.
- If it defines no credential input, do not invent one.

When a workload consumes a developer-supplied credential through connection projection, author or reuse `Radius.Security/secrets` and connect that Secret by `.id`. A sensitive backing-resource input is not readable back from that producer. Do not author a second Secret when no Secret connection/schema input is needed:

```bicep
@secure()
param password string

resource appCredentials 'Radius.Security/secrets@2025-08-01-preview' = {
  name: 'app-credentials'
  properties: {
    environment: environment
    application: app.id
    data: {
      password: {
        value: password
      }
    }
  }
}

resource apiContainer 'Radius.Compute/containers@2025-08-01-preview' = {
  name: 'api'
  properties: {
    environment: environment
    application: app.id
    connections: {
      credentials: {
        source: appCredentials.id
      }
    }
  }
}
```

The connection injects secret-backed `CONNECTION_CREDENTIALS_PASSWORD` only on a compatible Kubernetes Container Recipe. The suffix follows the authored `password` key. Confirm the source consumes that name; otherwise preserve an explicit supported native binding alongside the connection. Do not use this pattern to copy a Recipe output.

## Recipe-generated secret outputs

Some recipes generate sensitive values such as access keys, URLs, or connection strings. Their contract varies:

- a schema version may expose a managed-secret reference and declared secret keys;
- another version may use a different output shape or key names; or
- the configured recipe may not expose the value in a form containers can bind.

When the exact schema and wrapped Recipe declare generated credentials under `result.secrets`, connect only the producer:

```bicep
connections: {
  service: {
    source: service.id
  }
}
```

A compatible Kubernetes Container Recipe injects each declared secret output as a secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` environment variable. The connection key supplies `<CONNECTION>` and the exact `result.secrets` key supplies `<SECRETKEY>`; both are uppercased. For example, connection `service` plus key `apiKey` produces `CONNECTION_SERVICE_APIKEY`. Do not guess a suffix or connect the managed Secret separately.

When the application requires a custom Kubernetes environment-variable name instead of the generated connection name, bind the same Recipe output explicitly:

```bicep
APP_API_KEY: {
  valueFrom: {
    secretKeyRef: {
      secretName: service.properties.secrets.name
      key: 'apiKey'
    }
  }
}
```

`properties.secrets.name` is the public native Secret-name output for this explicit Kubernetes binding. The key must be declared by the exact Recipe output contract. The Secret name is not a Radius connection source.

For the same generated name, precedence is explicit `env`, then a managed secret reference, then an ordinary property value. Two secret-backed names that collide after uppercasing are invalid and must be surfaced rather than silently resolved. Set `disableDefaultEnvVars: true` only when all generated variables for that connection must be suppressed; omit it when one is required.

Never create an authored `Radius.Security/secrets` wrapper whose `data` copies a Recipe-generated value. If the exact contract exposes neither the required generated variable nor the name/key needed for a custom binding, report the schema/Recipe gap rather than placing the credential in plain state.

## Runtime composition

Applications often require one URL or config value that embeds a secret. Bicep interpolation would materialize the combined value before the container starts, so prefer runtime composition:

1. Bind the secret into a helper environment variable through an authored Secret connection for a developer-supplied credential, through the producer's generated secret-backed connection variable for a Recipe output, or through `secretKeyRef` from `<producer>.properties.secrets.name` when a custom native name is required.
2. Bind nonsecret host, port, database, and username values from verified outputs or literals.
3. Declare the helper before dependent values when the runtime requires ordering.
4. Compose the final app-native value in the container runtime or let the application construct it. The final key and syntax must exactly match the selected pinned-source contract.

For a non-URL format, compose from the exact generated input Secret or producer connection variable at runtime:

```bicep
env: {
  APP_DATABASE_OPTIONS: {
    // mysql is the database resource symbol; substitute your actual resource
    value: 'host=${mysql.properties.host};password=$(DB_PASSWORD)'
  }
}
```

Replace the redacted credential with the exact generated connection variable in a verified runtime composition path. Kubernetes expands `$(VAR_NAME)` only from variables declared earlier in the environment list. Confirm the exact container Recipe orders generated connection variables before explicit values that reference them, and preserve escaping through Bicep and any shell/config layer. Confirm the image has every shell or utility used by an entrypoint wrapper.

Credentials embedded in URLs must be URL-encoded. Kubernetes variable expansion does not encode them; use application logic or a verified runtime helper. If safe encoding cannot be guaranteed, do not generate a fragile connection string.

Do not assume an unconstrained developer-supplied password is URL-safe, recommend a restricted character set as a workaround, or treat shell expansion as encoding. Prefer source-native decomposed host, port, database, username, password, and TLS flags or fields when the application safely assembles the final client value.

### Authored secrets are not composition engines

`Radius.Security/secrets` can carry an exact application secret, but it does not turn Bicep interpolation into runtime composition. Never manufacture an aggregate credential-bearing URL or configuration in authored `data.value`, regardless of whether its other parts come from outputs, parameters, variables, or literals.

When the application accepts only one credential-bearing value, choose one proven path:

1. Consume an exact, source-compatible secret-backed connection string declared by the producer Recipe.
2. Bind the parts separately and use a verified application, entrypoint, or helper that safely encodes and composes them at runtime.

If neither path exists, report the schema/application contract gap and do not emit a definition described as deployable.

## Checklist

- The input Secret resource/connection, producer connection, Recipe `result.secrets` key, and any custom native Secret name/key all exist in the exact configured schemas and Recipe.
- Secret-backed projection is used only with proven-compatible Kubernetes Container Recipes; ACI and older/unknown contracts retain supported fallback wiring.
- Every container variable uses the exact native name and format read by source.
- Every developer-supplied credential used through connection projection is stored in a user-authored `Radius.Security/secrets` and connected by `.id`.
- Recipe-generated credentials come from the producer connection's secret-backed variable; its suffix follows the exact Recipe output key.
- A custom native environment-variable name uses `<producer>.properties.secrets.name` and the declared key.
- No authored secret `data.value` references a recipe resource output or guessed convenience property.
- No authored secret `data.value` interpolates an aggregate credential-bearing URL/config.
- No secret is hardcoded, assumed URL-safe, or assumed to have a generated suffix not derived from the exact authored data/`result.secrets` key; colliding secret-backed names after uppercasing are rejected.
- Generated-name precedence is explicit `env`, managed secret reference, then ordinary property.
- Existing working `app.bicep` files are not automatically migrated to connection projection.
- A user-authored input Secret is connected through its `.id`; a Recipe-owned output Secret is never connected separately.
- `secretKeyRef` binds a Recipe-generated value through the producer's exact read-only `properties.secrets.name` and declared key only when a custom native name is required.
- Runtime composition preserves dependency order, escaping, encoding, and image entrypoint behavior.
- A final credential-bearing URL/config is bound from a matching managed secret or safely composed at runtime; it is never reconstructed in Bicep or an authored secret.
