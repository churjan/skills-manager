import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

// Exercise the real store with a deterministic clock and mocked desktop IPC.
const compiled = ts.transpileModule(readFileSync(new URL("../src/repositories.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function store(invoke = async () => ({ status: "missing", retryAt: 86401 })) {
  let now = 1000
  const calls = []
  const exports = {}
  runInNewContext(compiled, {
    exports,
    Date: { now: () => now },
    require(name) {
      if (name === "react") return { useSyncExternalStore: () => {} }
      if (name === "@tauri-apps/api/core") return { invoke: (...args) => { calls.push(args); return invoke(...args) } }
      throw new Error(`Unexpected import ${name}`)
    },
  })
  return { api: exports, calls, advance: time => { now = time } }
}

test("cached missing result survives refresh and manual retry sends force", async () => {
  const { api, calls } = store()
  const cache = { entries: { skill: { status: "missing", retryAt: 86401 } }, rateLimitUntil: 0 }
  api.hydrateRepositoryLookups(cache)
  await api.findRepository("directory", "skill")
  api.retainRepositoryLookups(new Set(["skill"]))
  api.hydrateRepositoryLookups(cache)
  await api.findRepository("directory", "skill")
  assert.equal(calls.length, 0)
  await api.findRepository("directory", "skill", true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "find_github_repository")
  assert.equal(calls[0][1].force, true)
})

test("expired missing result automatically queries again", async () => {
  const { api, calls, advance } = store()
  api.hydrateRepositoryLookups({ entries: { skill: { status: "missing", retryAt: 10 } }, rateLimitUntil: 0 })
  advance(10_000)
  await api.findRepository("directory", "skill")
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].force, false)
})

test("manual retry bypasses network error cooldown", async () => {
  const { api, calls } = store()
  api.hydrateRepositoryLookups({ entries: { skill: { status: "error", retryAt: 301 } }, rateLimitUntil: 0 })
  await api.findRepository("directory", "skill")
  assert.equal(calls.length, 0)
  await api.findRepository("directory", "skill", true)
  assert.equal(calls.length, 1)
})

test("global rate limit blocks other digests and manual retry until deadline", async () => {
  const { api, calls, advance } = store()
  api.hydrateRepositoryLookups({ entries: {}, rateLimitUntil: 300 })
  assert.equal((await api.findRepository("directory", "new", true)).status, "rateLimited")
  assert.equal(calls.length, 0)
  advance(300_000)
  await api.findRepository("directory", "new", true)
  assert.equal(calls.length, 1)
})

test("new server limit also blocks other skills and stale refresh cannot erase it", async () => {
  const { api, calls } = store(async () => ({ status: "rateLimited", retryAt: 300 }))
  await api.findRepository("directory", "first")
  api.hydrateRepositoryLookups({ entries: {}, rateLimitUntil: 0 })
  assert.equal((await api.findRepository("another", "changed", true)).status, "rateLimited")
  assert.equal(calls.length, 1)
})

test("in-flight calls are reused across detail, manual retry and refresh", async () => {
  let resolve
  const { api, calls } = store(() => new Promise(done => { resolve = done }))
  const first = api.findRepository("directory", "shared")
  assert.equal(api.repositoryLookup("shared").status, "loading")
  api.retainRepositoryLookups(new Set())
  api.hydrateRepositoryLookups({ entries: { shared: { status: "error", retryAt: 301 } }, rateLimitUntil: 0 })
  const second = api.findRepository("link", "shared", true)
  assert.equal(calls.length, 1)
  const found = { status: "found", url: "https://github.com/org/repo" }
  resolve(found)
  assert.equal(await first, found)
  assert.equal(await second, found)
  assert.equal(api.repositoryLookup("shared").status, "found")
})

test("successful results remain available offline and during rate limits", async () => {
  const { api, calls } = store(async () => ({ status: "found", url: "https://github.com/org/repo" }))
  await api.findRepository("directory", "skill")
  api.hydrateRepositoryLookups({ entries: {}, rateLimitUntil: 300 })
  assert.equal((await api.findRepository("directory", "skill", true)).status, "found")
  assert.equal(calls.length, 1)
})

test("IPC failures stay retryable and do not break local preview", async () => {
  const { api, calls } = store(async () => { throw new Error("IPC unavailable") })
  assert.equal((await api.findRepository("directory", "skill")).status, "error")
  await api.findRepository("directory", "skill")
  assert.equal(calls.length, 1)
  await api.findRepository("directory", "skill", true)
  assert.equal(calls.length, 2)
})

test("concurrent callers share handled IPC failure without rejected promises", async () => {
  let reject
  const { api, calls } = store(() => new Promise((_, fail) => { reject = fail }))
  const first = api.findRepository("directory", "shared")
  const second = api.findRepository("link", "shared", true)
  reject(new Error("IPC unavailable"))
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.status, "error")
  assert.equal(one, two)
  assert.equal(calls.length, 1)
  assert.equal(api.repositoryLookup("shared").status, "error")
})
