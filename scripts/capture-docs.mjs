// Documentation screenshots use synthetic data only. No desktop IPC or user profile is read.
// Start `npm run dev`, then run with Playwright installed:
// node scripts/capture-docs.mjs
// PLAYWRIGHT_MODULE may point to an existing Playwright index.mjs.
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 810 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
  })
  await page.addInitScript(() => {
    const examples = [
      ['frontend-design', 'Frontend Design', '创建有辨识度的前端界面，兼顾布局、字体、配色与交互细节。', '.claude'],
      ['find-skills', 'Find Skills', '根据任务查找合适的技能，了解用途并选择安装方式。', '.agents'],
      ['web-design-guidelines', 'Web Design Guidelines', '检查网页的可访问性、视觉一致性和交互体验。', '.cursor'],
      ['pdf', 'PDF', '提取和整理 PDF 内容，创建文档并检查页面布局。', '.codex'],
      ['docx', 'DOCX', '创建和编辑 Word 文档，调整结构、样式与排版。', '.claude'],
      ['xlsx', 'XLSX', '整理电子表格，编写公式并生成清晰的数据图表。', '.codex'],
      ['pptx', 'PPTX', '制作演示文稿，统一版式并组织清晰的视觉叙事。', '.claude'],
      ['webapp-testing', 'Webapp Testing', '使用浏览器验证网页流程，定位交互问题并记录结果。', '.cursor'],
      ['skill-creator', 'Skill Creator', '将重复工作整理成可复用的技能，明确步骤与验证方式。', '.agents'],
    ]
    const skills = examples.map(([name, displayName, description, label], i) => {
      const root = `C:\\Users\\Demo\\${label}\\skills`
      return {
        name, displayName, description, label, root,
        directory: `${root}\\${name}`, target: `${root}\\${name}`, linked: false,
        digest: `demo-${name}`, repository: 'https://github.com/example/skills', version: null, lockName: null,
        installedAt: null, modifiedAt: 1700000000 - i * 3600,
        body: `# ${displayName}\n\n${description}\n\n> 以下内容为文档截图的模拟示例。\n\n## 工作流程\n\n1. 理解目标与使用场景，确认需要交付的结果。\n2. 结合现有项目结构，选择合适的方法与工具。\n3. 完成实现并检查细节，保证结果清晰、可用。\n\n## 设计原则\n\n- 以用户任务为中心，保持信息层次清晰。\n- 使用一致的间距、字体与配色。\n- 关注键盘操作、可访问性与响应式布局。\n\n## 交付检查\n\n检查主要流程、边界情况与最终展示效果。`,
      }
    })
    const settings = {
      models: [
        { id: 'demo-1', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
        { id: 'demo-2', baseUrl: 'https://api.openai.com/v1', model: 'example-model' },
      ], activeModel: 'demo-1', autoGenerate: true,
    }
    const summaries = Object.fromEntries(skills.map(skill => [skill.digest, skill.description]))
    const responses = {
      scan_skills: { skills, physicalCount: skills.length, errors: [] },
      ai_settings: settings, load_summaries: summaries,
      load_repository_lookups: { entries: {}, rateLimitUntil: 0 },
      check_skill_updates: {},
      find_github_repository: { status: 'missing', retryAt: 4102444800 },
    }
    window.isTauri = true
    window.__TAURI_INTERNALS__ = {
      invoke: async command => {
        if (!(command in responses)) throw new Error(`Unexpected mock IPC: ${command}`)
        return structuredClone(responses[command])
      },
    }
  })
  await page.goto(process.env.DOCS_URL || 'http://127.0.0.1:1420/')
  await page.getByRole('heading', { name: 'Frontend Design', exact: true }).first().waitFor()
  await page.getByRole('region', { name: 'AI 概括' }).waitFor()
  await page.getByRole('button', { name: '打开 GitHub 仓库', exact: true }).waitFor()
  await mkdir('docs/images', { recursive: true })
  async function capture(name) {
    await page.mouse.move(1299, 809)
    await page.waitForTimeout(400)
    const screenshot = join(tmpdir(), `skills-manager-docs-${name}.png`)
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    const result = spawnSync('python', ['-c',
      'from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2], "WEBP", lossless=True, method=6)',
      screenshot, `docs/images/${name}.webp`], { encoding: 'utf8' })
    if (result.status !== 0) throw Error(result.stderr || 'WebP conversion failed')
  }
  await capture('main')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('deepseek-chat', { exact: true }).first().waitFor()
  await capture('ai-settings')
  if (errors.length) throw Error(errors.join('\n'))
  console.log('Generated two WebP screenshots using synthetic data only.')
} finally {
  await browser.close()
}
