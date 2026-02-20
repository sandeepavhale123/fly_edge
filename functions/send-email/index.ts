import { serve } from "https://deno.land/std@0.131.0/http/server.ts"

console.log('Test SMTP function started on port 9007');

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { host, port, username, password, secure, fromEmail, fromName, toEmail, subject, body } = await req.json();

    // Validate required fields
    if (!host || !port || !username || !password || !fromEmail || !toEmail) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields: host, port, username, password, fromEmail, toEmail" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Connecting to SMTP: ${host}:${port} (secure: ${secure})`);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Connect
    let conn: Deno.Conn;
    if (secure || port === 465) {
      conn = await Deno.connectTls({ hostname: host, port });
    } else {
      conn = await Deno.connect({ hostname: host, port });
    }

    async function readResponse(): Promise<string> {
      const buf = new Uint8Array(4096);
      const n = await conn.read(buf);
      if (n === null) throw new Error("Connection closed");
      const resp = decoder.decode(buf.subarray(0, n));
      console.log("SMTP <<", resp.trim());
      return resp;
    }

    async function sendCommand(cmd: string): Promise<string> {
      console.log("SMTP >>", cmd.startsWith("AUTH") || cmd === btoa(username) || cmd === btoa(password) ? "[REDACTED]" : cmd);
      await conn.write(encoder.encode(cmd + "\r\n"));
      return await readResponse();
    }

    // Greeting
    const greeting = await readResponse();
    console.log("Greeting:", greeting.trim());

    // EHLO
    let ehloResponse = await sendCommand("EHLO localhost");

    // STARTTLS
    if (!secure && port !== 465) {
      if (ehloResponse.includes("STARTTLS")) {
        await sendCommand("STARTTLS");
        conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host });
        ehloResponse = await sendCommand("EHLO localhost");
      }
    }

    // AUTH
    await sendCommand("AUTH LOGIN");
    await sendCommand(btoa(username));
    const authResp = await sendCommand(btoa(password));

    if (!authResp.startsWith("235")) {
      conn.close();
      return new Response(
        JSON.stringify({ success: false, error: "SMTP auth failed: " + authResp.trim() }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // MAIL FROM / RCPT TO
    await sendCommand(`MAIL FROM:<${fromEmail}>`);
    await sendCommand(`RCPT TO:<${toEmail}>`);

    // DATA
    await sendCommand("DATA");

    const message = [
      `From: "${fromName || 'Test'}" <${fromEmail}>`,
      `To: ${toEmail}`,
      `Subject: ${subject || 'SMTP Test Email'}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Date: ${new Date().toUTCString()}`,
      ``,
      body || `<h2>SMTP Test Successful!</h2><p>If you see this, your SMTP configuration is working correctly.</p><p>Sent at: ${new Date().toISOString()}</p>`,
    ].join("\r\n");

    const dataResp = await sendCommand(message + "\r\n.");

    if (!dataResp.startsWith("250")) {
      conn.close();
      return new Response(
        JSON.stringify({ success: false, error: "Send failed: " + dataResp.trim() }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await sendCommand("QUIT");
    conn.close();

    console.log("Test email sent successfully to:", toEmail);

    return new Response(
      JSON.stringify({ success: true, message: `Test email sent to ${toEmail}` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("SMTP test error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}, { port: 9000 })
