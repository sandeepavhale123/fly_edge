import { serve } from "https://deno.land/std@0.131.0/http/server.ts"

interface ReqPayload {
  name: string;
}

console.log("hello-world started");

serve(async (req: Request) => {
  // Allow GET request (so browser works)
  if (req.method === "GET") {
    return new Response("Hello World 🚀", {
      status: 200,
    });
  }

  // Handle POST with JSON
  if (req.method === "POST") {
    try {
      const { name }: ReqPayload = await req.json();

      const data = {
        message: `Hello ${name} from Supabase Edge Functions!`,
      };

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (error) {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400 }
      );
    }
  }

  return new Response("Method Not Allowed", { status: 405 });

}, { port: 9005 });
