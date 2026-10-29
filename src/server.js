import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createPrisma } from './db.js'
import { createStorage } from './storage/index.js'

const config = loadConfig()
const db = createPrisma()
const app = await createApp({ db, config, storage: createStorage(config) })
const server = app.listen(config.port, () =>
  console.log(`Local: http://localhost:${config.port}`),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(async () => {
      app.locals.sessionStore.stopInterval()
      await db.$disconnect()
      process.exit(0)
    })
  })
