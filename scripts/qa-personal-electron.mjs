#!/usr/bin/env node
/** Full Electron + preload + HTTP + SQLite QA. Every persisted record belongs to .runtime/qa. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QA = path.join(ROOT, '.runtime/qa')
const ARTIFACTS = path.join(ROOT, 'docs/personal/qa')
const PYTHON = path.join(ROOT, 'services/personal/.venv/bin/python')
const require = createRequire(path.join(ROOT, 'apps/desktop/package.json'))
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE ?? 'playwright'
const { _electron } = require(PLAYWRIGHT)
const { expect } = require(`${PLAYWRIGHT}/test`)
const execFileAsync = promisify(execFile)
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', '__CF_USER_TEXT_ENCODING'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
const report = { syntheticOnly: true, startedAt: new Date().toISOString(), service: 'http://127.0.0.1:8788', checks: [], screenshots: [], pageErrors: [], consoleErrors: [], teardownConsoleErrors: [] }
let service
let electron
let page
let token
let qaHermesHome
let rendererLifecycle
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = (name, detail = {}) => { report.checks.push({ name, result: 'PASS', ...detail }); console.log(`PASS ${name}`) }

function redactQaMessage(value) {
  return String(value)
    .replace(/((?:[?&]|\b)(?:token|access_token|api[_-]?key|key|secret)=)[^&\s'"\\]+/gi, '$1[redacted]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(["']?(?:access_token|token|api[_-]?key|secret)["']?\s*:\s*["']?)[^"',\s}]+/gi, '$1[redacted]')
}

async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:8788${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw new Error(`QA API ${method} ${route}: HTTP ${response.status}: ${value.detail ?? 'rejected'}`)
  return value
}

async function startService() {
  const log = await fs.open(path.join(QA, 'service.log'), 'a', 0o600)
  service = spawn(PYTHON, [path.join(ROOT, 'scripts/qa-personal-service.py')], { cwd: ROOT, env, stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) throw new Error(`QA service exited (${service.exitCode}); inspect isolated service.log`)
    try { if ((await fetch('http://127.0.0.1:8788/healthz')).ok) { token = (await fs.readFile(path.join(QA, 'private/token'), 'utf8')).trim(); return } } catch {}
    await pause(100)
  }
  throw new Error('QA service startup timed out')
}

async function stopService() {
  if (!service || service.exitCode !== null) return
  service.kill('SIGTERM')
  await new Promise(resolve => service.once('exit', resolve))
  service = undefined
}

async function launch() {
  const bootstrap = path.join(QA, 'electron-entry.mjs')
  await fs.writeFile(bootstrap, `import {app} from 'electron';\napp.setPath('appData', ${JSON.stringify(path.join(QA, 'app-data'))});\napp.setPath('userData', ${JSON.stringify(path.join(QA, 'chromium'))});\nawait import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'apps/desktop/dist/electron/main.mjs')).href)});\n`)
  electron = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [bootstrap, '--personal-plan', new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tegucigalpa' })], cwd: ROOT, timeout: 60000,
    env: { ...env, HERMES_HOME: qaHermesHome, HERALD_OS_HERMES_ROOT: process.env.HERALD_OS_HERMES_ROOT ?? path.join(homedir(), '.hermes/hermes-agent'), HERALD_OS_WINDOWED: '1', HERALD_PERSONAL_URL: 'http://127.0.0.1:8788', HERALD_PERSONAL_TOKEN_FILE: path.join(QA, 'private/token') }
  })
  const profile = await electron.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(profile, path.join(QA, 'chromium'))
  report.electronVersions = await electron.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }))
  page = await electron.firstWindow()
  const lifecycle = { phase: 'launch' }
  rendererLifecycle = lifecycle
  page.setDefaultTimeout(60000)
  page.on('pageerror', error => report.pageErrors.push({ at: new Date().toISOString(), phase: lifecycle.phase, message: redactQaMessage(error.message) }))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const event = { at: new Date().toISOString(), phase: lifecycle.phase, message: redactQaMessage(message.text()) }
    if (lifecycle.phase === 'teardown') report.teardownConsoleErrors.push(event)
    else report.consoleErrors.push(event)
  })
  await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 980); window.center() })
  // The scheduled CLI flag must focus Personal after boot without a synthetic click.
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await expect(page.getByText('Servicio conectado', { exact: true })).toBeVisible()
  if (await page.getByRole('button', { name: 'Not now', exact: true }).first().isVisible().catch(() => false)) await page.getByRole('button', { name: 'Not now', exact: true }).first().click()
  lifecycle.phase = 'active'
  return page
}

async function closeElectron() {
  if (!electron) return
  if (rendererLifecycle) rendererLifecycle.phase = 'teardown'
  const closing = electron
  electron = undefined
  await closing.close()
}

async function screenshot(name) {
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  const file = `${name}.png`
  await page.screenshot({ path: path.join(ARTIFACTS, file), fullPage: true })
  report.screenshots.push(file)
}

async function main() {
  await fs.mkdir(QA, { recursive: true, mode: 0o700 })
  await fs.mkdir(ARTIFACTS, { recursive: true })
  report.playwrightVersion = require(`${PLAYWRIGHT}/package.json`).version
  report.builtMainSha256 = createHash('sha256').update(await fs.readFile(path.join(ROOT, 'apps/desktop/dist/electron/main.mjs'))).digest('hex')
  // This directory is an explicit disposable fixture. The root-owned service uses port 8787 and another data directory.
  await fs.rm(path.join(QA, 'data'), { recursive: true, force: true })
  await fs.rm(path.join(QA, 'provider-requests.jsonl'), { force: true })
  await startService()
  qaHermesHome = await fs.mkdtemp('/private/tmp/herald-personal-qa-')
  await fs.chmod(qaHermesHome, 0o700)
  await fs.mkdir(path.join(qaHermesHome, 'herald-os'), { mode: 0o700 })
  await fs.copyFile(path.join(QA, 'hermes-home/herald-os/prefs.json'), path.join(qaHermesHome, 'herald-os/prefs.json'))
  const syntheticTask = await api('POST', '/v1/tasks', { title: 'QA SINTÉTICO · Revisar entrega de desarrollo', status: 'in_progress', source_type: 'agent', source_id: 'qa-scope', project: 'qa-demo', idempotency_key: 'qa-supervised-task' })
  const runId = 'b1c41a90-3882-4725-a4bd-37b920e32009'
  await api('PUT', `/v1/agent-runs/${runId}`, { run_id: runId, revision: 2, scope_id: 'QA SINTÉTICO · Verificación de interfaz', task_id: syntheticTask.id, workspace: 'qa-demo', agent: 'claude', status: 'completed', created_at: '2026-10-08T16:00:00Z', updated_at: '2026-10-08T16:05:00Z', verification: 'not_run', attempts: [{ number: 1, status: 'completed', started_at: '2026-10-08T16:00:00Z', finished_at: '2026-10-08T16:05:00Z', exit_code: 0, stdout_sha256: 'a'.repeat(64), stderr_sha256: 'b'.repeat(64), outcome: 'QA: instantánea sintética persistida; no se ejecutó un agente real.' }] })
  const observation = { observer_id: 'qa-observed', revision: 1, observed_at: new Date().toISOString(), agent: 'opencode', native_session_id: 'qa-session', workspace: 'QA SINTÉTICO', status: 'waiting_permission', evidence_source: 'opencode_http_api', confidence: 'high', source_updated_at: new Date().toISOString(), stale_after_seconds: 300, signals: ['Permiso sintético pendiente'], verification: 'not_run' }
  await api('PUT', '/v1/agent-observations/qa-observed', observation)
  await launch()
  record('Scheduled flag opens Personal after renderer boot with authenticated connection')
  assert.deepEqual((await api('GET', '/v1/daily-plans')).items, [])
  await page.getByRole('button', { name: 'Preparar plan', exact: true }).click()
  await expect(page.getByText(/^Fuentes y frescura · /)).toBeVisible()
  const plan = (await api('GET', '/v1/daily-plans')).items[0]
  assert.equal((await api('POST', '/v1/daily-plans/generate', { date: plan.date })).revision, plan.revision)
  record('Daily plan is explicitly generated once and kept with its evidence')
  await screenshot('01-qa-hoy')

  await page.getByRole('button', { name: 'Compromiso', exact: true }).click()
  await page.getByLabel('Título', { exact: true }).fill('QA SINTÉTICO · Compromiso desde Electron')
  await page.getByLabel('Detalle', { exact: true }).fill('Registro creado usando controles reales, preload y servicio persistente.')
  await page.getByLabel('Estado', { exact: true }).selectOption('next')
  await page.getByLabel('Prioridad', { exact: true }).selectOption('high')
  await page.getByLabel('Fecha límite').fill('2026-10-12')
  await page.getByLabel('Proyecto', { exact: true }).fill('QA-ELECTRON')
  await page.getByRole('button', { name: 'Guardar compromiso', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Editar compromiso', exact: true })).toBeVisible()
  let task = (await api('GET', '/v1/tasks?q=Compromiso+desde+Electron')).items[0]
  assert.equal(task.revision, 1)
  assert.equal(task.due_at, '2026-10-13T05:59:59Z')
  record('GUI commitment create and Tegucigalpa date-only persistence', { id: task.id, revision: task.revision })
  await page.getByLabel('Título', { exact: true }).fill('QA SINTÉTICO · Compromiso editado')
  await page.getByRole('button', { name: 'Guardar compromiso', exact: true }).click()
  await expect(page.getByText('Revisión 2', { exact: true })).toBeVisible()
  task = await api('GET', `/v1/tasks/${task.id}`)
  assert.equal(task.title, 'QA SINTÉTICO · Compromiso editado')
  assert.equal(task.due_at, '2026-10-13T05:59:59Z')
  record('GUI commitment edit increments revision and preserves deadline')
  await page.getByLabel('Título', { exact: true }).fill('QA SINTÉTICO · Borrador local sin perder')
  await page.getByRole('tab', { name: 'Diario', exact: true }).click()
  await page.getByRole('tab', { name: 'Compromisos', exact: true }).click()
  await expect(page.getByLabel('Título', { exact: true })).toHaveValue('QA SINTÉTICO · Borrador local sin perder')
  await api('PATCH', `/v1/tasks/${task.id}`, { title: 'QA SINTÉTICO · Versión externa', expected_revision: task.revision })
  await page.getByRole('button', { name: 'Guardar compromiso', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/409|revisión|cambió/i)
  await expect(page.getByRole('alert')).not.toContainText('herald-os:personal:request')
  assert.equal((await api('GET', `/v1/tasks/${task.id}`)).title, 'QA SINTÉTICO · Versión externa')
  await expect(page.getByLabel('Título', { exact: true })).toHaveValue('QA SINTÉTICO · Borrador local sin perder')
  await screenshot('02-qa-conflicto-revision')
  await page.getByRole('button', { name: 'Recargar versión', exact: true }).click()
  await expect(page.getByLabel('Título', { exact: true })).toHaveValue('QA SINTÉTICO · Versión externa')
  await expect(page.getByText('Revisión 3', { exact: true })).toBeVisible()
  await page.getByLabel('Estado', { exact: true }).selectOption('waiting')
  await page.getByRole('button', { name: 'Guardar compromiso', exact: true }).click()
  await expect(page.getByText('Revisión 4', { exact: true })).toBeVisible()
  await expect(page.getByText('Estado: En espera. Revisión 4.', { exact: true })).toBeVisible()
  record('GUI stale edit rejected, local draft retained, reload and status save succeed')
  await screenshot('03-qa-compromisos')

  await page.getByRole('tab', { name: 'Diario', exact: true }).click()
  await page.getByLabel('Fecha del diario').fill('2026-10-08')
  await page.getByLabel('¿Qué avanzó hoy?', { exact: true }).fill('QA SINTÉTICO: comprobamos creación, revisión y recuperación.')
  await page.getByLabel('¿Qué quedó pendiente?', { exact: true }).fill('QA: revisar resultado independiente.')
  await page.getByLabel('¿Qué sigue mañana?', { exact: true }).fill('QA: continuar con el siguiente paso.')
  await page.getByRole('tab', { name: 'Hoy', exact: true }).click()
  await page.getByRole('tab', { name: 'Diario', exact: true }).click()
  await expect(page.getByLabel('¿Qué avanzó hoy?', { exact: true })).toHaveValue('QA SINTÉTICO: comprobamos creación, revisión y recuperación.')
  await page.getByRole('button', { name: 'Guardar entrada', exact: true }).click()
  await expect(page.getByText('Entrada de diario guardada.', { exact: true })).toBeVisible()
  const diary = (await api('GET', '/v1/checkins')).items.find(item => item.date === '2026-10-08')
  assert.ok(diary.accomplished.includes('QA SINTÉTICO'))
  assert.equal((await api('GET', `/v1/tasks/${task.id}`)).status, 'waiting')
  record('GUI diary save and tab preservation leave task status unchanged', { id: diary.id })
  await screenshot('04-qa-diario')

  await page.getByRole('tab', { name: 'Correo', exact: true }).click()
  await expect(page.getByText('Correo listo', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Crear compromiso', exact: true })).toBeDisabled()
  const guestContents = async (fn, arg) => electron.evaluate(({ webContents }, { code, argument }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:8098/'))
    if (!contents) throw new Error('Synthetic embedded mail was not found')
    return contents.executeJavaScript(`(${code})(${JSON.stringify(argument)})`)
  }, { code: fn.toString(), argument: arg })
  assert.equal(await guestContents(() => typeof window.heraldOS), 'undefined')
  await guestContents(() => document.querySelector('a[href="/correo/MAIL-1"]').click())
  await expect(page.getByText('MAIL-1', { exact: true })).toBeVisible()
  await guestContents(() => { document.querySelector('textarea').value = 'QA: borrador preservado' })
  await page.getByRole('tab', { name: 'Hoy', exact: true }).click()
  await page.getByRole('tab', { name: 'Correo', exact: true }).click()
  assert.equal(await guestContents(() => document.querySelector('textarea').value), 'QA: borrador preservado')
  await page.getByRole('button', { name: 'Crear compromiso', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Editar compromiso', exact: true })).toBeVisible()
  const captured = (await api('GET', '/v1/tasks')).items.find(item => item.source_id === 'ingelmec-mail:MAIL-1')
  assert.ok(captured)
  const mcp = await execFileAsync(PYTHON, [path.join(ROOT, 'scripts/qa-personal-service.py'), '--mcp-capture', 'MAIL-1'], { cwd: ROOT, env, timeout: 20000 })
  assert.equal(JSON.parse(mcp.stdout).task_id, captured.id)
  assert.equal((await api('GET', '/v1/tasks')).items.filter(item => item.source_id === 'ingelmec-mail:MAIL-1').length, 1)
  record('Embedded mail stays isolated and keeps its draft across tab switches')
  record('Native guest selection and MCP capture share the original MAIL identity')
  await page.getByRole('tab', { name: 'Correo', exact: true }).click()
  const nativeView = await electron.evaluate(async ({ BrowserWindow }, destination) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(item => item.webContents?.getURL().startsWith('http://127.0.0.1:8098/'))
    if (!view) throw new Error('Native mail view missing')
    return { visible: view.getVisible(), bounds: view.getBounds(), png: (await view.webContents.capturePage()).toPNG().toString('base64') }
  }, path.join(ARTIFACTS, '05c-qa-vista-nativa.png'))
  await fs.writeFile(path.join(ARTIFACTS, '05c-qa-vista-nativa.png'), Buffer.from(nativeView.png, 'base64'))
  assert.equal(nativeView.visible, true)
  assert.ok(nativeView.bounds.width > 300 && nativeView.bounds.height > 200)
  report.screenshots.push('05c-qa-vista-nativa.png')
  await screenshot('05-qa-correo-sintetico')
  await page.getByRole('navigation', { name: 'Vistas integradas de correo' }).getByRole('button', { name: 'Seguimiento', exact: true }).click()
  await expect(page.getByText('Correo listo', { exact: true })).toBeVisible()
  assert.equal(await guestContents(() => location.pathname), '/seguimiento')
  record('Native mail navigation uses the original app surface')

  await page.getByRole('tab', { name: 'Desarrollo', exact: true }).click()
  await expect(page.getByText('Proceso terminó', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Validación pendiente', { exact: true })).toBeVisible()
  await expect(page.getByText(runId, { exact: true })).toBeVisible()
  await expect(page.getByText('Sesiones observadas', { exact: true })).toBeVisible()
  await expect(page.getByText('Espera permiso', { exact: true })).toBeVisible()
  await expect(page.getByText('Resultado sin revisar', { exact: true }).first()).toBeVisible()
  assert.equal((await api('GET', '/v1/agent-runs')).items[0].verification, 'not_run')
  record('GUI persisted coding snapshot distinguishes process exit from validation')
  await screenshot('06-qa-desarrollo')
  await page.getByRole('tab', { name: 'Hoy', exact: true }).click()
  await page.getByRole('button', { name: 'Preparar cierre', exact: true }).click()
  await expect(page.getByText('Tu resumen', { exact: true })).toBeVisible()
  await screenshot('07-qa-resumen')

  await stopService()
  await page.getByRole('button', { name: 'Actualizar espacio personal', exact: true }).click()
  await expect(page.getByText('No se pudo actualizar. Se conserva la última consulta.', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Compromisos', exact: true }).click()
  await expect(page.getByRole('button', { name: /QA SINTÉTICO · Versión externa/ })).toBeVisible()
  await screenshot('07b-qa-servicio-desconectado')
  await startService()
  await page.getByRole('button', { name: 'Actualizar espacio personal', exact: true }).click()
  await expect(page.getByText('Servicio conectado', { exact: true })).toBeVisible()
  record('GUI service disconnection retains the last snapshot and recovers after restart')

  await closeElectron()
  await stopService()
  await startService()
  await launch()
  assert.equal((await api('GET', `/v1/tasks/${task.id}`)).revision, 4)
  assert.equal((await api('GET', '/v1/daily-plans')).items[0].date, plan.date)
  assert.equal((await api('GET', '/v1/agent-observations')).items[0].observer_id, 'qa-observed')
  assert.equal((await api('GET', '/v1/checkins')).items.find(item => item.date === '2026-10-08').id, diary.id)
  assert.equal((await api('GET', '/v1/tasks')).items.find(item => item.source_id === 'ingelmec-mail:MAIL-1').id, captured.id)
  assert.equal((await api('GET', '/v1/agent-runs')).items[0].run_id, runId)
  await page.getByRole('tab', { name: 'Compromisos', exact: true }).click()
  await expect(page.getByRole('button', { name: /QA SINTÉTICO · Versión externa/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Diario', exact: true }).click()
  await page.getByLabel('Fecha del diario').fill('2026-10-08')
  await expect(page.getByLabel('¿Qué avanzó hoy?', { exact: true })).toHaveValue(diary.accomplished)
  record('Full service and Electron restart preserve task, diary, mail linkage and run snapshot')
  await screenshot('08-qa-persistencia')
  const providerRequests = (await fs.readFile(path.join(QA, 'provider-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(providerRequests.every(request => request.method === 'GET'))
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.consoleErrors, [])
  record('Synthetic provider received only GET; renderer has no uncaught errors', { providerRequests: providerRequests.length })
}

if (process.argv.includes('--check-log-redaction')) {
  for (const input of [
    'ws://127.0.0.1:1234/api/ws?token=qa-only-value',
    'https://qa.test/?access_token=qa-only-value&safe=yes',
    'https://qa.test/?api_key=qa-only-value',
    'Authorization: Bearer qa-only-value',
    '{"apiKey":"qa-only-value","safe":true}',
    "token: 'qa-only-value'"
  ]) assert.ok(!redactQaMessage(input).includes('qa-only-value'))
  assert.equal(redactQaMessage('Servicio desconectado; HTTP 503'), 'Servicio desconectado; HTTP 503')
  console.log('PASS QA log redaction: URL, bearer and structured token/API-key values; diagnostic preserved.')
} else {
try {
  await main()
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'
  report.failure = redactQaMessage(error.message)
  console.error(report.failure)
  if (page && await page.getByRole('heading', { name: 'Personal', exact: true }).isVisible().catch(() => false)) await screenshot('qa-failure').catch(() => {})
  process.exitCode = 1
} finally {
  if (electron) await closeElectron().catch(() => {})
  await stopService()
  if (qaHermesHome) {
    await fs.cp(path.join(qaHermesHome, 'logs'), path.join(QA, 'last-hermes-logs'), { recursive: true }).catch(() => {})
    await fs.rm(qaHermesHome, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString()
  if (report.pageErrors.length || report.consoleErrors.length) {
    report.result = 'FAIL'
    report.failure ??= 'Se registraron errores del renderer durante el arranque o la ejecución; consulta los eventos con su fase.'
    process.exitCode = 1
  }
  if (report.result === 'PASS') await fs.rm(path.join(ARTIFACTS, 'qa-failure.png'), { force: true })
  await fs.writeFile(path.join(ARTIFACTS, 'report.json'), redactQaMessage(JSON.stringify(report, null, 2)) + '\n')
  console.log(`QA ${report.result}: ${report.checks.length} checks; report docs/personal/qa/report.json`)
}
}
