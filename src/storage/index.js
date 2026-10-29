import { localStorage } from './local.js'
import { supabaseStorage } from './supabase.js'
export function createStorage(config) {
  return config.provider === 'local'
    ? localStorage(config.localDir)
    : supabaseStorage(config)
}
