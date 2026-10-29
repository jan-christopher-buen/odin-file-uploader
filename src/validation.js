import { body, validationResult } from 'express-validator'
import { HttpError } from './middleware/security.js'

export const usernameRules = body('username')
  .isString()
  .bail()
  .trim()
  .toLowerCase()
  .matches(/^[a-z0-9_]{3,32}$/)
  .withMessage('Use 3–32 letters, numbers, or underscores.')
export const signupRules = [
  usernameRules,
  body('password')
    .isString()
    .bail()
    .custom(
      (value) => value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72,
    )
    .withMessage('Use at least 8 characters and at most 72 UTF-8 bytes.'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords must match.'),
]
export const folderRules = [
  body('name')
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 80 })
    .matches(/^[^\u0000-\u001f\u007f/\\]+$/u)
    .withMessage('Use 1–80 characters without slashes or control characters.'),
]
export function validate(req, res, next) {
  const result = validationResult(req)
  if (!result.isEmpty())
    return next(
      new HttpError(
        422,
        result
          .array()
          .map((item) => item.msg)
          .join(' '),
      ),
    )
  next()
}
