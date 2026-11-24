import { Badge } from "./ui/badge"

export function SkillTypeBadge({ linked, className }: { linked: boolean; className?: string }) {
  return <Badge variant={linked ? "sourceLinked" : "source"} className={className}>{linked ? "软链接" : "实际目录"}</Badge>
}
