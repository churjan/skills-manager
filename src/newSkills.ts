export const NEW_SKILL_DURATION = 3 * 24 * 60 * 60 * 1000

export function isNewSkill(installedAt: number | null, now: number) {
  return installedAt !== null && Number.isFinite(installedAt) && installedAt > 0
    && installedAt <= now && now < installedAt + NEW_SKILL_DURATION
}

export type SeenSkills = Record<string, number>

export function isUnreadSkill(directory: string, installedAt: number | null, now: number, seen: SeenSkills) {
  return isNewSkill(installedAt, now) && seen[directory] !== installedAt
}

/** Remember that a new installation was opened, dropping entries that are no longer new. */
export function markSkillSeen(seen: SeenSkills, directory: string, installedAt: number, now: number): SeenSkills {
  const kept = Object.entries(seen).filter(([, time]) => isNewSkill(time, now))
  return { ...Object.fromEntries(kept), [directory]: installedAt }
}
