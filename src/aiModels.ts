import catalog from "./modelCatalog.json"
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg"
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg"
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg"
import siliconflow from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg"
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg"
import openai from "@lobehub/icons-static-svg/icons/openai.svg"
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg"

export interface ModelConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export const providers = [
  { name: "DeepSeek", url: "https://api.deepseek.com", models: catalog.deepseek, logo: deepseek },
  { name: "Kimi（月之暗面）", url: "https://api.moonshot.cn/v1", models: catalog["moonshotai-cn"], logo: kimi },
  { name: "智谱 GLM", url: "https://open.bigmodel.cn/api/paas/v4", models: catalog.zhipuai, logo: zhipu },
  { name: "硅基流动", url: "https://api.siliconflow.cn/v1", models: catalog["siliconflow-cn"], logo: siliconflow },
  { name: "MiniMax", url: "https://api.minimax.cn/v1", models: catalog["minimax-cn"], logo: minimax },
  { name: "OpenAI", url: "https://api.openai.com/v1", models: catalog.openai, logo: openai },
  { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", models: catalog.google, logo: gemini },
]

export function providerFor(url: string) {
  return providers.find(p => p.url === url.trim().replace(/\/+$/, ""))
}


export interface ModelInfo { id: string; baseUrl: string; model: string }
export interface SettingsView { models: ModelInfo[]; activeModel: string | null; autoGenerate: boolean }
