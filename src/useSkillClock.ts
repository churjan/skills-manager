import { useEffect, useState } from "react"
import type { Skill } from "./model"
import { NEW_SKILL_DURATION } from "./newSkills"

// Expire list badges while idle and refresh the clock after resuming the app.
export function useSkillClock(skills: Skill[]) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const update = () => setNow(Date.now())
    let next = Infinity
    for (const { installedAt } of skills) {
      if (installedAt === null || !Number.isFinite(installedAt) || installedAt <= 0) continue
      for (const boundary of [installedAt, installedAt + NEW_SKILL_DURATION]) {
        if (boundary > now) next = Math.min(next, boundary)
      }
    }
    const timer = Number.isFinite(next)
      ? window.setTimeout(update, Math.max(0, Math.min(next - Date.now() + 1, 2_147_483_647))) : undefined
    window.addEventListener("focus", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [skills, now])
  return now
}
