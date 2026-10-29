import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPrisma } from '../src/db.js'

const db = createPrisma()
const username = `smoke_${randomUUID().slice(0, 12)}`
let user
try {
  user = await db.user.create({
    data: {
      username,
      passwordHash: 'disposable-smoke-record',
      folders: { create: { name: 'Smoke', nameKey: 'smoke' } },
    },
    include: { folders: true },
  })
  assert.equal(user.folders.length, 1)
  const folder = await db.folder.update({
    where: { id: user.folders[0].id },
    data: { name: 'Updated' },
  })
  assert.equal(folder.name, 'Updated')
  const read = await db.user.findUnique({
    where: { id: user.id },
    include: { folders: true },
  })
  assert.equal(read.folders[0].name, 'Updated')
  console.log('Prisma create/read/update and relation checks passed')
} finally {
  if (user) {
    await db.folder.deleteMany({ where: { ownerId: user.id } })
    await db.user.delete({ where: { id: user.id } })
    assert.equal(await db.user.count({ where: { id: user.id } }), 0)
    console.log('Disposable records deleted')
  }
  await db.$disconnect()
}
