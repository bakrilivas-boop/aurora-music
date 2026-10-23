import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const { createPreferences } = require('../electron/preferences.cjs')
const { createNativeLibrary } = require('../electron/native-library.cjs')
const root = mkdtempSync(resolve('.qa/desktop-state-'))
let checks = 0
async function check(name, test) { await test(); checks++; console.log('PASS ' + name) }
const full = { accent:'#6b9ff5', volume:.31, muted:true, shuffle:true, repeat:'one', eqEnabled:true, eqGains:[1,2,3,4,5,6,7,8,9,10], reducedMotion:true, showSpectrum:false, autoAnalyze:false, autoMetadata:false }
await check('主进程在立即退出前提交全部设置，重建实例保留主题音量均衡器与开关', () => {
  const file = join(root,'settings.json'), prefs = createPreferences(file)
  prefs.save(full); prefs.flush()
  assert.deepEqual(createPreferences(file).read(),full)
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),full)
  assert.equal(readdirSync(root).some((name)=>name.endsWith('.tmp')),false)
})
await check('快速连续设置只保存最终值，调用方修改数组不会篡改检查点', () => {
  const file=join(root,'rapid.json'), prefs=createPreferences(file)
  const supplied={...full,eqGains:full.eqGains.slice()}
  prefs.save(supplied); supplied.eqGains[0]=-12
  for(let i=0;i<50;i++)prefs.save({volume:i/100})
  prefs.flush()
  const state=createPreferences(file).read()
  assert.equal(state.volume,.49); assert.equal(state.eqGains[0],1)
})
await check('损坏或非法设置不覆盖有效配置；只接受已知偏好字段', () => {
  const file=join(root,'validation.json'), prefs=createPreferences(file)
  prefs.save(full);prefs.flush()
  for(const bad of [{volume:NaN},{volume:2},{repeat:'bad'},{eqGains:[0]},{autoAnalyze:'true'},{accent:'url(x)'}])assert.throws(()=>prefs.save(bad))
  assert.deepEqual(prefs.read(),full)
  prefs.save({apiKey:'MUST_NOT_PERSIST'});prefs.flush()
  assert.ok(!readFileSync(file,'utf8').includes('MUST_NOT_PERSIST'))
  const corrupt=join(root,'corrupt.json');writeFileSync(corrupt,'{bad')
  assert.deepEqual(createPreferences(corrupt).read(),{})
})

const first=join(root,'music'), second=join(root,'second'), outside=join(root,'outside')
for(const directory of [first,second,outside])mkdirSync(directory)
const bytes=Buffer.alloc(32768,7);bytes.set([0xff,0xfb,0x90,0xc0])
writeFileSync(join(first,'Artist - Original.mp3'),bytes)
writeFileSync(join(first,'.aurora-test.part'),bytes)
writeFileSync(join(first,'page.html'),bytes)
writeFileSync(join(outside,'outside.mp3'),bytes)
let roots=[first]
const library=createNativeLibrary({directories:()=>roots})
let entries=library.list()
await check('只索引显式下载目录的音频，临时文件和网页不入库，编号不含路径', () => {
  assert.equal(entries.length,1)
  assert.match(entries[0].id,/^[a-f\d]{64}$/)
  assert.ok(!JSON.stringify(entries).includes(root))
  assert.deepEqual(library.list(),entries)
})
await check('目录改选后保留既有目录，重复根目录不会重复入库', () => {
  writeFileSync(join(second,'Second.mp3'),bytes)
  roots=[first,second,first]
  assert.equal(library.list().length,2)
  roots=[first];entries=library.list()
})
await check('符号链接不能把选定目录外的文件带入曲库', () => {
  try { symlinkSync(join(outside,'outside.mp3'),join(first,'linked.mp3'),'file') } catch(error) { if(error.code!=='EPERM')throw error }
  assert.equal(library.list().length,1)
})
const server=createServer((req,res)=>library.serve(req,res,new URL(req.url,'http://local').pathname.slice(1)))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}/${entries[0].id}`
try {
  await check('本地播放支持完整读取、Range与HEAD，分段内容逐字节一致', async () => {
    let response=await fetch(url,{headers:{Range:'bytes=10-31'}})
    assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 10-31/${bytes.length}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(10,32))
    response=await fetch(url,{method:'HEAD'});assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal((await response.arrayBuffer()).byteLength,0)
    response=await fetch(url,{headers:{Range:'bytes=-12'}});assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(-12))
  })
  await check('越界、多段和非法Range被拒绝，未知编号不暴露任意文件', async () => {
    for(const range of ['bytes=999999-','bytes=1-0','bytes=0-1,2-3','bytes=-0','invalid'])assert.equal((await fetch(url,{headers:{Range:range}})).status,416)
    assert.equal((await fetch(url.replace(entries[0].id,'not-a-file'))).status,404)
  })
  await check('文件被替换后旧索引停止播放，重新同步才使用新元数据', async () => {
    writeFileSync(join(first,'Artist - Original.mp3'),Buffer.concat([bytes,Buffer.from([1])]))
    assert.equal((await fetch(url)).status,404)
    const next=library.list()[0];assert.equal(next.id,entries[0].id);assert.equal(next.size,bytes.length+1)
  })
} finally { await new Promise(resolve=>server.close(resolve)) }
await build({entryPoints:['src/lib/library.ts'],bundle:true,format:'esm',platform:'browser',outfile:'.tmp/native-library.mjs'})
const {buildNativeTrack}=await import('../.tmp/native-library.mjs')
await check('原生歌曲标签按需读取，复用解析器且不创建整首音频File', async () => {
  const original=globalThis.fetch
  let total=0
  globalThis.fetch=async (_,options)=>{
    const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert.ok(match)
    const data=bytes.subarray(Number(match[1]),Number(match[2])+1);total+=data.length
    return new Response(data,{status:206})
  }
  try {
    const track=await buildNativeTrack({id:'a'.repeat(64),filename:'Artist - Song.mp3',size:bytes.length,lastModified:1})
    assert.equal(track.title,'Song');assert.equal(track.artist,'Artist');assert.equal(track.file,undefined)
    assert.match(track.nativeUrl,/^\/native-audio\//);assert.ok(total<100)
  } finally { globalThis.fetch=original }
})
console.log(`Desktop state regression: ${checks} checks passed`)
