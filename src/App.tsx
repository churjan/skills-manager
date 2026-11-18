import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { ArrowDownAZ, ChevronRight, Clock, LayoutGrid, RefreshCw, Search, Settings as SettingsIcon } from "lucide-react"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { Badge } from "./components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible"
import { IconTooltip } from "./components/ui/icon-tooltip"
import { SkillDetail } from "./SkillDetail"
import { AgentIcon } from "./components/AgentIcon"
import { agentSource } from "./agentSources"
import { SkillTypeBadge } from "./components/SkillTypeBadge"
import { SkillUpdateBadge } from "./components/SkillUpdateBadge"
import { isUnreadSkill, markSkillSeen, type SeenSkills } from "./newSkills"
import { useSkillClock } from "./useSkillClock"
import { SkillListPane } from "./components/SkillListPane"
import { matches, type Inventory, type Skill, type SkillUpdate } from "./model"
import { AiSettings } from "./AiSettings"
import { findRepository, hydrateRepositoryLookups, retainRepositoryLookups, type RepositoryLookupCache } from "./repositories"
import type { SettingsView } from "./aiModels"
import { compareSkills, readSkillSort, type SkillSort } from "./skillSort"
import { Select, SelectButton, SelectContent, SelectGroup, SelectItem, SelectLabel } from "./components/ui/select"

const initial: Inventory = { skills: [], physicalCount: 0, errors: [] }
const SEEN_KEY = "seen-new-skills"

function readSeen(): SeenSkills {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}")
    return value && typeof value === "object" ? value as SeenSkills : {}
  } catch { return {} }
}

export function App() {
  const [report, setReport] = useState(initial)
  const now = useSkillClock(report.skills)
  const rememberRepository = useCallback((digest: string, url: string) => {
    setReport(current => ({ ...current, skills: current.skills.map(skill =>
      skill.digest === digest && !skill.repository ? { ...skill, repository: url } : skill
    ) }))
  }, [])
  const [busy, setBusy] = useState(true)
  const [spinning, setSpinning] = useState(false)
  const [query, setQuery] = useState("")
  const [sortOrder, setSortOrder] = useState<SkillSort>(readSkillSort)
  const [root, setRoot] = useState("")
  const [selection, setSelection] = useState("")
  const [error, setError] = useState("")
  const lock = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [automatic, setAutomatic] = useState(false)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [activeDigest, setActiveDigest] = useState("")
  const generating = useRef(false)
  const summaryPass = useRef(0)
  const [aiError, setAiError] = useState("")
  const repositoryPass = useRef(0)
  const [seen, setSeen] = useState(readSeen)
  const [updates, setUpdates] = useState<Record<string, SkillUpdate>>({})
  const updatePass = useRef(0)

  function open(skill: Skill) {
    setSelection(skill.directory)
    if (skill.installedAt === null || !isUnreadSkill(skill.directory, skill.installedAt, now, seen)) return
    const next = markSkillSeen(seen, skill.directory, skill.installedAt, now)
    setSeen(next)
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)) } catch { /* Keep the dot hidden for this session. */ }
  }

  async function checkRepositories(skills: Skill[]) {
    const pass = ++repositoryPass.current
    const seen = new Set<string>()
    for (const skill of skills) {
      if (pass !== repositoryPass.current) break
      if (skill.repository || !skill.digest || seen.has(skill.digest)) continue
      seen.add(skill.digest)
      try {
        const result = await findRepository(skill.directory, skill.digest)
        if (result.status === "found") rememberRepository(skill.digest, result.url)
        if (result.status === "rateLimited") break
      } catch { /* Continue with other skills if this lookup fails. */ }
    }
  }

  function applySettings(settings: SettingsView) {
    setConfigured(settings.models.some(m => m.id === settings.activeModel))
    setAutomatic(settings.autoGenerate)
    if (!settings.autoGenerate) {
      ++summaryPass.current
      setSummaries({})
    }
    setAiError("")
  }

  async function generate(skill: Skill) {
    if (generating.current || !skill.digest) return
    generating.current = true
    const pass = summaryPass.current
    setActiveDigest(skill.digest)
    setAiError("")
    try {
      const summary = await invoke<string>("generate_summary", { directory: skill.directory, id: skill.digest, force: false })
      if (pass === summaryPass.current) setSummaries(previous => ({ ...previous, [skill.digest]: summary }))
    } catch (reason) {
      if (pass === summaryPass.current) setAiError(skill.displayName + "：" + String(reason))
    } finally {
      generating.current = false
      setActiveDigest("")
    }
  }

  useEffect(() => {
    if (!automatic || !configured || busy || aiError || activeDigest || showSettings) return
    const missing = report.skills.find(skill => skill.digest && !summaries[skill.digest])
    if (missing) void generate(missing)
  }, [automatic, configured, busy, aiError, activeDigest, showSettings, report.skills, summaries])

  async function refresh(animate = false) {
    if (lock.current) return
    lock.current = true
    ++repositoryPass.current
    setBusy(true)
    if (animate) setSpinning(true)
    setError("")
    try {
      if (!isTauri()) throw new Error("请在 Windows 客户端中打开以扫描本机目录。")
      const next = await invoke<Inventory>("scan_skills")
      if (!next.errors.length) retainRepositoryLookups(new Set(next.skills.map(skill => skill.digest)))
      setReport(next)
      setRoot(previous => next.skills.some(s => s.root === previous) ? previous : "")
      const [cache, settings, lookups] = await Promise.allSettled([
        invoke<Record<string, string>>("load_summaries"),
        invoke<SettingsView>("ai_settings"),
        invoke<RepositoryLookupCache>("load_repository_lookups"),
      ])
      if (lookups.status === "fulfilled") hydrateRepositoryLookups(lookups.value)
      void checkRepositories(next.skills)
      const pass = ++updatePass.current
      void invoke<Record<string, SkillUpdate>>("check_skill_updates")
        .then(result => { if (pass === updatePass.current) setUpdates(result) })
        .catch(() => { /* Update status is optional and retried on the next scan. */ })
      if (settings.status === "fulfilled") applySettings(settings.value)
      else setAiError(String(settings.reason))
      if (cache.status === "fulfilled") setSummaries(settings.status === "fulfilled" && settings.value.autoGenerate ? cache.value : {})
      else setAiError(String(cache.reason))
    } catch (reason) {
      setError(String(reason))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return
      if (event.ctrlKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const sources = useMemo(() => {
    const labels = new Map(report.skills.map(skill => [skill.root, skill.label]))
    return [...labels].sort(([a, x], [b, y]) =>
      Number(agentSource(y).name === "Agents") - Number(agentSource(x).name === "Agents")
      || x.localeCompare(y, "zh-CN") || a.localeCompare(b))
  }, [report.skills])

  const sourceLabel = sources.find(([path]) => path === root)?.[1]
  const sourceName = sourceLabel ? agentSource(sourceLabel).name : "全部"
  const results = report.skills
    .filter(skill => (!root || skill.root === root) && matches(skill, query, automatic ? summaries[skill.digest] : undefined))
    .sort((a, b) => compareSkills(a, b, sortOrder))
  const selected = results.find(skill => skill.directory === selection) ?? results[0]
  const errors = [...(error ? [error] : []), ...report.errors]

  return <main className="workspace">
    <nav className="rail" aria-label="按来源浏览">
      <div className="rail-sources">
        <IconTooltip label="全部"><Button variant="ghost" size="icon" aria-label="浏览全部技能"
          aria-current={root === "" ? "page" : undefined} onClick={() => setRoot("")}><LayoutGrid /></Button></IconTooltip>
        {sources.map(([path, label]) =>
        <IconTooltip key={path} label={agentSource(label).name}>
          <Button variant="ghost" size="icon" aria-label={"浏览 " + agentSource(label).name}
            aria-description={path} aria-current={root === path ? "page" : undefined}
            onClick={() => setRoot(path)}><AgentIcon label={label} /></Button>
        </IconTooltip>
      )}</div>
      <IconTooltip label="设置"><Button variant="ghost" size="icon" aria-label="设置"
        onClick={() => setShowSettings(true)}><SettingsIcon /></Button></IconTooltip>
    </nav>
    <SkillListPane>
      <div className="tools">
        <div className="heading">
          <h1 id="skill-list-heading" className="min-w-0" title={sourceName}><span className="truncate">{sourceName}</span> <Badge variant="secondary" className="skill-count shrink-0">{results.length}</Badge></h1>
          <div className="flex shrink-0 items-center gap-0.5">
          <Select value={sortOrder} onValueChange={value => {
            if (value !== "modified" && value !== "alphabetical") return
            setSortOrder(value)
            try { localStorage.setItem("skill-sort", value) } catch { /* Keep the selection for this session. */ }
          }}>
            <SelectButton render={<Button variant="ghost" size="icon-sm" />}
              aria-label="技能排序" title={"排序：" + (sortOrder === "modified" ? "最近变更" : "字母顺序")}>
              {sortOrder === "modified" ? <Clock /> : <ArrowDownAZ />}
            </SelectButton>
            <SelectContent align="end" alignItemWithTrigger={false} className="min-w-60"><SelectGroup>
              <SelectLabel>排序方式</SelectLabel>
              <SelectItem value="modified"><Clock />最近变更<span className="text-xs text-muted-foreground">最近在前</span></SelectItem>
              <SelectItem value="alphabetical"><ArrowDownAZ />字母顺序<span className="text-xs text-muted-foreground">A → Z</span></SelectItem>
            </SelectGroup></SelectContent>
          </Select>
          <Button variant="ghost" size="icon-sm" disabled={busy} title="重新扫描" aria-label="重新扫描"
            className="disabled:opacity-100" onClick={() => void refresh(true)}>
            <RefreshCw className={spinning ? "refresh-spin" : ""} onAnimationIteration={() => { if (!busy) setSpinning(false) }} /></Button>
          </div>
        </div>
        <div className="search"><Search /><Input ref={search} type="search" aria-label="搜索名称、描述或路径"
          title="搜索名称、描述或路径 (Ctrl+F)" placeholder={root ? "搜索技能…" : "搜索全部技能…"} value={query}
          onChange={event => setQuery(event.target.value)} /></div>
        {errors.length > 0 && <Collapsible className="warning">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="justify-start" />}>
            <ChevronRight data-icon="inline-start" className="group-aria-expanded/button:rotate-90" />
            {error ? "扫描失败" : "部分目录未能读取"}（{errors.length}）
          </CollapsibleTrigger>
          <CollapsibleContent><ul>{errors.map((message,i) => <li key={i}>{message}</li>)}</ul></CollapsibleContent>
        </Collapsible>}
        {aiError && <p role="alert" className="warning">AI 简介：{aiError}</p>}
      </div>
      <div className="entries" key={root}>
        {results.map(skill => {
          const description = (automatic ? summaries[skill.digest]?.trim() : undefined) || skill.description.trim() || "暂无描述"
          return <Button key={skill.directory} variant="ghost" className="entry h-auto justify-start whitespace-normal"
            title={[skill.displayName, description, skill.directory].join("\n")}
            aria-pressed={skill.directory === selected?.directory} onClick={() => open(skill)}>
            {isUnreadSkill(skill.directory, skill.installedAt, now, seen) &&
              <span className="entry-unread" title="新安装，尚未查看" aria-label="新安装，尚未查看" />}
            <span className="entry-copy">
              <span className="entry-title">
                <span className="entry-name">{skill.displayName}</span>
                <SkillTypeBadge linked={skill.linked} />
                <SkillUpdateBadge update={skill.lockName ? updates[skill.lockName] : undefined} />
              </span>
              {!root && <span className="entry-sources"><Badge variant="source">{agentSource(skill.label).name}</Badge></span>}
              <span className="entry-description">{description}</span>
            </span>
          </Button>
        })}
        {!busy && !results.length && <div className="empty">{query.trim() ? "没有匹配的 Skill" : error ? "无法加载技能清单" : "在已扫描范围内未发现 Skill"}</div>}
      </div>
    </SkillListPane>
    {selected ? <SkillDetail key={selected.directory + selected.target} skill={selected}
      description={selected.description}
      aiSummary={automatic ? summaries[selected.digest]?.trim() : undefined}
      update={selected.lockName ? updates[selected.lockName] : undefined}
      repositoryLookupReady={!busy}
      rememberRepository={rememberRepository} /> :
      <section className="detail empty">{busy ? "正在读取本地 Skills…" : "暂无 Skill 详情"}</section>}
    {showSettings && <AiSettings close={() => setShowSettings(false)} changed={applySettings} saved={applySettings} />}
  </main>
}
