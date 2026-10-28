import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { resolve } from 'node:path'

test('controller contracts reject unknown dependencies and invalid shared state writes', () => {
  const config = ts.readConfigFile('tsconfig.client.json', ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const file = resolve('__controller_contract_check__.ts')
  const source = `import type { PanelEnv, ConversationEnv, HistoryEnv } from './src/client/controller-contracts.js';
declare const panel: PanelEnv;
declare const conversation: ConversationEnv;
declare const history: HistoryEnv;
panel.askBox.value = 'draft';
panel.state.raw = 'answer';
conversation.state.asking = true;
history.state.turns.push({ role: 'user', text: 'hello' });
// @ts-expect-error misspelled dependency must not silently become any
panel.hideHistroyList();
// @ts-expect-error a shared boolean cannot be replaced with text
panel.panelOpen = 'open';
// @ts-expect-error shared request state has a concrete boolean
conversation.state.asking = 'yes';
// @ts-expect-error DOM dependencies retain their real element type
panel.askBox.value = 12;
`
  const host = ts.createCompilerHost(parsed.options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) => name === file ? ts.createSourceFile(file, source, languageVersion, true) : original(name, languageVersion, ...rest)
  const program = ts.createProgram([...parsed.fileNames, file], parsed.options, host)
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n', getCanonicalFileName: name => name }))
})
