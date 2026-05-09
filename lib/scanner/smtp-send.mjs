import nodemailer from "nodemailer";

/**
 * @param {{ to: string, subject: string, text: string }} args
 */
export async function sendMailConfigured(args) {
  const host = process.env.PMCI_SMTP_HOST?.trim();
  const port = Number(process.env.PMCI_SMTP_PORT ?? "587");
  const user = process.env.PMCI_SMTP_USER?.trim();
  const pass = process.env.PMCI_SMTP_PASS?.trim();
  const from = process.env.PMCI_SMTP_FROM?.trim();
  if (!host || !user || !pass || !from) {
    throw new Error("email: set PMCI_SMTP_HOST USER PASS FROM");
  }
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  await transport.sendMail({
    from,
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
}
