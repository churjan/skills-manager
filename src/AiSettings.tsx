import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Globe, Pencil, Plus, Trash2 } from "lucide-react"
import { AiModelEditor } from "./AiModelEditor"
import { providerFor, type SettingsView } from "./aiModels"
import { Button } from "./components/ui/button"
import { Checkbox } from "./components/ui/checkbox"
import { Empty, EmptyDescription } from "./components/ui/empty"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "./components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select"

export function AiSettings({ close, changed, saved }: {
  close: () => void; changed: (settings: SettingsView) => void; saved: (settings: SettingsView) => void
}) {
  const [config, setConfig] = useState<SettingsView | null>(null)
  const [editor, setEditor] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [automatic, setAutomatic] = useState(false)
  const [removing, setRemoving] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function load(view: SettingsView) {
    setConfig(view)
    setActive(view.activeModel)
    setAutomatic(view.autoGenerate)
  }
  useEffect(() => {
    let current = true
    invoke<SettingsView>("ai_settings").then(view => { if (current) load(view) })
      .catch(reason => { if (current) setError(String(reason)) })
    return () => { current = false }
  }, [])

  function openEditor(id = "") {
    setRemoving("")
    setError("")
    setEditor(id)
  }
  function updateModels(view: SettingsView) {
    const next = active !== config?.activeModel && view.models.some(m => m.id === active)
      ? active : view.activeModel
    setConfig(view)
    setActive(next)
    setAutomatic(Boolean(next) && (automatic !== config?.autoGenerate ? automatic : view.autoGenerate))
    changed(view)
  }
  async function remove(id: string) {
    setBusy(true)
    setError("")
    try {
      const view = await invoke<SettingsView>("remove_ai_model", { id })
      updateModels(view)
      setRemoving("")
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  async function save() {
    setBusy(true)
    setError("")
    try {
      const view = await invoke<SettingsView>("save_ai_preferences", { activeModel: active, autoGenerate: automatic })
      saved(view)
      close()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  if (editor !== null) {
    return <AiModelEditor id={editor || undefined} close={() => setEditor(null)} saved={view => {
      updateModels(view)
      setEditor(null)
    }} />
  }
  const activeInfo = config?.models.find(m => m.id === active)
  const activeProvider = activeInfo && providerFor(activeInfo.baseUrl)
  return <Dialog open onOpenChange={(open, event) => {
    if (busy) event.cancel()
    else if (!open) close()
  }}>
    <DialogContent className="settings-dialog max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[520px]">
      <DialogHeader className="px-6 pt-6 pb-4">
        <DialogTitle className="text-lg leading-6">AI 设置</DialogTitle>

      </DialogHeader>

      <div className="px-6">
      {config && <div>
        <section aria-labelledby="models-heading" className="pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 id="models-heading" className="text-sm font-medium">模型列表</h3>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => openEditor()}><Plus data-icon="inline-start" />添加模型</Button>
          </div>
          {config.models.length ? <ul className="max-h-56 divide-y divide-border/70 overflow-y-auto rounded-lg border border-border">
            {config.models.map(m => <li key={m.id} className="flex items-center gap-3 p-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent" aria-hidden="true">
                {providerFor(m.baseUrl)?.logo ? <img src={providerFor(m.baseUrl)?.logo} alt="" className="size-6 object-contain" /> : <Globe className="size-5 text-muted-foreground" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm leading-5 font-medium" title={m.baseUrl}>{providerFor(m.baseUrl)?.name ?? m.baseUrl}</div>
                <div className="truncate text-xs leading-5 text-muted-foreground" title={m.model}>{m.model}</div>
              </div>
              {removing === m.id ? <>
                <Button size="xs" variant="destructive" disabled={busy} onClick={() => void remove(m.id)}>确认移除</Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving("")}>取消</Button>
              </> : <>
                <Button size="icon-sm" variant="ghost" aria-label={"编辑 " + m.model} disabled={busy} onClick={() => openEditor(m.id)}><Pencil /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={"移除 " + m.model} disabled={busy} onClick={() => setRemoving(m.id)}><Trash2 /></Button>
              </>}
            </li>)}
          </ul> : <Empty className="rounded-md border border-solid border-border bg-muted/40 p-3">
            <EmptyDescription>尚未添加模型</EmptyDescription>
          </Empty>}
        </section>
        <FieldGroup className="gap-5 py-6">
          <Field>
            <FieldLabel htmlFor="active-model" className="shrink-0">使用的模型</FieldLabel>
            <Select value={active} disabled={!config.models.length || busy} onValueChange={setActive}>
              <SelectTrigger id="active-model" className="w-full min-w-0" title={activeInfo?.baseUrl}>
                {activeInfo && (activeProvider ? <img src={activeProvider.logo} alt="" className="size-4 shrink-0 object-contain" /> : <Globe aria-hidden="true" />)}
                <SelectValue className="min-w-0 truncate" placeholder="选择模型">{activeInfo?.model}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectGroup>{config.models.map(m => {
                  const provider = providerFor(m.baseUrl)
                  return <SelectItem key={m.id} value={m.id} label={m.model} title={m.baseUrl}>
                    {provider ? <img src={provider.logo} alt="" className="size-4 shrink-0 object-contain" /> : <Globe aria-hidden="true" />}
                    {m.model}
                  </SelectItem>
                })}</SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal" data-disabled={busy || !active}>
            <Checkbox id="summary-auto" disabled={busy || !active} checked={automatic}
              onCheckedChange={setAutomatic} />
            <FieldLabel htmlFor="summary-auto">自动生成技能介绍</FieldLabel>
          </Field>
        </FieldGroup>
      </div>}
      </div>
      {error && <p role="alert" className="px-6 pb-4 text-sm text-destructive">{error}</p>}
      <DialogFooter className="m-0 flex-row justify-end rounded-none border-border/70 bg-background px-6 py-4">
        <DialogClose render={<Button variant="outline" disabled={busy} />}>关闭</DialogClose>
        <Button disabled={!config || busy} onClick={() => void save()}>保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
