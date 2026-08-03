import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALLOW,
  AZURE_GLOBAL_NAME_SOURCES,
  AZURE_RECIPE_PACK_URL,
  DENY,
  RESOURCE_TYPES_CONTRIB_COMMIT,
  RecipeContractError,
  check,
  compileRecipePack,
  constrainedContract,
  contractFaults,
  environmentUniqueAzureName,
  fetchRecipePack,
  findBicepConfig,
  main,
  makeResult,
  recipeContractFromPackArm,
  recipeSourceKey,
  signatureOf,
} from "../../skills/app-modeling/scripts/check.mjs";

function resource(type, properties = {}) {
  return { type, properties: { properties } };
}

function namedResource(type, name, properties = {}) {
  return { type, properties: { name, properties } };
}

function recipePack(recipes) {
  return {
    resources: {
      pack: resource("Radius.Core/recipePacks@2025-08-01-preview", { recipes }),
    },
  };
}

test("normalizes compiled Recipe Pack ARM and omits output-less Recipes", () => {
  const contract = recipeContractFromPackArm(
    recipePack({
      "Radius.Data/postgreSqlDatabases": {
        source:
          "mcr.microsoft.com/bicep/avm/res/" +
          "db-for-postgre-sql/flexible-server:0.15.2",
        outputs: { host: "fqdn" },
      },
      "Radius.Compute/containers": {
        source: "ghcr.io/radius-project/kube-recipes/containers:latest",
      },
    }),
  );
  assert.deepEqual(contractFaults(contract), []);
  assert.deepEqual(
    contract.types["Radius.Data/postgreSqlDatabases"].reservedPrefixes.username,
    ["pg_"],
  );
  assert.equal(Object.hasOwn(contract.types, "Radius.Compute/containers"), false);
  assert.deepEqual(contract.recipeTypes, [
    "Radius.Compute/containers",
    "Radius.Data/postgreSqlDatabases",
  ]);
});

test("rejects a Recipe contract that loses output-less type membership", () => {
  assert.match(
    contractFaults({
      types: {
        "Radius.Data/postgreSqlDatabases": {
          source: "example.test/postgres:1",
          outputs: { host: "hostname" },
        },
      },
    }).join("\n"),
    /recipeTypes/u,
  );
});

test("applies Azure restrictions only to exact normalized module sources", () => {
  assert.equal(
    recipeSourceKey(
      "mcr.microsoft.com/bicep/avm/res/sql/server@sha256:abc",
    ),
    "avm/res/sql/server",
  );
  assert.equal(
    Object.hasOwn(
      constrainedContract(
        "example.test/avm/res/sql/server-wrapper:1.0",
        { host: "fqdn" },
      ),
      "reserved",
    ),
    false,
  );
});

test("rejects conflicting case-insensitive Recipe definitions", () => {
  assert.throws(
    () =>
      recipeContractFromPackArm(
        recipePack({
          "Radius.Data/redisCaches": {
            source: "one",
            outputs: { host: "first" },
          },
          "radius.data/rediscaches": {
            source: "two",
            outputs: { host: "second" },
          },
        }),
      ),
    /conflicting Recipe definitions/u,
  );
});

test("fetches the fixed raw pack with bounded response size", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested;
  globalThis.fetch = async (url) => {
    requested = url;
    return new Response("extension radius");
  };
  assert.equal(await fetchRecipePack(), "extension radius");
  assert.equal(requested, AZURE_RECIPE_PACK_URL);
  assert.match(AZURE_RECIPE_PACK_URL, new RegExp(RESOURCE_TYPES_CONTRIB_COMMIT, "u"));
  assert.doesNotMatch(AZURE_RECIPE_PACK_URL, /\/main\//u);

  globalThis.fetch = async () => new Response("too large");
  await assert.rejects(
    fetchRecipePack(AZURE_RECIPE_PACK_URL, 1_000, 3),
    (error) =>
      error instanceof RecipeContractError &&
      error.message.includes("3-byte download limit"),
  );
});

test("rejects invalid UTF-8 Recipe Pack downloads", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(Uint8Array.from([0xff]), {
      headers: { "content-type": "text/plain" },
    });
  await assert.rejects(
    fetchRecipePack(),
    (error) =>
      error instanceof RecipeContractError &&
      error.message.includes("valid UTF-8"),
  );
});

test("compiles beside the active Bicep configuration and cleans up", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "checker-node-"));
  const previousBinary = process.env.BICEP_BINARY;
  try {
    const radius = path.join(temporary, ".radius");
    fs.mkdirSync(radius);
    const config = path.join(radius, "bicepconfig.json");
    fs.writeFileSync(config, "{}");
    const compiler = path.join(temporary, "fake-bicep.mjs");
    const compiled = recipePack({
      "Radius.Data/redisCaches": {
        source: "example.test/redis:1.0",
        outputs: { host: "hostname" },
      },
    });
    fs.writeFileSync(
      compiler,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(compiled),
      )});\n`,
      { mode: 0o755 },
    );
    process.env.BICEP_BINARY = compiler;

    assert.equal(findBicepConfig(temporary), config);
    const contract = compileRecipePack("extension radius", config);
    assert.equal(
      contract.types["Radius.Data/redisCaches"].outputs.host,
      "hostname",
    );
    assert.deepEqual(
      fs.readdirSync(radius).filter((name) =>
        name.startsWith(".recipe-contract-"),
      ),
      [],
    );
  } finally {
    if (previousBinary === undefined) delete process.env.BICEP_BINARY;
    else process.env.BICEP_BINARY = previousBinary;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the removed --recipes option is rejected", async () => {
  const stdout = { value: "", write(text) { this.value += text; } };
  const stderr = { value: "", write(text) { this.value += text; } };
  const code = await main(
    ["arm.json", "--recipes", "contract.json", "--diagnostics", "app.sarif"],
    stdout,
    stderr,
  );
  assert.equal(code, 2);
  assert.match(stderr.value, /unrecognized arguments: --recipes/u);
  assert.equal(stdout.value, "");
});

function arm(resources, parameters = {}) {
  return { parameters, resources };
}

function appResource() {
  return resource("Radius.Core/applications@2025-08-01-preview", {
    environment: "[parameters('environment')]",
  });
}

function containerResource(properties) {
  return resource("Radius.Compute/containers@2025-08-01-preview", {
    application: "[reference('app').id]",
    ...properties,
  });
}

function findingCodes(findings) {
  return findings.map(({ code }) => code);
}

const EMPTY_CONTRACT = { types: {}, recipeTypes: [] };
const POSTGRES_KIND = "Radius.Data/postgreSqlDatabases";
const POSTGRES_CONTRACT = {
  types: {
    [POSTGRES_KIND]: {
      source: "example.test/postgres:1",
      outputs: {
        host: "hostname",
        secrets: { password: "administratorPassword" },
      },
      reserved: { username: ["postgres", "root"] },
      reservedPrefixes: { username: ["pg_"] },
    },
  },
  recipeTypes: [POSTGRES_KIND],
};

function assertHasCode(findings, code) {
  assert.equal(
    findingCodes(findings).includes(code),
    true,
    `expected ${code}; got ${JSON.stringify(findings)}`,
  );
}

function assertLacksCode(findings, code) {
  assert.equal(
    findingCodes(findings).includes(code),
    false,
    `did not expect ${code}; got ${JSON.stringify(findings)}`,
  );
}

function databaseResource(properties = {}) {
  return resource(`${POSTGRES_KIND}@2025-08-01-preview`, properties);
}

function connectedWorkload(container, extra = {}) {
  return containerResource({
    containers: { web: container },
    connections: {
      database: { source: "[reference('database').id]" },
    },
    ...extra,
  });
}

for (const { name, compilerOutput, denied } of [
  { name: "empty diagnostics", compilerOutput: "", denied: false },
  {
    name: "clean SARIF",
    compilerOutput: '{"runs":[{"results":[]}]}',
    denied: false,
  },
  {
    name: "compiler finding",
    compilerOutput:
      '{"runs":[{"results":[{"ruleId":"BCP081","message":{"text":"unknown type"}}]}]}',
    denied: true,
  },
  { name: "plain compiler output", compilerOutput: "error: boom", denied: true },
  { name: "empty SARIF runs", compilerOutput: '{"runs":[]}', denied: true },
  { name: "malformed SARIF", compilerOutput: '{"runs":"bad"}', denied: true },
]) {
  test(`compiler diagnostics: ${name}`, () => {
    const findings = check(
      arm({ app: appResource() }),
      EMPTY_CONTRACT,
      compilerOutput,
    );
    if (denied) assertHasCode(findings, "compiler-diagnostic");
    else assertLacksCode(findings, "compiler-diagnostic");
  });
}

test("reads diagnostics from every SARIF run and preserves line numbers", () => {
  const compilerOutput = JSON.stringify({
    runs: [
      { results: [] },
      {
        results: [
          {
            ruleId: "BCP081",
            message: { text: "unknown type" },
            locations: [{ physicalLocation: { region: { startLine: 12 } } }],
          },
        ],
      },
    ],
  });
  const findings = check(
    arm({ app: appResource() }),
    EMPTY_CONTRACT,
    compilerOutput,
  );
  assert.ok(
    findings.some(
      ({ code, message }) =>
        code === "compiler-diagnostic" && message.includes("line 12"),
    ),
  );
});

for (const { name, model, denied } of [
  {
    name: "symbolic resources",
    model: arm({ app: appResource() }),
    denied: false,
  },
  {
    name: "classic resource array",
    model: { resources: [] },
    denied: true,
  },
]) {
  test(`extension resolution: ${name}`, () => {
    const findings = check(model, EMPTY_CONTRACT);
    if (denied) assertHasCode(findings, "unresolved-extension");
    else assertLacksCode(findings, "unresolved-extension");
  });
}

for (const { name, resources, denied } of [
  { name: "exactly one application", resources: { app: appResource() }, denied: false },
  { name: "no application", resources: {}, denied: true },
  {
    name: "two applications",
    resources: { app: appResource(), other: appResource() },
    denied: true,
  },
  {
    name: "conditional application",
    resources: { app: { ...appResource(), condition: true } },
    denied: true,
  },
  {
    name: "copied application",
    resources: {
      app: { ...appResource(), copy: { name: "apps", count: 2 } },
    },
    denied: true,
  },
]) {
  test(`application count: ${name}`, () => {
    const findings = check(arm(resources), EMPTY_CONTRACT);
    if (denied) assertHasCode(findings, "application-count");
    else assertLacksCode(findings, "application-count");
  });
}

for (const { name, body } of [
  { name: "non-object resource", body: "bad" },
  {
    name: "missing properties",
    body: { type: "Radius.Compute/containers@2025-08-01-preview" },
  },
  {
    name: "non-object properties",
    body: {
      type: "Radius.Compute/containers@2025-08-01-preview",
      properties: "bad",
    },
  },
  {
    name: "containers array",
    body: containerResource({ containers: [] }),
  },
  {
    name: "non-object container",
    body: containerResource({ containers: { web: "bad" } }),
  },
]) {
  test(`resource shape: ${name}`, () => {
    assertHasCode(
      check(arm({ app: appResource(), workload: body }), EMPTY_CONTRACT),
      "malformed-resource",
    );
  });
}

test("malformed documents and contracts do not crash the checker", () => {
  for (const document of [
    null,
    [],
    "",
    0,
    true,
    {},
    { resources: null },
    { resources: { app: null } },
  ]) {
    assert.doesNotThrow(() => check(document, EMPTY_CONTRACT));
  }
  for (const contract of [null, [], "", 0, true, {}, { types: "bad" }]) {
    assert.doesNotThrow(() => check(arm({ app: appResource() }), contract));
  }
});

for (const { name, source, variables = {}, denied } of [
  {
    name: "missing ref",
    source: "git::https://github.com/example/app.git",
    denied: true,
  },
  {
    name: "branch ref",
    source: "git::https://github.com/example/app.git?ref=main",
    denied: true,
  },
  {
    name: "release tag ref",
    source: "git::https://github.com/example/app.git?ref=v1.2.3",
    denied: true,
  },
  {
    name: "commit ref",
    source:
      "git::https://github.com/example/app.git" +
      "?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    denied: false,
  },
  {
    name: "commit ref through variable",
    source: "[variables('source')]",
    variables: {
      source:
        "git::https://gitlab.com/example/app.git" +
        "?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    denied: false,
  },
  {
    name: "unresolvable parameter",
    source: "[parameters('source')]",
    denied: false,
  },
  { name: "unreadable URL", source: "http://[bad?ref=main", denied: false },
]) {
  test(`build source: ${name}`, () => {
    const model = arm({
      app: appResource(),
      image: resource("Radius.Compute/containerImages@2025-08-01-preview", {
        build: { source },
      }),
      workload: containerResource({
        containers: {
          web: { image: "[reference('image').properties.imageReference]" },
        },
      }),
    });
    model.variables = variables;
    const findings = check(model, EMPTY_CONTRACT);
    if (denied) assertHasCode(findings, "mutable-build-source");
    else assertLacksCode(findings, "mutable-build-source");
  });
}

for (const { name, value, denied } of [
  { name: "neutral username", value: "appuser", denied: false },
  { name: "reserved username", value: "ROOT", denied: true },
  { name: "reserved prefix", value: "PG_service", denied: true },
  { name: "prefix is anchored", value: "app_pg_service", denied: false },
  {
    name: "unresolved username",
    value: "[parameters('username')]",
    denied: false,
  },
]) {
  test(`reserved provider values: ${name}`, () => {
    const findings = check(
      arm({
        app: appResource(),
        database: databaseResource({ username: value }),
        workload: connectedWorkload({ image: "example.test/app@sha256:abc" }),
      }),
      POSTGRES_CONTRACT,
    );
    if (denied) assertHasCode(findings, "reserved-property-value");
    else assertLacksCode(findings, "reserved-property-value");
  });
}

test("resolves reserved provider values through ARM variables", () => {
  const model = arm({
    app: appResource(),
    database: databaseResource({ username: "[variables('username')]" }),
    workload: connectedWorkload({ image: "example.test/app@sha256:abc" }),
  });
  model.variables = { username: "postgres" };
  assertHasCode(check(model, POSTGRES_CONTRACT), "reserved-property-value");
});

test("tracks every globally scoped service in the pinned Azure Recipe Pack", () => {
  assert.deepEqual([...AZURE_GLOBAL_NAME_SOURCES].sort(), [
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
});

for (const source of AZURE_GLOBAL_NAME_SOURCES) {
  test(`requires environment uniqueness for ${source}`, () => {
    const kind = "Radius.Example/resources";
    const contract = {
      types: { [kind]: { source, outputs: { host: "host" } } },
      recipeTypes: [kind],
    };
    const model = arm({
      app: appResource(),
      backing: namedResource(
        `${kind}@2025-08-01-preview`,
        "common-name",
      ),
      workload: containerResource({
        containers: { web: { image: "example.test/app@sha256:abc" } },
        connections: {
          backing: { source: "[reference('backing').id]" },
        },
      }),
    });
    assertHasCode(check(model, contract), "nonunique-cloud-name");

    model.resources.backing.properties.name =
      "[format('appdb{0}', uniqueString(parameters('environment')))]";
    assertLacksCode(check(model, contract), "nonunique-cloud-name");
  });
}

for (const { name, value, allowed } of [
  {
    name: "safe universal form",
    value: "[format('appdb{0}', uniqueString(parameters('environment')))]",
    allowed: true,
  },
  {
    name: "safe form through variable",
    value: "[variables('globalName')]",
    allowed: true,
  },
  { name: "literal name", value: "appdb", allowed: false },
  {
    name: "prefix with a hyphen",
    value: "[format('app-db{0}', uniqueString(parameters('environment')))]",
    allowed: false,
  },
  {
    name: "prefix longer than eleven characters",
    value:
      "[format('applicationdb{0}', uniqueString(parameters('environment')))]",
    allowed: false,
  },
  {
    name: "escaped format placeholder",
    value: "[format('appdb{{0}}', uniqueString(parameters('environment')))]",
    allowed: false,
  },
  {
    name: "conditional uniqueness",
    value:
      "[if(false(), format('appdb{0}', " +
      "uniqueString(parameters('environment'))), 'appdb')]",
    allowed: false,
  },
]) {
  test(`Azure global name form: ${name}`, () => {
    const variables = {
      globalName:
        "[format('appdb{0}', uniqueString(parameters('environment')))]",
    };
    assert.equal(environmentUniqueAzureName(value, variables), allowed);
  });
}

test("allows mapped, authored, and managed-secret Recipe properties", () => {
  const model = arm({
    app: appResource(),
    database: databaseResource({ database: "app" }),
    workload: connectedWorkload({
      image: "example.test/app@sha256:abc",
      env: {
        HOST: { value: "[reference('database').properties.host]" },
        DATABASE: { value: "[reference('database').properties.database]" },
        SECRET: { value: "[reference('database').properties.secrets]" },
      },
    }),
  });
  assertLacksCode(check(model, POSTGRES_CONTRACT), "unmapped-recipe-output");
});

test("rejects a Recipe property the model neither authors nor receives", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      workload: connectedWorkload({
        image: "example.test/app@sha256:abc",
        env: {
          PORT: { value: "[reference('database').properties.port]" },
        },
      }),
    }),
    POSTGRES_CONTRACT,
  );
  assertHasCode(findings, "unmapped-recipe-output");
});

test("checks Recipe output reads outside the inner properties bag", () => {
  const workload = connectedWorkload({
    image: "example.test/app@sha256:abc",
  });
  workload.location = "[reference('database').properties.port]";
  assertHasCode(
    check(
      arm({
        app: appResource(),
        database: databaseResource(),
        workload,
      }),
      POSTGRES_CONTRACT,
    ),
    "unmapped-recipe-output",
  );
});

test("reports an identical Recipe output defect only once", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      workload: connectedWorkload({
        image: "example.test/app@sha256:abc",
        env: {
          VALUE: {
            value:
              "[format('{0}{1}', reference('database').properties.port, " +
              "reference('database').properties.port)]",
          },
        },
      }),
    }),
    POSTGRES_CONTRACT,
  );
  assert.equal(
    findings.filter(({ code }) => code === "unmapped-recipe-output").length,
    1,
  );
});

test("result verdicts and signatures are stable", () => {
  const left = [
    { code: "second", path: "b", message: "two" },
    { code: "first", path: "a", message: "one" },
  ];
  const right = [...left].reverse();
  assert.equal(signatureOf(left), signatureOf(right));
  assert.equal(makeResult([]).verdict, ALLOW);
  assert.equal(makeResult(left).verdict, DENY);
  assert.equal(makeResult(left).signature, signatureOf(left));
});

test("requires connections for consumed backing resources", () => {
  const model = arm({
    app: appResource(),
    database: databaseResource(),
    workload: containerResource({
      containers: {
        web: {
          image: "example.test/app@sha256:abc",
          env: {
            HOST: { value: "[reference('database').properties.host]" },
          },
        },
      },
    }),
  });
  assertHasCode(check(model, POSTGRES_CONTRACT), "missing-connection");
  model.resources.workload.properties.properties.connections = {
    database: { source: "[reference('database').id]" },
  };
  assertLacksCode(check(model, POSTGRES_CONTRACT), "missing-connection");
});

for (const { name, env, connections, denied } of [
  {
    name: "declared connection variable",
    env: { CONNECTION_DATABASE_HOST: { value: "manual" } },
    connections: {
      database: { source: "[reference('database').id]" },
    },
    denied: false,
  },
  {
    name: "forged connection variable",
    env: { CONNECTION_DATABASE_HOST: { value: "manual" } },
    connections: {},
    denied: true,
  },
  {
    name: "ordinary variable",
    env: { DATABASE_HOST: { value: "manual" } },
    connections: {},
    denied: false,
  },
]) {
  test(`connection variables: ${name}`, () => {
    const findings = check(
      arm({
        app: appResource(),
        database: databaseResource(),
        workload: containerResource({
          containers: {
            web: { image: "example.test/app@sha256:abc", env },
          },
          connections,
        }),
      }),
      POSTGRES_CONTRACT,
    );
    if (denied) assertHasCode(findings, "orphaned-connection-variable");
    else assertLacksCode(findings, "orphaned-connection-variable");
  });
}

test("rejects authored secrets that copy managed resource outputs", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      copied: resource("Radius.Security/secrets@2025-08-01-preview", {
        data: {
          password: {
            value: "[reference('database').properties.secrets.password]",
          },
        },
      }),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              PASSWORD: {
                valueFrom: {
                  secretKeyRef: {
                    secretName: "[reference('copied').name]",
                    key: "password",
                  },
                },
              },
            },
          },
        },
      }),
    }),
    POSTGRES_CONTRACT,
  );
  assertHasCode(findings, "authored-secret-copies-output");
});

test("allows a secure parameter passed whole through env or an authored secret", () => {
  const findings = check(
    arm(
      {
        app: appResource(),
        config: resource("Radius.Security/secrets@2025-08-01-preview", {
          data: { token: { value: "[parameters('token')]" } },
        }),
        workload: containerResource({
          containers: {
            web: {
              image: "example.test/app@sha256:abc",
              env: {
                TOKEN: { value: "[parameters('token')]" },
                CONFIG_TOKEN: {
                  valueFrom: {
                    secretKeyRef: {
                      secretName: "[reference('config').name]",
                      key: "token",
                    },
                  },
                },
              },
            },
          },
        }),
      },
      { token: { type: "securestring" } },
    ),
    EMPTY_CONTRACT,
  );
  assertLacksCode(findings, "secret-composed-in-template");
  assertLacksCode(findings, "secret-in-process-args");
});

for (const { name, location, denied } of [
  { name: "composed env", location: "env", denied: true },
  { name: "composed authored secret", location: "secret", denied: true },
  { name: "plain process args", location: "plainArgs", denied: false },
]) {
  test(`secure values: ${name}`, () => {
    const resources = {
      app: appResource(),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            ...(location === "env"
              ? {
                  env: {
                    TOKEN: {
                      value: "[format('prefix-{0}', parameters('token'))]",
                    },
                  },
                }
              : {}),
            ...(location === "plainArgs" ? { args: ["--port=8080"] } : {}),
          },
        },
      }),
    };
    if (location === "secret") {
      resources.config = resource(
        "Radius.Security/secrets@2025-08-01-preview",
        {
          data: {
            token: {
              value: "[format('prefix-{0}', parameters('token'))]",
            },
          },
        },
      );
      resources.workload.properties.properties.containers.web.env = {
        TOKEN: {
          valueFrom: {
            secretKeyRef: {
              secretName: "[reference('config').name]",
              key: "token",
            },
          },
        },
      };
    }
    const findings = check(
      arm(resources, { token: { type: "securestring" } }),
      EMPTY_CONTRACT,
    );
    if (denied) assertHasCode(findings, "secret-composed-in-template");
    else assertLacksCode(findings, "secret-composed-in-template");
  });
}

for (const parameterType of ["securestring", "secureObject", "SecureString"]) {
  test(`rejects ${parameterType} parameters in process arguments`, () => {
    const findings = check(
      arm(
        {
          app: appResource(),
          workload: containerResource({
            containers: {
              web: {
                image: "example.test/app@sha256:abc",
                command: ["server"],
                args: ["--secret", "[parameters('secret')]"],
              },
            },
          }),
        },
        { secret: { type: parameterType } },
      ),
      EMPTY_CONTRACT,
    );
    assertHasCode(findings, "secret-in-process-args");
  });
}

test("rejects managed secrets in process arguments", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      workload: connectedWorkload({
        image: "example.test/app@sha256:abc",
        args: ["[reference('database').properties.secrets.password]"],
      }),
    }),
    POSTGRES_CONTRACT,
  );
  assertHasCode(findings, "secret-in-process-args");
});

function workloadWithSecretBinding(secretName, key = "password") {
  return connectedWorkload({
    image: "example.test/app@sha256:abc",
    env: {
      PASSWORD: {
        valueFrom: { secretKeyRef: { secretName, key } },
      },
    },
  });
}

test("accepts the managed secret name and a published key", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      workload: workloadWithSecretBinding(
        "[reference('database').properties.secrets.name]",
      ),
    }),
    POSTGRES_CONTRACT,
  );
  assertLacksCode(findings, "wrong-secret-name-path");
  assertLacksCode(findings, "unknown-secret-key");
});

for (const { name, secretName } of [
  {
    name: "resource name",
    secretName: "[reference('database').name]",
  },
  {
    name: "ordinary resource property",
    secretName: "[reference('database').properties.host]",
  },
]) {
  test(`rejects managed secret binding through ${name}`, () => {
    assertHasCode(
      check(
        arm({
          app: appResource(),
          database: databaseResource(),
          workload: workloadWithSecretBinding(secretName),
        }),
        POSTGRES_CONTRACT,
      ),
      "wrong-secret-name-path",
    );
  });
}

test("rejects unpublished managed secret keys", () => {
  assertHasCode(
    check(
      arm({
        app: appResource(),
        database: databaseResource(),
        workload: workloadWithSecretBinding(
          "[reference('database').properties.secrets.name]",
          "username",
        ),
      }),
      POSTGRES_CONTRACT,
    ),
    "unknown-secret-key",
  );
});

function redisContract() {
  const kind = "Radius.Data/redisCaches";
  return {
    kind,
    contract: {
      types: {
        [kind]: {
          source:
            "mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1",
          outputs: {
            host: "hostName",
            port: "port",
            secrets: { url: "primaryConnectionString" },
          },
        },
      },
      recipeTypes: [kind],
    },
  };
}

test("rejects Azure Redis wiring that omits its authentication secret", () => {
  const { kind, contract } = redisContract();
  const findings = check(
    arm({
      app: appResource(),
      cache: namedResource(
        `${kind}@2025-08-01-preview`,
        "[format('appredis{0}', uniqueString(parameters('environment')))]",
      ),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              REDIS_HOST: {
                value: "[reference('cache').properties.host]",
              },
              REDIS_PORT: {
                value: "[reference('cache').properties.port]",
              },
            },
          },
        },
        connections: {
          cache: { source: "[reference('cache').id]" },
        },
      }),
    }),
    contract,
  );
  assertHasCode(findings, "missing-required-secret-binding");
});

test("accepts the complete Azure Redis URL from its managed secret", () => {
  const { kind, contract } = redisContract();
  const findings = check(
    arm({
      app: appResource(),
      cache: namedResource(
        `${kind}@2025-08-01-preview`,
        "[format('appredis{0}', uniqueString(parameters('environment')))]",
      ),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              REDIS_URL: {
                valueFrom: {
                  secretKeyRef: {
                    secretName:
                      "[reference('cache').properties.secrets.name]",
                    key: "url",
                  },
                },
              },
            },
          },
        },
        connections: {
          cache: { source: "[reference('cache').id]" },
        },
      }),
    }),
    contract,
  );
  assertLacksCode(findings, "missing-required-secret-binding");
});

for (const { name, secretName, key, deniedCode } of [
  {
    name: "valid variable-expanded managed path",
    secretName: "[reference('database').properties.secrets.name]",
    key: "password",
    deniedCode: null,
  },
  {
    name: "variable-expanded ordinary property",
    secretName: "[reference('database').properties.host]",
    key: "password",
    deniedCode: "wrong-secret-name-path",
  },
  {
    name: "variable-expanded unpublished key",
    secretName: "[reference('database').properties.secrets.name]",
    key: "username",
    deniedCode: "unknown-secret-key",
  },
]) {
  test(`secret binding: ${name}`, () => {
    const model = arm({
      app: appResource(),
      database: databaseResource(),
      workload: workloadWithSecretBinding(
        "[variables('managedSecretName')]",
        key,
      ),
    });
    model.variables = { managedSecretName: secretName };
    const findings = check(model, POSTGRES_CONTRACT);
    if (deniedCode) assertHasCode(findings, deniedCode);
    else {
      assertLacksCode(findings, "wrong-secret-name-path");
      assertLacksCode(findings, "unknown-secret-key");
    }
  });
}

test("leaves an unclassifiable managed secret expression alone", () => {
  const findings = check(
    arm({
      app: appResource(),
      database: databaseResource(),
      workload: workloadWithSecretBinding(
        "[reference('database', '2025-08-01-preview').properties.secrets.name]",
      ),
    }),
    POSTGRES_CONTRACT,
  );
  assertLacksCode(findings, "wrong-secret-name-path");
});

test("uses an authored secret resource name rather than its properties", () => {
  const config = resource("Radius.Security/secrets@2025-08-01-preview", {
    data: { token: { value: "placeholder" } },
  });
  const good = arm({
    app: appResource(),
    config,
    workload: containerResource({
      containers: {
        web: {
          image: "example.test/app@sha256:abc",
          env: {
            TOKEN: {
              valueFrom: {
                secretKeyRef: {
                  secretName: "[reference('config').name]",
                  key: "token",
                },
              },
            },
          },
        },
      },
    }),
  });
  assertLacksCode(check(good, EMPTY_CONTRACT), "wrong-secret-name-path");

  good.resources.workload.properties.properties.containers.web.env.TOKEN
    .valueFrom.secretKeyRef.secretName =
    "[reference('config').properties.name]";
  assertHasCode(check(good, EMPTY_CONTRACT), "wrong-secret-name-path");
});

test("rejects unconsumed backing resources but not workloads", () => {
  assertHasCode(
    check(
      arm({ app: appResource(), database: databaseResource() }),
      POSTGRES_CONTRACT,
    ),
    "unconsumed-resource",
  );
  assertLacksCode(
    check(
      arm({
        app: appResource(),
        workload: containerResource({
          containers: { web: { image: "example.test/app@sha256:abc" } },
        }),
      }),
      EMPTY_CONTRACT,
    ),
    "unconsumed-resource",
  );
});

test("dependsOn alone does not consume a backing resource", () => {
  const workload = containerResource({
    containers: { web: { image: "example.test/app@sha256:abc" } },
  });
  workload.dependsOn = ["database"];
  assertHasCode(
    check(
      arm({
        app: appResource(),
        database: databaseResource(),
        workload,
      }),
      POSTGRES_CONTRACT,
    ),
    "unconsumed-resource",
  );
});

test("leaves outputs of Recipe types without contracts unchecked", () => {
  const kind = "Radius.Example/resources";
  const findings = check(
    arm({
      app: appResource(),
      example: resource(`${kind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              VALUE: { value: "[reference('example').properties.anything]" },
            },
          },
        },
        connections: {
          example: { source: "[reference('example').id]" },
        },
      }),
    }),
    { types: {}, recipeTypes: [kind] },
  );
  assertLacksCode(findings, "unmapped-recipe-output");
});

test("rejects static container names Kubernetes cannot create", () => {
  const findings = check(
    arm({
      app: appResource(),
      workload: containerResource({
        containers: {
          volumeOwner: {
            image: "busybox@sha256:abc",
            initContainer: true,
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(findingCodes(findings).includes("invalid-container-name"), true);
});

test("allows lowercase RFC 1123 container names", () => {
  const findings = check(
    arm({
      app: appResource(),
      workload: containerResource({
        containers: {
          "volume-owner": {
            image: "busybox@sha256:abc",
            initContainer: true,
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(findingCodes(findings).includes("invalid-container-name"), false);
});

test("source builds allow an independent tag and default platforms", () => {
  const imageKind = "Radius.Compute/containerImages@2025-08-01-preview";
  const findings = check(
    arm({
      app: appResource(),
      image: resource(imageKind, {
        tag: "latest",
        build: {
          source:
            "git::https://github.com/example/app.git" +
            "?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
      workload: containerResource({
        containers: {
          web: { image: "[reference('image').properties.imageReference]" },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(findingCodes(findings).includes("mutable-build-source"), false);
});

test("allows runtime interpolation from an authored secret-backed env", () => {
  const findings = check(
    arm({
      app: appResource(),
      config: resource("Radius.Security/secrets@2025-08-01-preview", {
        data: { token: { value: "placeholder" } },
      }),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              TOKEN: {
                valueFrom: {
                  secretKeyRef: {
                    secretName: "[reference('config').name]",
                    key: "token",
                  },
                },
              },
              CONFIG: { value: "prefix $(TOKEN)" },
            },
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("does not infer authored env ordering from a mutable container Recipe", () => {
  const findings = check(
    arm({
      app: appResource(),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              ALPHA: { value: "$(ZULU)" },
              ZULU: { value: "value" },
            },
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("allows runtime interpolation from an earlier authored plain env", () => {
  const findings = check(
    arm({
      app: appResource(),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              ALPHA: { value: "value" },
              ZULU: { value: "$(ALPHA)" },
            },
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("leaves unknown image-provided runtime env references alone", () => {
  const findings = check(
    arm({
      app: appResource(),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: { CONFIG: { value: "prefix $(IMAGE_DEFAULT)" } },
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("does not infer connection env ordering from a mutable container Recipe", () => {
  const databaseKind = "Radius.Data/postgreSqlDatabases";
  const findings = check(
    arm({
      app: appResource(),
      database: resource(`${databaseKind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              DATABASE_URL: {
                value: "postgres://user@$(CONNECTION_DATABASE_HOST)/app",
              },
            },
          },
        },
        connections: {
          database: { source: "[reference('database').id]" },
        },
      }),
    }),
    {
      types: {
        [databaseKind]: {
          source: "example.test/postgres:1",
          outputs: { host: "hostname" },
        },
      },
      recipeTypes: [databaseKind],
    },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("allows direct resource-property wiring without runtime interpolation", () => {
  const databaseKind = "Radius.Data/postgreSqlDatabases";
  const findings = check(
    arm({
      app: appResource(),
      database: resource(`${databaseKind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              DATABASE_HOST: {
                value: "[reference('database').properties.host]",
              },
            },
          },
        },
        connections: {
          database: { source: "[reference('database').id]" },
        },
      }),
    }),
    {
      types: {
        [databaseKind]: {
          source: "example.test/postgres:1",
          outputs: { host: "hostname" },
        },
      },
      recipeTypes: [databaseKind],
    },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("denies interpolation when connection env injection is disabled", () => {
  const databaseKind = "Radius.Data/postgreSqlDatabases";
  const findings = check(
    arm({
      app: appResource(),
      database: resource(`${databaseKind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              DATABASE_HOST: { value: "$(CONNECTION_DATABASE_HOST)" },
            },
          },
        },
        connections: {
          database: {
            source: "[reference('database').id]",
            disableDefaultEnvVars: true,
          },
        },
      }),
    }),
    {
      types: {
        [databaseKind]: {
          source: "example.test/postgres:1",
          outputs: { host: "hostname" },
        },
      },
      recipeTypes: [databaseKind],
    },
  );
  assert.ok(
    findings.some(
      ({ code, message }) =>
        code === "unresolvable-runtime-interpolation" &&
        message.includes("disables default environment-variable injection"),
    ),
  );
});

test("allows an explicitly authored variable when connection injection is disabled", () => {
  const databaseKind = "Radius.Data/postgreSqlDatabases";
  const findings = check(
    arm({
      app: appResource(),
      database: resource(`${databaseKind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              CONNECTION_DATABASE_HOST: { value: "database.internal" },
              DATABASE_HOST: { value: "$(CONNECTION_DATABASE_HOST)" },
            },
          },
        },
        connections: {
          database: {
            source: "[reference('database').id]",
            disableDefaultEnvVars: true,
          },
        },
      }),
    }),
    {
      types: {
        [databaseKind]: {
          source: "example.test/postgres:1",
          outputs: { host: "hostname" },
        },
      },
      recipeTypes: [databaseKind],
    },
  );
  assert.equal(
    findingCodes(findings).includes("unresolvable-runtime-interpolation"),
    false,
  );
});

test("denies interpolation from a managed connection secret variable", () => {
  const databaseKind = "Radius.Data/postgreSqlDatabases";
  const findings = check(
    arm({
      app: appResource(),
      database: resource(`${databaseKind}@2025-08-01-preview`, {}),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              DATABASE_URL: {
                value:
                  "postgres://user:$(CONNECTION_DATABASE_PASSWORD)@database/app",
              },
            },
          },
        },
        connections: {
          database: { source: "[reference('database').id]" },
        },
      }),
    }),
    {
      types: {
        [databaseKind]: {
          source: "example.test/postgres:1",
          outputs: {
            host: "hostname",
            secrets: { password: "administratorPassword" },
          },
        },
      },
      recipeTypes: [databaseKind],
    },
  );
  assert.ok(
    findings.some(
      ({ code, message }) =>
        code === "unresolvable-runtime-interpolation" &&
        message.includes("do not inject secret outputs"),
    ),
  );
});

test("allows a secure parameter that may already be URL encoded", () => {
  const findings = check(
    arm(
      {
        app: appResource(),
        workload: containerResource({
          containers: {
            web: {
              image: "example.test/app@sha256:abc",
              env: {
                PASSWORD: { value: "[parameters('password')]" },
                DATABASE_URL: {
                  value: "postgres://user:$(PASSWORD)@database/app",
                },
              },
            },
          },
        }),
      },
      {
        environment: { type: "string" },
        password: { type: "securestring" },
      },
    ),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(
    findingCodes(findings).includes("unencoded-secret-in-url"),
    false,
  );
});

test("does not treat an at-sign outside URL authority as userinfo", () => {
  const findings = check(
    arm(
      {
        app: appResource(),
        workload: containerResource({
          containers: {
            web: {
              image: "example.test/app@sha256:abc",
              env: {
                PASSWORD: { value: "[parameters('password')]" },
                CALLBACK_URL: {
                  value: "https://example.test/path/$(PASSWORD)@callback",
                },
              },
            },
          },
        }),
      },
      {
        environment: { type: "string" },
        password: { type: "securestring" },
      },
    ),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(findingCodes(findings).includes("unencoded-secret-in-url"), false);
});

test("allows a complete URL bound directly through secretKeyRef", () => {
  const findings = check(
    arm({
      app: appResource(),
      config: resource("Radius.Security/secrets@2025-08-01-preview", {
        data: { url: { value: "placeholder" } },
      }),
      workload: containerResource({
        containers: {
          web: {
            image: "example.test/app@sha256:abc",
            env: {
              DATABASE_URL: {
                valueFrom: {
                  secretKeyRef: {
                    secretName: "[reference('config').name]",
                    key: "url",
                  },
                },
              },
            },
          },
        },
      }),
    }),
    { types: {}, recipeTypes: [] },
  );
  assert.equal(findingCodes(findings).includes("unencoded-secret-in-url"), false);
});

test("requires a connection for an output-less persistent-volume Recipe", () => {
  const volumeKind = "Radius.Compute/persistentVolumes";
  const model = arm({
    app: appResource(),
    volume: resource(`${volumeKind}@2025-08-01-preview`, {}),
    workload: containerResource({
      containers: { web: { image: "example.test/app@sha256:abc" } },
      volumes: {
        data: {
          persistentVolume: { resourceId: "[reference('volume').id]" },
        },
      },
    }),
  });
  const recipes = { types: {}, recipeTypes: [volumeKind] };
  const findings = check(model, recipes);
  assert.ok(
    findings.some(
      ({ code, path: findingPath }) =>
        code === "missing-connection" &&
        findingPath.includes("persistentVolume.resourceId"),
    ),
  );

  model.resources.workload.properties.properties.connections = {
    data: { source: "[reference('volume').id]" },
  };
  assert.equal(
    findingCodes(check(model, recipes)).includes("missing-connection"),
    false,
  );
});
