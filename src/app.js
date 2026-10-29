import express from 'express'
import session from 'express-session'
import { PrismaSessionStore } from '@quixo3/prisma-session-store'
import bcrypt from 'bcryptjs'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { body, validationResult } from 'express-validator'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPassport } from './auth.js'
import { createUpload, cleanupTemp } from './uploads.js'
import {
  checkCsrf,
  csrfToken,
  requireUser,
  HttpError,
} from './middleware/security.js'
import {
  signupRules,
  usernameRules,
  folderRules,
  validate,
} from './validation.js'
import { folderControllers } from './controllers/folders.js'
import { fileControllers } from './controllers/files.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export async function createApp({ db, config, storage }) {
  const app = express()
  const passport = createPassport(db)
  const store = new PrismaSessionStore(db, {
    checkPeriod: 120000,
    dbRecordIdIsSessionId: true,
  })
  app.locals.sessionStore = store
  app.set('view engine', 'ejs')
  app.set('views', path.join(root, 'src/views'))
  if (config.proxyHops) app.set('trust proxy', config.proxyHops)
  app.disable('x-powered-by')
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))
  app.use(helmet())
  app.use('/assets', express.static(path.join(root, 'public')))
  app.use(
    express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }),
  )
  app.use(
    session({
      name: 'folio.sid',
      secret: config.secret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        maxAge: 86400000,
      },
    }),
  )
  app.use(passport.initialize(), passport.session(), csrfToken)
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    res.locals.user = req.user
    res.locals.config = config
    res.locals.bytes = (value) =>
      value < 1024
        ? `${value} B`
        : value < 1048576
          ? `${(value / 1024).toFixed(1)} KB`
          : `${(value / 1048576).toFixed(1)} MB`
    next()
  })
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) =>
      next(
        new HttpError(
          429,
          'Too many attempts. Please try again in 15 minutes.',
        ),
      ),
  })
  const uploadLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 40,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) =>
      next(
        new HttpError(429, 'Upload limit reached. Try again in 15 minutes.'),
      ),
  })
  app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'))
  for (const mode of ['login', 'signup'])
    app.get(`/${mode}`, (req, res) =>
      req.user
        ? res.redirect('/dashboard')
        : res.render('auth', {
            title: mode === 'login' ? 'Welcome back' : 'Create your workspace',
            mode,
            error: null,
            username: '',
          }),
    )
  function validateAuth(mode) {
    return (req, res, next) => {
      const errors = validationResult(req)
      if (errors.isEmpty()) return next()
      res.status(422).render('auth', {
        title: mode === 'login' ? 'Welcome back' : 'Create your workspace',
        mode,
        error: errors
          .array()
          .map((item) => item.msg)
          .join(' '),
        username:
          typeof req.body.username === 'string' ? req.body.username : '',
      })
    }
  }
  app.post(
    '/signup',
    authLimit,
    checkCsrf,
    signupRules,
    validateAuth('signup'),
    async (req, res, next) => {
      const user = await db.user.create({
        data: {
          username: req.body.username,
          passwordHash: await bcrypt.hash(req.body.password, 12),
        },
        select: { id: true, username: true },
      })
      req.logIn(user, (error) =>
        error
          ? next(error)
          : req.session.save((error) =>
              error ? next(error) : res.redirect('/dashboard'),
            ),
      )
    },
  )
  app.post(
    '/login',
    authLimit,
    checkCsrf,
    usernameRules,
    body('password')
      .isString()
      .bail()
      .isLength({ min: 1 })
      .custom((value) => Buffer.byteLength(value, 'utf8') <= 72)
      .withMessage('Enter a password of at most 72 UTF-8 bytes.'),
    validateAuth('login'),
    (req, res, next) => {
      passport.authenticate('local', (error, user) => {
        if (error) return next(error)
        if (!user)
          return res.status(401).render('auth', {
            title: 'Welcome back',
            mode: 'login',
            error: 'Incorrect username or password.',
            username: req.body.username,
          })
        req.logIn(user, (error) =>
          error
            ? next(error)
            : req.session.save((error) =>
                error ? next(error) : res.redirect('/dashboard'),
              ),
        )
      })(req, res, next)
    },
  )
  app.post('/logout', requireUser, checkCsrf, (req, res, next) =>
    req.logout((error) => {
      if (error) return next(error)
      req.session.destroy((error) => {
        if (error) return next(error)
        res.clearCookie('folio.sid', {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.production,
        })
        res.redirect('/login')
      })
    }),
  )
  const folders = folderControllers(db)
  const files = fileControllers(db, storage, config)
  app.get('/dashboard', requireUser, folders.dashboard)
  app.post(
    '/folders',
    requireUser,
    checkCsrf,
    folderRules,
    validate,
    folders.create,
  )
  app.get('/folders/:id', requireUser, folders.show)
  app.post(
    '/folders/:id/rename',
    requireUser,
    checkCsrf,
    folderRules,
    validate,
    folders.rename,
  )
  app.post('/folders/:id/delete', requireUser, checkCsrf, folders.remove)
  const upload = await createUpload(config)
  app.post(
    '/folders/:id/files',
    requireUser,
    uploadLimit,
    async (req, res, next) => {
      if (
        !(await db.folder.findFirst({
          where: { id: req.params.id, ownerId: req.user.id },
          select: { id: true },
        }))
      )
        throw new HttpError(404, 'Folder not found.')
      next()
    },
    upload,
    checkCsrf,
    files.upload,
  )
  app.get('/files/:id', requireUser, files.details)
  app.get('/files/:id/download', requireUser, files.download)
  app.post('/files/:id/delete', requireUser, checkCsrf, files.remove)
  app.use((req, res, next) =>
    next(new HttpError(404, 'The page you’re looking for could not be found.')),
  )
  app.use(async (error, req, res, next) => {
    await cleanupTemp(req).catch(() =>
      console.error('Temporary upload cleanup failed'),
    )
    if (res.headersSent) return next(error)
    let status = error.status || 500
    let message = error.message
    if (error.code === 'P2002') {
      status = 409
      message =
        'That username or folder name is already in use. Folder names ignore letter case.'
    }
    if (error.name === 'MulterError') {
      status = 422
      message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `File too large. Maximum size is ${res.locals.bytes(config.maxFileBytes)}.`
          : 'Upload one file using the file field, with no extra fields.'
    }
    if (status >= 500) {
      console.error('Request failed:', error.code || error.name)
      message =
        'Something went wrong. Please try again. Your saved files remain private.'
    }
    res.status(status).render('error', {
      title: status === 404 ? 'Page not found' : 'Unable to continue',
      status,
      message,
    })
  })
  return app
}
