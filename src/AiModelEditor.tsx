import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Check, CircleAlert, Globe, LoaderCircle } from "lucide-react"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { Badge } from "./components/ui/badge"
import { providers, providerFor, type ModelConfig, type SettingsView } from "./aiModels"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog"
import { Field, FieldGroup, FieldLabel, FieldSet } from "./components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "./components/ui/select"

export function AiModelEditor({ id, close, saved }: { id?: string; close: () => void; saved: (config: SettingsView) => void }) {
  const [settings, setSettings] = useState<ModelConfig | null>(null)
  const [pending, setPending] = useState<"test" | "save" | null>(null)
  const [testedSettings, setTestedSettings] = useState<ModelConfig | null>(null)
  const tested = settings !== null && testedSettings === settings
  const [error, setError] = useState<{ message: string; field?: "apiKey" } | null>(null)
  const invalidKey = error?.field === "apiKey"
  const working = pending !== null
  const [manualModel, setManualModel] = useState(false)
  const [providerName, setProviderName] = useState("")
  const provider = providers.find(p => p.name === providerName)
  const selectedModel = provider?.models.find(model => model.id === settings?.model)
  useEffect(() => {
    let current = true
    const load = id ? invoke<ModelConfig>("read_ai_model", { id }) : Promise.resolve({
      baseUrl: providers[0].url, model: providers[0].models[0].id, apiKey: "",
    })
    load.then(initial => {
      if (!current) return
      const known = providerFor(initial.baseUrl)
      setProviderName(known?.name ?? "")
      setSettings({ ...initial, model: initial.model || known?.models[0].id || "" })
      setManualModel(Boolean(initial.model && !known?.models.some(m => m.id === initial.model)))
    }).catch(reason => { if (current) setError({ message: String(reason) }) })
    return () => { current = false }
  }, [id])

  function edit<K extends keyof ModelConfig>(field: K, value: ModelConfig[K]) {
    setSettings(old => old && { ...old, [field]: value })
    setError(null)
  }
  async function submit(test: boolean) {
    if (!settings || working || (!test && !tested)) return
    setPending(test ? "test" : "save")
    setError(null)
    try {
      if (test) {
        setTestedSettings(null)
        await invoke("test_ai_settings", { settings })
        setTestedSettings(settings)
      } else {
        saved(await invoke<SettingsView>("save_ai_model", { id: id ?? null, model: settings }))
      }
    } catch (reason) {
      if (test && reason && typeof reason === "object" && "message" in reason) {
        setError({
          message: String(reason.message),
          field: "field" in reason && reason.field === "apiKey" ? "apiKey" : undefined,
        })
      } else {
        setError({ message: String(reason) })
      }
    } finally {
      setPending(null)
    }
  }
  return <Dialog open disablePointerDismissal onOpenChange={(open, event) => {
    if (working) event.cancel()
    else if (!open) close()
  }}>
    <DialogContent className="settings-dialog max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[520px]">
    <DialogHeader className="px-6 pt-6 pb-5"><DialogTitle className="text-lg leading-6">{id ? "编辑 AI 模型" : "添加 AI 模型"}</DialogTitle></DialogHeader>
    {settings && <FieldSet disabled={working} className="px-6 pb-6">
      <FieldGroup className="gap-5">
      <Field>
        <FieldLabel id="provider-label" htmlFor="provider-trigger">服务商</FieldLabel>
        <Select value={provider?.name ?? "自定义"}
          disabled={working} onValueChange={name => {
            if (!name) return
            const next = providers.find(p => p.name === name)
            setProviderName(next?.name ?? "")
            setSettings({ ...settings, baseUrl: next?.url ?? "", model: next?.models[0].id ?? "", apiKey: "" })
            setManualModel(false)
            setError(null)
          }}>
          <SelectTrigger id="provider-trigger" aria-labelledby="provider-label" className="w-full min-w-0">
            {provider ? <img src={provider.logo} alt="" className="size-4 shrink-0 object-contain" /> : <Globe aria-hidden="true" />}
            <SelectValue>{provider?.name ?? "自定义"}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectGroup><SelectLabel>服务商</SelectLabel>{providers.map(({name, logo}) =>
              <SelectItem key={name} value={name} label={name}>
                <img src={logo} alt="" className="size-4 shrink-0 object-contain" />{name}
              </SelectItem>
            )}</SelectGroup>
            <SelectSeparator />
            <SelectGroup><SelectItem value="自定义" label="自定义"><Globe aria-hidden="true" />自定义</SelectItem></SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {!provider && <Field>
        <FieldLabel htmlFor="ai-url">API 基础地址</FieldLabel>
        <Input id="ai-url" type="url" value={settings.baseUrl} placeholder="https://example.com/v1"
          onChange={e => {
            const baseUrl = e.target.value
            setSettings({ ...settings, baseUrl, apiKey: "" })
            setError(null)
          }} />
      </Field>}
      <Field>
        <FieldLabel htmlFor={provider ? "ai-model-choice" : "ai-model"}>模型</FieldLabel>
        {provider && <Select value={manualModel || !selectedModel ? "__custom__" : selectedModel.id} disabled={working}
          onValueChange={id => {
            if (!id) return
            setManualModel(id === "__custom__")
            edit("model", id === "__custom__" ? "" : id)
          }}>
          <SelectTrigger id="ai-model-choice" className="w-full min-w-0">
            <SelectValue className="min-w-0 truncate">{manualModel || !selectedModel ? "手动输入模型" : selectedModel.name}</SelectValue>
            {!manualModel && selectedModel?.id === provider.models[0].id && <Badge variant="source">默认</Badge>}
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectGroup><SelectLabel>{provider.name}</SelectLabel>
              {provider.models.map(model => <SelectItem key={model.id} value={model.id}
                label={model.name}>
                <span className="flex flex-col items-start">
                  <span>{model.name}</span>
                  <span className="text-xs text-muted-foreground">{model.id}</span>
                </span>
              </SelectItem>)}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup><SelectItem value="__custom__">手动输入模型</SelectItem></SelectGroup>
          </SelectContent>
        </Select>}
        {(!provider || manualModel || !selectedModel) && <Input id="ai-model" aria-label="模型 ID"
          placeholder="输入服务商提供的模型 ID" value={settings.model} onChange={e => edit("model", e.target.value)} />}
      </Field>
      <Field data-invalid={invalidKey || undefined}>
        <FieldLabel htmlFor="ai-key">API 密钥</FieldLabel>
        <Input id="ai-key" type="password" autoComplete="off" placeholder="粘贴服务商提供的 API Key" value={settings.apiKey}
          aria-invalid={invalidKey || undefined} aria-describedby={invalidKey ? "ai-model-error" : undefined}
          onChange={e => edit("apiKey", e.target.value)} />
      </Field>
      </FieldGroup>
    </FieldSet>}
    {tested && !error && <p role="status" className="flex items-center gap-2 px-6 pb-5 text-sm font-medium text-green-700 dark:text-green-400">
      <Check aria-hidden="true" className="size-4 shrink-0 rounded-full bg-green-700 p-0.5 text-white" strokeWidth={3} />
      模型可用
    </p>}
    {error && <p id="ai-model-error" role="alert" className="flex items-start gap-2 px-6 pb-5 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 fill-destructive stroke-background" />
      {error.message}
    </p>}
    <DialogFooter className="m-0 flex-row flex-wrap rounded-none border-border/70 bg-background px-6 py-4">
      {settings && <Button variant="outline" className="mr-auto" disabled={working}
        onClick={() => void submit(true)}>
        {pending === "test" && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
        <span aria-live="polite">{pending === "test" ? "正在测试…" : "测试模型"}</span>
      </Button>}
      <DialogClose render={<Button variant="outline" disabled={working} />}>取消</DialogClose>
      {settings && <Button disabled={working || !tested} onClick={() => void submit(false)}>保存</Button>}
    </DialogFooter>
    </DialogContent>
  </Dialog>
}
