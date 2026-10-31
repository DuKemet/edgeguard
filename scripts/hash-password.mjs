#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import bcrypt from "bcryptjs";

async function readPassword() {
  const fromArgs = process.argv[2];
  if (fromArgs) return fromArgs;
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Password: ")).trim();
  } finally {
    rl.close();
  }
}

const password = await readPassword();
if (password.length < 8) {
  process.stderr.write("Password must be at least 8 characters.\n");
  process.exit(1);
}
const rounds = Number(process.env.BCRYPT_ROUNDS ?? 10);
if (!Number.isInteger(rounds) || rounds < 8 || rounds > 14) {
  process.stderr.write("BCRYPT_ROUNDS must be an integer between 8 and 14.\n");
  process.exit(1);
}
const hash = bcrypt.hashSync(password, rounds);
process.stdout.write(`${hash}\n`);
