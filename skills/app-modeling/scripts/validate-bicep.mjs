#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function diagnostics(output) {
    try {
        const runs = JSON.parse(output).runs;
        if (!Array.isArray(runs) || runs.length === 0) {
            return null;
        }

        const results = [];
        for (const run of runs) {
            if (run === null || typeof run !== "object" || Array.isArray(run)) {
                return null;
            }
            const runResults = run.results ?? [];
            if (!Array.isArray(runResults)) {
                return null;
            }
            results.push(...runResults);
        }
        return results.every(
            (result) => result !== null &&
                typeof result === "object" &&
                !Array.isArray(result),
        ) ? results : null;
    } catch {
        return null;
    }
}

function printDiagnostic(result) {
    const physical = result.locations?.[0]?.physicalLocation;
    const source = physical?.artifactLocation?.uri;
    const line = physical?.region?.startLine;
    const location = typeof source === "string"
        ? `${source}${Number.isInteger(line) ? `:${line}` : ""}`
        : Number.isInteger(line) ? `line ${line}` : "";
    const level = typeof result.level === "string" ? result.level : "warning";
    const rule = typeof result.ruleId === "string" && result.ruleId
        ? ` ${result.ruleId}`
        : "";
    const text = typeof result.message?.text === "string" && result.message.text
        ? result.message.text
        : "Bicep reported a diagnostic.";
    console.error(`${location ? `${location}: ` : ""}${level}${rule}: ${text}`);
}

function isFailure(result) {
    return result.level !== "note" && result.level !== "none";
}

const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
const bicep = path.join(
    os.homedir(),
    ".radius",
    "ai-extensions",
    "bin",
    executable,
);
const app = path.resolve(process.argv[2] || ".radius/app.bicep");

const compiled = spawnSync(
    bicep,
    ["build", app, "--diagnostics-format", "sarif", "--stdout"],
    {
        cwd: path.dirname(app),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
        windowsHide: true,
    },
);

if (compiled.error) {
    console.error(compiled.error.message);
    process.exitCode = 1;
} else {
    const findings = diagnostics(compiled.stderr ?? "");
    if (findings === null) {
        console.error(
            (compiled.stderr ?? "").trim() ||
            "Bicep did not return valid SARIF diagnostics.",
        );
        process.exitCode = 1;
    } else {
        findings.forEach(printDiagnostic);
        process.exitCode = compiled.status === 0 && !findings.some(isFailure)
            ? 0
            : compiled.status || 1;
    }
}
