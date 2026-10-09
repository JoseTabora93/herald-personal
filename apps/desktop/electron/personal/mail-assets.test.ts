import { describe, it, expect, vi } from 'vitest'
import { readMailAsset, previewMailAsset, saveMailAsset } from './mail-assets.ts'
const env = { HERALD_PERSONAL_URL: 'http://127.0.0.1:8787', HERALD_PERSONAL_TOKEN:'private-test-token' }
const ref = { kind: 'attachment' as const, clave:'MAIL-12', message_id:'msg+/=', attachment_id:'att+/=' }
const png = Buffer.from('89504e470d0a1a0a1234','hex')
const response=()=>new Response(png,{headers:{'content-type':'image/png','x-mail-filename':'photo.png'}})
describe('mail files',()=>{
  it('reads only a validated reference with main-process authentication',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>response())
    const file=await readMailAsset(ref,env,fetcher)
    expect(file.bytes).toEqual(png)
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8787/v1/mail-workspace/asset')
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',method:'POST'})
    expect(previewMailAsset(file)).toBe('data:image/png;base64,'+png.toString('base64'))
  })
  it('rejects arbitrary sources, active image formats and disguised HTML',async()=>{
    const fetcher=vi.fn()
    await expect(readMailAsset({...ref,url:'https://evil.test'} as never,env,fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    for(const mime of ['image/svg+xml','image/png']) expect(()=>previewMailAsset({bytes:Buffer.from('<script/>'),mime,name:'x'})).toThrow()
  })
  it('cancel does not write or fetch, and save preserves exact bytes only at chosen path',async()=>{
    const fetcher=vi.fn(async()=>({bytes:png,mime:'image/png',name:'photo.png'})); const write=vi.fn()
    expect(await saveMailAsset(ref,'../../unsafe.png',async()=>undefined,fetcher,write)).toEqual({cancelled:true})
    expect(fetcher).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    const choose=vi.fn(async()=>'/chosen/photo.png')
    await saveMailAsset(ref,'../../unsafe.png',choose,fetcher,write)
    expect(choose).toHaveBeenCalledWith('unsafe.png')
    expect(write).toHaveBeenCalledWith('/chosen/photo.png',png)
  })
  it('caps binary responses and does not expose upstream diagnostics',async()=>{
    await expect(readMailAsset(ref,env,async()=>new Response('secret',{status:500}))).rejects.not.toThrow(/secret/)
    await expect(readMailAsset(ref,env,async()=>new Response('x',{headers:{'content-length':'30000000'}}))).rejects.toThrow(/grande|límite/)
  })
})
