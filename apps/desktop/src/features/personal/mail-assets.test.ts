import {it,expect,vi} from 'vitest'
import {createMailAssetsController} from './mail-assets.ts'
it('ignores an older image preview and keeps image bytes only in memory',async()=>{
 const pending: ((v:{dataUrl:string})=>void)[]=[]
 const api=vi.fn(()=>new Promise<{dataUrl:string}>(resolve=>pending.push(resolve)))
 const c=createMailAssetsController(api)
 const a=c.preview({kind:'attachment',clave:'MAIL-1',message_id:'m',attachment_id:'a'})
 const b=c.preview({kind:'attachment',clave:'MAIL-1',message_id:'m',attachment_id:'b'})
 pending[1]({dataUrl:'data:image/png;base64,second'}); await b
 pending[0]({dataUrl:'data:image/png;base64,first'}); await a
 expect(c.state.get().src).toContain('second')
 c.clear(); expect(c.state.get().src).toBeNull()
})
