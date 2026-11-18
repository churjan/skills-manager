import { Badge } from "./ui/badge"
import type { SkillUpdate } from "../model"

export function SkillUpdateBadge({ update }: { update?: SkillUpdate }) {
  return update === "available" ? <Badge variant="update" title="上游有更新" aria-label="上游有更新">可更新</Badge> : null
}
