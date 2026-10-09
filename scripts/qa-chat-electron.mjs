#!/usr/bin/env node
/** Actual Hermes persistence + Electron UI. Disposable synthetic home, no model prompts. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { _electron } = require('playwright')
const { expect } = require('playwright/test')
const qa = path.join(root, '.runtime/qa-chat')
const report = { syntheticOnly: true, modelPromptsSent: 0, checks: [], errors: [] }
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
let electron, page, hermesHome
const record = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function launch() {
  console.log("QA launching isolated desktop")
  electron = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(qa, 'entry.mjs')], cwd: root, timeout: 45000, env: { ...env, HERMES_HOME: hermesHome, HERALD_OS_HERMES_ROOT: process.env.HERALD_OS_HERMES_ROOT ?? path.join(os.homedir(), '.hermes/hermes-agent'), HERALD_OS_WINDOWED: '1', HERALD_PERSONAL_URL: 'http://127.0.0.1:1' } })
  page = await electron.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(25000)
  page.on('pageerror', error => report.errors.push(error.message.replace(/token=[^&\s]+/gi, 'token=[redacted]')))
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 980))
  await expect.poll(() => page.evaluate(async () => (await window.heraldOS.backend.getState()).phase), { timeout: 45000 }).toBe('ready')
  if (await page.getByRole('button', { name: 'Not now', exact: true }).first().isVisible().catch(() => false)) await page.getByRole('button', { name: 'Not now', exact: true }).first().click()
  // Use the user's navigation control; the whole test uses production renderer assets.
  await page.getByRole('navigation', { name: 'Pages', exact: true }).getByText('Hermes', { exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Historial de conversaciones' })).toBeVisible()
}
async function rpc(method, params) {
  return page.evaluate(async ({ method, params }) => {
    const state = await window.heraldOS.backend.getState()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(state.wsUrl)
      const timer = setTimeout(() => { socket.close(); reject(new Error('QA RPC timeout')) }, 30000)
      socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'qa-chat', method, params }))
      socket.onmessage = event => { const result = JSON.parse(event.data); if (result.id !== 'qa-chat') return; clearTimeout(timer); socket.close(); result.error ? reject(new Error(result.error.message)) : resolve(result.result) }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('QA RPC connection error')) }
    })
  }, { method, params })
}
const history = () => page.getByRole('complementary', { name: 'Historial de conversaciones' })
async function search(text) { await history().getByLabel('Buscar conversaciones', { exact: true }).fill(text); await history().getByRole('button', { name: 'Buscar en el historial', exact: true }).click(); await expect(history().getByRole('status')).toHaveCount(0) }
try {
  await fs.mkdir(qa, { recursive: true, mode: 0o700 })
  hermesHome = await fs.mkdtemp('/private/tmp/herald-chat-qa-')
  await fs.mkdir(path.join(hermesHome, 'herald-os'), { recursive: true })
  await fs.writeFile(path.join(hermesHome, 'herald-os/prefs.json'), JSON.stringify({ fullscreenOnLaunch: false, reduceMotion: true, voice: { enabled: false, wakeWord: false }, continuity: { enabled: false, exclude: [] }, crashHelp: { enabled: false, muted: [] } }))
  // Own userData / appData avoids the installed user's single-instance lock and preferences.
  await fs.writeFile(path.join(qa, 'entry.mjs'), `import {app} from 'electron'; app.setPath('appData', ${JSON.stringify(path.join(qa, 'app-data'))}); app.setPath('userData', ${JSON.stringify(path.join(qa, 'chromium'))}); await import(${JSON.stringify(pathToFileURL(path.join(root, 'apps/desktop/dist/electron/main.mjs')).href)});`)
  await launch()
  record('History is visible without the hidden menu')
  for (let i = 0; i < 73; i++) await rpc('session.create', { source: i === 0 ? 'web' : 'herald_os', title: `QA conversación ${String(i).padStart(3, '0')}`, messages: [{ role: 'user', content: `QA mensaje ${i} ${i === 0 ? 'aguacatependiente' : 'sintético'}` }, { role: 'assistant', content: `QA respuesta guardada ${i}` }] })
  await history().getByRole('button', { name: 'Actualizar historial', exact: true }).click()
  await expect(history().getByText('Perfil de Herald · 73 conversaciones')).toBeVisible()
  await history().getByRole('button', { name: 'Cargar anteriores' }).click()
  await expect(history().getByRole('button', { name: /^QA conversación 000/ })).toBeVisible()
  record('73 persisted conversations are reachable, including web-origin history')
  await search('aguacatependiente')
  await expect(history().getByRole('button', { name: /^QA conversación 000/ })).toBeVisible()
  await history().getByRole('button', { name: /^QA conversación 000/ }).click()
  await expect(page.getByText('QA respuesta guardada 0', { exact: true })).toBeVisible()
  record('Server content search finds an older session and resumes its transcript')
  await page.getByLabel('Mensaje para Hermes', { exact: true }).fill('QA borrador A')
  await history().getByRole('button', { name: 'Limpiar búsqueda' }).click()
  await history().getByRole('button', { name: /^QA conversación 072/ }).click()
  await expect(page.getByText('QA respuesta guardada 72', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Mensaje para Hermes', { exact: true })).toHaveValue('')
  await page.getByLabel('Mensaje para Hermes', { exact: true }).fill('QA borrador B')
  await search('aguacatependiente')
  await history().getByRole('button', { name: /^QA conversación 000/ }).click()
  await expect(page.getByLabel('Mensaje para Hermes', { exact: true })).toHaveValue('QA borrador A')
  record('Drafts stay with their conversation when switching between saved sessions')
  await page.getByRole('button', { name: 'Acciones de conversación', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Renombrar', exact: true }).click()
  await page.getByLabel('Título de conversación').fill('QA título persistente')
  await page.getByRole('button', { name: 'Guardar título', exact: true }).click()
  await expect(page.getByLabel('Título de conversación')).toHaveCount(0)
  await expect(history().getByRole('button', { name: /^QA título persistente/ })).toBeVisible()
  record('Rename is acknowledged and reflected in the history')
  await page.screenshot({ path: path.join(qa, 'chat-synthetic.png') })
  await electron.close(); electron = undefined
  await launch()
  await search('QA título persistente')
  await history().getByRole('button', { name: /^QA título persistente/ }).click()
  await expect(page.getByText('QA respuesta guardada 0', { exact: true })).toBeVisible()
  record('App and backend restart preserve the renamed conversation and complete transcript')
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click()
  await expect(page.getByText('QA respuesta guardada 0', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Mensaje para Hermes', { exact: true })).toHaveValue('')
  record('Starting a new conversation does not display the previous transcript or draft')
  assert.deepEqual(report.errors, [])
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'; report.error = String(error.message).replace(/token=[^&\s]+/gi, 'token=[redacted]'); process.exitCode = 1
  if (page) { await page.screenshot({ path: path.join(qa, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(qa, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 }) }
} finally {
  if (electron) await electron.close().catch(() => {})
  await fs.writeFile(path.join(qa, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
  if (hermesHome) await fs.rm(hermesHome, { recursive: true, force: true })
}
