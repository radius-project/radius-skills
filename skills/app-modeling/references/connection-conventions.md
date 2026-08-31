# Connection Conventions

## What a connection does

A `Radius.Compute/containers` connection declares a generic Radius relationship to another resource. It can project resource properties into the workload, but it does **not** translate them into arbitrary names or formats expected by an application.

Connection projection is version-specific. Depending on the Radius/container schema and recipe, a connection may provide:

- a `CONNECTION_<NAME>_PROPERTIES` JSON value;
- individual `CONNECTION_<NAME>_<PROPERTY>` values, including secret-backed values for Recipe-declared secret outputs;
- relationship metadata; and/or
- no sensitive outputs.

Inspect the exact configured extension, registered resource schema, recipe output mapping, and Radius runtime before relying on any projection shape. Do not infer it from a different version's documentation.

## Compatibility and gradual adoption

Secret-backed `CONNECTION_*` projection is behavior of the Kubernetes Container Recipe. It requires compatible Radius control-plane support ([radius#12709](https://github.com/radius-project/radius/pull/12709)) and compatible Container Recipes ([resource-types-contrib#300](https://github.com/radius-project/resource-types-contrib/pull/300) or later). Verify the configured schema, Radius runtime, deployment target, and exact Recipe contract before relying on it; mixed or older installations must not be assumed to support secret projection.

If compatibility cannot be proven, preserve or use existing schema-supported wiring: explicit `env`, `valueFrom.secretKeyRef`, `envFrom`, the application's native variable, or another supported binding. Do not emit a connection-only model that depends on unverified projection. Do not automatically rewrite an existing working `app.bicep`; migration requires explicit user intent.

Azure Container Instances (ACI) behavior is unchanged. Do not recommend Kubernetes secret-backed connection projection for ACI.

## Decide wiring from source

For every dependency:

1. Inspect source, entrypoint, compose, and configuration files for the exact values the workload reads.
2. Record the selected profile's required names, casing, defaults, types, literal values, URL/config syntax, endpoint transformations, and secret handling.
3. Inspect the exact resource outputs and connection projection supplied by the target schema and recipe.
4. Prove the full client tuple: subresource, complete endpoint, port, protocol/version, TLS, auth mechanism, secret, and final source-supported format.
5. Select the wiring for each app-native value:
   - explicit `env.value` from a verified nonsecret output or literal;
   - a connection to a user-authored input Secret via `source: <secret>.id`;
   - a producer connection via `source: <producer>.id`, which projects Recipe-declared secret outputs as secret-backed connection variables;
   - `valueFrom.secretKeyRef` via `<producer>.properties.secrets.name` and an exact declared key only when the source requires a custom Kubernetes environment-variable name;
   - runtime composition; or
   - generic connection projection only when the source explicitly consumes that applicable contract.

An unmodified third-party image usually expects its own native variables or configuration. A connection alone does not configure it unless its source already understands the projected `CONNECTION_*` contract. A provider-specific `host` output may also require a documented suffix, port, TLS mode, or auth block before it is a usable client endpoint. Requiring an operator to configure the dependency later through an admin UI or API does not make the generated deployment runnable.

## Source consumes the generic contract

When the application explicitly parses the exact projection supplied by the target Radius version, or the selected profile explicitly requires Radius relationship metadata, declare the relationship with the required key:

```bicep
connections: {
  database: {
    source: database.id
  }
}
```

`connections` is a top-level object map under container resource `properties`, not inside an individual container.

### Input and output credential connections

Input and output credentials use different connection sources:

```bicep
connections: {
  credentials: {
    source: appCredentials.id
  }
  database: {
    source: database.id
  }
}
```

- `appCredentials` is an authored or reused `Radius.Security/secrets` input needed by this workload. Connect the Secret resource itself with `source: appCredentials.id`.
- `database` is a producer whose wrapped Recipe declares secret outputs under `result.secrets`. Connect only the producer with `source: database.id`; do not add a connection to `database.properties.secrets.name`.

For each declared Recipe secret output, a compatible Kubernetes Container Recipe injects a secret-backed environment variable named `CONNECTION_<CONNECTION>_<SECRETKEY>`. `<CONNECTION>` comes from the connection key and `<SECRETKEY>` comes from the exact Recipe `result.secrets` key. Both are uppercased by the generated-name contract. For example, a `database` connection and key `connectionString` produce `CONNECTION_DATABASE_CONNECTIONSTRING`. Never substitute a generic suffix unless it is the actual key.

For the same generated name, precedence is: an explicit container `env` entry, then a managed secret reference, then an ordinary property value. Use explicit precedence for a deliberate override. Two secret-backed names that collide after uppercasing are invalid and must be surfaced rather than silently resolved. Set `disableDefaultEnvVars: true` only when the exact schema supports it and all generated variables for that connection must be suppressed; never set it when the workload relies on one of them.

## Source expects native configuration

Map every required input to the exact name the source consumes:

```bicep
containers: {
  api: {
    image: apiImage.properties.imageReference
    env: {
      APP_DB_HOST: {
        value: database.properties.host
      }
    }
  }
}
```

This is a representative nonsecret mapping, not a required variable naming scheme. Confirm that `host` is explicitly mapped by the exact Recipe and that the app-native variable exists in the pinned source. Credentials still follow the input Secret or producer-output rules above. If a developer-owned credential also needs a different native environment name, an explicit schema-supported binding may coexist with the Secret connection. Direct resource references create dependency ordering, so a connection is not required merely to order deployment.

Keep a connection alongside native variables when the source consumes generic values or the selected profile explicitly requires Radius relationship metadata. Explicit native variables are not categorically forbidden just because generic projection exists. Ensure duplicate names do not carry conflicting values.

## Rules

1. Never assume a connection invents app-specific variables, URLs, credentials, database names, or protocol settings.
2. Never assume one universal JSON or scalar `CONNECTION_*` projection. Verify the target version.
3. Recipe-declared secret outputs are projected by the producer connection as secret-backed `CONNECTION_<CONNECTION>_<SECRETKEY>` values. The suffix follows the exact Recipe output key. Do not connect the managed Secret separately.
   When the application requires a different environment-variable name, add an explicit `env.valueFrom.secretKeyRef` using `<producer>.properties.secrets.name` and the declared key. Explicit `env` takes precedence over a generated variable with the same name.
4. Reference a nonsecret read-only output only when the exact schema exposes it and the exact target Recipe maps it. Do not **set** read-only properties.
5. Apply the exact precedence order: explicit `env`, managed secret reference, ordinary property. Reject two secret-backed names that collide after uppercasing.
6. Use `disableDefaultEnvVars` only on the connection entry, only when the exact container schema supports it, and only when all generated variables from that connection should be disabled.
7. Treat case, number-to-string conversion, URL encoding, TLS mode, and protocol-specific formatting as part of the app's runtime contract.
8. Preserve exact relationship names and provider/runtime values supplied by an explicit compatible profile; do not normalize them to generic defaults.
9. Do not count a connected resource as used unless the selected feature path consumes its projection or explicit native wiring.
10. If schema drift blocks a required producer connection, authored Secret connection, or custom native secret binding, resolve a compatible extension or fail closed. Never invent a managed Secret connection or guessed output suffix to obtain a clean compile.