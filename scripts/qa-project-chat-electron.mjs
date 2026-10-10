#!/usr/bin/env node
/** Real Electron, IPC, API, SQLite and Hermes history. Prompt delivery is intercepted, never sent to a model. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const ROOT = path.resolve(import.meta.dirname, '..')
const QA = path.join(ROOT, '.runtime/qa-project-chat')
const require = createRequire(path.join(ROOT, 'apps/desktop/package.json'))
const { _electron } = require('playwright')
const { expect: baseExpect } = require('playwright/test')
const expect = baseExpect.configure({ timeout: 30000 })
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
const report = { syntheticOnly: true, realModelPrompts: 0, interceptedPrompts: 0, checks: [], errors: [] }
let service, electron, page, token, turn, rejectNext = false, stopped
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:8797/v1/${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert(response.ok, `Fixture API ${response.status}`); return response.json()
}
function event(type, payload = {}) { turn.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: turn.id, payload } })) }
async function launch() {
  electron = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(QA, 'entry.mjs'), '--personal-plan', '2026-10-10'], cwd: ROOT, timeout: 60000, env: { ...env, HERMES_HOME: path.join(QA, 'hermes-home'), HERALD_OS_HERMES_ROOT: path.join(os.homedir(), '.hermes/hermes-agent'), HERALD_OS_WINDOWED: '1', HERALD_PERSONAL_URL: 'http://127.0.0.1:8797', HERALD_PERSONAL_TOKEN_FILE: path.join(QA, 'token') } })
  page = await electron.firstWindow(); page.setDefaultTimeout(30000)
  // The disposable home intentionally has no model credentials; history remains usable.
  await page.addLocatorHandler(page.getByRole('dialog', { name: 'Sign in to Hermes', exact: true }), async () => {
    await page.getByRole('dialog', { name: 'Sign in to Hermes', exact: true }).getByRole('button', { name: 'Not now', exact: true }).first().click()
  })
  page.on('pageerror', error => report.errors.push(error.name))
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  await expect.poll(() => page.evaluate(async () => (await window.heraldOS.backend.getState()).phase), { timeout: 60000 }).toBe('ready')
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const request = JSON.parse(String(message))
      if (request.method === 'prompt.submit') {
        report.interceptedPrompts++
        if (rejectNext) { rejectNext = false; ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'QA envío rechazado' } })); return }
        turn = { ws, id: request.params.session_id, text: request.params.text }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: 'accepted' } }))
        event('message.start'); event('message.delta', { text: 'QA revisando el proyecto…' })
        return
      }
      if (request.method === 'session.interrupt') {
        stopped = request.params.session_id
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { interrupted: true } }))
        event('message.complete', { text: 'QA interrumpido', partial: true, status: 'interrupted' }); return
      }
      server.send(message)
    })
  })
  await page.reload()
  await page.getByRole('navigation', { name: 'Pages', exact: true }).getByText('Personal', { exact: true }).click()
  await page.getByRole('tab', { name: 'Proyectos', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Conversar con Hermes', exact: true })).toBeVisible()
}
async function rpc(method, params) {
  return page.evaluate(async ({ method, params }) => {
    const state = await window.heraldOS.backend.getState()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(state.wsUrl)
      const timer = setTimeout(() => { socket.close(); reject(new Error('QA RPC timeout')) }, 30000)
      socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'qa-project-chat', method, params }))
      socket.onmessage = event => { const result = JSON.parse(event.data); if (result.id !== 'qa-project-chat') return; clearTimeout(timer); socket.close(); result.error ? reject(new Error(result.error.message)) : resolve(result.result) }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('QA RPC connection error')) }
    })
  }, { method, params })
}
const chat = () => page.getByTestId('project-chat')
const composer = () => chat().getByLabel('Mensaje del proyecto para Hermes')
async function submit(text) { await composer().fill(text); await chat().getByRole('button', { name: 'Enviar mensaje del proyecto', exact: true }).click() }
try {
  await fs.mkdir(QA, { recursive: true, mode: 0o700 })
  for (const folder of ['data', 'chromium']) await fs.rm(path.join(QA, folder), { recursive: true, force: true })
  token = randomBytes(32).toString('hex'); await fs.writeFile(path.join(QA, 'token'), token, { mode: 0o600 })
  await fs.mkdir(path.join(QA, 'hermes-home/herald-os'), { recursive: true })
  await fs.writeFile(path.join(QA, 'hermes-home/herald-os/prefs.json'), JSON.stringify({ fullscreenOnLaunch: false, reduceMotion: true, voice: { enabled: false, wakeWord: false }, continuity: { enabled: false, exclude: [] }, crashHelp: { enabled: false, muted: [] } }))
  await fs.writeFile(path.join(QA, 'entry.mjs'), `import {app} from 'electron'; app.setPath('appData',${JSON.stringify(path.join(QA, 'app-data'))}); app.setPath('userData',${JSON.stringify(path.join(QA, 'chromium'))}); await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'apps/desktop/dist/electron/main.mjs')).href)});`)
  const log = await fs.open(path.join(QA, 'service.log'), 'w', 0o600)
  service = spawn(path.join(ROOT, 'services/personal/.venv/bin/python'), [path.join(ROOT, 'scripts/qa-project-chat-service.py')], { cwd: ROOT, env, stdio: ['ignore', log.fd, log.fd] }); await log.close()
  await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:8797/healthz')).ok } catch { return false } }).toBe(true)
  await api('POST', 'tasks', { title: 'QA importador', project: 'QA Campo', status: 'waiting' })
  await api('POST', 'tasks', { title: 'QA oficina', project: 'QA Oficina' })
  const pid = (await api('GET', 'projects')).items.find(p => p.name === 'QA Campo').id
  await launch()
  await page.getByRole('button', { name: 'Conversar con Hermes', exact: true }).click()
  await expect(composer()).toBeEnabled()
  assert.equal((await api('GET', `projects/${pid}/workspace`)).conversations.length, 0)
  pass('Opening the small project window creates no session and sends no model prompt')
  await chat().getByRole('button', { name: '¿Qué debo atender ahora?', exact: true }).click()
  await expect(composer()).toHaveValue('¿Qué debo atender ahora?'); assert.equal(report.interceptedPrompts, 0)
  await page.getByRole('button', { name: 'Ver proyecto QA Oficina', exact: true }).click(); await expect(composer()).toHaveValue('')
  await composer().fill('QA borrador oficina')
  await page.getByRole('button', { name: 'Ver proyecto QA Campo', exact: true }).click(); await expect(composer()).toHaveValue('¿Qué debo atender ahora?')
  pass('Suggestion drafts and project switching never mix messages or submit automatically')
  rejectNext = true; await submit('QA conserva este borrador')
  await expect(chat().getByText(/El borrador se conserva/)).toBeVisible(); await expect(composer()).toHaveValue('QA conserva este borrador')
  assert.equal((await api('GET', `projects/${pid}/workspace`)).conversations.length, 1)
  pass('Rejected first send retains its draft and durable conversation link')
  await submit('QA prioriza el importador')
  await expect(chat().getByText('QA revisando el proyecto…', { exact: true })).toBeVisible()
  await expect(chat().getByRole('button', { name: 'Detener respuesta del proyecto' })).toBeVisible()
  assert.equal(turn.text, 'QA prioriza el importador')
  const result = await api('PUT', `projects/${pid}/direction`, { text: 'QA atender primero el importador', expected_revision: 0 })
  event('tool.start', { tool_id: 'qa-direction', name: 'personal_project_direction_update', args: { text: result.text } })
  event('tool.complete', { tool_id: 'qa-direction', name: 'personal_project_direction_update', result })
  event('message.complete', { text: 'QA rumbo guardado en Herald; entrega externa sin confirmar.', status: 'complete' })
  await expect(chat().getByText('QA rumbo guardado en Herald; entrega externa sin confirmar.', { exact: true })).toBeVisible()
  await expect(chat().getByTestId('project-direction')).toBeVisible()
  pass('Streaming and tool results refresh the persisted direction without claiming remote delivery')
  await submit('QA detén esta respuesta'); await expect(chat().getByRole('button', { name: 'Detener respuesta del proyecto' })).toBeVisible()
  const expectedStop = turn.id; await chat().getByRole('button', { name: 'Detener respuesta del proyecto' }).click()
  await expect.poll(() => stopped).toBe(expectedStop)
  pass('Stop targets the exact project conversation')
  const saved = await rpc('session.create', { source: 'herald_os', title: 'QA historial persistente', messages: [{ role: 'user', content: 'QA mensaje guardado' }, { role: 'assistant', content: 'QA respuesta histórica del proyecto' }] })
  const sid = saved.stored_session_id ?? saved.info?.stored_session_id ?? saved.session_key ?? saved.session_id
  await api('POST', `projects/${pid}/conversations`, { session_id: sid, title: 'QA historial persistente' })
  await chat().getByRole('button', { name: 'Actualizar chat del proyecto' }).click()
  await chat().getByLabel('Conversaciones de este proyecto').selectOption(sid)
  await expect(chat().getByText('QA respuesta histórica del proyecto', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(QA, 'project-chat.png') })
  await electron.close(); electron = null; await launch()
  await page.getByRole('button', { name: 'Conversar con Hermes', exact: true }).click()
  await expect(chat().getByText('QA respuesta histórica del proyecto', { exact: true })).toBeVisible()
  await expect(chat().getByTestId('project-direction')).toBeVisible()
  pass('Actual Hermes transcript, project link and direction survive an app and backend restart')
  await composer().fill('QA sin enviar'); await chat().getByRole('button', { name: 'Minimizar chat del proyecto' }).click()
  await expect(chat()).toHaveCount(0); await page.getByRole('button', { name: 'Conversar con Hermes', exact: true }).click()
  await expect(composer()).toHaveValue('QA sin enviar')
  await chat().getByRole('button', { name: 'Nueva conversación del proyecto' }).click()
  await expect(composer()).toHaveValue(''); await expect(chat().getByText('QA respuesta histórica del proyecto')).toHaveCount(0)
  assert.equal((await api('GET', `projects/${pid}/workspace`)).conversations.length, 2)
  pass('Minimize keeps the draft; new conversation starts blank without deleting history')
  assert.deepEqual(report.errors, []); report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'; report.failure = String(error.message); process.exitCode = 1
  if (page) { await page.screenshot({ path: path.join(QA, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(QA, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 }) }
} finally {
  if (electron) await electron.close().catch(() => {})
  if (service) { service.kill('SIGTERM'); await new Promise(resolve => service.once('exit', resolve)) }
  await fs.writeFile(path.join(QA, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report))
}
