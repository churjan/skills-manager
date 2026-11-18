import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { ArrowDown, ArrowUpCircle, Check, Copy, FileText, FolderOpen, LoaderCircle } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import githubIcon from "@lobehub/icons-static-svg/icons/github.svg"
import { Button } from "./components/ui/button"
import { AgentIcon } from "./components/AgentIcon"
import { AiSummaryIcon } from "./components/AiSummaryIcon"
import { SkillTypeBadge } from "./components/SkillTypeBadge"
import type { Skill, SkillUpdate } from "./model"
import { findRepository, useRepositoryLookup } from "./repositories"

function PathField({ label, path, open, report }: {
  label: string
  path: string
  open?: () => void
  report: (message: string) => void
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
    } catch (error) {
      report("复制失败：" + String(error))
    }
  }
  return <div className="path-section">
    <h3>{label}</h3>
    <div className="path-actions">
      <div className="path-value">
        <code>{path}</code>
        <Button variant="ghost" size="icon-sm" onClick={copy} onBlur={() => setCopied(false)}
          aria-label={copied ? "已复制" : "复制" + label} title={copied ? "已复制" : "复制" + label}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      {open && <Button variant="outline" onClick={open}><FolderOpen data-icon="inline-start" />打开实际目录</Button>}
    </div>
  </div>
}

export function SkillDetail({ skill, description, aiSummary, update, repositoryLookupReady, rememberRepository }: {
  skill: Skill; description: string; repositoryLookupReady: boolean
  update?: SkillUpdate
  aiSummary?: string
  rememberRepository: (digest: string, url: string) => void
}) {
  const [error, setError] = useState("")
  const lookup = useRepositoryLookup(skill.digest)
  const repository = skill.repository || (lookup.status === "found" ? lookup.url : undefined)
  const [now, setNow] = useState(Date.now)
  const retryAt = "retryAt" in lookup ? lookup.retryAt * 1000 : 0
  useEffect(() => {
    setNow(Date.now())
    if (!retryAt || retryAt <= Date.now()) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(retryAt - Date.now() + 50, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [retryAt])
  const limited = lookup.status === "rateLimited" && retryAt > now
  const querying = lookup.status === "loading"

  async function lookupRepository(force = false) {
    const result = await findRepository(skill.directory, skill.digest, force)
    if (result.status === "found") rememberRepository(skill.digest, result.url)
  }
  useEffect(() => {
    if (!repositoryLookupReady || limited || repository || !skill.digest) return
    const timer = window.setTimeout(() => {
      void findRepository(skill.directory, skill.digest).then(result => {
        if (result.status === "found") rememberRepository(skill.digest, result.url)
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [repositoryLookupReady, limited, skill.directory, skill.digest, repository, rememberRepository])
  async function open() {
    try {
      setError("")
      await invoke("open_directory", { directory: skill.directory })
    } catch (reason) {
      setError("无法打开目录：" + String(reason))
    }
  }
  return <article className="detail" aria-label="Skill 详情">
    <div className="summary">
      <header className="flex items-center justify-between gap-3">
        <div className="skill-title min-w-0 flex-1"><AgentIcon label={skill.label} /><h2>{skill.displayName}</h2>
        <SkillTypeBadge linked={skill.linked} />
        {skill.version && <span className="relative top-0.5 text-sm text-muted-foreground tabular-nums" title="SKILL.md 中标注的版本">v{skill.version}</span>}
        </div>
        <div className="ml-auto flex max-w-1/2 shrink-0 items-center justify-end gap-2">
          {update === "available" && skill.lockName && <Button variant="ghost" size="sm"
            className="text-sm font-normal text-skill-update-foreground hover:text-skill-update-foreground"
            title={`查看上游改动
运行 npx skills update ${skill.lockName} 更新`} onClick={async () => {
              try {
                setError("")
                await invoke("open_skill_changes", { name: skill.lockName })
              } catch (reason) { setError("无法打开上游改动：" + String(reason)) }
            }}><ArrowUpCircle data-icon="inline-start" aria-hidden="true" />可更新</Button>}
          {!repository && querying && <span className="text-muted-foreground" role="status" aria-label="正在查找仓库">
            <LoaderCircle className="spin size-4" aria-hidden="true" />
          </span>}
          {repository && <Button variant="ghost" size="icon-sm"
            title={repository} aria-label="打开 GitHub 仓库" onClick={async () => {
              try {
                setError("")
                await invoke("open_github_repository", { url: repository })
              } catch (reason) { setError("无法打开 GitHub 仓库：" + String(reason)) }
            }}><img src={githubIcon} alt="" className="size-4" /></Button>}
          {!repository && !querying && repositoryLookupReady && <div className="flex flex-wrap items-center justify-end gap-1 text-right text-sm text-muted-foreground" role="status">
            {!skill.digest ? <span>暂无可查询的技能正文</span> : <>
              <span>{limited ? `请求受限，${new Date(retryAt).toLocaleString("zh-CN", {
                month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
              })} 后可重试` : lookup.status === "missing" ? "暂未找到仓库" :
                lookup.status === "error" ? "仓库查询失败" : "尚未查找仓库"}</span>
              {!limited && <><span aria-hidden="true">·</span><Button variant="link" size="xs"
                disabled={querying} onClick={() => void lookupRepository(true)}>
                {lookup.status === "missing" ? "重新查找" : lookup.status === "error" || lookup.status === "rateLimited" ? "重试" : "查找仓库"}
              </Button></>}
            </>}
          </div>}
        </div>
      </header>
      {aiSummary ? <section className="ai-summary" aria-label="AI 概括">
        <div className="ai-summary-label">
          <AiSummaryIcon />
          AI 概括
        </div>
        <p>{aiSummary}</p>
      </section> : description && <p className="description">{description}</p>}
      {skill.linked && <>
        <PathField label="发现位置" path={skill.directory} report={setError} />
        <div className="direction"><ArrowDown />指向</div>
      </>}
      <PathField label="实际目录" path={skill.target} open={open} report={setError} />
      {error && <p role="alert" className="warning">{error}</p>}
    </div>
    <div className="doc-bar"><FileText />SKILL.md</div>
    <div className="markdown">
      {skill.body ? <Markdown remarkPlugins={[remarkGfm]} skipHtml
        components={{ a: ({children}) => <span className="doc-link">{children}</span>,
                      img: ({alt}) => <span>{alt}</span> }}>
        {skill.body}
      </Markdown> : <p className="muted">此文件没有正文。</p>}
    </div>
  </article>
}
