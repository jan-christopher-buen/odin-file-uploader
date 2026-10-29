# Folio — File Uploader

A private personal file manager built for [The Odin Project's File Uploader assignment](https://www.theodinproject.com/lessons/nodejs-file-uploader). Organize flat folders, upload files, inspect their details, and download or delete them from a responsive server-rendered workspace.

## Stack

Node.js 24+, Express 5, JavaScript ES modules, EJS, plain CSS, PostgreSQL, Prisma 7 with the PostgreSQL driver adapter, Passport Local, bcryptjs, express-session, the assignment-linked Prisma session store, Multer, and express-validator. npm dependencies and Prettier are pinned in the lockfile.

## Local setup

1. Install Node.js 24+ and PostgreSQL. Create dedicated databases owned by your local role:

   ```sh
   createdb odin_file_uploader
   createdb odin_file_uploader_test
   createdb odin_file_uploader_shadow
   ```

   Inspect existing databases first. The shadow database must be disposable and separate from all application databases.

2. Install dependencies and prepare configuration:

   ```sh
   npm ci
   cp .env.example .env
   ```

   Edit `.env` privately. Set a random `SESSION_SECRET` of at least 32 characters. The example PostgreSQL URLs use the Ubuntu local `jc` role and peer authentication through `/var/run/postgresql`. Adjust these for your installation. Passwords, if used in URLs, must be URL encoded.

3. Apply tracked migrations and generate the JavaScript client:

   ```sh
   npm run db:deploy
   npm run prisma:generate
   npm start
   ```

   Open `http://localhost:3000`. Use `npm run dev` for watch mode. `npm run db:migrate -- --name describe_change` creates development migrations; it requires a dedicated shadow database or a role permitted to create one. Never use an application database as the shadow database. Do not reset databases to resolve migration errors.

   Prisma uses the TOP JavaScript adjustments: `prisma-client-js`, a JavaScript Prisma config, and explicit `.js` imports. Native Node environment-file support loads `.env` for app and Prisma scripts. Provider-injected variables work without an `.env` file and take precedence.

## Configuration

| Variable               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`         | Application PostgreSQL connection                           |
| `DIRECT_DATABASE_URL`  | Optional direct PostgreSQL connection for migrations        |
| `TEST_DATABASE_URL`    | Separate `odin_file_uploader_test` database                 |
| `SHADOW_DATABASE_URL`  | Dedicated disposable development migration database         |
| `SESSION_SECRET`       | Server-side session signing secret, at least 32 characters  |
| `PORT`                 | HTTP port, default 3000                                     |
| `NODE_ENV`             | `development` locally, `production` when hosted             |
| `TRUST_PROXY_HOPS`     | 0 locally; 1 only behind exactly one trusted reverse proxy  |
| `STORAGE_PROVIDER`     | `local` or `supabase`                                       |
| `LOCAL_STORAGE_DIR`    | Private local objects, default `./var/files`                |
| `TEMP_UPLOAD_DIR`      | Temporary upload staging, default `./var/tmp`               |
| `MAX_FILE_BYTES`       | Per-file limit, default 5242880                             |
| `MAX_USER_BYTES`       | Per-user storage quota, default 52428800                    |
| `MAX_USER_FILES`       | Per-user file quota, default 100                            |
| `SUPABASE_URL`         | Storage project's HTTPS URL                                 |
| `SUPABASE_SERVICE_KEY` | Private server-side secret key (or legacy service role key) |
| `SUPABASE_BUCKET`      | Dedicated private bucket name                               |

Keep local and temporary storage outside `public/`; neither is served statically. Real environment files, uploads, and generated Prisma output are gitignored.

## Private cloud storage

The Supabase Storage adapter is prepared; live cloud behavior still requires account configuration and verification. Supabase is used only for storage. Passport handles authentication, and application/session records remain in PostgreSQL.

1. Create a Supabase project and a dedicated **private** bucket, for example `private-files`. Do not enable public access or public object policies. Configure the bucket size limit to match `MAX_FILE_BYTES` and allow PDF, PNG, JPEG, and plain text MIME types.
2. Set `STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_BUCKET`, and a dedicated server-side secret key (`sb_secret_...`) in the private server environment. Never expose the credential to templates or browser code. Server credentials bypass Storage RLS; application ownership checks are mandatory.
3. Verify upload, authorized byte-matching download, deletion, and cross-user rejection with actual credentials before using the app for real files. Downloads stream through authenticated application routes; no public URLs are created.

Existing local files are not automatically migrated to a cloud bucket. Keep their original storage and database references together. Production refuses local storage because hosts such as Render have ephemeral filesystems.

For a future Render deployment, use a new service, dedicated Neon PostgreSQL database, and private Supabase bucket. Generate the Prisma client during build with `npm ci && npm run prisma:generate`, set the free service start command to `npm run db:deploy && npm start`. Free Render services do not support pre-deploy commands, so migrations run before the HTTP server starts. Use `/health` as the HTTP health-check path. Set `DIRECT_DATABASE_URL` to the direct Neon connection for migrations and `DATABASE_URL` to the pooled connection for runtime. Tests explicitly override the direct URL with their isolated test connection. Set `NODE_ENV=production`, `TRUST_PROXY_HOPS=1` for Render's single proxy, and a new private session secret. Confirm current provider free-tier availability before provisioning. No hosted resources or deployment are included in this repository.

## Rules and design

- Usernames normalize to lowercase, with 3–32 ASCII letters, digits, or underscores. Passwords preserve whitespace, require at least eight characters, and reject more than bcrypt's 72 UTF-8 bytes.
- Folder names are unique per user ignoring case. Folders are flat; a nonempty folder cannot be deleted. Delete its files individually first.
- One nonempty file per request, up to **5 MiB** by default; **100 files / 50 MiB per user**. Supported extensions are `.pdf`, `.png`, `.jpg`, `.jpeg`, and `.txt`. Binary signatures must agree with the extension. Text must be valid UTF-8 without binary controls or HTML-like markup. HTML, SVG, executables, and archives are rejected. This is format validation, not malware scanning.
- Original names are escaped display metadata. Storage uses generated UUID keys. Paths, control characters, and names over 180 characters are rejected. Downloads use attachment disposition and `nosniff`.
- Folder and file operations derive identity from Passport and scope queries to the authenticated owner. Inaccessible IDs return 404. A composite foreign key also prevents cross-owner folder assignment.
- Sessions live in PostgreSQL, serialize only the user ID, expire after one day, and use HttpOnly/SameSite=Lax cookies plus Secure cookies in HTTPS production. Forms, including logout and uploads, require session-bound CSRF tokens. Authentication and uploads have process-local rate limits.
- Uploads stage on disk with bounded sizes. CSRF/content/quota checks precede permanent storage and file creation. Owner row locks serialize quota changes. Failed DB writes trigger object cleanup; failed storage deletions preserve the DB reference for retry.

Database and storage changes are not atomic together. A process crash, an ambiguous network failure, a failed compensation, or a DB commit failure after object deletion may require manual reconciliation. Reconcile generated storage keys against file records; never bulk-delete a bucket or application database. Temporary files left by a hard process crash also require operator cleanup. Provider switching is not a file migration. Rate limits require a shared store before horizontal scaling. There are no shared links, nested folders, previews, or file editing.

## Commands

```sh
npm start
npm run dev
npm run format
npm run format:check
npm run db:validate
npm run prisma:generate
npm run db:migrate -- --name describe_change
npm run db:deploy
npm run db:smoke
npm test
```

Tests use Node's test runner, Supertest, the explicitly named separate test database, and a temporary storage directory. They apply tracked migrations, create uniquely prefixed disposable records, and remove only their own records and files. `db:smoke` verifies Prisma CRUD/relations with disposable application-database records, then deletes only those records. Never point tests at an application or hosted database.
