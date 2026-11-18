import { Folder } from "lucide-react"
import { agentSource } from "../agentSources"
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar"

export function AgentIcon({ label }: { label: string }) {
  const { logo, name } = agentSource(label)
  return <Avatar className="agent-logo rounded-none after:hidden" aria-hidden="true">
    {logo && <AvatarImage src={logo} alt="" className="rounded-none object-contain" />}
    <AvatarFallback className="rounded-none bg-transparent text-inherit">
      {name === "Agents" ? <span className="agent-letter">A</span> : <Folder className="size-full" />}
    </AvatarFallback>
  </Avatar>
}
