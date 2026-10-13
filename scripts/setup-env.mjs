import { randomBytes, scrypt as derive } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';

const scrypt = promisify(derive);
const destination = process.argv.includes('--test')
  ? '.context/test.env'
  : '.env';
const hiddenOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const terminal = createInterface({
  input: process.stdin,
  output: hiddenOutput,
  terminal: process.stdin.isTTY,
});
let password;
try {
  if (process.argv.includes('--test')) {
    password = randomBytes(24).toString('base64url');
  } else {
    process.stdout.write('Choose your app password (input hidden): ');
    password = await terminal.question('');
    process.stdout.write('\n');
  }
} finally {
  terminal.close();
}
if (password.length < 12)
  throw new Error('Choose a password of at least 12 characters.');
const salt = randomBytes(16);
const key = await scrypt(password, salt, 64);
const hash = `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
let template = await readFile('.env.example', 'utf8');
// Single quotes preserve literal dollar characters during Compose interpolation.
template = template
  .replace('APP_PASSWORD_HASH=', `APP_PASSWORD_HASH='${hash}'`)
  .replace('SESSION_KEY=', `SESSION_KEY=${randomBytes(32).toString('hex')}`)
  .replace(
    'GATEWAY_TOKEN=',
    `GATEWAY_TOKEN=${randomBytes(32).toString('hex')}`,
  );
await writeFile(destination, template, { flag: 'wx', mode: 0o600 });
if (process.argv.includes('--test'))
  await writeFile('.context/test-password.txt', password, {
    flag: 'wx',
    mode: 0o600,
  });
console.info(
  `Created ${destination} with mode 0600. Add a provider key before sending messages.`,
);
