import { env } from "./env.js";

export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
}

/** 开发实现：验证码打印到服务端控制台 */
const consoleMailer: Mailer = {
  async sendCode(email, code) {
    console.log(`[mailer:console] 验证码 → ${email}: ${code}（10 分钟内有效）`);
  },
};

/**
 * 生产扩展点：实现 Mailer 接口（腾讯 SES / Resend），
 * 按 env.mailer 选择即可，调用方无感。
 */
export const mailer: Mailer = consoleMailer;
void env;
