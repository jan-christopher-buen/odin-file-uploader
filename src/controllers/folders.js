import { HttpError } from '../middleware/security.js'

export function folderControllers(db) {
  return {
    async dashboard(req, res) {
      const [folders, usage] = await Promise.all([
        db.folder.findMany({
          where: { ownerId: req.user.id },
          include: { _count: { select: { files: true } } },
          orderBy: { nameKey: 'asc' },
        }),
        db.file.aggregate({
          where: { ownerId: req.user.id },
          _sum: { byteSize: true },
          _count: true,
        }),
      ])
      res.render('dashboard', { title: 'My workspace', folders, usage })
    },
    async create(req, res) {
      const folder = await db.folder.create({
        data: {
          ownerId: req.user.id,
          name: req.body.name,
          nameKey: req.body.name.toLowerCase(),
        },
      })
      res.redirect(`/folders/${folder.id}`)
    },
    async show(req, res) {
      const folder = await db.folder.findFirst({
        where: { id: req.params.id, ownerId: req.user.id },
        include: { files: { orderBy: { uploadedAt: 'desc' } } },
      })
      if (!folder) throw new HttpError(404, 'Folder not found.')
      res.render('folder', { title: folder.name, folder })
    },
    async rename(req, res) {
      const result = await db.folder.updateMany({
        where: { id: req.params.id, ownerId: req.user.id },
        data: { name: req.body.name, nameKey: req.body.name.toLowerCase() },
      })
      if (!result.count) throw new HttpError(404, 'Folder not found.')
      res.redirect(`/folders/${req.params.id}`)
    },
    async remove(req, res) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.user.id} FOR UPDATE`
        const folder = await tx.folder.findFirst({
          where: { id: req.params.id, ownerId: req.user.id },
          include: { _count: { select: { files: true } } },
        })
        if (!folder) throw new HttpError(404, 'Folder not found.')
        if (folder._count.files)
          throw new HttpError(
            409,
            'This folder still contains files. Delete its files before deleting the folder.',
          )
        await tx.folder.delete({ where: { id: folder.id } })
      })
      res.redirect('/dashboard')
    },
  }
}
