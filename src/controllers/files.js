import { randomUUID } from 'node:crypto'
import { create as contentDisposition } from 'content-disposition'
import { HttpError } from '../middleware/security.js'
import { inspectFile, cleanupTemp } from '../uploads.js'

export function fileControllers(db, storage, config) {
  async function ownedFile(req) {
    const file = await db.file.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
      include: { folder: true },
    })
    if (!file) throw new HttpError(404, 'File not found.')
    if (file.provider !== storage.provider)
      throw new HttpError(
        503,
        'This file’s storage provider is currently unavailable.',
      )
    return file
  }
  return {
    async upload(req, res) {
      let uploaded
      let committed = false
      try {
        if (Object.keys(req.body).some((key) => key !== '_csrf'))
          throw new HttpError(422, 'Unexpected upload field.')
        const mimeType = await inspectFile(req.file)
        await db.$transaction(
          async (tx) => {
            // Serialize this owner's file/folder mutations, including quota checks.
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.user.id} FOR UPDATE`
            const folder = await tx.folder.findFirst({
              where: { id: req.params.id, ownerId: req.user.id },
            })
            if (!folder) throw new HttpError(404, 'Folder not found.')
            const usage = await tx.file.aggregate({
              where: { ownerId: req.user.id },
              _count: true,
              _sum: { byteSize: true },
            })
            if (
              usage._count >= config.maxUserFiles ||
              (usage._sum.byteSize || 0) + req.file.size > config.maxUserBytes
            )
              throw new HttpError(
                422,
                'Your storage quota is full. Delete a file and try again.',
              )
            const key = randomUUID()
            const storageRef = await storage.put(key, req.file.path, mimeType)
            uploaded = { storageKey: key, storageRef }
            const file = await tx.file.create({
              data: {
                ownerId: req.user.id,
                folderId: folder.id,
                originalName: req.file.originalname,
                mimeType,
                byteSize: req.file.size,
                storageKey: key,
                storageRef,
                provider: storage.provider,
              },
            })
            uploaded.id = file.id
          },
          { maxWait: 10000, timeout: 60000 },
        )
        committed = true
        res.redirect(`/files/${uploaded.id}`)
      } catch (error) {
        if (uploaded && !committed) {
          try {
            await storage.remove(uploaded)
          } catch {
            console.error(
              'Upload rollback failed; reconcile unreferenced storage key:',
              uploaded.storageKey,
            )
          }
        }
        throw error
      } finally {
        await cleanupTemp(req)
      }
    },
    async details(req, res) {
      res.render('file', { title: 'File details', file: await ownedFile(req) })
    },
    async download(req, res) {
      const file = await ownedFile(req)
      res.set({
        'Content-Type': file.mimeType,
        'Content-Disposition': contentDisposition(file.originalName, {
          type: 'attachment',
        }),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      await storage.download(file, res)
    },
    async remove(req, res) {
      let folderId
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.user.id} FOR UPDATE`
          const file = await tx.file.findFirst({
            where: { id: req.params.id, ownerId: req.user.id },
          })
          if (!file) throw new HttpError(404, 'File not found.')
          if (file.provider !== storage.provider)
            throw new HttpError(503, 'Storage provider unavailable.')
          folderId = file.folderId
          // Keep the reference if object deletion fails. Missing objects are safe to retry.
          await storage.remove(file)
          await tx.file.delete({ where: { id: file.id } })
        },
        { timeout: 60000 },
      )
      res.redirect(`/folders/${folderId}`)
    },
  }
}
