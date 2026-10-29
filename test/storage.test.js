import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PassThrough, Readable } from 'node:stream'
import { supabaseStorage } from '../src/storage/supabase.js'

test('Supabase adapter uses authenticated streaming and exact-key deletion; provider errors propagate', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'folio-adapter-'))
  try {
    const filePath = path.join(dir, 'source.txt')
    const bytes = Buffer.from('Private adapter fixture')
    await writeFile(filePath, bytes)
    const key = randomUUID()
    const config = {
      supabaseUrl: 'https://storage.example.test',
      supabaseKey: 'test-only-placeholder',
      bucket: 'private-files',
    }
    const storage = supabaseStorage(config)
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      calls.push({ url: url.toString(), method: options.method || 'GET' })
      assert.equal(
        options.headers.Authorization,
        `Bearer ${config.supabaseKey}`,
      )
      if (options.method === 'POST') {
        assert.equal(options.headers['x-upsert'], 'false')
        assert.equal(options.duplex, 'half')
        const chunks = []
        for await (const chunk of options.body) chunks.push(chunk)
        assert.deepEqual(Buffer.concat(chunks), bytes)
        return new Response('{}')
      }
      if (options.method === 'DELETE') {
        assert.deepEqual(JSON.parse(options.body), { prefixes: [key] })
        return new Response('[]')
      }
      return new Response(Readable.toWeb(Readable.from([bytes])))
    })
    const storageRef = await storage.put(key, filePath, 'text/plain')
    const file = { storageKey: key, storageRef }
    const destination = new PassThrough()
    const downloaded = []
    destination.on('data', (chunk) => downloaded.push(chunk))
    await storage.download(file, destination)
    assert.deepEqual(Buffer.concat(downloaded), bytes)
    await storage.remove(file)
    assert.deepEqual(calls, [
      {
        method: 'POST',
        url: `https://storage.example.test/storage/v1/object/private-files/${key}`,
      },
      {
        method: 'GET',
        url: `https://storage.example.test/storage/v1/object/authenticated/private-files/${key}`,
      },
      {
        method: 'DELETE',
        url: 'https://storage.example.test/storage/v1/object/private-files',
      },
    ])
    await assert.rejects(
      storage.remove({ ...file, storageRef: `different-bucket/${key}` }),
    )
    await assert.rejects(storage.put('../arbitrary', filePath, 'text/plain'))
    globalThis.fetch.mock.mockImplementation(
      async () => new Response('unavailable', { status: 503 }),
    )
    await assert.rejects(storage.put(key, filePath, 'text/plain'), /503/)
    await assert.rejects(storage.remove(file), /503/)
    await assert.rejects(storage.download(file, new PassThrough()), /503/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('modern Supabase secret keys use only the apikey header', async (t) => {
  const key = randomUUID()
  const secret = 'sb_secret_test-only-placeholder'
  const storage = supabaseStorage({
    supabaseUrl: 'https://storage.example.test',
    supabaseKey: secret,
    bucket: 'private-files',
  })
  let called = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    called = true
    assert.equal(options.headers.apikey, secret)
    assert.equal(options.headers.Authorization, undefined)
    return new Response('[]')
  })
  await storage.remove({ storageKey: key, storageRef: `private-files/${key}` })
  assert.ok(called)
})
