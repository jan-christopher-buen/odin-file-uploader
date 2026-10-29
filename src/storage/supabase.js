import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Server-side Storage REST API; no Supabase Auth or public object URLs.
export function supabaseStorage(config) {
  if (
    !config.supabaseUrl ||
    !config.supabaseKey ||
    !/^[a-z0-9-]+$/.test(config.bucket || '')
  )
    throw new Error('Supabase configuration is required')
  const base = new URL('/storage/v1/', config.supabaseUrl)
  if (base.protocol !== 'https:') throw new Error('Supabase requires HTTPS')
  function objectUrl(key, authenticated = false) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid storage key')
    return new URL(
      `object/${authenticated ? 'authenticated/' : ''}${config.bucket}/${key}`,
      base,
    )
  }
  const headers = {
    apikey: config.supabaseKey,
    ...(config.supabaseKey.startsWith('sb_secret_')
      ? {}
      : { Authorization: `Bearer ${config.supabaseKey}` }),
  }
  async function checked(response) {
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Storage request failed (${response.status})`)
    }
    return response
  }
  return {
    provider: 'supabase',
    async put(key, filePath, mimeType) {
      const response = await checked(
        await fetch(objectUrl(key), {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': mimeType,
            'x-upsert': 'false',
          },
          body: createReadStream(filePath),
          duplex: 'half',
          signal: AbortSignal.timeout(30000),
        }),
      )
      await response.body?.cancel()
      return `${config.bucket}/${key}`
    },
    async download(file, res) {
      if (file.storageRef !== `${config.bucket}/${file.storageKey}`)
        throw new Error('Storage reference does not match configured bucket')
      const response = await checked(
        await fetch(objectUrl(file.storageKey, true), {
          headers,
          signal: AbortSignal.timeout(30000),
        }),
      )
      await pipeline(Readable.fromWeb(response.body), res)
    },
    async remove(file) {
      objectUrl(file.storageKey)
      if (file.storageRef !== `${config.bucket}/${file.storageKey}`)
        throw new Error('Storage reference does not match configured bucket')
      const response = await checked(
        await fetch(new URL(`object/${config.bucket}`, base), {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: [file.storageKey] }),
          signal: AbortSignal.timeout(30000),
        }),
      )
      await response.body?.cancel()
    },
  }
}
