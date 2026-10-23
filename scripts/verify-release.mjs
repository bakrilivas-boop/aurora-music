import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import asar from '@electron/asar'

const archive = 'release/win-unpacked/resources/app.asar'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, version)
const files = ['dist/index.html', ...readdirSync('electron').filter((name) => name.endsWith('.cjs')).map((name) => join('electron', name)), ...readdirSync('dist/assets').map((name) => join('dist/assets', name))]
for (const file of files) assert.ok(asar.extractFile(archive, file).equals(readFileSync(file)), 'Stale packaged file: ' + file)
assert.ok(!asar.listPackage(archive).some((file) => /(^|[\\/])(\.qa|archive|test-music|test-results|metadata-cache|deepseek-config\.json)([\\/]|$)/.test(file)), 'Test data, credentials and personal caches must stay outside the application')
console.log('Release ' + version + ': ' + files.length + ' packaged source/assets match; no QA data included.')
