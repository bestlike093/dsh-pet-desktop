import { VaultStore, VaultLlmSecretStore, MemoryVaultStorage } from '../packages/vault/dist/index.js'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

function machinePassword() {
  let guid = ''
  try {
    guid = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('MachineGuid'))[0]
      ?.split(/\s+/)
      .pop() ?? ''
  } catch {}
  const seed = `${guid}|${process.env.USERNAME ?? ''}|cyrene-pet-vault-v1`
  return createHash('sha256').update(seed).digest('hex')
}

const pw = machinePassword()
console.log('machine_guid_found:', pw.length === 64)
console.log('password_stable:', pw === machinePassword())

const storage = new MemoryVaultStorage()
const store = new VaultStore(storage)
const t0 = Date.now()
await store.unlock(pw)
console.log('unlock_ms:', Date.now() - t0)

const secrets = new VaultLlmSecretStore(store)
await secrets.setApiKey('sk-proj-abcdef1234567890')
const raw = storage.raw()
console.log('cipher_bytes:', raw?.length)
console.log('plain_leaked:', raw?.includes('sk-proj-abcdef1234567890'))

const got = await secrets.getApiKey()
console.log('roundtrip_ok:', got === 'sk-proj-abcdef1234567890')

await secrets.clearApiKey()
console.log('after_clear_null:', (await secrets.getApiKey()) === null)

const store2 = new VaultStore(storage)
try {
  await store2.unlock('wrong-password')
  console.log('wrong_password_rejected: false')
} catch (e) {
  console.log('wrong_password_rejected: true ::', e.code ?? e.name)
}

const store3 = new VaultStore(storage)
await store3.unlock(pw)
console.log('reopen_ok:', (await store3.load()) !== undefined)
