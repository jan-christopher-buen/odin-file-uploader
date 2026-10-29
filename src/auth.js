import { Passport } from 'passport'
import { Strategy } from 'passport-local'
import bcrypt from 'bcryptjs'

export const normalizeUsername = (value) => value.trim().toLowerCase()
export function createPassport(db) {
  const passport = new Passport()
  passport.use(
    new Strategy(async (username, password, done) => {
      try {
        if (Buffer.byteLength(password, 'utf8') > 72) return done(null, false)
        const user = await db.user.findUnique({
          where: { username: normalizeUsername(username) },
        })
        const valid = await bcrypt.compare(
          password,
          user?.passwordHash ||
            '$2b$12$C6UzMDM.H6dfI/f/IKcEe.yrWmMywLQPP1Yp0dDPC5qK3bRCdC8Qq',
        )
        done(
          null,
          valid && user ? { id: user.id, username: user.username } : false,
        )
      } catch (error) {
        done(error)
      }
    }),
  )
  passport.serializeUser((user, done) => done(null, user.id))
  passport.deserializeUser(async (id, done) => {
    try {
      done(
        null,
        (await db.user.findUnique({
          where: { id },
          select: { id: true, username: true },
        })) || false,
      )
    } catch (error) {
      done(error)
    }
  })
  return passport
}
