import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/index.js'

export function createPrisma(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}
