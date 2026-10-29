import path from 'node:path'

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}`)
  return value
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production'
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32)
    throw new Error('SESSION_SECRET must be at least 32 characters')
  const provider = process.env.STORAGE_PROVIDER || 'local'
  if (!['local', 'supabase'].includes(provider))
    throw new Error('Invalid STORAGE_PROVIDER')
  if (production && provider !== 'supabase')
    throw new Error('Production requires private cloud storage')
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)
  if (![0, 1].includes(proxyHops))
    throw new Error('TRUST_PROXY_HOPS must be 0 or 1')
  return {
    production,
    secret,
    provider,
    proxyHops,
    port: positive('PORT', 3000),
    localDir: path.resolve(process.env.LOCAL_STORAGE_DIR || 'var/files'),
    tempDir: path.resolve(process.env.TEMP_UPLOAD_DIR || 'var/tmp'),
    maxFileBytes: positive('MAX_FILE_BYTES', 5 * 1024 * 1024),
    maxUserBytes: positive('MAX_USER_BYTES', 50 * 1024 * 1024),
    maxUserFiles: positive('MAX_USER_FILES', 100),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_KEY,
    bucket: process.env.SUPABASE_BUCKET,
  }
}
