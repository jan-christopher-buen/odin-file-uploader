import { copyFile, mkdir, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { constants } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export function localStorage(directory) {
  function location(key) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid storage key')
    return path.join(directory, key)
  }
  return {
    provider: 'local',
    async put(key, filePath) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await copyFile(filePath, location(key), constants.COPYFILE_EXCL)
      return key
    },
    async download(file, res) {
      await pipeline(createReadStream(location(file.storageKey)), res)
    },
    async remove(file) {
      try {
        await unlink(location(file.storageKey))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    },
  }
}
