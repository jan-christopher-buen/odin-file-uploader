import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createPrisma } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { localStorage } from '../src/storage/local.js'

const connection = process.env.TEST_DATABASE_URL
if (
  !connection ||
  decodeURIComponent(new URL(connection).pathname) !==
    '/odin_file_uploader_test'
)
  throw new Error(
    'Tests require explicitly isolated odin_file_uploader_test database',
  )
if (connection === process.env.DATABASE_URL)
  throw new Error('Test and application databases must differ')
const db = createPrisma(connection)
const prefix = `test_${randomUUID().slice(0, 8)}`
let dir, config, app, storage
const apps = []
const sessionIds = new Set()
const token = (response) => {
  const result = /name="_csrf" value="([a-f0-9]+)"/.exec(response.text)
  assert.ok(result, 'CSRF form token')
  return result[1]
}
async function get(agent, url) {
  const response = await agent.get(url)
  for (const cookie of response.headers['set-cookie'] || []) {
    const match = /^folio.sid=s%3A([^.;]+)/.exec(cookie)
    if (match) sessionIds.add(decodeURIComponent(match[1]))
  }
  return response
}
async function signup(suffix) {
  const agent = request.agent(app)
  const csrf = token(await get(agent, '/signup'))
  await agent
    .post('/signup')
    .type('form')
    .send({
      _csrf: csrf,
      username: `${prefix}_${suffix}`,
      password: 'test password 123',
      confirmPassword: 'test password 123',
    })
    .expect(302)
  await get(agent, '/dashboard')
  return agent
}
async function folder(agent, name = 'Documents') {
  const csrf = token(await get(agent, '/dashboard'))
  const response = await agent
    .post('/folders')
    .type('form')
    .send({ _csrf: csrf, name })
    .expect(302)
  return response.headers.location.split('/').at(-1)
}
async function upload(
  agent,
  folderId,
  name = 'note.txt',
  data = Buffer.from('A useful note.'),
) {
  const csrf = token(await get(agent, `/folders/${folderId}`))
  return agent
    .post(`/folders/${folderId}/files`)
    .field('_csrf', csrf)
    .attach('file', data, { filename: name })
}
async function post(agent, url, data = {}) {
  const csrf = token(await get(agent, '/dashboard'))
  return agent
    .post(url)
    .type('form')
    .send({ _csrf: csrf, ...data })
}

before(async () => {
  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: connection }, stdio: 'pipe' },
  )
  dir = await mkdtemp(path.join(os.tmpdir(), 'folio-test-'))
  config = {
    ...loadConfig(),
    production: false,
    provider: 'local',
    localDir: path.join(dir, 'files'),
    tempDir: path.join(dir, 'temp'),
    maxFileBytes: 1024,
    maxUserBytes: 1500,
    maxUserFiles: 2,
  }
  storage = localStorage(config.localDir)
  app = await createApp({ db, config, storage })
  apps.push(app)
})
after(async () => {
  for (const app of apps) app.locals.sessionStore.stopInterval()
  const users = await db.user.findMany({
    where: { username: { startsWith: prefix } },
  })
  for (const user of users) {
    await db.file.deleteMany({ where: { ownerId: user.id } })
    await db.folder.deleteMany({ where: { ownerId: user.id } })
    await db.user.delete({ where: { id: user.id } })
  }
  for (const row of await db.session.findMany()) {
    let value
    try {
      value = JSON.parse(row.data)
    } catch {
      continue
    }
    if (
      sessionIds.has(row.sid) ||
      users.some((user) => user.id === value.passport?.user)
    )
      await db.session.delete({ where: { id: row.id } })
  }
  await db.$disconnect()
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('signup validation, normalized uniqueness, login, persisted sessions, CSRF and logout', async () => {
  const agent = request.agent(app)
  let csrf = token(await get(agent, '/signup'))
  await agent
    .post('/signup')
    .type('form')
    .send({
      _csrf: csrf,
      username: `${prefix}_invalid`,
      password: '😀'.repeat(19),
      confirmPassword: '😀'.repeat(19),
    })
    .expect(422)
  await agent
    .post('/signup')
    .type('form')
    .send({
      _csrf: csrf,
      username: `${prefix}_invalid`,
      password: 'password123',
      confirmPassword: 'different',
    })
    .expect(422)
  await agent
    .post('/signup')
    .type('form')
    .send({ username: `${prefix}_invalid`, password: 'password123' })
    .expect(403)
  const user = await signup('auth')
  const page = await get(user, '/dashboard')
  csrf = token(page)
  assert.ok(!page.text.includes('passwordHash'))
  assert.ok((await db.session.count()) > 0)
  const persistedSession = await db.session.findFirst({
    where: {
      data: {
        contains: (
          await db.user.findUnique({ where: { username: `${prefix}_auth` } })
        ).id,
      },
    },
  })
  assert.ok(persistedSession)
  const secondApp = await createApp({ db, config, storage })
  apps.push(secondApp)
  // The same signed cookie is accepted by a fresh app/store instance.
  const { createHmac } = await import('node:crypto')
  const signed =
    persistedSession.sid +
    '.' +
    createHmac('sha256', config.secret)
      .update(persistedSession.sid)
      .digest('base64')
      .replace(/=+$/, '')
  await request(secondApp)
    .get('/dashboard')
    .set('Cookie', `folio.sid=${encodeURIComponent('s:' + signed)}`)
    .expect(200)
  const loginAgent = request.agent(secondApp)
  const loginCsrf = token(await get(loginAgent, '/login'))
  await loginAgent
    .post('/login')
    .type('form')
    .send({
      _csrf: loginCsrf,
      username: `${prefix}_auth`.toUpperCase(),
      password: 'test password 123',
    })
    .expect(302)
  await get(loginAgent, '/dashboard').then((result) =>
    assert.equal(result.status, 200),
  )
  await post(user, '/logout').then((result) => assert.equal(result.status, 302))
  await user.get('/dashboard').expect(302)
  csrf = token(await get(user, '/login'))
  await user
    .post('/login')
    .type('form')
    .send({ _csrf: csrf, username: `${prefix}_auth`, password: 'wrong' })
    .expect(401)
  await user
    .post('/signup')
    .type('form')
    .send({
      _csrf: csrf,
      username: `${prefix}_auth`.toUpperCase(),
      password: 'password123',
      confirmPassword: 'password123',
    })
    .expect(409)
})

test('folder CRUD, byte-perfect download, escaped metadata and ownership for every action', async () => {
  const owner = await signup('owner'),
    stranger = await signup('stranger')
  const id = await folder(owner)
  await post(owner, '/folders', { name: 'DOCUMENTS' }).then((result) =>
    assert.equal(result.status, 409),
  )
  await post(owner, `/folders/${id}/rename`, { name: 'Renamed' }).then(
    (result) => assert.equal(result.status, 302),
  )
  const data = Buffer.from('Private note.\nSame bytes.')
  const response = await upload(owner, id, 'note<em>.txt', data)
  assert.equal(response.status, 302)
  const fileUrl = response.headers.location
  const details = await owner.get(fileUrl).expect(200)
  assert.ok(details.text.includes('note&lt;em&gt;.txt'))
  const download = await owner.get(`${fileUrl}/download`).expect(200)
  assert.equal(download.text, data.toString())
  assert.match(download.headers['content-disposition'], /^attachment;/)
  assert.equal(download.headers['x-content-type-options'], 'nosniff')
  await post(owner, `/folders/${id}/delete`).then((result) =>
    assert.equal(result.status, 409),
  )
  for (const url of [`/folders/${id}`, fileUrl, `${fileUrl}/download`])
    await stranger.get(url).expect(404)
  for (const [url, body] of [
    [`/folders/${id}/rename`, { name: 'stolen' }],
    [`/folders/${id}/delete`, {}],
    [`${fileUrl}/delete`, {}],
  ])
    await post(stranger, url, body).then((result) =>
      assert.equal(result.status, 404),
    )
  const csrf = token(await get(stranger, '/dashboard'))
  await stranger
    .post(`/folders/${id}/files`)
    .field('_csrf', csrf)
    .attach('file', Buffer.from('stolen'), 'x.txt')
    .expect(404)
  await post(owner, `${fileUrl}/delete`).then((result) =>
    assert.equal(result.status, 302),
  )
  await post(owner, `/folders/${id}/delete`).then((result) =>
    assert.equal(result.status, 302),
  )
  await owner.get(`/folders/${id}`).expect(404)
  assert.deepEqual(await readdir(config.tempDir), [])
})

test('upload restrictions and validation leave no temporary or permanent orphans', async () => {
  const agent = await signup('validation'),
    id = await folder(agent)
  for (const [name, data] of [
    ['empty.txt', Buffer.alloc(0)],
    ['fake.png', Buffer.from('not png')],
    ['page.txt', Buffer.from('<html>bad</html>')],
    ['bad.txt', Buffer.from([255, 0])],
    ['code.svg', Buffer.from('<svg/>')],
    ['big.txt', Buffer.alloc(1025, 65)],
    ['path\\evil.txt', Buffer.from('hello')],
  ]) {
    const result = await upload(agent, id, name, data)
    assert.equal(result.status, 422, name)
  }
  let csrf = token(await get(agent, `/folders/${id}`))
  await agent
    .post(`/folders/${id}/files`)
    .field('_csrf', 'bad')
    .attach('file', Buffer.from('valid'), 'note.txt')
    .expect(403)
  await agent
    .post(`/folders/${id}/files`)
    .field('_csrf', csrf)
    .attach('unexpected', Buffer.from('valid'), 'note.txt')
    .expect(422)
  await agent
    .post(`/folders/${id}/files`)
    .field('_csrf', csrf)
    .field('ownerId', 'fake')
    .attach('file', Buffer.from('valid'), 'note.txt')
    .expect(422)
  await agent
    .post(`/folders/${id}/files`)
    .field('_csrf', csrf)
    .attach('file', Buffer.from('valid'), 'one.txt')
    .attach('file', Buffer.from('valid'), 'two.txt')
    .expect(422)
  assert.deepEqual(await readdir(config.tempDir), [])
  assert.equal(await db.file.count({ where: { folderId: id } }), 0)
  assert.equal(
    (await upload(agent, id, 'large.txt', Buffer.alloc(800, 65))).status,
    302,
  )
  assert.equal(
    (await upload(agent, id, 'large2.txt', Buffer.alloc(800, 65))).status,
    422,
  )
  assert.equal((await upload(agent, id, 'small.txt')).status, 302)
  assert.equal((await upload(agent, id, 'third.txt')).status, 422)
})

test('storage failure preserves records; DB failure compensates completed storage uploads', async () => {
  const agent = await signup('failures'),
    id = await folder(agent)
  const originalPut = storage.put,
    originalRemove = storage.remove
  storage.put = async () => {
    throw new Error('simulated storage failure')
  }
  assert.equal((await upload(agent, id)).status, 500)
  assert.equal(await db.file.count({ where: { folderId: id } }), 0)
  storage.put = async (...args) => {
    const ref = await originalPut(...args)
    // Constraint violation occurs after a successful upload.
    return null
  }
  const before = (await readdir(config.localDir).catch(() => [])).length
  assert.equal((await upload(agent, id)).status, 500)
  assert.equal((await readdir(config.localDir)).length, before)
  storage.put = originalPut
  const uploaded = await upload(agent, id)
  storage.remove = async () => {
    throw new Error('simulated deletion failure')
  }
  await post(agent, `${uploaded.headers.location}/delete`).then((result) =>
    assert.equal(result.status, 500),
  )
  const fileId = uploaded.headers.location.split('/').at(-1)
  assert.ok(await db.file.findUnique({ where: { id: fileId } }))
  storage.remove = originalRemove
  await post(agent, `${uploaded.headers.location}/delete`).then((result) =>
    assert.equal(result.status, 302),
  )
  assert.deepEqual(await readdir(config.tempDir), [])
})

test('real binary signatures and extension mismatches', async () => {
  const agent = await signup('binary')
  const id = await folder(agent)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==',
    'base64',
  )
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  )
  for (const [name, data] of [
    ['pixel.png', png],
    ['pixel.jpg', jpeg],
    ['document.pdf', pdf],
  ]) {
    const response = await upload(agent, id, name, data)
    assert.equal(response.status, 302, name)
    const download = await agent
      .get(`${response.headers.location}/download`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    assert.deepEqual(download.body, data)
    await post(agent, `${response.headers.location}/delete`)
  }
  assert.equal((await upload(agent, id, 'wrong.jpg', png)).status, 422)
  assert.equal(
    (await upload(agent, id, 'broken.png', png.subarray(0, 12))).status,
    422,
  )
})

test('concurrent uploads respect quotas and database rejects cross-owner folder relations', async () => {
  const agent = await signup('concurrent'),
    other = await signup('relation')
  const id = await folder(agent),
    otherId = await folder(other)
  const csrf = token(await get(agent, `/folders/${id}`))
  const results = await Promise.all(
    [1, 2, 3].map((index) =>
      agent
        .post(`/folders/${id}/files`)
        .field('_csrf', csrf)
        .attach('file', Buffer.alloc(800, 65), `parallel${index}.txt`),
    ),
  )
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [302, 422, 422],
  )
  assert.equal(await db.file.count({ where: { folderId: id } }), 1)
  const user = await db.user.findUnique({
    where: { username: `${prefix}_concurrent` },
  })
  await assert.rejects(
    db.file.create({
      data: {
        ownerId: user.id,
        folderId: otherId,
        originalName: 'invalid.txt',
        storageKey: randomUUID(),
        storageRef: 'never-uploaded',
        provider: 'local',
        mimeType: 'text/plain',
        byteSize: 1,
      },
    }),
    (error) => error.code === 'P2003',
  )
})
