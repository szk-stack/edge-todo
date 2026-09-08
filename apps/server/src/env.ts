export const env = {
  dbPath: process.env.DB_PATH ?? "./data/edgetodo.db",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-do-not-use-in-prod",
  port: Number(process.env.PORT ?? 8787),
  // 初始账号（仅首次启动 seed 时生效；生产环境务必用环境变量覆盖）
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "ll123456",
} as const;

if (process.env.NODE_ENV === "production" && env.jwtSecret.includes("dev-only")) {
  throw new Error("JWT_SECRET must be set in production");
}
