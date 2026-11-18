import { useSyncExternalStore } from "react"
import { invoke } from "@tauri-apps/api/core"

export type RepositoryLookup =
  | { status: "found"; url: string }
  | { status: "missing" | "error" | "rateLimited"; retryAt: number }
  | { status: "idle" | "loading" }

export interface RepositoryLookupCache {
  entries: Record<string, RepositoryLookup>
  rateLimitUntil: number
}

const idle: RepositoryLookup = { status: "idle" }
const loading: RepositoryLookup = { status: "loading" }
const pending = new Map<string, Promise<RepositoryLookup>>()
const recent = new Map<string, RepositoryLookup>()
const listeners = new Set<() => void>()
let rateLimit: Extract<RepositoryLookup, { retryAt: number }> | undefined

function notify() { for (const listener of listeners) listener() }

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function repositoryLookup(digest: string): RepositoryLookup {
  const result = recent.get(digest) ?? idle
  if (result.status === "found" || pending.has(digest)) return result
  return rateLimit && rateLimit.retryAt * 1000 > Date.now() ? rateLimit : result
}

export function useRepositoryLookup(digest: string) {
  return useSyncExternalStore(subscribe, () => repositoryLookup(digest))
}

export function hydrateRepositoryLookups(cache: RepositoryLookupCache) {
  const until = Math.max(cache.rateLimitUntil, rateLimit?.retryAt ?? 0)
  rateLimit = until ? { status: "rateLimited", retryAt: until } : undefined
  for (const [digest, result] of Object.entries(cache.entries)) {
    if (!pending.has(digest) && recent.get(digest)?.status !== "found") recent.set(digest, result)
  }
  notify()
}

export function retainRepositoryLookups(active: Set<string>) {
  for (const digest of recent.keys()) {
    if (!active.has(digest) && !pending.has(digest)) recent.delete(digest)
  }
  notify()
}

export async function findRepository(directory: string, digest: string, force = false): Promise<RepositoryLookup> {
  const running = pending.get(digest)
  if (running) return running
  const cached = repositoryLookup(digest)
  if (cached.status === "found") return cached
  if ("retryAt" in cached && cached.retryAt * 1000 > Date.now()
    && (cached.status === "rateLimited" || !force)) return cached

  const request = invoke<RepositoryLookup>("find_github_repository", { directory, id: digest, force }).then(result => {
    recent.set(digest, result)
    if (result.status === "rateLimited") rateLimit = result
    return result
  }).catch(() => {
    // IPC/file errors remain retryable without breaking the local skill preview.
    const result: RepositoryLookup = { status: "error", retryAt: Math.floor(Date.now() / 1000) + 5 * 60 }
    recent.set(digest, result)
    return result
  }).finally(() => {
    pending.delete(digest)
    notify()
  })
  // Share the handled promise so every caller receives the same retryable error state.
  pending.set(digest, request)
  recent.set(digest, loading)
  notify()
  return request
}
