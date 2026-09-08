import { SignJWT, jwtVerify } from "jose";
import { env } from "./env.js";

const key = new TextEncoder().encode(env.jwtSecret);

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
