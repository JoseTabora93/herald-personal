#!/usr/bin/env node
/** Native UI + real IPC + authenticated API; synthetic mail backend only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QA = path.join(ROOT, '.runtime/qa-native-mail')
const require = createRequire(path.join(ROOT, 'apps/desktop/package.json'))
const { _electron } = require('playwright')
const { expect: baseExpect } = require('playwright/test')
const expect = baseExpect.configure({ timeout: 30000 })
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','USER','LOGNAME','SHELL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
let service, electron, page
const report = { syntheticOnly: true, checks: [], errors: [], result: 'RUNNING' }
const pass = name => { report.checks.push(name); console.log('PASS ' + name) }
const pause = ms => new Promise(r => setTimeout(r, ms))
async function launch() {
  electron = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(QA, 'entry.mjs'), '--personal-plan', '2026-10-08'], cwd: ROOT, timeout: 60000, env: { ...env, HERMES_HOME: path.join(QA, 'hermes-home'), HERALD_OS_HERMES_ROOT: path.join(os.homedir(), '.hermes/hermes-agent'), HERALD_OS_WINDOWED: '1', HERALD_PERSONAL_URL: 'http://127.0.0.1:8794', HERALD_PERSONAL_TOKEN_FILE: path.join(QA, 'token') } })
  page = await electron.firstWindow(); page.setDefaultTimeout(30000)
  page.on('pageerror', error => report.errors.push(error.message))
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  await expect.poll(() => page.evaluate(async () => (await window.heraldOS.backend.getState()).phase), { timeout: 60000 }).toBe('ready')
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Correo', exact: true }).click()
  await expect(page.getByTestId('native-mail-workspace')).toBeVisible()
  await expect(page.getByRole('button', { name: /MAIL-1 .*Propuesta 01/ })).toBeVisible()
}
async function source() { return JSON.parse(await fs.readFile(path.join(QA, 'source.json'), 'utf8')) }
try {
  await fs.mkdir(QA, { recursive: true, mode: 0o700 })
  for (const file of ['source.json', 'requests.jsonl']) await fs.rm(path.join(QA, file), { force: true })
  await fs.rm(path.join(QA, 'chromium'), { recursive: true, force: true })
  await fs.mkdir(path.join(QA, 'hermes-home/herald-os'), { recursive: true })
  await fs.writeFile(path.join(QA, 'hermes-home/herald-os/prefs.json'), JSON.stringify({ fullscreenOnLaunch: false, reduceMotion: true, voice: { enabled: false, wakeWord: false }, continuity: { enabled: false, exclude: [] }, crashHelp: { enabled: false, muted: [] } }))
  await fs.writeFile(path.join(QA, 'entry.mjs'), `import {app} from 'electron'; app.setPath('appData',${JSON.stringify(path.join(QA,'app-data'))}); app.setPath('userData',${JSON.stringify(path.join(QA,'chromium'))}); await import(${JSON.stringify(pathToFileURL(path.join(ROOT,'apps/desktop/dist/electron/main.mjs')).href)});`)
  const log = await fs.open(path.join(QA, 'service.log'), 'w', 0o600)
  service = spawn(path.join(ROOT, 'services/personal/.venv/bin/python'), [path.join(ROOT,'scripts/qa-native-mail-service.py')], { cwd: ROOT, env, stdio: ['ignore', log.fd, log.fd] }); await log.close()
  await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:8794/healthz')).ok } catch { return false } }).toBe(true)
  await launch()
  assert.equal(await electron.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getURL().includes(':8104')).length), 0)
  pass('Default mail is renderer-native; no embedded mail view was created')
  await page.getByRole('button', { name: 'Página siguiente de correo' }).click()
  await expect(page.getByText('26–50 de 56', { exact: true })).toBeVisible()
  await page.getByLabel('Buscar correo', { exact: true }).fill('Propuesta 01')
  await page.getByRole('button', { name: 'Aplicar filtros' }).click()
  await expect(page.getByText('1–1 de 1', { exact: true })).toBeVisible()
  pass('Pagination and search operate on the authoritative source and reset offset')
  await page.getByRole('button', { name: /MAIL-1 .*Propuesta 01/ }).click()
  await expect(page.getByRole('article', { name: 'Hilo MAIL-1' })).toBeVisible()
  await expect(page.getByText(/Mensaje sintético. <script>/)).toBeVisible()
  assert.equal(await page.evaluate(() => window.__mailInjection), undefined)
  await page.getByLabel('Cambiar estado').selectOption('agendado')
  await expect.poll(async () => (await source()).states['1']).toBe('agendado')
  pass('Untrusted message renders as text; local classification is reread and persisted')
  await page.getByRole('button', { name: 'Responder', exact: true }).click()
  const body = page.getByLabel('Texto del borrador')
  await body.fill('QA FAIL SAVE')
  await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click()
  await expect(page.getByRole('alert').last()).toBeVisible()
  await expect(body).toHaveValue('QA FAIL SAVE')
  await expect(page.getByRole('button', { name: 'Adjuntos, Outlook y envío', exact: true })).toBeDisabled()
  pass('A failed save preserves text and blocks provider handoff')
  await body.fill('QA · Mi respuesta revisada\n\n[confirmar: fecha]')
  await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click()
  await expect(page.getByText('Borrador guardado y verificado.', { exact: true })).toBeVisible()
  assert.equal((await source()).compose.cuerpoMd, 'QA · Mi respuesta revisada\n\n[confirmar: fecha]')
  await page.screenshot({ path: path.join(QA, 'native-composer.png') })
  await electron.close(); electron = null
  await launch()
  await expect(page.getByLabel('Texto del borrador')).toHaveValue('QA · Mi respuesta revisada\n\n[confirmar: fecha]')
  pass('The same persisted draft resumes after a complete Electron restart')
  await page.getByRole('button', { name: 'Adjuntos, Outlook y envío', exact: true }).click()
  await expect.poll(() => electron.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getURL().includes('/correo/MAIL-1?redactar=f051aeb4-eae2-4b16-99db-c7840ff168f0')))).toBe(true)
  pass('Compatibility handoff opens exactly the saved compose identity')
  await electron.close(); electron = null
  await launch()
  await page.getByRole('button', { name: 'Cerrar redactor' }).click()
  await page.getByRole('navigation', { name: 'Vistas de correo nativo' }).getByRole('button', { name: 'Aprendizajes' }).click()
  await expect(page.getByText('QA · Prefiere respuestas concretas y breves.', { exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Vistas de correo nativo' }).getByRole('button', { name: 'Limpieza' }).click()
  await expect(page.getByText('Boletín de prueba', { exact: true })).toBeVisible()
  pass('Learning proposals and cleanup groups are native, with explicit approval handoffs')
  await page.getByRole('navigation', { name: 'Vistas de correo nativo' }).getByRole('button', { name: 'Lista', exact: true }).click()
  await page.getByRole('button', { name: /MAIL-1 .*Propuesta 01/ }).click()
  await page.getByRole('article', { name: 'Hilo MAIL-1' }).getByRole('button', { name: 'Compromiso', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Editar compromiso', exact: true })).toBeVisible()
  pass('A native mail selection creates a linked commitment through the canonical API')
  const events = (await fs.readFile(path.join(QA,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(events.every(e => !/send-|outlook-|limpieza-aplicar|aprendizaje-decidir|mail-seen/.test(e.action)))
  assert.deepEqual(report.errors, [])
  pass('No provider write, send, automatic seen, or approval action occurred')
  report.result = 'PASS'
} catch(error) {
  report.result = 'FAIL'; report.error = String(error.stack); process.exitCode = 1
  if(page) await page.screenshot({path:path.join(QA,'failure.png')}).catch(()=>{})
} finally {
  if(electron) await electron.close().catch(()=>{})
  if(service) { service.kill('SIGTERM'); await pause(300) }
  await fs.writeFile(path.join(QA,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
