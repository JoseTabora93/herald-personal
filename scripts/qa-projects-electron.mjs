#!/usr/bin/env node
/** Real Electron/IPC/API/SQLite, synthetic projects and evidence only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QA = path.join(ROOT, '.runtime/qa-projects')
const require = createRequire(path.join(ROOT, 'apps/desktop/package.json'))
const { _electron } = require('playwright')
const { expect: baseExpect } = require('playwright/test')
const expect = baseExpect.configure({ timeout: 30000 })
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','USER','LOGNAME','SHELL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
let service, electron, page, token
const report = { syntheticOnly: true, checks: [], errors: [], result: 'RUNNING' }
const pass = name => { report.checks.push(name); console.log('PASS ' + name) }
const stamp = () => new Date().toISOString()
async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:8796/v1/${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert(response.ok, `Fixture API ${method} ${route}: ${response.status}`)
  return response.json()
}
async function launch() {
  electron = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(QA, 'entry.mjs'), '--personal-plan', '2026-10-10'], cwd: ROOT, timeout: 60000, env: { ...env, HERMES_HOME: path.join(QA, 'hermes-home'), HERALD_OS_HERMES_ROOT: path.join(os.homedir(), '.hermes/hermes-agent'), HERALD_OS_WINDOWED: '1', HERALD_PERSONAL_URL: 'http://127.0.0.1:8796', HERALD_PERSONAL_TOKEN_FILE: path.join(QA, 'token') } })
  page = await electron.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 1080))
  await expect.poll(() => page.evaluate(async () => (await window.heraldOS.backend.getState()).phase), { timeout: 60000 }).toBe('ready')
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Proyectos', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'QA Campo', exact: true }).last()).toBeVisible()
}
try {
  await fs.mkdir(QA, { recursive: true, mode: 0o700 })
  for (const folder of ['data', 'chromium']) await fs.rm(path.join(QA, folder), { recursive: true, force: true })
  token = randomBytes(32).toString('hex')
  await fs.writeFile(path.join(QA, 'token'), token, { mode: 0o600 })
  await fs.mkdir(path.join(QA, 'hermes-home/herald-os'), { recursive: true })
  await fs.writeFile(path.join(QA, 'hermes-home/herald-os/prefs.json'), JSON.stringify({ fullscreenOnLaunch: false, reduceMotion: true, voice: { enabled: false, wakeWord: false }, continuity: { enabled: false, exclude: [] }, crashHelp: { enabled: false, muted: [] } }))
  await fs.writeFile(path.join(QA, 'entry.mjs'), `import {app} from 'electron'; app.setPath('appData',${JSON.stringify(path.join(QA,'app-data'))}); app.setPath('userData',${JSON.stringify(path.join(QA,'chromium'))}); await import(${JSON.stringify(pathToFileURL(path.join(ROOT,'apps/desktop/dist/electron/main.mjs')).href)});`)
  const log = await fs.open(path.join(QA, 'service.log'), 'w', 0o600)
  service = spawn(path.join(ROOT, 'services/personal/.venv/bin/python'), [path.join(ROOT, 'scripts/qa-projects-service.py')], { cwd: ROOT, env, stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:8796/healthz')).ok } catch { return false } }).toBe(true)
  const body = { project: 'QA Campo', label: 'QA Cezar + GitHub', attempted_at: stamp(), source_updated_at: stamp(), interval_seconds: 900, items: [
    { key: 'qa-n3', title: 'N3 CLI importador', run_id: 'qa-n3', run_status: 'completed' },
    ...[1,2,4,5,6].map(n => ({ key: `qa-n${n}`, title: `N${n} Trabajo integrado`, run_id: `qa-n${n}`, run_status: 'completed', pr: { repository: 'example/fixture', number: n + 10, state: 'MERGED', updated_at: stamp() } })),
    { key: 'qa-live', title: 'PDF v3 implementación', run_id: 'qa-live', run_status: 'running' }
  ] }
  await api('PUT', 'project-sources/qa-build', body)
  await api('POST', 'tasks', { title: 'Compromiso manual de otro proyecto', project: 'QA Oficina', status: 'done' })
  const before = (await api('GET', 'tasks')).items.map(t => t.id).sort()
  await launch()
  await expect(page.getByRole('region', { name: 'Cerrados', exact: true }).getByRole('button')).toHaveCount(5)
  await expect(page.getByRole('region', { name: 'En curso', exact: true }).getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Revisar / atender', exact: true }).getByRole('button')).toHaveCount(1)
  pass('Native project board includes five closed items, one active run and one blocker')
  await page.screenshot({ path: path.join(QA, 'dashboard.png'), fullPage: false })
  await page.getByRole('button', { name: 'Ver tarea N3 CLI importador', exact: true }).click()
  await expect(page.getByTestId('project-evidence').getByText(/falta un PR o evidencia/)).toBeVisible()
  await expect(page.getByTestId('project-evidence').getByText('Despliegue: sin verificar', { exact: true })).toBeVisible()
  pass('Task detail distinguishes process completion, integration and validation')
  await page.getByRole('button', { name: 'Ver proyecto QA Oficina', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Cerrados', exact: true }).getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ver tarea N3 CLI importador', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Ver proyecto QA Campo', exact: true }).click()
  pass('Project selection isolates both manual and imported work')
  body.attempted_at = stamp(); body.items[6].run_status = 'completed'; body.items[6].pr = { repository: 'example/fixture', number: 22, state: 'OPEN', updated_at: stamp() }
  await api('PUT', 'project-sources/qa-build', body)
  await page.getByRole('button', { name: 'Actualizar panel', exact: true }).click()
  await expect(page.getByRole('region', { name: 'En curso', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Revisar / atender', exact: true }).getByRole('button')).toHaveCount(2)
  assert.deepEqual((await api('GET', 'tasks')).items.map(t => t.id).sort(), before)
  pass('New source snapshot moves the run into PR review without creating duplicate tasks')
  await electron.close(); electron = null
  await launch()
  await expect(page.getByRole('region', { name: 'Cerrados', exact: true }).getByRole('button')).toHaveCount(5)
  await page.getByRole('button', { name: 'Ver tarea PDF v3 implementación', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ver PR #22', exact: true })).toBeVisible()
  pass('Project evidence persists across an Electron restart')
  await api('PUT', 'project-sources/qa-build', { ...body, attempted_at: stamp(), error: 'source_unavailable', items: [] })
  await page.getByRole('button', { name: 'Actualizar panel', exact: true }).click()
  await expect(page.getByText('Falló la consulta', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Cerrados', exact: true }).getByRole('button')).toHaveCount(5)
  pass('A failed source poll shows its failure while retaining prior evidence')
  assert.deepEqual(report.errors, [])
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'; report.failure = String(error.stack || error)
  if (page) await page.screenshot({ path: path.join(QA, 'failure.png') }).catch(()=>{})
  console.error(report.failure); process.exitCode = 1
} finally {
  if (electron) await electron.close().catch(()=>{})
  service?.kill('SIGTERM')
  await fs.writeFile(path.join(QA, 'report.json'), JSON.stringify(report, null, 2))
}
