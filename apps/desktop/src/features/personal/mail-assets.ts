import { atom } from 'nanostores'
import type { PersonalMailAsset } from '../../../shared/personal.ts'
export const assetKey = (ref: PersonalMailAsset) => JSON.stringify(ref)
export function createMailAssetsController(api: (ref: PersonalMailAsset, intent: 'preview' | 'download', name?: string) => Promise<{dataUrl?: string; cancelled?: boolean}>) {
  const state = atom<{key: string | null; src: string | null}>({key: null, src: null})
  let generation = 0
  return {
    state,
    clear() { generation++; state.set({key: null, src: null}) },
    async preview(ref: PersonalMailAsset) { const current = ++generation; const result = await api(ref, 'preview'); if (current === generation) state.set({key: assetKey(ref), src: result.dataUrl || null}) },
    download: (ref: PersonalMailAsset, name: string) => api(ref, 'download', name)
  }
}
export const mailAssets = createMailAssetsController((...args) => window.heraldOS.personal.mailAsset(...args))
