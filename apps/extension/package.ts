import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { createLogger } from "@live-connector/log"
import type { ExtensionManifest } from "./src/types/manifest"

const manifest_path = path.resolve("manifest.json")
const dist_dir = path.resolve("dist")
const log = createLogger("package")

function fail(message: string): never {
    log.error(message)
    process.exit(1)
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function readManifest(file_path: string): ExtensionManifest {
    let raw_manifest: unknown
    try {
        raw_manifest = JSON.parse(fs.readFileSync(file_path, "utf8"))
    } catch (error) {
        fail(`Failed to read manifest.json: ${String(error)}`)
    }

    if (raw_manifest === null || typeof raw_manifest !== "object") {
        fail("manifest.json must contain an object")
    }
    const manifest = raw_manifest as Partial<ExtensionManifest>
    if (!isNonEmptyString(manifest.name)) {
        fail("manifest.json must contain non-empty name")
    }
    if (!isNonEmptyString(manifest.version)) {
        fail("manifest.json must contain non-empty version")
    }
    if (!isNonEmptyString(manifest.entry)) {
        fail("manifest.json must contain non-empty entry")
    }
    if (!fs.existsSync(path.resolve(manifest.entry))) {
        fail(`Built entry file not found: ${manifest.entry}`)
    }
    return manifest as ExtensionManifest
}

function runPackageCommand(output_path: string): Promise<void> {
    return new Promise((resolve) => {
        const child = spawn("extensions-cli", ["package", ".", "-o", output_path], {
            stdio: "inherit",
        })
        child.on("error", (error) => {
            fail(`Failed to run extensions-cli package: ${String(error)}`)
        })
        child.on("close", (code) => {
            if (code !== 0) {
                fail(`extensions-cli package failed with exit code ${String(code)}`)
            }
            resolve()
        })
    })
}

const manifest = readManifest(manifest_path)
fs.mkdirSync(dist_dir, { recursive: true })
const output_path = path.join(dist_dir, `${manifest.name}-${manifest.version}.ablx`)
await runPackageCommand(output_path)
