import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checker = path.join(
    root,
    "skills",
    "app-modeling",
    "scripts",
    "validate-bicep.mjs",
);
const executable = process.platform === "win32" ? "bicep.exe" : "bicep";

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-modeling-check-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function fakeBicep(directory, compilerOutput, status) {
    const bicep = path.join(
        directory,
        ".radius",
        "ai-extensions",
        "bin",
        executable,
    );
    const driver = path.join(directory, "build");
    fs.mkdirSync(path.dirname(bicep), { recursive: true });
    try {
        fs.linkSync(fs.realpathSync(process.execPath), bicep);
    } catch {
        fs.copyFileSync(process.execPath, bicep);
    }
    if (process.platform !== "win32") {
        fs.chmodSync(bicep, 0o755);
    }
    fs.writeFileSync(
        driver,
        [
            "if (!process.argv.includes('--diagnostics-format') || !process.argv.includes('sarif')) process.exit(2);",
            `process.stderr.write(${JSON.stringify(compilerOutput)});`,
            `process.exit(${status});`,
            "",
        ].join("\n"),
    );
    return { HOME: directory, USERPROFILE: directory };
}

function runChecker(directory, env) {
    const app = path.join(directory, "app.bicep");
    fs.writeFileSync(app, "");
    return spawnSync(process.execPath, [checker, app], {
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

function sarif(results) {
    return JSON.stringify({ runs: [{ results }] });
}

test("passes a warning-free Bicep compilation", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, fakeBicep(directory, sarif([]), 0));

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
});

test("fails and surfaces a Bicep warning even when Bicep exits successfully", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, fakeBicep(directory, sarif([
        {
            ruleId: "use-secure-value-for-secure-inputs",
            message: { text: "Property 'password' expects a secure value." },
            locations: [{
                physicalLocation: {
                    artifactLocation: { uri: "file:///tmp/app.bicep" },
                    region: { startLine: 12 },
                },
            }],
        },
    ]), 0));

    assert.equal(result.status, 1);
    assert.match(
        result.stderr,
        /app\.bicep:12: warning use-secure-value-for-secure-inputs: Property 'password' expects a secure value\./u,
    );
});

test("surfaces informational diagnostics without failing", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, fakeBicep(directory, sarif([
        {
            level: "note",
            ruleId: "no-unused-vars",
            message: { text: "Variable 'unused' is declared but never used." },
        },
    ]), 0));

    assert.equal(result.status, 0);
    assert.match(result.stderr, /note no-unused-vars/u);
});

test("preserves a Bicep compiler failure", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, fakeBicep(directory, sarif([
        {
            level: "error",
            ruleId: "BCP007",
            message: { text: "This declaration type is not recognized." },
        },
    ]), 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /error BCP007: This declaration type is not recognized\./u);
});

test("fails closed when Bicep diagnostics are not valid SARIF", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, fakeBicep(directory, "warning: boom", 0));

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "warning: boom\n");
});

test("ignores Bicep overrides and PATH", (t) => {
    const directory = temporaryDirectory(t);
    const result = runChecker(directory, {
        ...fakeBicep(directory, sarif([]), 0),
        BICEP_BINARY: path.join(directory, "other-bicep"),
        PATH: "",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
});

function hasInstalledBicep() {
    const candidate = path.join(
        os.homedir(),
        ".radius",
        "ai-extensions",
        "bin",
        executable,
    );
    const version = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    return !version.error && version.status === 0;
}

const hasBicep = hasInstalledBicep();

test("accepts a secure value and rejects an insecure sensitive input", {
    skip: !hasBicep,
    timeout: 30_000,
}, (t) => {
    const directory = temporaryDirectory(t);
    const app = path.join(directory, "app.bicep");

    const model = (secure) => `${secure ? "@secure()\n" : ""}param secret string

resource script 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'test'
  location: 'westus'
  kind: 'AzureCLI'
  properties: {
    azCliVersion: '2.52.0'
    retentionInterval: 'P1D'
    scriptContent: 'echo test'
    environmentVariables: [
      {
        name: 'SECRET'
        secureValue: secret
      }
    ]
  }
}
`;

    fs.writeFileSync(app, model(true));
    const clean = spawnSync(process.execPath, [checker, app], {
        encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stderr, "");

    fs.writeFileSync(app, model(false));
    const insecure = spawnSync(process.execPath, [checker, app], {
        encoding: "utf8",
    });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /use-secure-value-for-secure-inputs/u);
});
