// Storage abstraction.
//
// Three backends, picked by env:
//   - s3:    set STORAGE_BUCKET; default when STORAGE_PROVIDER is unset and
//            a bucket is provided. Credentials use the AWS SDK chain.
//   - gcs:   set STORAGE_BUCKET and STORAGE_PROVIDER=gcs. Credentials use
//            Google Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS
//            file, or the runtime service account on GCE/GKE/Cloud Run).
//   - local: when STORAGE_BUCKET is unset (or STORAGE_PROVIDER=local). Files
//            live under UPLOADS_DIR. For dev / single-instance only — not
//            durable on ephemeral container filesystems.
//
// Public surface (every backend implements all of these):
//   storage.provider                      -> 's3' | 'gcs' | 'local'
//   storage.isCloud                       -> boolean (false for local)
//   storage.putFromPath(name, src, mime?) -> Promise<void>
//   storage.putBuffer(name, buf, mime?)   -> Promise<void>
//   storage.delete(name)                  -> Promise<void>
//   storage.getDownloadUrl(name, opts)    -> Promise<string|null>  (null in local)
//   storage.readText(name, maxBytes)      -> Promise<string>
//   storage.sendFile(res, name, opts)     -> Promise<void>  (302 in cloud, stream in local)
//
// `name` is the stored_name we record in the DB. The actual object key is
// `${STORAGE_PREFIX}${name}`.

const fs = require('fs');
const path = require('path');

const BUCKET = process.env.STORAGE_BUCKET || '';
const REGION = process.env.STORAGE_REGION || process.env.AWS_REGION || 'us-east-1';
const PREFIX = process.env.STORAGE_PREFIX || 'uploads/';
const SIGNED_URL_TTL = Math.max(60, parseInt(process.env.SIGNED_URL_TTL_SEC || '300', 10));

// Provider selection: explicit STORAGE_PROVIDER wins; otherwise default to s3
// when a bucket is set, local when not.
let provider = (process.env.STORAGE_PROVIDER || '').toLowerCase();
if (!provider) provider = BUCKET ? 's3' : 'local';
if (!['s3', 'gcs', 'local'].includes(provider)) {
    throw new Error(`storage: invalid STORAGE_PROVIDER='${provider}' (expected s3|gcs|local)`);
}
if (provider !== 'local' && !BUCKET) {
    throw new Error(`storage: STORAGE_PROVIDER=${provider} requires STORAGE_BUCKET to be set`);
}
const isCloud = provider !== 'local';

const keyOf = (name) => PREFIX + name;

// `disposition` argument is sanitized so it can't break out of the header.
function buildContentDisposition(disposition, filename) {
    if (!filename) return undefined;
    const safeFilename = String(filename).replace(/[\r\n"]/g, '');
    const safeDisposition = disposition === 'attachment' ? 'attachment' : 'inline';
    return `${safeDisposition}; filename="${safeFilename}"`;
}

// ── S3 backend ────────────────────────────────────────────────
function makeS3Backend() {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const s3 = new S3Client({ region: REGION });

    return {
        provider: 's3',
        isCloud: true,
        async putFromPath(name, srcPath, contentType) {
            await s3.send(new PutObjectCommand({
                Bucket: BUCKET, Key: keyOf(name),
                Body: fs.createReadStream(srcPath),
                ContentType: contentType || 'application/octet-stream',
            }));
        },
        async putBuffer(name, buf, contentType) {
            await s3.send(new PutObjectCommand({
                Bucket: BUCKET, Key: keyOf(name),
                Body: buf,
                ContentType: contentType || 'application/octet-stream',
            }));
        },
        async delete(name) {
            await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyOf(name) }));
        },
        async getDownloadUrl(name, { filename, disposition = 'inline' } = {}) {
            return getSignedUrl(s3, new GetObjectCommand({
                Bucket: BUCKET, Key: keyOf(name),
                ResponseContentDisposition: buildContentDisposition(disposition, filename),
            }), { expiresIn: SIGNED_URL_TTL });
        },
        async readText(name, maxBytes) {
            const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyOf(name) }));
            const chunks = [];
            let total = 0;
            for await (const chunk of r.Body) {
                total += chunk.length;
                chunks.push(chunk);
                if (total >= maxBytes) break;
            }
            return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf-8');
        },
        async sendFile(res, name, opts = {}) {
            res.redirect(302, await this.getDownloadUrl(name, opts));
        },
    };
}

// ── GCS backend ───────────────────────────────────────────────
function makeGcsBackend() {
    const { Storage } = require('@google-cloud/storage');
    const gcs = new Storage();
    const bucketRef = gcs.bucket(BUCKET);
    const fileRef = (name) => bucketRef.file(keyOf(name));

    return {
        provider: 'gcs',
        isCloud: true,
        async putFromPath(name, srcPath, contentType) {
            await bucketRef.upload(srcPath, {
                destination: keyOf(name),
                contentType: contentType || 'application/octet-stream',
                resumable: false,
            });
        },
        async putBuffer(name, buf, contentType) {
            await fileRef(name).save(buf, {
                contentType: contentType || 'application/octet-stream',
                resumable: false,
            });
        },
        async delete(name) {
            try { await fileRef(name).delete(); }
            catch (e) {
                // Treat 'not found' as already-deleted.
                if (e.code !== 404) throw e;
            }
        },
        async getDownloadUrl(name, { filename, disposition = 'inline' } = {}) {
            const [url] = await fileRef(name).getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + SIGNED_URL_TTL * 1000,
                responseDisposition: buildContentDisposition(disposition, filename),
            });
            return url;
        },
        async readText(name, maxBytes) {
            const stream = fileRef(name).createReadStream();
            const chunks = [];
            let total = 0;
            for await (const chunk of stream) {
                total += chunk.length;
                chunks.push(chunk);
                if (total >= maxBytes) {
                    stream.destroy();
                    break;
                }
            }
            return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf-8');
        },
        async sendFile(res, name, opts = {}) {
            res.redirect(302, await this.getDownloadUrl(name, opts));
        },
    };
}

// ── Local backend (single-instance / dev) ────────────────────
function makeLocalBackend(uploadsDir) {
    const safeJoin = (name) => {
        const target = path.resolve(path.join(uploadsDir, name));
        const root = path.resolve(uploadsDir) + path.sep;
        if (!target.startsWith(root)) throw new Error('storage: path escape rejected');
        return target;
    };
    return {
        provider: 'local',
        isCloud: false,
        async putFromPath(name, srcPath) {
            const dest = safeJoin(name);
            if (path.resolve(srcPath) === dest) return;
            await fs.promises.copyFile(srcPath, dest);
            await fs.promises.unlink(srcPath).catch(() => {});
        },
        async putBuffer(name, buf) {
            await fs.promises.writeFile(safeJoin(name), buf);
        },
        async delete(name) {
            try { await fs.promises.unlink(safeJoin(name)); } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
        },
        async getDownloadUrl() {
            return null; // local mode doesn't issue signed URLs
        },
        async readText(name, maxBytes) {
            const fd = await fs.promises.open(safeJoin(name), 'r');
            try {
                const buf = Buffer.alloc(maxBytes);
                const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
                return buf.subarray(0, bytesRead).toString('utf-8');
            } finally { await fd.close(); }
        },
        async sendFile(res, name, { filename, disposition = 'inline' } = {}) {
            const fp = safeJoin(name);
            if (!fs.existsSync(fp)) {
                res.status(404).json({ error: 'File missing from disk' });
                return;
            }
            const cd = buildContentDisposition(disposition, filename);
            if (cd) res.setHeader('Content-Disposition', cd);
            res.sendFile(fp);
        },
    };
}

function init(uploadsDir) {
    if (provider === 's3') return makeS3Backend();
    if (provider === 'gcs') return makeGcsBackend();
    return makeLocalBackend(uploadsDir);
}

module.exports = {
    init,
    provider,
    isCloud,
    BUCKET, REGION, PREFIX, SIGNED_URL_TTL,
    // exported for tests:
    _buildContentDisposition: buildContentDisposition,
    _keyOf: keyOf,
};
