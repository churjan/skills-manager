import antigravity from "@lobehub/icons-static-svg/icons/antigravity.svg"
import claude from "@lobehub/icons-static-svg/icons/claudecode.svg"
import codex from "@lobehub/icons-static-svg/icons/openai.svg"
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg"
import gemini from "@lobehub/icons-static-svg/icons/gemini.svg"
import copilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg"
import kilocode from "@lobehub/icons-static-svg/icons/kilocode.svg"
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg"
import roocode from "@lobehub/icons-static-svg/icons/roocode.svg"
import windsurf from "@lobehub/icons-static-svg/icons/windsurf.svg"
import workbuddy from "@lobehub/icons-static-svg/icons/workbuddy.svg"
import amp from "@lobehub/icons-static-svg/icons/amp.svg"
import cline from "@lobehub/icons-static-svg/icons/cline.svg"
import codebuddy from "@lobehub/icons-static-svg/icons/codebuddy.svg"
import devin from "@lobehub/icons-static-svg/icons/devin.svg"
import goose from "@lobehub/icons-static-svg/icons/goose.svg"
import junie from "@lobehub/icons-static-svg/icons/junie.svg"
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg"
import kiro from "@lobehub/icons-static-svg/icons/kiro.svg"
import openhands from "@lobehub/icons-static-svg/icons/openhands.svg"
import pi from "@lobehub/icons-static-svg/icons/pi.svg"
import qoder from "@lobehub/icons-static-svg/icons/qoder.svg"
import qwen from "@lobehub/icons-static-svg/icons/qwen.svg"
import replit from "@lobehub/icons-static-svg/icons/replit.svg"
import trae from "@lobehub/icons-static-svg/icons/trae.svg"
import grok from "@lobehub/icons-static-svg/icons/grok.svg"
import minimax from "@lobehub/icons-static-svg/icons/minimax.svg"
import mistral from "@lobehub/icons-static-svg/icons/mistral.svg"
import openclaw from "@lobehub/icons-static-svg/icons/openclaw.svg"

interface AgentSource { name: string; logo?: string }

const sources = new Map<string, AgentSource>([
  [".agents", { name: "Agents" }],
  [".codex", { name: "Codex", logo: codex }],
  [".workbuddy", { name: "WorkBuddy", logo: workbuddy }],
  [".cursor", { name: "Cursor", logo: cursor }],
  [".claude", { name: "Claude Code", logo: claude }],
  [".github", { name: "GitHub Copilot", logo: copilot }],
  [".gemini", { name: "Gemini", logo: gemini }],
  [".gemini/antigravity", { name: "Antigravity", logo: antigravity }],
  [".opencode", { name: "OpenCode", logo: opencode }],
  [".codeium/windsurf", { name: "Windsurf", logo: windsurf }],
  [".roo", { name: "Roo Code", logo: roocode }],
  [".kilocode", { name: "Kilo Code", logo: kilocode }],
  [".amp", { name: "Amp", logo: amp }],
  [".cline", { name: "Cline", logo: cline }],
  [".codebuddy", { name: "CodeBuddy", logo: codebuddy }],
  [".devin", { name: "Devin", logo: devin }],
  [".goose", { name: "Goose", logo: goose }],
  [".junie", { name: "Junie", logo: junie }],
  [".kimi", { name: "Kimi Code", logo: kimi }],
  [".kiro", { name: "Kiro", logo: kiro }],
  [".openhands", { name: "OpenHands", logo: openhands }],
  [".pi", { name: "Pi", logo: pi }],
  [".qoder", { name: "Qoder", logo: qoder }],
  [".qoder-cn", { name: "Qoder CN", logo: qoder }],
  [".qwen", { name: "Qwen Code", logo: qwen }],
  [".replit", { name: "Replit", logo: replit }],
  [".trae", { name: "Trae", logo: trae }],
  [".trae-cn", { name: "Trae CN", logo: trae }],
  [".grok", { name: "Grok Build", logo: grok }],
  [".minimax", { name: "MiniMax Code", logo: minimax }],
  [".vibe", { name: "Mistral Vibe", logo: mistral }],
  [".openclaw", { name: "OpenClaw", logo: openclaw }],
])

const aliases = new Map([
  ["codex_home", ".codex"],
  [".config/opencode", ".opencode"],
  ["xdg_config_home", ".opencode"],
  [".copilot", ".github"],
  [".kilo", ".kilocode"],
  [".kimi-code", ".kimi"],
  [".pi/agent", ".pi"],
  [".config/amp", ".amp"],
  [".config/devin", ".devin"],
  [".config/goose", ".goose"],
  [".gemini/config", ".gemini/antigravity"],
  [".clawdbot", ".openclaw"],
  [".moltbot", ".openclaw"],
])

export function agentSource(label: string): AgentSource {
  const key = label.replaceAll("\\", "/").toLowerCase()
  const known = sources.get(aliases.get(key) ?? key)
  if (known) return known
  const words = label.replace(/^\.+/, "").split(/[\s._-]+/).filter(Boolean)
  return { name: words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || label }
}
