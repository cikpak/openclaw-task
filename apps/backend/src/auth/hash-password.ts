import { hashPassword } from './password.js';
const password = process.env.APP_PASSWORD;
if (!password) throw new Error('Set APP_PASSWORD for this command.');
process.stdout.write(`${await hashPassword(password)}\n`);
