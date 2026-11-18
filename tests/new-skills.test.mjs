import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

const compiled = ts.transpileModule(readFileSync(new URL("../src/newSkills.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exports = {}
runInNewContext(compiled, { exports })
const { isNewSkill, isUnreadSkill, markSkillSeen, NEW_SKILL_DURATION } = exports

test("new installation expires at exactly 72 hours", () => {
  const installed = 1_800_000_000_000
  assert.equal(NEW_SKILL_DURATION, 72 * 60 * 60 * 1000)
  assert.equal(isNewSkill(installed, installed), true)
  assert.equal(isNewSkill(installed, installed + NEW_SKILL_DURATION - 1), true)
  assert.equal(isNewSkill(installed, installed + NEW_SKILL_DURATION), false)
})

test("unknown, invalid and future installation times do not mark existing skills as new", () => {
  const now = 1_800_000_000_000
  for (const time of [null, undefined, NaN, Infinity, 0, -1, now + 1]) {
    assert.equal(isNewSkill(time, now), false)
  }
})

test("opening a new installation hides its dot until it is reinstalled", () => {
  const now = 1_800_000_000_000
  const installed = now - 1000
  const seen = markSkillSeen({}, "a", installed, now)
  assert.equal(isUnreadSkill("a", installed, now, {}), true)
  assert.equal(isUnreadSkill("a", installed, now, seen), false)
  assert.equal(isUnreadSkill("b", installed, now, seen), true)
  assert.equal(isUnreadSkill("a", installed + 1, now, seen), true)
  assert.equal(isUnreadSkill("a", installed - NEW_SKILL_DURATION, now, {}), false)
})

test("seen entries for installations that are no longer new are dropped", () => {
  const now = 1_800_000_000_000
  const seen = markSkillSeen({ old: now - NEW_SKILL_DURATION, recent: now - 5 }, "a", now - 1, now)
  assert.deepEqual(Object.keys(seen).sort(), ["a", "recent"])
})
