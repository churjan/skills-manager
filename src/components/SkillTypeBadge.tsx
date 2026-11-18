import { Badge } from "./ui/badge"

export function SkillTypeBadge({ linked }: { linked: boolean }) {
  return linked ? <Badge variant="secondary" className="type-label">软链接</Badge> : null
}
