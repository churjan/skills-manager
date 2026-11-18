import { agentSource } from "./agentSources"

export interface Skill {
  name: string
  displayName: string
  description: string
  directory: string
  target: string
  linked: boolean
  root: string
  label: string
  body: string
  digest: string
  repository: string | null
  version: string | null
  lockName: string | null
  modifiedAt: number | null
  installedAt: number | null
}

export type SkillUpdate = "latest" | "available"

export interface Inventory {
  skills: Skill[]
  physicalCount: number
  errors: string[]
}

export function matches(skill: Skill, query: string, summary = "") {
  const fields = [skill.name, skill.displayName, skill.description, summary, skill.directory, skill.target, skill.label, agentSource(skill.label).name]
  const haystack = fields.join(" ").toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).every(word => haystack.includes(word))
}
