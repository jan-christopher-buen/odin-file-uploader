import { randomBytes, timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
export function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/login')
  next()
}
export function csrfToken(req, res, next) {
  req.session.csrf ||= randomBytes(32).toString('hex')
  res.locals.csrf = req.session.csrf
  next()
}
export function checkCsrf(req, res, next) {
  const token = req.body?._csrf
  const expected = req.session.csrf
  if (
    typeof token !== 'string' ||
    !expected ||
    Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    return next(
      new HttpError(
        403,
        'This form has expired. Reload the page and try again.',
      ),
    )
  }
  next()
}
