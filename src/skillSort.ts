export type SkillSort = "modified" | "alphabetical"
type SortableSkill = { name: string; directory: string; modifiedAt: number | null; installedAt: number | null }

export function compareSkills(a: SortableSkill, b: SortableSkill, order: SkillSort) {
  if (order === "modified") {
    const difference = Math.max(b.modifiedAt ?? -1, b.installedAt ?? -1)
      - Math.max(a.modifiedAt ?? -1, a.installedAt ?? -1)
    if (difference) return difference
  }
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en")
    || a.directory.localeCompare(b.directory)
}

export function readSkillSort(): SkillSort {
  try { return localStorage.getItem("skill-sort") === "alphabetical" ? "alphabetical" : "modified" }
  catch { return "modified" }
}
