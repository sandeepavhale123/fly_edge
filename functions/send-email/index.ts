import { serve } from "https://deno.land/std@0.131.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

console.log('Test SMTP function started on port 9007');

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

    // Step 2: Fetch SMTP settings from smtp_settings table
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

    const toEmail = "sandy.avhale143@gmail.com";
    log(`📧 Sending test email to: ${toEmail}`);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Step 3: Connect to SMTP server
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

    // Step 4: SMTP handshake
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

    // Step 5: AUTH
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

    // Step 6: MAIL FROM / RCPT TO
    const mailFromResp = await sendCommand(`MAIL FROM:<${from_email}>`);
    if (!mailFromResp.startsWith("250")) {
      log(`❌ MAIL FROM rejected: ${mailFromResp.trim()}`);
    }

    const rcptToResp = await sendCommand(`RCPT TO:<${toEmail}>`);
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

    // Step 7: DATA
    await sendCommand("DATA");

    const boundary = `----=_Part_${Date.now()}`;
    
    const htmlBody = [
  '<h2>🎉 SMTP Test Successful!</h2>',
  '<p>Your SMTP configuration is working correctly.</p>',
  '<table style="border-collapse:collapse;margin:16px 0;">',
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">Host</td><td style="padding:4px 12px;border:1px solid #ddd;">${host}</td></tr>`,
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">Port</td><td style="padding:4px 12px;border:1px solid #ddd;">${port}</td></tr>`,
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">Secure</td><td style="padding:4px 12px;border:1px solid #ddd;">${secure}</td></tr>`,
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">From</td><td style="padding:4px 12px;border:1px solid #ddd;">${from_name} &lt;${from_email}&gt;</td></tr>`,
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">CC</td><td style="padding:4px 12px;border:1px solid #ddd;">${cc_email || 'None'}</td></tr>`,
  `  <tr><td style="padding:4px 12px;border:1px solid #ddd;font-weight:bold;">Sent At</td><td style="padding:4px 12px;border:1px solid #ddd;">${new Date().toISOString()}</td></tr>`,
  '</table>'
].join('');

    const messageParts = [
      `From: "${from_name || 'Test'}" <${from_email}>`,
      `To: ${toEmail}`,
      cc_email ? `Cc: ${cc_email}` : "",
      `Subject: SMTP Test - ${new Date().toLocaleString()}`,
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
    ].filter(Boolean).join("\r\n");

    const dataResp = await sendCommand(messageParts + "\r\n.");

    if (!dataResp.startsWith("250")) {
      conn.close();
      log(`❌ Send failed: ${dataResp.trim()}`);
      return new Response(
        JSON.stringify({ success: false, error: "Send failed: " + dataResp.trim(), debug: debugLog }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log("✅ Email sent successfully!");

    await sendCommand("QUIT");
    conn.close();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Test email sent to ${toEmail}` + (cc_email ? ` (CC: ${cc_email})` : ''),
        smtp_config: { host, port, secure, from_email, from_name, cc_email: cc_email || null },
        debug: debugLog
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    log(`❌ Error: ${error.message}`);
    console.error("SMTP test error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message, debug: debugLog }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}, { port: 9007 })
