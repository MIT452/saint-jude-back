import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const deriveKey = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, (error, key) => {
    if (error) reject(error);
    else resolve(key as Buffer);
  });
});

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
};

export const verifyPassword = async (password: string, storedValue: string) => {
  if (!storedValue.startsWith("scrypt$")) {
    const supplied = Buffer.from(password);
    const legacy = Buffer.from(storedValue);
    return supplied.length === legacy.length && timingSafeEqual(supplied, legacy);
  }

  const [, saltHex, expectedHex] = storedValue.split("$");
  if (!saltHex || !expectedHex || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(expectedHex)) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");
  const actual = await deriveKey(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
