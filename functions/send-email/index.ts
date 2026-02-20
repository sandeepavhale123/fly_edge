import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, fullName, userId, siteUrl } = await req.json();

    if (!email || !userId || !siteUrl) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: email, userId, siteUrl" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get active SMTP settings
    const { data: smtpData, error: smtpError } = await supabase
      .from("smtp_settings")
      .select("*")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (smtpError || !smtpData) {
      return new Response(
        JSON.stringify({ error: "SMTP not configured. Please set up SMTP in Settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get active email template
    const { data: templateData, error: templateError } = await supabase
      .from("email_templates")
      .select("*")
      .eq("template_type", "signup_verification")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (templateError || !templateData) {
      return new Response(
        JSON.stringify({ error: "Email template not found." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate verification token
    const token = crypto.randomUUID();

    // Store verification record
    const { error: insertError } = await supabase.from("email_verifications").insert({
      user_id: userId,
      token,
      email,
    });

    if (insertError) {
      return new Response(
        JSON.stringify({ error: "Failed to create verification token: " + insertError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build verification link
    const verificationLink = `${siteUrl}/verify-email?token=${token}`;

    // Replace template variables
    const htmlBody = templateData.body_html
      .replace(/\{\{full_name\}\}/g, fullName || "User")
      .replace(/\{\{verification_link\}\}/g, verificationLink)
      .replace(/\{\{email\}\}/g, email);

    const subject = templateData.subject
      .replace(/\{\{full_name\}\}/g, fullName || "User");

    // Build CC header
    const ccEmail = smtpData.cc_email || "";

    // Send email via SMTP using Deno's built-in TCP
    await sendSmtpEmail({
      host: smtpData.host,
      port: smtpData.port,
      username: smtpData.username,
      password: smtpData.password,
      secure: smtpData.secure,
      fromEmail: smtpData.from_email,
      fromName: smtpData.from_name || "Todo App",
      toEmail: email,
      ccEmail,
      subject,
      htmlBody,
    });

    return new Response(
      JSON.stringify({ success: true, message: "Verification email sent" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Send email error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

interface SmtpParams {
  host: string;
  port: number;
  username: string;
  password: string;
  secure: boolean;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  ccEmail: string;
  subject: string;
  htmlBody: string;
}

async function sendSmtpEmail(params: SmtpParams) {
  const { host, port, username, password, fromEmail, fromName, toEmail, ccEmail, subject, htmlBody } = params;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Connect to SMTP server
  let conn: Deno.TcpConn;
  
  if (params.secure || port === 465) {
    conn = await Deno.connectTls({ hostname: host, port }) as unknown as Deno.TcpConn;
  } else {
    conn = await Deno.connect({ hostname: host, port });
  }

  async function readResponse(): Promise<string> {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new Error("Connection closed");
    return decoder.decode(buf.subarray(0, n));
  }

  async function sendCommand(cmd: string): Promise<string> {
    await conn.write(encoder.encode(cmd + "\r\n"));
    return await readResponse();
  }

  // Read server greeting
  await readResponse();

  // EHLO
  let ehloResponse = await sendCommand(`EHLO localhost`);

  // STARTTLS for non-SSL connections on port 587
  if (!params.secure && port !== 465) {
    if (ehloResponse.includes("STARTTLS")) {
      await sendCommand("STARTTLS");
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host }) as unknown as Deno.TcpConn;
      ehloResponse = await sendCommand(`EHLO localhost`);
    }
  }

  // AUTH LOGIN
  await sendCommand("AUTH LOGIN");
  await sendCommand(btoa(username));
  const authResponse = await sendCommand(btoa(password));

  if (!authResponse.startsWith("235")) {
    conn.close();
    throw new Error("SMTP authentication failed: " + authResponse);
  }

  // MAIL FROM
  await sendCommand(`MAIL FROM:<${fromEmail}>`);

  // RCPT TO
  await sendCommand(`RCPT TO:<${toEmail}>`);

  // CC recipient
  if (ccEmail) {
    await sendCommand(`RCPT TO:<${ccEmail}>`);
  }

  // DATA
  await sendCommand("DATA");

  // Build MIME message
  const boundary = `----=_Part_${Date.now()}`;
  const ccHeader = ccEmail ? `Cc: ${ccEmail}\r\n` : "";
  
  const message = [
    `From: "${fromName}" <${fromEmail}>`,
    `To: ${toEmail}`,
    ccEmail ? `Cc: ${ccEmail}` : "",
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `Date: ${new Date().toUTCString()}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ]
    .filter(Boolean)
    .join("\r\n");

  const dataResponse = await sendCommand(message + "\r\n.");

  if (!dataResponse.startsWith("250")) {
    conn.close();
    throw new Error("Failed to send email: " + dataResponse);
  }

  // QUIT
  await sendCommand("QUIT");
  conn.close();
}
