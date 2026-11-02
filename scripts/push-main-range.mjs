/**
 * 用 GitHub Git Data API 把本地一段提交逐个重建到远端 main。
 *
 * 每次提交都以远端当前树为 base_tree，重建后断言与本地 tree 完全一致；
 * 全部成功后再复查远端没有移动，最后 fast-forward 更新 ref。
 *
 * 用法：node scripts/push-main-range.mjs <local-base-sha> [--dry-run]
 */
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = 'bestlike093/agent-desktop-pet'
const BASE = 'https://api.github.com'
const CWD = process.cwd()
const DRY_RUN = process.argv.includes('--dry-run')
const BASE_LOCAL = process.argv[2]

if (!BASE_LOCAL) {
  throw new Error('usage: node scripts/push-main-range.mjs <local-base-sha> [--dry-run]')
}

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: CWD, maxBuffer: 64 * 1024 * 1024, ...opts })

function token() {
  const res = spawnSync('git', ['credential', 'fill'], {
    cwd: CWD,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const line = String(res.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('password='))
  if (!line) throw new Error('NO_TOKEN')
  return line.slice('password='.length).trim()
}

const TOKEN = token()

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  return text === '' ? null : JSON.parse(text)
}

function commits() {
  return git(['rev-list', '--reverse', `${BASE_LOCAL}..HEAD`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

function meta(sha) {
  const out = git(['log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI', sha], {
    encoding: 'utf8'
  }).split('\n')
  const message = git(['show', '-s', '--format=%B', sha], { encoding: 'utf8' }).replace(
    /\r?\n+$/,
    ''
  )
  return {
    message,
    author: { name: out[0], email: out[1], date: out[2] },
    committer: { name: out[3], email: out[4], date: out[5] }
  }
}

function treeMap(sha) {
  const out = git(['ls-tree', '-r', '-z', sha])
  const map = new Map()
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const [mode, type, objectSha] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    map.set(path, { mode, type, sha: objectSha })
  }
  return map
}

function changes(sha) {
  const out = git(['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', `${sha}^`, sha])
  const parts = out.toString('utf8').split('\0').filter(Boolean)
  const list = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = parts[i++]
      const to = parts[i++]
      if (status.startsWith('R')) list.push({ status: 'D', path: from })
      list.push({ status: 'A', path: to })
    } else {
      list.push({ status: status[0], path: parts[i++] })
    }
  }
  return list
}

const branch = await api('GET', `/repos/${REPO}/branches/main`)
let remoteSha = branch.commit.sha
let remoteTree = branch.commit.commit.tree.sha
console.log(`REMOTE ${remoteSha} TREE ${remoteTree}`)

// 基线必须与远端当前树一致；不一致说明本地落后或有分叉，先 fetch/rebase。
const baseTree = git(['rev-parse', `${BASE_LOCAL}^{tree}`], { encoding: 'utf8' }).trim()
if (baseTree !== remoteTree) {
  throw new Error(
    `BASE_TREE_MISMATCH ${BASE_LOCAL} ${baseTree} != ${remoteTree}；先 fetch/rebase 到 origin/main`
  )
}

const list = commits()
if (list.length === 0) {
  console.log('NO_COMMITS')
  process.exit(0)
}
console.log(`COMMITS ${list.length}`)

for (const sha of list) {
  const info = meta(sha)
  const map = treeMap(sha)
  const entries = []

  for (const item of changes(sha)) {
    if (item.status === 'D') {
      entries.push({ path: item.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const file = map.get(item.path)
    if (!file) throw new Error(`MISSING_IN_TREE ${item.path}`)
    if (file.type !== 'blob') throw new Error(`UNSUPPORTED_TYPE ${item.path} ${file.type}`)
    const content = git(['cat-file', 'blob', file.sha])
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64'
    })
    if (blob.sha !== file.sha) throw new Error(`BLOB_SHA_MISMATCH ${item.path}`)
    entries.push({ path: item.path, mode: file.mode, type: 'blob', sha: blob.sha })
  }

  // 每一步都以远端当前树为 base_tree，而不是拿本地父提交的树当基线。
  const tree = await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: remoteTree,
    tree: entries
  })
  const localTree = git(['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim()
  if (tree.sha !== localTree) {
    throw new Error(`TREE_SHA_MISMATCH ${sha} ${tree.sha} != ${localTree}`)
  }

  if (DRY_RUN) {
    console.log(`DRY ${sha.slice(0, 8)} TREE ${tree.sha.slice(0, 8)}`)
    remoteTree = tree.sha
    continue
  }

  const created = await api('POST', `/repos/${REPO}/git/commits`, {
    message: info.message,
    tree: tree.sha,
    parents: [remoteSha],
    author: info.author,
    committer: info.committer
  })
  console.log(`OK ${sha.slice(0, 8)} -> ${created.sha.slice(0, 8)} ${info.message.split('\n')[0]}`)
  remoteSha = created.sha
  remoteTree = tree.sha
}

if (DRY_RUN) {
  console.log('DRY_RUN_OK')
  process.exit(0)
}

// 推送前再确认远端没被别人推进；变了就退出，避免覆盖。
const latest = await api('GET', `/repos/${REPO}/branches/main`)
if (latest.commit.sha !== branch.commit.sha) {
  throw new Error(`REMOTE_MOVED ${branch.commit.sha} -> ${latest.commit.sha}；重新执行`)
}

await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: remoteSha, force: false })
console.log(`PUSHED ${remoteSha}`)
