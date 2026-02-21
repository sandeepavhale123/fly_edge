import { serve } from "https://deno.land/std@0.131.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

console.log('Send-email function started on port 9006');

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const debugLog: string[] = [];
  function log(msg: string) {
    console.log(msg);
    debugLog.push(msg);
  }

  try {
    const { email, fullName, userId, siteUrl } = await req.json();

    if (!email || !userId || !siteUrl) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: email, userId, siteUrl", debug: debugLog }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: Connect to Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars", debug: debugLog }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`✅ Supabase URL: ${supabaseUrl}`);

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Step 2: Fetch SMTP settings
    log("📡 Fetching SMTP settings from smtp_settings table...");
    const { data: smtp, error: smtpError } = await supabase
      .from("smtp_settings")
      .select("*")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (smtpError) {
      log(`❌ DB error fetching smtp_settings: ${smtpError.message}`);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to fetch SMTP settings: " + smtpError.message, debug: debugLog }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!smtp) {
      log("❌ No active SMTP settings found in smtp_settings table");
      return new Response(
        JSON.stringify({ success: false, error: "No active SMTP settings found. Please configure SMTP in Settings page.", debug: debugLog }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { host, port, username, password, secure, from_email, from_name, cc_email } = smtp;
    log(`✅ SMTP config loaded: host=${host}, port=${port}, secure=${secure}, from=${from_email}, cc=${cc_email || 'none'}`);

    // Step 3: Get active email template
    log("📡 Fetching email template...");
    const { data: templateData, error: templateError } = await supabase
      .from("email_templates")
      .select("*")
      .eq("template_type", "signup_verification")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (templateError || !templateData) {
      log(`❌ Template error: ${templateError?.message || "No active template found"}`);
      return new Response(
        JSON.stringify({ success: false, error: "Email template not found.", debug: debugLog }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    log("✅ Email template loaded");

    // Step 4: Generate verification token
    const token = crypto.randomUUID();
    const { error: insertError } = await supabase.from("email_verifications").insert({
      user_id: userId,
      token,
      email,
    });

    if (insertError) {
      log(`❌ Insert error: ${insertError.message}`);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to create verification token: " + insertError.message, debug: debugLog }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const verificationLink = `${siteUrl}/verify-email?token=${token}`;
    log(`✅ Verification link created: ${verificationLink}`);

    // Step 5: Replace template variables
    const htmlBody = templateData.body_html
      .replace(/\{\{full_name\}\}/g, fullName || "User")
      .replace(/\{\{verification_link\}\}/g, verificationLink)
      .replace(/\{\{email\}\}/g, email);

    const subject = templateData.subject
      .replace(/\{\{full_name\}\}/g, fullName || "User");

    // Step 6: Connect to SMTP server (using proven test-smtp logic)
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    log(`🔌 Connecting to ${host}:${port} (secure: ${secure})...`);
    let conn: Deno.Conn;
    if (secure || port === 465) {
      conn = await Deno.connectTls({ hostname: host, port });
      log("✅ TLS connection established");
    } else {
      conn = await Deno.connect({ hostname: host, port });
      log("✅ TCP connection established");
    }

    async function readResponse(): Promise<string> {
      const buf = new Uint8Array(4096);
      const n = await conn.read(buf);
      if (n === null) throw new Error("Connection closed unexpectedly");
      const resp = decoder.decode(buf.subarray(0, n));
      log(`SMTP << ${resp.trim()}`);
      return resp;
    }

    async function sendCommand(cmd: string, redact = false): Promise<string> {
      log(`SMTP >> ${redact ? "[REDACTED]" : cmd}`);
      await conn.write(encoder.encode(cmd + "\r\n"));
      return await readResponse();
    }

    // Step 7: SMTP handshake
    const greeting = await readResponse();
    log(`✅ Server greeting received`);

    let ehloResponse = await sendCommand("EHLO localhost");

    // STARTTLS
    if (!secure && port !== 465) {
      if (ehloResponse.includes("STARTTLS")) {
        log("🔒 STARTTLS supported, upgrading...");
        await sendCommand("STARTTLS");
        conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host });
        log("✅ TLS upgrade successful");
        ehloResponse = await sendCommand("EHLO localhost");
      } else {
        log("⚠️ STARTTLS not supported by server");
      }
    }

    // Step 8: AUTH
    log("🔑 Authenticating...");
    await sendCommand("AUTH LOGIN");
    await sendCommand(btoa(username), true);
    const authResp = await sendCommand(btoa(password), true);

    if (!authResp.startsWith("235")) {
      conn.close();
      log(`❌ Authentication failed: ${authResp.trim()}`);
      return new Response(
        JSON.stringify({ success: false, error: "SMTP auth failed: " + authResp.trim(), debug: debugLog }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    log("✅ Authentication successful");

    // Step 9: MAIL FROM / RCPT TO
    const mailFromResp = await sendCommand(`MAIL FROM:<${from_email}>`);
    if (!mailFromResp.startsWith("250")) {
      log(`❌ MAIL FROM rejected: ${mailFromResp.trim()}`);
    }

    const rcptToResp = await sendCommand(`RCPT TO:<${email}>`);
    if (!rcptToResp.startsWith("250")) {
      log(`❌ RCPT TO rejected: ${rcptToResp.trim()}`);
    }

    // CC recipient
    if (cc_email) {
      log(`📧 Adding CC: ${cc_email}`);
      const ccResp = await sendCommand(`RCPT TO:<${cc_email}>`);
      if (!ccResp.startsWith("250")) {
        log(`⚠️ CC RCPT rejected: ${ccResp.trim()}`);
      }
    }

    // Step 10: DATA
    await sendCommand("DATA");

    const boundary = `----=_Part_${Date.now()}`;

    const headers = [
      `From: "${from_name || 'Test'}" <${from_email}>`,
      `To: ${email}`,
      ...(cc_email ? [`Cc: ${cc_email}`] : []),
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `Date: ${new Date().toUTCString()}`,
    ];

    const body = [
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      htmlBody,
      ``,
      `--${boundary}--`,
    ];

    const messageParts = headers.join("\r\n") + "\r\n\r\n" + body.join("\r\n");

    const dataResp = await sendCommand(messageParts + "\r\n.");

    if (!dataResp.startsWith("250")) {
      conn.close();
      log(`❌ Send failed: ${dataResp.trim()}`);
      return new Response(
        JSON.stringify({ success: false, error: "Send failed: " + dataResp.trim(), debug: debugLog }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log("✅ Verification email sent successfully!");

    await sendCommand("QUIT");
    conn.close();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Verification email sent to ${email}` + (cc_email ? ` (CC: ${cc_email})` : ''),
        debug: debugLog
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    log(`❌ Error: ${error.message}`);
    console.error("Send email error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message, debug: debugLog }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}, { port: 9006 })
