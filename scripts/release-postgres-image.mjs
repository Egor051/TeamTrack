import { failure } from './release-ci-process.mjs';

// The already validated 17.11 image, not the subsequently republished tag.
// Both official registries were compared byte-for-byte for each platform.
export const postgresImage = {
  version: '17.11.0.004', postgresVersion: '17.11',
  originalIndex: 'sha256:6058a6759ab9268cff8ee70641d61f1bd75953316281b76427cf5a6b4db2eafc',
  repositories: ['ghcr.io/supabase/postgres', 'public.ecr.aws/supabase/postgres'],
  platforms: {
    'linux/amd64': {
      manifest: 'sha256:f2a84af37797675f0b27e27ea1fad2ebcd913ebf7ad60be05d7df0bcbd29e4b5',
      config: 'sha256:94fe95acfce6e1d41106ff2abd4c08e7932a6941d453499a56f8a620a473de1a',
    },
    'linux/arm64': {
      manifest: 'sha256:42c140019fa5500deddd05aaef68188de3f87cdedcc4af95a9866ed45d063724',
      config: 'sha256:8fac45379c5953558656db67e8741800ecb5771b57225a1a00e7657780e1b3c8',
    },
  },
};

export function pullFailure(result) {
  const text = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n');
  if (/digest|checksum|unauthorized|authentication required|denied|forbidden|not found|manifest unknown|x509|certificate|unsupported/i.test(text)) return 'PERMANENT';
  if (result.timedOut || /toomanyrequests|too many requests|\b429\b|\b50[0234]\b|data limit exceeded|rate exceeded|timeout|timed out|connection reset|temporary failure|unexpected EOF|no such host|network is unreachable|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(text)) return 'TRANSIENT';
  return 'PERMANENT';
}

export function verifyImageIdentity(image, platform) {
  const expected = postgresImage.platforms[platform];
  if (!expected) throw failure('UNSUPPORTED_PLATFORM', 'No reviewed image for ' + platform);
  const [os, architecture] = platform.split('/');
  const trusted = postgresImage.repositories.map((repo) => repo + '@' + expected.manifest);
  const digest = image.Descriptor?.digest;
  const knownIds = [expected.config, expected.manifest, postgresImage.originalIndex];
  if (image.Os !== os || image.Architecture !== architecture || !image.RepoDigests?.some((ref) => trusted.includes(ref))
      || !knownIds.includes(image.Id) || (digest && ![expected.manifest, postgresImage.originalIndex].includes(digest))) {
    throw failure('IMAGE_INTEGRITY', 'PostgreSQL architecture/digest/config differs from the reviewed runtime');
  }
}

export async function preparePostgresImage(journal, { sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const info = await journal.command('docker-platform', 'docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { timeoutMs: 10_000 });
  if (info.exitCode !== 0) throw failure('DOCKER_UNAVAILABLE', info.stderr || info.error || 'Docker platform unavailable');
  const platform = info.stdout.trim().replace('x86_64', 'amd64').replace('aarch64', 'arm64');
  const expected = postgresImage.platforms[platform];
  journal.data.image = { version: postgresImage.version, originalIndex: postgresImage.originalIndex, platform, expectedDigest: expected?.manifest ?? null,
    expectedConfig: expected?.config ?? null, references: expected ? postgresImage.repositories.map((repo) => repo + '@' + expected.manifest) : [] };
  journal.save();
  if (!expected) throw failure('UNSUPPORTED_PLATFORM', 'No reviewed PostgreSQL image for ' + platform);
  const inspect = async (reference) => {
    const result = await journal.command('image-verify', 'docker', ['image', 'inspect', reference, '--format', '{{json .}}'], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) return { result };
    let image;
    try { image = JSON.parse(result.stdout); } catch { throw failure('IMAGE_INTEGRITY', 'Malformed Docker image metadata'); }
    verifyImageIdentity(image, platform);
    return { result, image };
  };
  for (const reference of journal.data.image.references) {
    const cached = await inspect(reference);
    if (cached.image) {
      Object.assign(journal.data.image, { reference, registry: reference.split('/')[0], cache: true, verified: true, imageId: cached.image.Id });
      journal.save(); return { reference, platform };
    }
    if (!/no such image|image.*not found/i.test(cached.result.stderr)) throw failure('DOCKER_UNAVAILABLE', cached.result.stderr || 'Image cache inspection failed');
  }
  // Two primary attempts, then one attempt at the other identical official
  // registry. Only a transient failure permits retry/failover; never retag.
  for (const [source, reference] of journal.data.image.references.entries()) {
    const attempts = source === 0 ? 2 : 1;
    for (let number = 1; number <= attempts; number++) {
      Object.assign(journal.data.image, { reference, registry: reference.split('/')[0], cache: false });
      const attempt = { source, number, registry: reference.split('/')[0], reference, expectedDigest: expected.manifest,
        startedAt: new Date(journal.now()).toISOString() };
      journal.data.attempts.push(attempt); journal.save();
      const result = await journal.command('image-pull', 'docker', ['pull', '--platform', platform, reference], { timeoutMs: 180_000 });
      Object.assign(attempt, result, { finishedAt: new Date(journal.now()).toISOString() }); journal.save();
      if (result.exitCode === 0 && !result.error && !result.timedOut) {
        const actual = await inspect(reference);
        if (!actual.image) throw failure('IMAGE_INCOMPLETE', actual.result.stderr || 'Successful pull did not produce a complete image');
        Object.assign(journal.data.image, { verified: true, imageId: actual.image.Id }); journal.save(); return { reference, platform };
      }
      attempt.classification = pullFailure(result); journal.save();
      if (attempt.classification !== 'TRANSIENT') throw failure('IMAGE_PULL_PERMANENT', result.stderr || result.error || 'Permanent image pull failure');
      if (number < attempts) await sleep(1000);
    }
  }
  throw failure('IMAGE_PULL_EXHAUSTED', 'All three bounded image attempts failed; no database suites were started');
}
