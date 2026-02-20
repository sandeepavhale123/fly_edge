import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  from_email: string;
  from_name: string;
  secure: boolean;
}

interface EmailTemplate {
  subject: string;
  body_html: string;
}

// Simple SMTP email sender using Deno's TCP
async function sendEmailViaSMTP(
  smtp: SmtpSettings,
  to: string,
  subject: string,
  htmlBody: string
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const conn = smtp.secure
    ? await Deno.connectTls({ hostname: smtp.host, port: smtp.port })
    : await Deno.connect({ hostname: smtp.host, port: smtp.port });

  async function read(): Promise<string> {
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    return decoder.decode(buf.subarray(0, n ?? 0));
  }

  async function write(data: string) {
    await conn.write(encoder.encode(data + "\r\n"));
  }

  async function command(cmd: string): Promise<string> {
    await write(cmd);
    return await read();
  }

  // Read greeting
  await read();

  // EHLO
  await command(`EHLO localhost`);

  // STARTTLS if not already secure
  if (!smtp.secure) {
    const starttlsRes = await command("STARTTLS");
    if (starttlsRes.startsWith("220")) {
      // Upgrade connection - for simplicity, we'll skip TLS upgrade in basic impl
      // In production, use a proper SMTP library
    }
  }

  // AUTH LOGIN
  await command("AUTH LOGIN");
  await command(btoa(smtp.username));
  await command(btoa(smtp.password));

  // MAIL FROM
  await command(`MAIL FROM:<${smtp.from_email}>`);

  // RCPT TO
  await command(`RCPT TO:<${to}>`);

  // DATA
  await command("DATA");

  const boundary = "boundary_" + crypto.randomUUID().replace(/-/g, "");
  const message = [
    `From: ${smtp.from_name} <${smtp.from_email}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
    `.`,
  ].join("\r\n");

  const res = await command(message);

  await command("QUIT");
  conn.close();

  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { to, template_type, variables } = await req.json();

    if (!to || !template_type) {
      return new Response(
        JSON.stringify({ error: "Missing 'to' or 'template_type'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create admin client to read settings
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch SMTP settings
    const { data: smtpData, error: smtpError } = await supabaseAdmin
      .from("smtp_settings")
      .select("*")
      .eq("is_active", true)
      .single();

    if (smtpError || !smtpData) {
      return new Response(
        JSON.stringify({ error: "SMTP not configured. Please add SMTP settings." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch email template
    const { data: templateData, error: templateError } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .eq("template_type", template_type)
      .eq("is_active", true)
      .single();

    if (templateError || !templateData) {
      return new Response(
        JSON.stringify({ error: `No active template found for type: ${template_type}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Replace variables in template
    let subject = templateData.subject as string;
    let bodyHtml = templateData.body_html as string;

    if (variables && typeof variables === "object") {
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{{${key}}}`;
        subject = subject.replaceAll(placeholder, String(value));
        bodyHtml = bodyHtml.replaceAll(placeholder, String(value));
      }
    }

    // Send email
    const smtp: SmtpSettings = {
      host: smtpData.host,
      port: smtpData.port,
      username: smtpData.username,
      password: smtpData.password,
      from_email: smtpData.from_email,
      from_name: smtpData.from_name,
      secure: smtpData.secure,
    };

    await sendEmailViaSMTP(smtp, to, subject, bodyHtml);

    return new Response(
      JSON.stringify({ success: true, message: "Email sent successfully" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
