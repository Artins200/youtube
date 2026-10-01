// Резервный подписыватель для окружений без SDK apksigner.
// Ресурсы уже выровнены zipalign в build-apk.sh. Не вызываем zipalign из
// apk_sign_ts: версия 1.0.1 добавляет недопустимые 1–3 байта ZIP extra field.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ApkSigner, SigningKey, findEndOfCentralDirectory,
  createSigningBlock, createV2SignaturePair
} from 'apk_sign_ts';

const [input, output, key, certificate] = process.argv.slice(2);
if (!input || !output || !key || !certificate) {
  console.error('Usage: ZIPALIGN=/path/to/zipalign node sign-apk.mjs aligned.apk signed.apk key.pem cert.pem');
  process.exit(2);
}
const signer = new ApkSigner({
  signingKey: SigningKey.fromPEM(readFileSync(key, 'utf8'), readFileSync(certificate, 'utf8'))
});
const workdir = mkdtempSync(join(tmpdir(), 'ytlocal-sign-'));
try {
  // Подписываем содержимое v1, затем выравниваем все добавленные META-INF-файлы.
  // zipalign меняет только заголовки ZIP, поэтому JAR-подпись остаётся действительной.
  const v1 = await signer.v1Signer.sign(new Uint8Array(readFileSync(input)));
  const v1File = join(workdir, 'v1.apk');
  const alignedFile = join(workdir, 'v1-aligned.apk');
  writeFileSync(v1File, v1);
  execFileSync(process.env.ZIPALIGN || 'zipalign', ['-f', '-p', '4', v1File, alignedFile]);
  const aligned = new Uint8Array(readFileSync(alignedFile));
  const eocd = findEndOfCentralDirectory(aligned);
  if (!eocd) throw new Error('Нет ZIP central directory');
  const { centralDirectoryOffset, recordOffset } = eocd;
  const [{ v2Value }, { v3Value }] = await Promise.all([
    signer.v2Signer.sign(aligned, centralDirectoryOffset, recordOffset),
    signer.v3Signer.sign(aligned, centralDirectoryOffset, recordOffset)
  ]);
  const block = createSigningBlock([
    createV2SignaturePair(v2Value), { id: 0xf05368c0, value: v3Value }
  ]);
  writeFileSync(output, signer.insertSigningBlock(aligned, block, centralDirectoryOffset, recordOffset));
  console.log('APK подписан (v1 + v2 + v3):', output);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
