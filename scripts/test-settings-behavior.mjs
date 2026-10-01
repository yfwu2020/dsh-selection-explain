/** Exercise setting effects through the real plugin HTTP handlers in disposable storage. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../lib/index.js'

const home=await mkdtemp(join(tmpdir(),'dsh-settings-behavior-'))
const oldHome=process.env.DSH_HOME
process.env.DSH_HOME=home
await mkdir(join(home,'selection-explain'))
await writeFile(join(home,'selection-explain/settings.json'),JSON.stringify({values:{maxTokens:1234,temperature:0.4,resultCacheTtlMs:600000,historyMaxEntries:0}}))
const longSelection='长'.repeat(4500)+'末尾标记'
await writeFile(join(home,'selection-explain/history.json'),JSON.stringify({entries:[{key:'existing-long',text:longSelection}]}))
const routes=new Map(), calls=[], executions=[]
let mode='answer', toolPath='inside.txt', checks=0, serial=0
const events=[]
for(let i=1;i<=10;i++){
  events.push({type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:`Q${String(i).padStart(2,'0')} `+'甲'.repeat(300)}]}})
  events.push({type:'assistant/message',data:{message:{content:[{type:'text',text:`A${String(i).padStart(2,'0')} `+'乙'.repeat(300)}]}}})
}
const llm={listProviders:()=>[{id:'fixture',name:'Fixture'}],listModels:async()=>[{id:'a',name:'A'},{id:'b',name:'B'}],
  async *stream(options){
    calls.push(options)
    if(mode==='timeout'){
      await new Promise((resolve,reject)=>{
        if(options.signal.aborted)reject(new DOMException('aborted','AbortError'))
        else options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})
      })
    }
    const tool=mode==='unexpected-tools'?(options.tools?.[0]??{name:'read'}):mode==='unlisted-tool'?{name:'grep'}:options.tools?.[0]
    const hasResult=options.messages.some(m=>m.role==='tool')
    if(tool && (mode==='unexpected-tools' || mode==='unlisted-tool' || mode==='repeat-tools' || mode==='one-tool' && !hasResult)){
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id:'call-'+calls.length,name:tool.name,argumentsDelta:JSON.stringify({file_path:toolPath})}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'call-'+calls.length,name:tool.name,arguments:JSON.stringify({file_path:toolPath})}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
    }else{
      yield {type:'text-delta',index:0,text:'这是验证设置行为的回答，内容完整。'}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  },
}
const registry={schemas:()=>['read','grep','web_search','platform_search'].map(name=>({name,description:name,parameters:{type:'object',properties:{}}})),
  async execute(input){executions.push(input);return {content:[{type:'text',text:'工具结果'.repeat(400)}],isError:false}}}
const services={llm,tools:registry,agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'a'})},sessions:{get:()=>({header:{cwd:'/fixture/project'}})},
  sessionQuery:{readSurface:async()=>({events}),readSession:async()=>({events:[]})}}
const ctx={llm,get:name=>services[name],on(){return ()=>{}},effect:fn=>fn(),logger:{info(){},warn(){}},
  webServer:{register(route){routes.set(route.path,route.handler);return ()=>routes.delete(route.path)}}}
apply(ctx,{})
const server=createServer((req,res)=>{
  const handler=routes.get(new URL(req.url,'http://localhost').pathname)
  if(!handler){res.writeHead(404);res.end();return}
  Promise.resolve(handler(req,res)).catch(error=>{console.error(error);if(!res.headersSent)res.writeHead(500);res.end()})
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin='http://127.0.0.1:'+server.address().port
async function json(path,body){const r=await fetch(origin+'/selection-explain/api/'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return r.json()}
async function set(values){const result=await json('settings',{values});assert.equal(result.ok,true);assert.deepEqual(result.rejected,[]);return result}
async function analyze(body={}){
  const start=calls.length
  const r=await fetch(origin+'/selection-explain/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'probe-'+(++serial),refresh:true,sessionId:'fixture-session',...body})})
  const text=await r.text()
  const chunks=text.split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)))
  return {status:r.status,text,chunks,calls:calls.slice(start)}
}
function check(label,fn){try{fn();checks++;console.log('PASS '+label)}catch(error){console.error('FAIL '+label);throw error}}
function prompt(call){return (call?.messages||[]).filter(m=>m.role!=='system').flatMap(m=>m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')}
function background(call){const text=prompt(call);return text.includes('【会话背景】')?text.split('【会话背景】')[1].split('上面是会话背景')[0]:''}
try{
  await json('history',{key:'startup',text:'启动时历史设置'})
  const initialHistory=await json('history')
  check('首次直接保存历史也读取已持久化的设置',()=>assert.deepEqual(initialHistory.entries.map(e=>e.key),['existing-long']))
  const loadedLong=await json('history?key=existing-long')
  check('加载已有长划词历史不会按旧默认截断',()=>assert(loadedLong.entry.text===longSelection,`实际保存 ${loadedLong.entry.text.length} 字，期望 ${longSelection.length} 字`))
  await json('settings')
  await set({historyMaxEntries:20})
  await set({provider:'fixture',model:'b',translationReasoningEffort:'max',reasoningEffort:'low',chatReasoningEffort:'off',tools:false})
  for(const [label,body,effort] of [['首轮',{stage:'translation'},'max'],['次轮',{stage:'detail'},'low'],['追问',{question:'继续解释'},'off']]){
    const r=await analyze(body)
    check(label+'实际采用同一模型与对应思考强度',()=>{assert.equal(r.calls[0].model,'b');assert.equal(r.calls[0].reasoningEffort,effort)})
  }
  check('隐藏的输出上限、温度仍进入模型调用',()=>{assert.equal(calls[0].maxTokens,1234);assert.equal(calls[0].temperature,0.4)})
  await set({maxSelectionChars:20})
  const over=await analyze({text:'长'.repeat(21)})
  check('选中文字上限拒绝过长请求',()=>assert.equal(over.status,413))
  await set({maxSelectionChars:6000})
  const longer=await analyze({text:'长'.repeat(4500)})
  check('调高选中文字上限后 host 接受超过旧默认的文字',()=>assert.equal(longer.status,200))
  await json('history',{key:'saved-long',text:longSelection})
  const savedLong=await json('history?key=saved-long')
  check('保存长划词历史保留选中文字及末尾',()=>assert(savedLong.entry.text===longSelection,`实际保存 ${savedLong.entry.text.length} 字，期望 ${longSelection.length} 字`))
  await set({maxContextChars:200,sessionContext:false})
  const local=await analyze({context:'局'.repeat(400)})
  check('局部上下文按上限截断',()=>{assert(prompt(local.calls[0]).includes('局'.repeat(200)));assert(!prompt(local.calls[0]).includes('局'.repeat(201)))})
  check('关闭会话背景后不注入会话消息',()=>assert.equal(background(local.calls[0]),''))
  await set({sessionContext:true,sessionContextFastMessages:2,sessionContextMaxMessages:4,sessionContextMaxChars:0})
  const fast=await analyze({text:'Q09',stage:'translation'})
  const detail=await analyze({text:'Q09',stage:'detail'})
  const chat=await analyze({text:'Q09',question:'继续'})
  const count=r=>(background(r.calls[0]).match(/(?:▶\s*)?(?:用户|助手)：/g)||[]).length
  check('首轮按设置取两条背景消息',()=>assert.equal(count(fast),2))
  check('次轮与追问按设置取四条背景消息',()=>{assert.equal(count(detail),4);assert.equal(count(chat),4)})
  await set({sessionContextMaxChars:1000})
  const cap=await analyze({text:'Q09',stage:'detail'})
  check('会话上下文字符上限改变实际注入量',()=>assert(background(cap.calls[0]).length<background(detail.calls[0]).length))
  await set({quoteContextRounds:0,quoteContextMaxCharsPerTurn:200,quoteContextMaxChars:6000})
  const quote0=await json('quote-context',{text:'Q05',sessionId:'fixture-session'})
  await set({quoteContextRounds:2,quoteContextMaxCharsPerTurn:2000})
  const quote2=await json('quote-context',{text:'Q05',sessionId:'fixture-session'})
  check('引用上下文轮数控制实际取出的轮数',()=>{assert.equal(quote0.rounds,1);assert.equal(quote2.rounds,5)})
  check('引用单条消息上限控制长消息裁剪',()=>{assert(quote0.context.length<600);assert(quote2.context.includes('甲'.repeat(300)))})
  await set({quoteContextMaxChars:600})
  const quoteCap=await json('quote-context',{text:'Q05',sessionId:'fixture-session'})
  check('引用总字符上限减少上下文并保留引用',()=>{assert(quoteCap.context.length<quote2.context.length);assert(quoteCap.context.includes('【Q05】'))})
  await set({tools:true,maxToolRounds:1,toolNames:'read',fallbackToolNames:'web_search',toolReadRoot:'/fixture/project',toolResultMaxChars:200})
  mode='one-tool'; toolPath='/fixture/project/inside.txt'
  const tool=await analyze()
  check('工具允许列表控制提供给模型的工具',()=>assert.deepEqual(tool.calls[0].tools.map(t=>t.name),['read','web_search']))
  check('工具返回字符上限作用于回灌模型的结果',()=>{const next=prompt(tool.calls[1]);assert(next.includes('已截断'));assert(!next.includes('工具结果'.repeat(60)))})
  const beforeDenied=executions.length;toolPath='/fixture/outside.txt'
  const denied=await analyze()
  check('指定文件目录拒绝目录外调用',()=>{assert.equal(executions.length,beforeDenied);assert(denied.text.includes('越界已拒绝'))})
  await set({toolReadRoot:''});toolPath='/fixture/outside.txt'
  const beforeDefault=executions.length;await analyze()
  check('文件目录留空时按会话工作目录限制',()=>assert.equal(executions.length,beforeDefault))
  await set({toolReadRoot:'*'});await analyze()
  check('文件目录星号允许跨目录调用',()=>assert.equal(executions.length,beforeDefault+1))
  await set({toolNames:'unavailable',fallbackToolNames:'web_search'})
  const fallback=await analyze()
  check('首选工具不可用时加入备用搜索工具',()=>assert.deepEqual(fallback.calls[0].tools.map(t=>t.name),['web_search']))
  await set({tools:false})
  const noTools=await analyze()
  check('关闭工具调用后模型拿不到工具',()=>assert.equal(noTools.calls[0].tools,undefined))
  await set({tools:true,maxToolRounds:0})
  const zero=await analyze()
  check('调用轮数为零时不提供工具',()=>assert.equal(zero.calls[0].tools,undefined))
  await set({maxToolRounds:1});mode='repeat-tools'
  const beforeRounds=executions.length;await analyze()
  check('调用轮数为一时只执行一轮工具',()=>assert.equal(executions.length-beforeRounds,1))
  mode='unexpected-tools'
  const beforeUnexpected=executions.length;await analyze()
  check('收尾轮即使返回工具调用也不突破轮数上限',()=>assert.equal(executions.length-beforeUnexpected,1))
  await set({maxToolRounds:0})
  const beforeZeroUnexpected=executions.length;await analyze()
  check('轮数为零时即使返回工具调用也不执行',()=>assert.equal(executions.length,beforeZeroUnexpected))
  await set({maxToolRounds:1,tools:false})
  const beforeDisabledUnexpected=executions.length;await analyze()
  check('关闭工具后即使返回工具调用也不执行',()=>assert.equal(executions.length,beforeDisabledUnexpected))
  await set({tools:true,toolNames:'read',fallbackToolNames:''});mode='unlisted-tool'
  const beforeUnlisted=executions.length;await analyze()
  check('模型返回未允许的工具也不执行',()=>assert.equal(executions.length,beforeUnlisted))
  mode='answer';await set({tools:false})
  const cacheText='cache-probe';const first=await analyze({text:cacheText,refresh:false});const second=await analyze({text:cacheText,refresh:false})
  check('隐藏缓存设置后仍复用相同请求的结果',()=>{assert(first.calls.length>0);assert.equal(second.calls.length,0);assert(second.chunks.some(c=>c.cached===true))})
  await set({historyMaxEntries:1})
  await json('history',{key:'one',text:'一',turns:[]});await json('history',{key:'two',text:'二',turns:[]})
  const history=await json('history')
  check('历史保留段数实际淘汰旧对话',()=>assert.deepEqual(history.entries.map(e=>e.key),['two']))
  await set({historyMaxEntries:0});await json('history',{key:'three',text:'三'})
  const unchangedHistory=await json('history')
  check('历史上限为零停止新保存并保留已有记录',()=>assert.deepEqual(unchangedHistory.entries.map(e=>e.key),['two']))
  await set({timeoutMs:5000});mode='timeout'
  const started=Date.now(), timed=await analyze()
  check('生成时限实际取消模型流',()=>{assert(timed.chunks.some(c=>c.type==='error'&&c.message.includes('超时')));assert(Date.now()-started>=4900);assert(Date.now()-started<9000)})
  mode='answer';await set({maxRequestsPerMinute:1})
  const rate=await analyze()
  check('每分钟请求上限实际拒绝超限请求',()=>assert.equal(rate.status,429))
  console.log(`全部 ${checks} 项实际行为验证通过`)
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  await new Promise(resolve=>setTimeout(resolve,900))
  if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome
  await rm(home,{recursive:true,force:true})
}
