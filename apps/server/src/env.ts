export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://edgetodo:edgetodo@localhost:5432/edgetodo",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-do-not-use-in-prod",
  port: Number(process.env.PORT ?? 8787),
  mailer: process.env.MAILER ?? "console",
} as const;

if (process.env.NODE_ENV === "production" && env.jwtSecret.includes("dev-only")) {
  throw new Error("JWT_SECRET must be set in production");
}
