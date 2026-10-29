import multer from 'multer'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { fileTypeFromFile } from 'file-type'
import { HttpError } from './middleware/security.js'

export async function createUpload(config) {
  await mkdir(config.tempDir, { recursive: true, mode: 0o700 })
  return multer({
    dest: config.tempDir,
    preservePath: true,
    limits: {
      fileSize: config.maxFileBytes,
      files: 1,
      fields: 1,
      parts: 2,
      fieldSize: 128,
      fieldNameSize: 30,
    },
    fileFilter(req, file, done) {
      if (
        !file.originalname ||
        file.originalname.length > 180 ||
        /[/\\\u0000-\u001f\u007f]/u.test(file.originalname)
      )
        return done(
          new HttpError(
            422,
            'Use a filename of 1–180 characters without paths or control characters.',
          ),
        )
      done(null, true)
    },
  }).single('file')
}
export async function cleanupTemp(req) {
  if (req.file?.path)
    await unlink(req.file.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
}
export async function inspectFile(file) {
  if (!file || !file.size)
    throw new HttpError(422, 'Choose a nonempty file to upload.')
  const extension = file.originalname.split('.').at(-1).toLowerCase()
  let detected
  try {
    detected = await fileTypeFromFile(file.path)
  } catch {
    throw new HttpError(422, 'This file is malformed or incomplete.')
  }
  const allowed = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  }
  if (allowed[extension] && detected?.mime === allowed[extension])
    return detected.mime
  if (extension === 'txt' && !detected) {
    const buffer = await readFile(file.path)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new HttpError(422, 'Text files must contain valid UTF-8.')
    }
    if (
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) &&
      !/<\s*[!?/a-z]/iu.test(text)
    )
      return 'text/plain'
  }
  throw new HttpError(
    422,
    'Upload a valid PDF, PNG, JPEG, or plain UTF-8 .txt file. HTML and SVG are not allowed.',
  )
}
