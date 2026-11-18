import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"
import type { ReactElement } from "react"

export function IconTooltip({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
}
